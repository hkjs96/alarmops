/**
 * API-CONTRACT §8.4 users (hkjs96/alarmops#69, D-55). ADMIN with the all-customer range only; portal users never see these routes (404).
 *   GET   /users              list (filters kind, customerId, status, role, q) — e-mail masked, like contacts
 *   POST  /users              create: INTERNAL (MSP staff: ADMIN | OPERATOR | VIEWER, all customers) or CUSTOMER (portal user of exactly one customer, VIEWER)
 *   GET   /users/{id}
 *   PATCH /users/{id}         role | status (ACTIVE | DISABLED) | customerId (portal users) | clearGoogleSub
 * Rules the store enforces atomically: e-mail unique (case-insensitive, stored lower-case); never demote / disable the last ACTIVE ADMIN
 * (409 LAST_ADMIN). Rules here: nobody changes their own role, status or Google binding (403 FORBIDDEN). Users are never deleted (their
 * id is in audit rows and reveal logs): DISABLED is the end state. No e-mail address is written to an audit row or a log; the response
 * carries `emailMasked` only.
 */
import { requireAuth, requireRole, type AuthContext, type Role } from './auth.js';
import { ApiError, invalid, isRecord, notFound, ok, q, validation, withoutUndefined, type ApiRequest, type ApiResponse } from './http.js';
import { maskEmail } from './peopleApi.js';
import type { ApiRepository, UserFilter, UserPatch, UserRecord, UserStatusValue } from './repo.js';

interface Deps { repo: ApiRepository; now: () => Date }

const ROLES: readonly Role[] = ['VIEWER', 'OPERATOR', 'ADMIN'];
const STATUSES: readonly UserStatusValue[] = ['PENDING', 'ACTIVE', 'DISABLED'];
const NAME_MAX = 80;
const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Trimmed, lower-case address, or null when it is not a plausible address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}
export const emailDomain = (email: string): string => email.slice(email.lastIndexOf('@') + 1);

/** Only the MSP ADMIN with the all-customer range; for everybody else the route does not exist or is forbidden (portal 404, other staff 403). */
function adminAll(req: ApiRequest): AuthContext {
  const auth = requireAuth(req);
  if (auth.kind !== 'INTERNAL') throw notFound();
  requireRole(auth, 'ADMIN');
  if (auth.customerIds !== '*') throw new ApiError(403, 'FORBIDDEN', 'Managing users needs access to all customers.');
  return auth;
}

export function userView(u: UserRecord) {
  return {
    id: u.id, name: u.name, kind: u.kind, customerId: u.customerId,
    role: u.kind === 'CUSTOMER' ? 'VIEWER' : u.role, status: u.status, emailMasked: maskEmail(u.email) ?? '', googleBound: u.googleBound,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null, createdAt: u.createdAt.toISOString(),
  };
}

export async function listUsers(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  adminAll(req);
  const f: UserFilter = {};
  const kind = q(req, 'kind'); if (kind !== undefined) { if (kind !== 'INTERNAL' && kind !== 'CUSTOMER') throw invalid('kind', 'kind is INTERNAL or CUSTOMER.'); f.kind = kind; }
  const status = q(req, 'status'); if (status !== undefined) { if (!(STATUSES as readonly string[]).includes(status)) throw invalid('status', 'Unknown status.'); f.status = status as UserStatusValue; }
  const role = q(req, 'role'); if (role !== undefined) { if (!(ROLES as readonly string[]).includes(role)) throw invalid('role', 'Unknown role.'); f.role = role as Role; }
  const customerId = q(req, 'customerId'); if (customerId !== undefined) f.customerId = customerId;
  const text = q(req, 'q'); if (text !== undefined) { if (text.length > 100) throw invalid('q', 'q is at most 100 characters.'); f.q = text; }
  return ok({ items: (await deps.repo.listUsers(f)).map(userView) });
}

export async function getUser(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  adminAll(req);
  const u = await deps.repo.findUser(id);
  if (!u) throw notFound();
  return ok(userView(u));
}

