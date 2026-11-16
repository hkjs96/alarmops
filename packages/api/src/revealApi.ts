/**
 * D-35 contact reveal: POST /contacts/{id}/reveal and GET /contact-reveals (API-CONTRACT §8.4).
 *
 * Order of every reveal (security: the value is the last thing to leave, and only after the log row is committed):
 *   1. out of scope (no such contact / not this portal user's customer / not a customer the caller sees whole) → the one 404;
 *   2. body check (400), then WHO MAY: `revealStanding` — the single place that decides NORMAL / EMERGENCY / refused;
 *   3. an EMERGENCY reveal needs a typed reason (422, no value);
 *   4. the value exists for that channel (422, nothing is logged for a reveal that shows nothing);
 *   5. `recordReveal`: ONE transaction counts the caller's rows (429), then writes ContactRevealLog + AuditLog.
 *      If this throws, the request ends 500 and the value was never put into a response.
 * The value is read from the contact only after step 3 and is never written to the log, the audit row or the idempotency store.
 */
import { pagingPath, type Contact } from '@alarmops/core';
import { customerWide, effectiveRole, hasRole, requireAuth, scopeOf, type AuthContext } from './auth.js';
import { ApiError, decodeCursor, encodeCursor, invalid, isCleanId, isIsoInstant, isRecord, limitOf, notFound, ok, q, rateLimited, roleRequired, type ApiRequest, type ApiResponse } from './http.js';
import type { ApiRepository, RevealChannelValue, RevealLimits, RevealModeValue } from './repo.js';
import { SLUG_PATTERN } from './slug.js';

