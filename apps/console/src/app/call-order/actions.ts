"use server";
import { revalidatePath } from "next/cache";
import { getApi } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import { requireSession } from "@/lib/auth";
import { assertId, assertVersion, InvalidInputError } from "@/lib/validate";
import { assertAddResponder, assertPagingInput, assertReachable, assertRole, assertScope } from "@/lib/call-order/input";
import { levelOf, type CoScope, type Directory } from "@/lib/call-order/model";
import { fail, type ActionResult } from "@/lib/action-result";

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireSession();
    const data = await fn();
    revalidatePath("/", "layout"); // the tree (OWN STEPS, call health), the list and the panel all show this
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

/**
 * The scope arrives as slugs — the same ones that are in the panel's address — and is resolved to ids here, inside
 * what this user may see (GET /scope-tree). A slug that does not resolve is the same Not found as anywhere else.
 */
async function resolve(scope: CoScope) {
  const api = await getApi();
  const c = (await api.scopeTree()).customers.find((x) => x.slug === scope.customer);
  const p = scope.project ? c?.projects.find((x) => x.slug === scope.project) : undefined;
  const s = scope.service ? p?.services.find((x) => x.slug === scope.service) : undefined;
  if (!c || (scope.project && !p) || (scope.service && !s)) throw new ApiError(404, "NOT_FOUND", "Not found.", "");
  return { api, customerId: c.id, customerName: c.name, level: levelOf(scope), scopeId: s?.id ?? p?.id ?? c.id };
}

/**
 * Saves the steps of exactly one level. `version` is the If-Match the editor started from (409 VERSION_CONFLICT when
 * someone saved meanwhile); 0 creates the steps of a level that has none (answered 201).
 * Checked as strictly as the editor checks (security review 권고 4): shape and limits first, then — against the
 * customer's Responders and rotations as they are now — that every target exists and somebody is reached.
 */
export async function saveCallOrder(scope: CoScope, body: unknown, version: number): Promise<ActionResult<{ version: number }>> {
  return run(async () => {
    const sc = assertScope(scope);
    const input = assertPagingInput(body);
    const v = assertVersion(version);
    const { api, customerId, customerName, level, scopeId } = await resolve(sc);
    const [responders, rotations, allStaff] = await Promise.all([api.getResponders(customerId), api.listRotations({ customerId }), api.listStaff()]);
    const dir: Directory = { customerName, staff: responders.staff, people: responders.people, rotations, allStaff, slackChannel: responders.slackChannel };
    assertReachable(input, dir);
    if (level === "CUSTOMER") return { version: (await api.putPaging(customerId, input, v)).version };
    return { version: (await api.putPagingOverride(customerId, level, scopeId, input, v)).version };
  });
}

/** Removes the own steps of a project or service; it follows the level above again. */
export async function removeOwnSteps(scope: CoScope, version: number): Promise<ActionResult<null>> {
  return run(async () => {
    const sc = assertScope(scope);
    const v = assertVersion(version);
    const { api, customerId, level, scopeId } = await resolve(sc);
    if (level === "CUSTOMER") throw new InvalidInputError("A customer always has steps.");
    await api.deletePagingOverride(customerId, level, scopeId, v);
    return null;
  });
}

/**
 * Responders writes. `version` is the version of the Responders list the user was looking at (If-Match): when someone
 * else changed the list meanwhile the answer is 409 VERSION_CONFLICT and nothing is changed (security review 권고 2).
 * `confirmUnreachable` is sent only after the user was told, in the confirmation, that the change leaves nobody reachable.
 */
export async function addResponder(customer: string, input: unknown, version: number): Promise<ActionResult<{ contactId: string; version: number }>> {
  return run(async () => {
    const body = assertAddResponder(input);
    const v = assertVersion(version);
    const { api, customerId } = await resolve(assertScope({ customer }));
    const r = await api.addResponder(customerId, body, { version: v });
    return { contactId: r.contactId, version: r.version };
  });
}
export async function setResponderRole(customer: string, contactId: string, role: unknown, version: number, confirmUnreachable = false): Promise<ActionResult<{ version: number }>> {
  return run(async () => {
    const [id, r, v] = [assertId(contactId, "contactId"), assertRole(role), assertVersion(version)];
    const { api, customerId } = await resolve(assertScope({ customer }));
    return { version: (await api.patchResponder(customerId, id, { role: r }, { version: v, confirmUnreachable: confirmUnreachable === true })).version };
  });
}
export async function removeResponder(customer: string, contactId: string, version: number, confirmUnreachable = false): Promise<ActionResult<{ version: number }>> {
  return run(async () => {
    const [id, v] = [assertId(contactId, "contactId"), assertVersion(version)];
    const { api, customerId } = await resolve(assertScope({ customer }));
    return { version: (await api.removeResponder(customerId, id, { version: v, confirmUnreachable: confirmUnreachable === true })).version };
  });
}
