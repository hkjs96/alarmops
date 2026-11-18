"use server";
import { revalidatePath } from "next/cache";
import { getApi } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { requireRole } from "@/lib/auth/role";
import { assertId, InvalidInputError } from "@/lib/validate";
import type {
  AccountCapabilities, AccountEnvironment, AccountRecord, AccountStatus, ContactRecord, CustomerRecord, ProjectRecord, ServiceRecord, VerifyBulkResult, VerifyChannel, VerifyContactResult,
} from "@/lib/api/types";
import { fail, type ActionResult } from "@/lib/action-result";
import { parseLoginDomains } from "@/lib/onboarding";

/**
 * Customer onboarding (API-CONTRACT 8.4, #62, #69). Writes are ADMIN only: session first, then the role, then input,
 * then the API call (the API checks the role again and stays the authority). Reads of the connection state need the
 * session and a staff role (VIEWER and up). Nothing here logs a value: not the ExternalId, not an address.
 */
async function run<T>(min: "VIEWER" | "ADMIN", fn: () => Promise<T>, revalidate = true): Promise<ActionResult<T>> {
  try {
    await requireSession();
    await requireRole(min);
    const data = await fn();
    if (revalidate) revalidatePath("/", "layout"); // the tree, the Customers list
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

const NAME_MAX = 80;
const HIDDEN_CHARS = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/;
function assertName(v: unknown, what = "name"): string {
  const n = typeof v === "string" ? v.trim() : "";
  if (!n || n.length > NAME_MAX || /[\u0000-\u001f]/.test(n)) throw new InvalidInputError(`Give a ${what} of 1 to ${NAME_MAX} characters.`);
  // bidi controls and zero-width characters make two different names look the same (or reorder what is shown)
  if (HIDDEN_CHARS.test(n)) throw new InvalidInputError(`The ${what} has characters that cannot be seen. Type it again without copying from a document.`);
  return n;
}
const ENVS: readonly AccountEnvironment[] = ["PRD", "STG", "DEV"];
const CHANNELS: readonly VerifyChannel[] = ["EMAIL", "SMS", "SLACK"];

/** Step 1. `loginDomains` is the text the user typed (commas, spaces or lines); it is cleaned here and checked again by the API (400 / 422 / 409). */
export async function createCustomerAction(input: { name: string; loginDomains?: string }): Promise<ActionResult<CustomerRecord>> {
  return run("ADMIN", async () => {
    const name = assertName(input?.name, "customer name");
    const parsed = parseLoginDomains(typeof input?.loginDomains === "string" ? input.loginDomains : "");
    if (!parsed.ok) throw new InvalidInputError(parsed.message);
    return (await getApi()).createCustomer({ name, ...(parsed.domains.length ? { loginDomains: parsed.domains } : {}) });
  });
}

/** Step 2: one project, optionally with one service. A service that fails leaves the project in place (the result says so by the failure of the second call). */
export async function createProjectAction(customerId: string, name: string): Promise<ActionResult<ProjectRecord>> {
  return run("ADMIN", async () => (await getApi()).createProject(assertId(customerId, "customer"), { name: assertName(name, "project name") }));
}
export async function createServiceAction(projectId: string, name: string): Promise<ActionResult<ServiceRecord>> {
  return run("ADMIN", async () => (await getApi()).createService(assertId(projectId, "project"), { name: assertName(name, "service name") }));
}

export interface AccountForm extends Partial<AccountCapabilities> { awsAccountId: string; alias?: string; environment?: string; serviceId?: string }
/** Step 3. 12 digits as text; the ExternalId and the role ARNs are made by the server and come back in the answer. */
export async function createAccountAction(customerId: string, form: AccountForm): Promise<ActionResult<AccountRecord>> {
  return run("ADMIN", async () => {
    const id = assertId(customerId, "customer");
    const awsAccountId = typeof form?.awsAccountId === "string" ? form.awsAccountId.replace(/[\s-]/g, "") : "";
    if (!/^[0-9]{12}$/.test(awsAccountId)) throw new InvalidInputError("An AWS account id is exactly 12 digits.");
    const alias = typeof form.alias === "string" ? form.alias.trim() : "";
    if (alias.length > 80) throw new InvalidInputError("The alias is at most 80 characters.");
    if (form.environment !== undefined && form.environment !== "" && !ENVS.includes(form.environment as AccountEnvironment)) throw new InvalidInputError("Choose PRD, STG or DEV.");
    for (const k of ["alarmWriterEnabled", "tagWriterEnabled", "remediatorEnabled"] as const) if (form[k] !== undefined && typeof form[k] !== "boolean") throw new InvalidInputError("Invalid capability.");
    return (await getApi()).createAccount(id, {
      awsAccountId,
      ...(alias ? { alias } : {}),
      ...(form.environment ? { environment: form.environment as AccountEnvironment } : {}),
      ...(form.serviceId ? { serviceId: assertId(form.serviceId, "service") } : {}),
      alarmWriterEnabled: form.alarmWriterEnabled === true, tagWriterEnabled: form.tagWriterEnabled === true, remediatorEnabled: form.remediatorEnabled === true,
    });
  });
}
export async function listAccountsAction(customerId: string): Promise<ActionResult<AccountRecord[]>> {
  return run("ADMIN", async () => (await getApi()).listAccounts(assertId(customerId, "customer")), false);
}
/** Turn one capability on or off. The stack parameter has to change in the customer's account too (the kit says so). */
export async function setCapabilityAction(accountId: string, key: keyof AccountCapabilities, on: boolean): Promise<ActionResult<AccountRecord>> {
  return run("ADMIN", async () => {
    const id = assertId(accountId, "account");
    if (key !== "alarmWriterEnabled" && key !== "tagWriterEnabled" && key !== "remediatorEnabled") throw new InvalidInputError("Invalid capability.");
    if (typeof on !== "boolean") throw new InvalidInputError("Invalid value.");
    return (await getApi()).patchAccount(id, { [key]: on });
  });
}

/** Queue a connection check (202). The result is read with `accountStatusAction` until `lastCheckedAt` changes. */
export async function checkAccountAction(accountId: string): Promise<ActionResult<{ commandId: string }>> {
  return run("ADMIN", async () => (await getApi()).checkAccount(assertId(accountId, "account")), false);
}
export async function accountStatusAction(accountId: string): Promise<ActionResult<AccountStatus>> {
  return run("VIEWER", async () => (await getApi()).getAccountStatus(assertId(accountId, "account")), false);
}

/** Step 5: a customer person. Values go to the API once; the list that comes back has only masked values. */
export async function createContactAction(customerId: string, input: { name: string; email?: string; phone?: string }): Promise<ActionResult<ContactRecord>> {
  return run("ADMIN", async () => {
    const id = assertId(customerId, "customer");
    const name = assertName(input?.name, "name");
    const email = typeof input?.email === "string" ? input.email.trim() : "";
    const phone = typeof input?.phone === "string" ? input.phone.trim() : "";
    if (!email && !phone) throw new InvalidInputError("Give an e-mail address or a phone number.");
    if (email.length > 254 || phone.length > 30) throw new InvalidInputError("That value is too long.");
    return (await getApi()).createContact({ customerId: id, name, ...(email ? { email } : {}), ...(phone ? { phone } : {}) });
  });
}
export async function listContactsAction(customerId: string): Promise<ActionResult<ContactRecord[]>> {
  return run("ADMIN", async () => (await (await getApi()).listContacts({ customerId: assertId(customerId, "customer") })).items, false);
}
/** `method: "link"` needs a sender: 503 VERIFICATION_UNAVAILABLE / NOT_CONFIGURED -> the page offers manual. Manual needs a note of how it was checked. */
export async function verifyContactAction(contactId: string, channel: VerifyChannel, method: "link" | "manual", note?: string): Promise<ActionResult<VerifyContactResult>> {
  return run("ADMIN", async () => {
    const id = assertId(contactId, "contact");
    if (!CHANNELS.includes(channel)) throw new InvalidInputError("Invalid channel.");
    if (method !== "link" && method !== "manual") throw new InvalidInputError("Invalid method.");
    const n = typeof note === "string" ? note.trim() : "";
    if (n.length > 300) throw new InvalidInputError("The note is at most 300 characters.");
    // Marking a channel verified by hand is a statement that someone checked it: the note says how. The API does not require
    // it yet (backend follow-up), so the console does.
    if (method === "manual" && n.length < 5) throw new InvalidInputError("Say how you checked it, in at least 5 characters (for example “Confirmed by phone with the person”).");
    if (HIDDEN_CHARS.test(n)) throw new InvalidInputError("The note has characters that cannot be seen.");
    return (await getApi()).verifyContact(id, { channel, method, ...(n ? { note: n } : {}) });
  });
}
/** "Send links to everyone who needs it": the page shows the target list and asks first; this only sends what it was given. */
export async function verifyBulkAction(contactIds: string[]): Promise<ActionResult<VerifyBulkResult>> {
  return run("ADMIN", async () => {
    if (!Array.isArray(contactIds) || contactIds.length === 0 || contactIds.length > 200) throw new InvalidInputError("Choose 1 to 200 people.");
    return (await getApi()).verifyBulk(contactIds.map((c) => assertId(c, "contact")));
  });
}