export async function createUser(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = adminAll(req);
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  const unknown = Object.keys(b).filter((k) => !['email', 'name', 'kind', 'role', 'customerId'].includes(k));
  if (unknown.length) throw validation(unknown.map((field) => ({ field, message: 'Not accepted here.' })));
  const email = normalizeEmail(b.email);
  if (!email) throw invalid('email', 'email must be a valid address.');
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > NAME_MAX || CONTROL.test(name)) throw invalid('name', `name is required (1-${NAME_MAX} characters).`);
  if (b.kind !== 'INTERNAL' && b.kind !== 'CUSTOMER') throw invalid('kind', 'kind is INTERNAL or CUSTOMER.');
  let role: Role;
  let customerId: string | null = null;
  if (b.kind === 'INTERNAL') {
    if (!(ROLES as readonly unknown[]).includes(b.role)) throw invalid('role', 'role is ADMIN, OPERATOR or VIEWER.');
    if (b.customerId !== undefined && b.customerId !== null) throw invalid('customerId', 'MSP staff see all customers; a customer range cannot be set.');
    role = b.role as Role;
  } else {
    if (b.role !== undefined && b.role !== 'VIEWER') throw invalid('role', 'Portal users are always VIEWER.');
    if (typeof b.customerId !== 'string' || !b.customerId) throw invalid('customerId', 'A portal user belongs to exactly one customer: customerId is required.');
    role = 'VIEWER';
    customerId = b.customerId;
  }
  const r = await deps.repo.createUser({ email, name, customerId, role, status: 'ACTIVE' }, {
    at: deps.now(), actorType: 'USER', actorId: auth.userId, action: 'user.create', targetType: 'User', before: null,
    after: { kind: b.kind, role, status: 'ACTIVE', customerId }, requestId: req.requestId,
  });
  if (r === 'EMAIL_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'A user with this e-mail already exists.');
  if (r === 'NO_SUCH_CUSTOMER') throw invalid('customerId', 'No such customer.');
  return ok(userView(r), { location: `/api/v1/users/${r.id}` }, 201);
}

export async function patchUser(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const auth = adminAll(req);
  const cur = await deps.repo.findUser(id);
  if (!cur) throw notFound();
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  const unknown = Object.keys(b).filter((k) => !['role', 'status', 'customerId', 'clearGoogleSub'].includes(k));
  if (unknown.length) throw validation(unknown.map((field) => ({ field, message: 'Not accepted here.' })));
  if (Object.keys(b).length === 0) throw invalid('body', 'Nothing to change.');
  const patch: UserPatch = {};
  if ('role' in b) {
    if (!(ROLES as readonly unknown[]).includes(b.role)) throw invalid('role', 'role is ADMIN, OPERATOR or VIEWER.');
    if (cur.kind === 'CUSTOMER' && b.role !== 'VIEWER') throw invalid('role', 'Portal users are always VIEWER.');
    if (b.role !== cur.role) patch.role = b.role as Role;
  }
  if ('status' in b) {
    if (b.status !== 'ACTIVE' && b.status !== 'DISABLED') throw invalid('status', 'status is ACTIVE (activate) or DISABLED.');
    if (b.status !== cur.status) patch.status = b.status;
  }
  if ('customerId' in b) {
    if (cur.kind !== 'CUSTOMER') throw invalid('customerId', 'MSP staff see all customers; a customer range cannot be set.');
    if (typeof b.customerId !== 'string' || !b.customerId) throw invalid('customerId', 'customerId must be a customer id.');
    if (b.customerId !== cur.customerId) patch.customerId = b.customerId;
  }
  if ('clearGoogleSub' in b) {
    if (b.clearGoogleSub !== true) throw invalid('clearGoogleSub', 'clearGoogleSub can only be true.');
    if (cur.googleBound) patch.clearGoogleSub = true;
  }
  // Nobody changes their own role, disables themselves or resets their own Google binding (another ADMIN does).
  if (cur.id === auth.userId && (patch.role !== undefined || patch.status === 'DISABLED' || patch.clearGoogleSub)) throw new ApiError(403, 'FORBIDDEN', 'You cannot change your own role or status, or reset your own Google account.');
  if (Object.keys(patch).length === 0) return ok(userView(cur)); // nothing differs: no write, no audit row
  const before: Record<string, unknown> = {}; const after: Record<string, unknown> = {};
  if (patch.role) { before.role = cur.role; after.role = patch.role; }
  if (patch.status) { before.status = cur.status; after.status = patch.status; }
  if (patch.customerId) { before.customerId = cur.customerId; after.customerId = patch.customerId; }
  if (patch.clearGoogleSub) { before.googleBound = true; after.googleBound = false; }
  const r = await deps.repo.updateUser(id, patch, { at: deps.now(), actorType: 'USER', actorId: auth.userId, action: 'user.update', targetType: 'User', before, after, requestId: req.requestId });
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'LAST_ADMIN') throw new ApiError(409, 'LAST_ADMIN', 'This is the last active ADMIN with access to all customers. Make another ADMIN first.');
  if (r === 'NO_SUCH_CUSTOMER') throw invalid('customerId', 'No such customer.');
  if (r === 'CONTACT_LINKED') throw new ApiError(409, 'CONTACT_LINKED', 'This portal user is linked to a contact of the current customer; it cannot move to another customer.');
  if (r === 'EMAIL_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'Conflict.');
  return ok(userView(r));
}
