import "server-only";
import { getApi } from "../api";
import type { Role } from "../api/types";
import { roleAtLeast } from "../roles";

/** Refused by the console before the API is asked to change anything. Worded like the API's own 403 (lib/errors.ts). */
export class RoleRequiredError extends Error {
  readonly code = "ROLE_REQUIRED";
  readonly details: { role: Role };
  constructor(min: Role) {
    super(`This action needs the ${min} role.`);
    this.name = "RoleRequiredError";
    this.details = { role: min };
  }
}

/**
 * Defence in depth (security 재검토 권고 2): a server action that writes asks who the session's user is (GET /me) and
 * stops here when the role is too low — before input is looked at, so the answer does not tell whether an id exists.
 * The API stays the authority: it checks the role again on the write itself, and what it answers wins.
 * Needs a session (getApi requires one); if /me cannot be read, nothing is let through.
 */
export async function requireRole(min: Role): Promise<void> {
  const me = await (await getApi()).me();
  if (!roleAtLeast(me.role, min)) throw new RoleRequiredError(min);
}
