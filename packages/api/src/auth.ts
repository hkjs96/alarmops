/**
 * Authorization context and tenant scope (API-CONTRACT §2 "범위", §8.0 tenant rules; DATA-MODEL §0).
 * The adapter resolves the session (Google SSO etc.) into an AuthContext; this package never talks to an auth provider.
 */
import { isRecord, roleRequired, unauthenticated, type ApiRequest } from './http.js';

export type Role = 'VIEWER' | 'OPERATOR' | 'ADMIN';

export interface AuthContext {
  userId: string;
  /** Display name for timeline/audit wording. */
  name?: string;
  /** INTERNAL = MSP staff, CUSTOMER = portal user of a customer. */
  kind: 'INTERNAL' | 'CUSTOMER';
  /**
   * Customers this user may see. INTERNAL staff: '*' (all customers — `mine` is a filter, not a permission, D-34)
   * or an explicit list. CUSTOMER users: their customer(s); '*' is never honoured for them.
   */
  customerIds: readonly string[] | '*';
  role: Role;
  /**
   * Optional narrowing inside a customer (ContactScope PROJECT/SERVICE users, §8.0 rule 1): when a customer has
   * entries here, only those subtrees are visible.
   */
  subScopes?: ReadonlyArray<{ customerId: string; projectId?: string; serviceId?: string }>;
}

/** What every repository query receives. The repository must put it INSIDE the query (never fetch-then-compare, §2). */
export interface ScopeFilter {
  customerIds: readonly string[] | '*';
  /** Unmapped-account data (customerId null). INTERNAL users with the full range only (security R-2). */
  unmapped: boolean;
  subScopes: ReadonlyArray<{ customerId: string; projectId?: string; serviceId?: string }>;
}

/** Fail closed: anything unexpected yields the empty scope (known-bugs 8-4). */
export function scopeOf(auth: AuthContext): ScopeFilter {
  const subScopes = auth.subScopes ?? [];
  if (auth.kind === 'INTERNAL') {
    if (auth.customerIds === '*') return { customerIds: '*', unmapped: true, subScopes };
    return { customerIds: Array.isArray(auth.customerIds) ? [...auth.customerIds] : [], unmapped: false, subScopes };
  }
  return { customerIds: Array.isArray(auth.customerIds) ? [...auth.customerIds] : [], unmapped: false, subScopes };
}

export const seesCustomer = (s: ScopeFilter, customerId: string): boolean => s.customerIds === '*' || s.customerIds.includes(customerId);

/**
 * Does the scope cover the WHOLE customer (not just some project/service of it)? Customer-level settings — the
 * customer's own call order — exist only for these users; for a narrowed user they are "not found" (R-6).
 */
export const customerWide = (s: ScopeFilter, customerId: string): boolean => {
  if (!seesCustomer(s, customerId)) return false;
  const subs = s.subScopes.filter((x) => x.customerId === customerId);
  return subs.length === 0 || subs.some((x) => !x.projectId && !x.serviceId);
};

/** Is an entity at (customer, project?, service?) inside the scope? null customer = unmapped. */
export function inScope(s: ScopeFilter, e: { customerId: string | null; projectId?: string | null; serviceId?: string | null }): boolean {
  if (e.customerId == null) return s.unmapped;
  if (!seesCustomer(s, e.customerId)) return false;
  const subs = s.subScopes.filter((x) => x.customerId === e.customerId);
  if (subs.length === 0) return true;
  return subs.some((x) => (x.serviceId ? x.serviceId === e.serviceId : x.projectId ? x.projectId === e.projectId : true));
}

/** Can the scope see this tree node (a node is visible when it is, contains, or is contained in a granted subtree)? */
export function nodeVisible(s: ScopeFilter, n: { customerId: string; projectId?: string; serviceId?: string }, serviceProject?: (serviceId: string) => string | undefined): boolean {
  if (!seesCustomer(s, n.customerId)) return false;
  const subs = s.subScopes.filter((x) => x.customerId === n.customerId);
  if (subs.length === 0) return true;
  return subs.some((x) => {
    const xProject = x.projectId ?? (x.serviceId ? serviceProject?.(x.serviceId) : undefined);
    if (!x.projectId && !x.serviceId) return true;
    if (!n.projectId) return true; // the customer node itself, as the parent of a granted subtree
    if (n.serviceId) return x.serviceId ? x.serviceId === n.serviceId : xProject === n.projectId;
    return xProject === n.projectId;
  });
}

const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const ROLES: readonly Role[] = ['VIEWER', 'OPERATOR', 'ADMIN'];
/** Own data property only — never a getter, never something inherited (R-16). */
const own = (o: object, k: string): unknown => {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d && 'value' in d ? d.value : undefined;
};
const nullProto = <T extends object>(fields: T): T => Object.freeze(Object.assign(Object.create(null) as T, fields));

