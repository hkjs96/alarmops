"use server";
import { revalidatePath } from "next/cache";
import { getApi } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { requireRole } from "@/lib/auth/role";
import { assertId, InvalidInputError } from "@/lib/validate";
import type { NewUserInput, UserItem, UserPatchInput } from "@/lib/api/types";
import { fail, type ActionResult } from "@/lib/action-result";
import { NAME_MAX, normalizeEmail } from "@/lib/users";

/**
 * Settings › Users writes (API-CONTRACT 8.4 #69, D-55): ADMIN only. Session first, then the role (a portal user and a
 * lower role are refused here, before input is looked at), then the input, then the API call. The API checks again —
 * all-customer ADMIN, your own account, the last admin, a linked contact — and what it answers wins.
 * Nothing here logs or returns an e-mail address: the answer carries the masked one.
 */
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireSession();
    await requireRole("ADMIN");
    const data = await fn();
    revalidatePath("/settings/users");
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

const ROLES = ["ADMIN", "OPERATOR", "VIEWER"] as const;
const isRole = (v: unknown): v is (typeof ROLES)[number] => typeof v === "string" && (ROLES as readonly string[]).includes(v);

/** POST /users. Staff: kind INTERNAL + role. Portal user: kind CUSTOMER + customerId (always read-only, no role is sent). */
export async function addUserAccount(input: NewUserInput): Promise<ActionResult<UserItem>> {
  return run(async () => {
    const o = (input ?? {}) as unknown as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !["email", "name", "kind", "role", "customerId"].includes(k));
    if (extra.length) throw new InvalidInputError("Invalid input.");
    const email = typeof o.email === "string" ? normalizeEmail(o.email) : null;
    if (!email) throw new InvalidInputError("Enter a valid e-mail address.");
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name || name.length > NAME_MAX) throw new InvalidInputError(`Enter a name of 1 to ${NAME_MAX} characters.`);
    if (o.kind === "INTERNAL") {
      if (!isRole(o.role)) throw new InvalidInputError("Choose a role: Admin, Operator or Viewer.");
      if (o.customerId !== undefined && o.customerId !== "") throw new InvalidInputError("Staff are not tied to a customer.");
      return (await getApi()).createUser({ email, name, kind: "INTERNAL", role: o.role });
    }
    if (o.kind === "CUSTOMER") {
      const customerId = assertId(o.customerId, "customer");
      if (o.role !== undefined && o.role !== "" && o.role !== "VIEWER") throw new InvalidInputError("Portal users are always read-only (Viewer).");
      return (await getApi()).createUser({ email, name, kind: "CUSTOMER", customerId });
    }
    throw new InvalidInputError("Choose staff or portal user.");
  });
}

/** PATCH /users/{id}: role, status (ACTIVE = enable, DISABLED = disable), customer (portal user), or clear the Google link. */
export async function changeUserAccount(userId: string, patch: UserPatchInput): Promise<ActionResult<UserItem>> {
  return run(async () => {
    const id = assertId(userId, "user");
    const o = (patch ?? {}) as unknown as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined);
    if (keys.length !== 1 || !["role", "status", "customerId", "clearGoogleSub"].includes(keys[0]!)) throw new InvalidInputError("Change one thing at a time.");
    const body: UserPatchInput = {};
    if (keys[0] === "role") { if (!isRole(o.role)) throw new InvalidInputError("Choose a role: Admin, Operator or Viewer."); body.role = o.role; }
    else if (keys[0] === "status") { if (o.status !== "ACTIVE" && o.status !== "DISABLED") throw new InvalidInputError("Status is Active or Disabled."); body.status = o.status; }
    else if (keys[0] === "customerId") body.customerId = assertId(o.customerId, "customer");
    else { if (o.clearGoogleSub !== true) throw new InvalidInputError("Invalid input."); body.clearGoogleSub = true; }
    return (await getApi()).patchUser(id, body);
  });
}
