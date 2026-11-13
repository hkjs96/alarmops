"use server";
import { revalidatePath } from "next/cache";
import { getApi } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { requireRole } from "@/lib/auth/role";
import { assertId, assertVersion, InvalidInputError } from "@/lib/validate";
import type { CustomerStatusChange, CustomerStatusInput, CustomerStatusValue, Offboarding, OffboardStepKey } from "@/lib/api/types";
import { fail, type ActionResult } from "@/lib/action-result";

/**
 * Customer status and offboarding (API-CONTRACT 8.4, D-43): ADMIN only. Session first, then the role, then input, then
 * the API call. The API checks the role again on the write and stays the authority.
 */
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireSession();
    await requireRole("ADMIN");
    const data = await fn();
    revalidatePath("/", "layout"); // the tree's tag, the list, the header and the incidents' markers
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

const STATUSES: readonly CustomerStatusValue[] = ["ACTIVE", "SUSPENDED", "TERMINATED"];
const STEPS: readonly OffboardStepKey[] = ["PAGING_STOPPED", "ALARMS_DELETED", "CUSTOMER_STACK_REMOVED", "ACCOUNTS_DISABLED", "BUS_ALLOWLIST_REMOVED"];

/**
 * Suspend, resume or terminate. `version` is the If-Match the page was rendered with (409 VERSION_CONFLICT when someone
 * else changed the status). A termination needs `confirmName`, the exact customer name; the API checks it, the dialog
 * checks it first. 503 COMMANDS_UNAVAILABLE means nothing was changed.
 */
export async function changeCustomerStatus(customerId: string, input: CustomerStatusInput, version: number): Promise<ActionResult<CustomerStatusChange>> {
  return run(async () => {
    const id = assertId(customerId, "customer");
    const v = assertVersion(version);
    if (!input || typeof input !== "object" || !STATUSES.includes(input.status)) throw new InvalidInputError("Invalid status.");
    if (typeof input.reason !== "string" || input.reason.length > 2000) throw new InvalidInputError("Invalid reason.");
    if (input.confirmName !== undefined && (typeof input.confirmName !== "string" || input.confirmName.length > 300)) throw new InvalidInputError("Invalid name.");
    const body: CustomerStatusInput = { status: input.status, reason: input.reason, ...(input.confirmName !== undefined ? { confirmName: input.confirmName } : {}) };
    return (await getApi()).patchCustomerStatus(id, body, v);
  });
}

/** A person marks a step of the offboarding checklist done. ALARMS_DELETED needs a note of what was checked. */
export async function markOffboardingStep(customerId: string, key: OffboardStepKey, detail?: string): Promise<ActionResult<Offboarding>> {
  return run(async () => {
    const id = assertId(customerId, "customer");
    if (!STEPS.includes(key)) throw new InvalidInputError("Invalid step.");
    if (detail !== undefined && (typeof detail !== "string" || detail.length > 2000)) throw new InvalidInputError("Invalid note.");
    const note = detail?.trim();
    return (await getApi()).markOffboardStep(id, { key, state: "DONE", ...(note ? { detail: note } : {}) });
  });
}