interface Deps { repo: ApiRepository; now: () => Date; log?: (level: 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void }

/** API-CONTRACT §8.4 / Q-API-14: 30 reveals a minute, 10 emergency reveals an hour, per user. */
export const REVEAL_LIMITS: RevealLimits = { perMinute: 30, emergencyPerHour: 10 };
export const REASON_MAX = 500;

/**
 * PENDING USER DECISION (D-35 does not say): may a VIEWER who is a Responder of the customer open a value?
 * `false` = no, 403 ROLE_REQUIRED (nothing is logged). Flip this one constant to let them (they then reveal as NORMAL).
 * It also drives `canReveal` in the Responders list, so the button and the endpoint never disagree.
 */
export const VIEWER_RESPONDER_MAY_REVEAL = false;

export type RevealStanding = { mode: RevealModeValue } | { denied: 'NOT_A_RESPONDER' | 'ROLE_REQUIRED' };

/**
 * Who may open a contact (D-35), for a contact that is already in the caller's scope.
 * - portal user: NORMAL (scope already limited them to their own customer's people), never EMERGENCY;
 * - staff who is a Responder: NORMAL (a VIEWER only if `VIEWER_RESPONDER_MAY_REVEAL`, else ROLE_REQUIRED);
 * - staff ADMIN who is not: EMERGENCY, for a CUSTOMER contact only;
 * - everyone else: NOT_A_RESPONDER.
 * `isResponder` = Responder of the customer the contact belongs to (for an INTERNAL contact: of a customer both are Responder of).
 */
export function revealStanding(auth: AuthContext, isResponder: boolean, target: 'CUSTOMER' | 'INTERNAL'): RevealStanding {
  // Fail closed: requireAuth only lets INTERNAL | CUSTOMER through; anything else (a future kind) is refused here too.
  if ((auth.kind as string) !== 'INTERNAL' && (auth.kind as string) !== 'CUSTOMER') return { denied: 'NOT_A_RESPONDER' };
  if (auth.kind === 'CUSTOMER') return { mode: 'NORMAL' };
  const role = effectiveRole(auth) ?? 'VIEWER';
  if (isResponder) return role === 'VIEWER' && !VIEWER_RESPONDER_MAY_REVEAL ? { denied: 'ROLE_REQUIRED' } : { mode: 'NORMAL' };
  if (role === 'ADMIN' && target === 'CUSTOMER') return { mode: 'EMERGENCY' };
  return { denied: 'NOT_A_RESPONDER' };
}

/** `canReveal` / `revealRequiresReason` of the contract, from the same standing. */
export function revealFlags(auth: AuthContext, isResponder: boolean, target: 'CUSTOMER' | 'INTERNAL'): { canReveal: boolean; revealRequiresReason: boolean } {
  const s = revealStanding(auth, isResponder, target);
  return 'denied' in s ? { canReveal: false, revealRequiresReason: false } : { canReveal: true, revealRequiresReason: s.mode === 'EMERGENCY' };
}

/** `actorRole` of a portal user's reveal: not a console role, so a portal reveal is never shown as a staff VIEWER. */
export const PORTAL_ACTOR = 'PORTAL';

/** A refused attempt leaves a trace (who, which contact, which code) — never the value, never the reason text. */
function refused(deps: Deps, req: ApiRequest, auth: AuthContext, contactId: string, status: number, code: string): void {
  deps.log?.('warn', 'contact.reveal.refused', { requestId: req.requestId, userId: auth.userId, contactId, status, code });
}

const CHANNELS: readonly RevealChannelValue[] = ['PHONE', 'EMAIL', 'SLACK'];
const valueOf = (c: Contact, ch: RevealChannelValue): string | null => {
  const v = ch === 'PHONE' ? c.phone : ch === 'EMAIL' ? c.email : c.slackUserId;
  return typeof v === 'string' && v.length > 0 ? v : null;
};

/**
 * Q-API-14 (current handling). Who is told about an EMERGENCY reveal — INTERNAL, active contacts only, never the revealed
 * contact itself and never the caller, never a customer's person:
 *   1. the first such target of step 1 of the customer's own call order (a rotation: whoever is on shift now);
 *   2. else every other active ADMIN staff;
 *   3. else nobody: `[]`, which the list shows as `notifyStatus: 'NO_RECIPIENT'` (not to be read as "fine").
 * Recording only: nothing is delivered yet (hkjs96/alarmops#39).
 */
async function emergencyRecipients(deps: Deps, customerId: string, actorContactId: string | null, revealedContactId: string): Promise<string[]> {
  const skip = (id: string) => id === actorContactId || id === revealedContactId;
  const { configs, world } = await deps.repo.pagingContext(customerId);
  for (const id of pagingPath(configs, { customerId }, world, deps.now())?.steps[0]?.nowIds ?? []) {
    if (skip(id)) continue;
    const c = await deps.repo.getContact(id);
    if (c && c.kind === 'INTERNAL' && c.active) return [c.id];
  }
  return (await deps.repo.adminStaff()).map((a) => a.contactId).filter((id) => !skip(id));
}

export async function revealContact(req: ApiRequest, deps: Deps, contactId: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const contact = await deps.repo.getContact(contactId);

  // 1. scope first: the same 404 for "no such contact" and "not yours" (§2). Portal: only people of its own customer.
  // an inactive contact is gone for this purpose: the same 404 (NORMAL and EMERGENCY alike)
  if (!contact || !contact.active) throw notFound();
  let customerId: string | null; // the customer the reveal is logged against
  let isResponder: boolean;
  if (auth.kind === 'CUSTOMER') {
    if (contact.kind !== 'CUSTOMER' || !contact.customerId || !customerWide(scope, contact.customerId)) throw notFound();
    customerId = contact.customerId;
    isResponder = false;
  } else {
    const mine = new Set(await deps.repo.responderCustomerIds(auth.userId));
    if (contact.kind === 'CUSTOMER') {
      if (!contact.customerId || !customerWide(scope, contact.customerId)) throw notFound();
      customerId = contact.customerId;
      isResponder = mine.has(customerId);
    } else {
      // an INTERNAL person: the basis is a customer both the caller and this person are Responder of
      const shared = (await deps.repo.responderCustomerIdsOfContact(contact.id)).filter((c) => mine.has(c) && customerWide(scope, c)).sort();
      customerId = shared[0] ?? null;
      isResponder = shared.length > 0;
    }
  }

  // 2. body
  const b = req.body;
  if (!isRecord(b)) throw invalid('body', 'Body must be a JSON object.');
  if (typeof b.channel !== 'string' || !(CHANNELS as readonly string[]).includes(b.channel)) throw invalid('channel', 'channel must be PHONE, EMAIL or SLACK.');
  const channel = b.channel as RevealChannelValue;
  if (b.reason !== undefined && b.reason !== null && typeof b.reason !== 'string') throw invalid('reason', 'reason must be text.');
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length > REASON_MAX) throw invalid('reason', `reason is at most ${REASON_MAX} characters.`);

  const standing = revealStanding(auth, isResponder, contact.kind);
  if ('denied' in standing) {
    refused(deps, req, auth, contact.id, 403, standing.denied);
    throw standing.denied === 'ROLE_REQUIRED' ? roleRequired('OPERATOR') : new ApiError(403, 'NOT_A_RESPONDER', 'Only a responder of this customer can open this contact.');
  }
  // 3. a typed reason for an emergency (no value, nothing logged)
  if (standing.mode === 'EMERGENCY' && reason.length === 0) {
    refused(deps, req, auth, contact.id, 422, 'EMERGENCY_REASON_REQUIRED');
    throw new ApiError(422, 'EMERGENCY_REASON_REQUIRED', 'You are not a responder for this customer. Give the reason you need this contact.', { field: 'reason' });
  }
  // 4. nothing on file: nothing to reveal, nothing to log
  const value = valueOf(contact, channel);
  if (value === null) throw new ApiError(422, 'VALIDATION_FAILED', 'This contact has nothing on file for that channel.', { fields: [{ field: 'channel', message: 'Nothing on file.' }] });