/**
 * The AuthContext this package works with, rebuilt field by field from what the session adapter handed over
 * (B-1, R-16, N-15), or null = "not signed in".
 * - Only OWN data properties are read: a polluted `Object.prototype.role` / `.kind` / `.customerIds` gives nothing.
 * - Exact primitive types: `userId`, `kind` and every id are primitive strings (no String objects, no arrays, no
 *   objects with toString); `role` counts only when it is exactly 'VIEWER' | 'OPERATOR' | 'ADMIN' — anything else
 *   is left out, so the user reads as the scope allows and every write answers 403.
 * - `subScopes` may only narrow customers the user has: an entry for a customer that is not in `customerIds`
 *   (wrong case, typo, another tenant) used to be ignored — which WIDENED the view to the whole customer. It is 401 now.
 * - The result is a frozen copy on a null prototype: later mutation of the adapter's object, or of
 *   Object.prototype, cannot change what was checked.
 */
export function normalizeAuth(a: unknown): AuthContext | null {
  if (!isRecord(a)) return null;
  const userId = own(a, 'userId');
  const kind = own(a, 'kind');
  const name = own(a, 'name');
  const rawIds = own(a, 'customerIds');
  const rawSubs = own(a, 'subScopes');
  const role = own(a, 'role');
  if (!isStr(userId)) return null;
  if (kind !== 'INTERNAL' && kind !== 'CUSTOMER') return null;
  if (name !== undefined && typeof name !== 'string') return null;
  let customerIds: readonly string[] | '*';
  if (rawIds === '*') customerIds = '*';
  else if (Array.isArray(rawIds) && rawIds.every(isStr)) customerIds = Object.freeze([...rawIds]);
  else return null;
  let subScopes: AuthContext['subScopes'];
  if (rawSubs !== undefined) {
    if (!Array.isArray(rawSubs)) return null;
    const list: Array<{ customerId: string; projectId?: string; serviceId?: string }> = [];
    for (const x of rawSubs) {
      if (!isRecord(x)) return null;
      const customerId = own(x, 'customerId');
      const projectId = own(x, 'projectId');
      const serviceId = own(x, 'serviceId');
      if (!isStr(customerId) || (projectId !== undefined && !isStr(projectId)) || (serviceId !== undefined && !isStr(serviceId))) return null;
      // N-15: a narrowing for a customer the user does not have. '*' is honoured for INTERNAL staff only.
      const has = customerIds === '*' ? kind === 'INTERNAL' : customerIds.includes(customerId);
      if (!has) return null;
      list.push(nullProto({ customerId, ...(projectId !== undefined ? { projectId } : {}), ...(serviceId !== undefined ? { serviceId } : {}) }));
    }
    subScopes = Object.freeze(list);
  }
  return nullProto({
    userId, kind, customerIds,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof role === 'string' && (ROLES as readonly string[]).includes(role) ? { role: role as Role } : {}),
    ...(subScopes ? { subScopes } : {}),
  }) as AuthContext;
}

/**
 * Shape check of what the session adapter handed over (security B-1). Anything this package does not expect is
 * "not signed in": a missing or unknown `kind`, a `customerIds` that is neither '*' nor a list of ids, a broken
 * `subScopes`. `role` is deliberately NOT required here — without a valid role the user can still read (as the
 * scope allows) and every write answers 403 (requireRole).
 */
export function isAuthContext(a: unknown): a is AuthContext {
  return normalizeAuth(a) !== null;
}

/** Always the normalised copy (see normalizeAuth) — handlers never touch the adapter's object. */
export function requireAuth(req: ApiRequest): AuthContext {
  const auth = normalizeAuth(req.auth);
  if (!auth) throw unauthenticated();
  return auth;
}

/**
 * Role check for a write on a target the caller CAN see (403 is only ever used there, §2).
 * Call it after the scoped lookup so out-of-scope targets have already answered 404.
 * Portal (CUSTOMER) users are VIEWER whatever their stored role says (org-tenant R4-3).
 */
export function requireRole(auth: AuthContext, min: Role): void {
  // Fail closed (B-1): the stored role counts for INTERNAL staff only; every other kind — including a kind this
  // code does not know — is VIEWER. Own-property lookup, so 'constructor' and friends are not roles.
  if (!hasRole(auth, min)) throw roleRequired(min);
}

/**
 * The role that counts: the stored one for INTERNAL staff when it is an own, primitive, known role; VIEWER for
 * every other kind; null (no role at all — not even VIEWER-gated actions) for INTERNAL staff without a valid role.
 */
export function effectiveRole(auth: { kind: unknown; role?: unknown }): Role | null {
  if (auth.kind !== 'INTERNAL') return 'VIEWER';
  const role: unknown = Object.hasOwn(auth, 'role') ? auth.role : undefined;
  return typeof role === 'string' && (ROLES as readonly string[]).includes(role) ? (role as Role) : null;
}
export const hasRole = (auth: { kind: unknown; role?: unknown }, min: Role): boolean => {
  const role = effectiveRole(auth);
  return role !== null && RANK[role] >= RANK[min];
};

/** Stable identity of the caller's range, for ETags that must differ between users (§8.0 rule 5). */
export const scopeKey = (auth: AuthContext): string =>
  JSON.stringify([auth.userId, auth.kind, auth.role, auth.customerIds === '*' ? '*' : [...auth.customerIds].sort(), (auth.subScopes ?? []).map((x) => [x.customerId, x.projectId ?? '', x.serviceId ?? ''])]);
