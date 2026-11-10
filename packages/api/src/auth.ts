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

/**
 * Shape check of what the session adapter handed over (security B-1). Anything this package does not expect is
 * "not signed in": a missing or unknown `kind`, a `customerIds` that is neither '*' nor a list of ids, a broken
 * `subScopes`. `role` is deliberately NOT required here — without a valid role the user can still read (as the
 * scope allows) and every write answers 403 (requireRole).
 */
export function isAuthContext(a: unknown): a is AuthContext {
  if (!isRecord(a) || !isStr(a.userId)) return false;
  if (a.kind !== 'INTERNAL' && a.kind !== 'CUSTOMER') return false;
  if (a.name !== undefined && typeof a.name !== 'string') return false;
  if (!(a.customerIds === '*' || (Array.isArray(a.customerIds) && a.customerIds.every(isStr)))) return false;
  if (a.subScopes !== undefined) {
    const ok = Array.isArray(a.subScopes) && a.subScopes.every((x) => isRecord(x) && isStr(x.customerId)
      && (x.projectId === undefined || isStr(x.projectId)) && (x.serviceId === undefined || isStr(x.serviceId)));
    if (!ok) return false;
  }
  return true;
}

export function requireAuth(req: ApiRequest): AuthContext {
  if (!isAuthContext(req.auth)) throw unauthenticated();
  return req.auth;
}

/**
 * Role check for a write on a target the caller CAN see (403 is only ever used there, §2).
 * Call it after the scoped lookup so out-of-scope targets have already answered 404.
 * Portal (CUSTOMER) users are VIEWER whatever their stored role says (org-tenant R4-3).
 */
export function requireRole(auth: AuthContext, min: Role): void {
  // Fail closed (B-1): the stored role counts for INTERNAL staff only; every other kind — including a kind this
  // code does not know — is VIEWER. Own-property lookup, so 'constructor' and friends are not roles.
  const effective: Role = auth.kind === 'INTERNAL' ? auth.role : 'VIEWER';
  if (!Object.hasOwn(RANK, effective) || RANK[effective] < RANK[min]) throw roleRequired(min);
}

/** Stable identity of the caller's range, for ETags that must differ between users (§8.0 rule 5). */
export const scopeKey = (auth: AuthContext): string =>
  JSON.stringify([auth.userId, auth.kind, auth.role, auth.customerIds === '*' ? '*' : [...auth.customerIds].sort(), (auth.subScopes ?? []).map((x) => [x.customerId, x.projectId ?? '', x.serviceId ?? ''])]);