  // 5. log first (limits + log + audit in one transaction), value after
  const actorContactId = await deps.repo.contactIdForUser(auth.userId);
  const notified = standing.mode === 'EMERGENCY' && customerId ? await emergencyRecipients(deps, customerId, actorContactId, contact.id) : [];
  const res = await deps.repo.recordReveal({
    actorUserId: auth.userId, actorRole: auth.kind === 'CUSTOMER' ? PORTAL_ACTOR : effectiveRole(auth) ?? 'VIEWER', contactId: contact.id, contactName: contact.name, customerId, channel, mode: standing.mode,
    reason: reason || null, notifiedContactIds: notified, requestId: req.requestId, limits: REVEAL_LIMITS,
  });
  if (!res.ok) {
    refused(deps, req, auth, contact.id, 429, 'RATE_LIMITED');
    throw rateLimited('Too many reveals. Try again shortly.', res.retryAfterSec);
  }
  return ok({ channel, value, mode: standing.mode, revealedAt: res.at.toISOString(), auditId: res.id }, { 'cache-control': 'no-store' });
}

// ───────────────────────────── GET /contact-reveals ─────────────────────────────

interface Cursor { t: string; id: string }
const isCursor = (v: unknown): v is Cursor => isRecord(v) && isIsoInstant(v.t) && isCleanId(v.id);

export async function listContactReveals(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  if (auth.kind !== 'INTERNAL') throw notFound(); // portal: no such path (D-36)
  if (!hasRole(auth, 'OPERATOR')) throw roleRequired('OPERATOR'); // VIEWER: 403
  const scope = scopeOf(auth);
  const admin = hasRole(auth, 'ADMIN');
  const limit = limitOf(req);
  const after = decodeCursor(q(req, 'cursor'), isCursor);

  const mode = q(req, 'mode');
  if (mode !== undefined && mode !== 'NORMAL' && mode !== 'EMERGENCY') throw invalid('mode', 'mode must be NORMAL or EMERGENCY.');
  const actorUserId = q(req, 'actorUserId');
  if (actorUserId !== undefined && !isCleanId(actorUserId)) throw invalid('actorUserId', 'actorUserId is not valid.');
  const contactId = q(req, 'contactId');
  if (contactId !== undefined && !isCleanId(contactId)) throw invalid('contactId', 'contactId is not valid.');
  const from = q(req, 'from');
  const to = q(req, 'to');
  if (from !== undefined && !isIsoInstant(from)) throw invalid('from', 'from must be an ISO instant (…Z).');
  if (to !== undefined && !isIsoInstant(to)) throw invalid('to', 'to must be an ISO instant (…Z).');

  // The customers whose rows the caller may read: ADMIN every customer they see (and rows without one); OPERATOR the ones they are a Responder of.
  const tree = await deps.repo.orgTree(scope);
  const seen = new Set(tree.customers.map((c) => c.id));
  let allowed: string[] | null = admin && scope.customerIds === '*' ? null : admin ? [...seen] : (await deps.repo.responderCustomerIds(auth.userId)).filter((c) => seen.has(c));
  const slug = q(req, 'customer');
  if (slug !== undefined) {
    const c = SLUG_PATTERN.test(slug) ? tree.customers.find((x) => x.slug === slug) : undefined;
    if (!c || (allowed !== null && !allowed.includes(c.id))) throw notFound(); // out of range = the one 404
    allowed = [c.id];
  }
  const page = await deps.repo.revealLog({
    customerIds: allowed, mode, actorUserId, contactId, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined, after, limit,
  });
  const last = page.rows[page.rows.length - 1];
  return ok({
    items: page.rows.map((r) => ({
      id: r.id, at: r.at.toISOString(), mode: r.mode, actor: { id: r.actorUserId, name: r.actorName, kind: r.actorRole === PORTAL_ACTOR ? 'PORTAL' : 'STAFF' }, contact: { id: r.contactId, name: r.contactName },
      org: { customer: r.customer }, channel: r.channel, reason: r.reason, notified: r.notified,
      // recording only (nothing is delivered yet): an empty list on an EMERGENCY row is NO_RECIPIENT, never "fine"
      notifyStatus: r.mode !== 'EMERGENCY' ? 'NOT_APPLICABLE' : r.notified.length ? 'RECORDED' : 'NO_RECIPIENT',
    })),
    nextCursor: page.hasMore && last ? encodeCursor({ t: last.at.toISOString(), id: last.id } satisfies Cursor) : null,
  });
}
