"use server";
import { revalidatePath } from "next/cache";
import { getApi } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import { requireSession, UnauthorizedError } from "@/lib/auth";
import { NotConfiguredError } from "@/lib/mode";
import { assertId, assertVersion, InvalidInputError } from "@/lib/validate";
import { assertAddResponder, assertPagingInput, assertRole, assertScope } from "@/lib/call-order/input";
import { levelOf, type CoScope } from "@/lib/call-order/model";
import type { ActionResult } from "../incidents/actions";

function fail(e: unknown): { ok: false; code: string; message: string; requestId: string } {
  if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message, requestId: e.requestId };
  if (e instanceof UnauthorizedError || e instanceof InvalidInputError || e instanceof NotConfiguredError) return { ok: false, code: e.code, message: e.message, requestId: "" };
  return { ok: false, code: "UNKNOWN", message: "Something went wrong.", requestId: "" };
}
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
  return { api, customerId: c.id, level: levelOf(scope), scopeId: s?.id ?? p?.id ?? c.id };
}

/**
 * Saves the steps of exactly one level. `version` is the If-Match the editor started from (409 VERSION_CONFLICT when
 * someone saved meanwhile); null creates own steps for a project or service that had none.
 */
export async function saveCallOrder(scope: CoScope, body: unknown, version: number | null): Promise<ActionResult<{ version: number }>> {
  return run(async () => {
    const sc = assertScope(scope);
    const input = assertPagingInput(body);
    const v = version === null ? null : assertVersion(version);
    const { api, customerId, level, scopeId } = await resolve(sc);
    if (level === "CUSTOMER") {
      if (v === null) throw new InvalidInputError("Invalid version.");
      return { version: (await api.putPaging(customerId, input, v)).version };
    }
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

export async function addResponder(customer: string, input: unknown): Promise<ActionResult<{ contactId: string }>> {
  return run(async () => {
    const body = assertAddResponder(input);
    const { api, customerId } = await resolve(assertScope({ customer }));
    return api.addResponder(customerId, body);
  });
}
export async function setResponderRole(customer: string, contactId: string, role: unknown): Promise<ActionResult<null>> {
  return run(async () => {
    const [id, r] = [assertId(contactId, "contactId"), assertRole(role)];
    const { api, customerId } = await resolve(assertScope({ customer }));
    await api.patchResponder(customerId, id, { role: r });
    return null;
  });
}
export async function removeResponder(customer: string, contactId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const id = assertId(contactId, "contactId");
    const { api, customerId } = await resolve(assertScope({ customer }));
    await api.removeResponder(customerId, id);
    return null;
  });
}
