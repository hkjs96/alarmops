/**
 * API-CONTRACT §8.4 contacts and channel verification (hkjs96/alarmops#62):
 *   GET    /contacts                 list (values always masked, D-35)
 *   POST   /contacts                 create (INTERNAL by an MSP ADMIN, CUSTOMER by an MSP ADMIN or a portal user with the `contacts` grant)
 *   PATCH  /contacts/{id}            edit; a changed value loses its verification
 *   DELETE /contacts/{id}            refused (409 IN_USE) while the contact is a Responder / rotation member / named in a step / a login user
 *   POST   /contacts/{id}/verify     { channel, method: link | manual, note? }
 *   POST   /contacts/verify-bulk     { contactIds[] } or { kind?, customerId?, filter: "needsAction" }
 *   GET    /verify/{token}           one-time link, no session
 *
 * Who: MSP ADMIN (every contact in range) or a portal user whose customer granted `contacts` (CUSTOMER contacts of its own
 * customer only; MSP staff never appear to them, D-36). Everything else about a contact outside the caller's range is the one 404.
 *
 * Sending a verification link needs a delivery adapter (Slack / e-mail / SMS: hkjs96/alarmops#39, #10) that does not exist yet.
 * The API depends on the `VerificationSender` port below; without one a link request is refused with 503
 * VERIFICATION_UNAVAILABLE before anything is written — no token is made for a message that cannot be sent.
 * Only the SHA-256 of a token is stored (ChannelVerification.tokenHash). The plaintext exists in the sender call only.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { verifiedAt } from '@alarmops/core';
import { customerWide, requireAuth, requireRole, scopeOf, type AuthContext } from './auth.js';
import { withoutUndefined, ApiError, decodeCursor, encodeCursor, invalid, isCleanId, isRecord, limitOf, notFound, ok, q, rateLimited, validation, type ApiRequest, type ApiResponse } from './http.js';
import { EMAIL_RE, PHONE_RE, maskEmail, maskPhone } from './peopleApi.js';
import type { ApiRepository, ContactPatch, ContactRow, ContactsWorld, OrgTree, VerificationLink, VerifyChannelValue } from './repo.js';
import { revealFlags } from './revealApi.js';
import { resolveNodeFilter } from './scope.js';

/** Delivers a verification link. Implemented by the e-mail / SMS adapters; absent today. Gets the plaintext token and the address: never log either. */
export interface VerificationSender {
  send(m: { channel: 'EMAIL' | 'SMS'; to: string; contactId: string; customerId: string | null; token: string; expiresAt: Date }): Promise<void>;
}

interface Deps { repo: ApiRepository; now: () => Date; verification?: VerificationSender; verificationSecret?: string; log?: (level: 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void }

/** notification R9-2: a link lives 24 hours and works once. */
export const VERIFY_TTL_MS = 24 * 3600_000;
/** A second link to the same contact + channel waits this long: the API must not become a way to spam a third party. */
export const VERIFY_COOLDOWN_SEC = 60;
/** API-CONTRACT §2 "한도": 일괄 처리 항목 200. */
export const BULK_MAX = 200;
/** Hourly caps (DB-counted): sends per customer and per destination address, on top of the per-contact cooldown. */
export const VERIFY_CAP_PER_CUSTOMER_HOUR = 200;
export const VERIFY_CAP_PER_DESTINATION_HOUR = 3;
/** A portal user may create this many contacts per 24 hours (DB-counted from the audit trail). */
export const PORTAL_CONTACTS_PER_DAY = 20;
const NAME_MAX = 80;
const NOTE_MAX = 500;
const SLACK_ID_RE = /^[UW][A-Z0-9]{2,20}$/;
const TOKEN_RE = /^vf_[A-Za-z0-9_-]{43}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * One address, one form: e-mail lower-case; a phone number as digits only with the Korean country code folded into the
 * national form (`+82 10-1234-5678`, `82-10-1234-5678` and `010-1234-5678` are the same destination).
 */
export function normalizeDestination(channel: 'EMAIL' | 'SMS', to: string): string {
  if (channel === 'EMAIL') return to.trim().toLowerCase();
  const d = to.replace(/\D/g, '');
  return d.startsWith('82') && d.length >= 11 ? `0${d.slice(2)}` : d;
}
/** Keyed hash of a destination, per customer: counts sends without storing the address and without letting another customer use up the allowance. */
export const destinationHash = (secret: string, customerId: string | null, channel: 'EMAIL' | 'SMS', to: string): string =>
  createHmac('sha256', secret).update(`${customerId ?? '-'}|${channel}|${normalizeDestination(channel, to)}`).digest('hex');
const secretMissing = (deps: Deps): ApiError | null =>
  (deps.verificationSecret ?? '').length >= 32 ? null : new ApiError(503, 'NOT_CONFIGURED', 'Verification links need a server secret that is not configured.');

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
/** 256 random bits; the `vf_` prefix only makes a leaked token recognisable. */
export const newVerifyToken = (): string => `vf_${randomBytes(32).toString('base64url')}`;

// ───────────────────────────── who may ─────────────────────────────

interface Actor { auth: AuthContext; ids: readonly string[] | '*'; staff: boolean }

/**
 * The range the caller may touch. Staff: must be ADMIN (contract role column "A"); every customer they see whole, plus the
 * INTERNAL contacts. Portal: only customers that granted `contacts` (403 PORTAL_GRANT_REQUIRED when none), never INTERNAL contacts.
 */
async function actorOf(req: ApiRequest, deps: Deps, lazyGrant = false): Promise<Actor> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  if (auth.kind === 'INTERNAL') {
    requireRole(auth, 'ADMIN');
    if (scope.customerIds === '*') return { auth, ids: '*', staff: true };
    return { auth, ids: scope.customerIds.filter((id) => customerWide(scope, id)), staff: true };
  }
  const wide = scope.customerIds === '*' ? [] : scope.customerIds.filter((id) => customerWide(scope, id));
  // Routes that name a contact look it up FIRST (a foreign or unknown id is the one 404) and check the grant after: `requireGrant`.
  if (lazyGrant) return { auth, ids: wide, staff: false };
  const granted: string[] = [];
  for (const id of wide) if ((await deps.repo.portalGrants(id)).includes('contacts')) granted.push(id);
  if (!granted.length) throw new ApiError(403, 'PORTAL_GRANT_REQUIRED', 'Your organisation has not enabled this for the portal.');
  return { auth, ids: granted, staff: false };
}
async function requireGrant(deps: Deps, a: Actor, customerId: string | null): Promise<void> {
  if (a.auth.kind === 'INTERNAL') return;
  if (!customerId || !(await deps.repo.portalGrants(customerId)).includes('contacts')) throw new ApiError(403, 'PORTAL_GRANT_REQUIRED', 'Your organisation has not enabled this for the portal.');
}
const adminStaff = (a: Actor): boolean => a.auth.kind === 'INTERNAL';
const inIds = (ids: readonly string[] | '*', id: string): boolean => ids === '*' || ids.includes(id);

// ───────────────────────────── views ─────────────────────────────


type ChannelStatus = 'VERIFIED' | 'UNVERIFIED' | 'NOT_SET' | 'LINK_SENT' | 'EXPIRED';
interface ChannelOut { status: ChannelStatus; via: string | null; at: string | null; expiresAt: string | null }
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function channelOut(c: ContactRow, ch: VerifyChannelValue, links: VerificationLink[], now: Date): ChannelOut {
  const value = ch === 'EMAIL' ? c.email : ch === 'SMS' ? c.phone : c.slackUserId;
  const at = ch === 'EMAIL' ? c.emailVerifiedAt : ch === 'SMS' ? c.phoneVerifiedAt : c.slackVerifiedAt;
  const via = (ch === 'EMAIL' ? c.emailVerifiedVia : ch === 'SMS' ? c.phoneVerifiedVia : c.slackVerifiedVia) ?? null;
  if (!value) return { status: 'NOT_SET', via: null, at: null, expiresAt: null };
  if (verifiedAt(at, now)) return { status: 'VERIFIED', via, at: iso(at), expiresAt: null };
  const link = links.filter((l) => l.contactId === c.id && l.channel === ch).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
  if (link && !link.usedAt) return { status: link.expiresAt.getTime() > now.getTime() ? 'LINK_SENT' : 'EXPIRED', via: null, at: null, expiresAt: iso(link.expiresAt) };
  return { status: 'UNVERIFIED', via: null, at: null, expiresAt: null };
}

/** Needs action (contacts.md): a value that is not verified, or a Pageable person without a phone. */
function needsAction(c: ContactRow, ch: Record<'EMAIL' | 'SMS' | 'SLACK', ChannelOut>, pageable: boolean): boolean {
  return (['EMAIL', 'SMS', 'SLACK'] as const).some((k) => ch[k].status !== 'NOT_SET' && ch[k].status !== 'VERIFIED') || (pageable && ch.SMS.status === 'NOT_SET') || (!c.email && !c.phone && !c.slackUserId);
}

interface ViewCtx { world: ContactsWorld; tree: OrgTree; mine: ReadonlySet<string>; auth: AuthContext; now: Date }

function contactView(c: ContactRow, x: ViewCtx) {
  const ch = { EMAIL: channelOut(c, 'EMAIL', x.world.links, x.now), SMS: channelOut(c, 'SMS', x.world.links, x.now), SLACK: channelOut(c, 'SLACK', x.world.links, x.now) };
  const resp = x.world.responders.filter((r) => r.contactId === c.id);
  const customer = c.customerId ? x.tree.customers.find((k) => k.id === c.customerId) : undefined;
  const isResponder = c.kind === 'CUSTOMER' ? !!c.customerId && x.mine.has(c.customerId) : resp.some((r) => x.mine.has(r.customerId));
  const scopes = x.world.scopes.filter((s) => s.contactId === c.id).map((s) => {
    const name = s.scopeType === 'CUSTOMER' ? x.tree.customers.find((k) => k.id === s.scopeId)?.name : s.scopeType === 'PROJECT' ? x.tree.projects.find((p) => p.id === s.scopeId)?.name : x.tree.services.find((v) => v.id === s.scopeId)?.name;
    return { level: s.scopeType, id: s.scopeId, name: name ?? s.scopeId, role: s.role };
  });
  return {
    id: c.id, kind: c.kind, name: c.name, active: c.active,
    ...(customer ? { org: { customer: { id: customer.id, name: customer.name, slug: customer.slug } } } : {}),
    emailMasked: maskEmail(c.email) ?? null, phoneMasked: maskPhone(c.phone) ?? null, hasSlack: !!c.slackUserId,
    channels: { EMAIL: ch.EMAIL, SMS: ch.SMS, VOICE: ch.SMS, SLACK: ch.SLACK },
    ...(c.kind === 'INTERNAL' ? { customerCount: new Set(resp.map((r) => r.customerId)).size } : { responderRole: resp.find((r) => r.customerId === c.customerId)?.role ?? null, scopes }),
    needsAction: needsAction(c, ch, resp.some((r) => r.role === 'PAGEABLE')),
    ...revealFlags(x.auth, isResponder, c.kind),
  };
}

async function viewCtx(deps: Deps, a: Actor, world: ContactsWorld): Promise<ViewCtx> {
  const tree = await deps.repo.orgTree(scopeOf(a.auth));
  const mine = a.auth.kind === 'INTERNAL' ? new Set(await deps.repo.responderCustomerIds(a.auth.userId)) : new Set<string>();
  return { world, tree, mine, auth: a.auth, now: deps.now() };
}

// ───────────────────────────── GET /contacts ─────────────────────────────

interface Cursor { n: string; id: string }
const isCursor = (v: unknown): v is Cursor => isRecord(v) && typeof v.n === 'string' && v.n.length <= 200 && isCleanId(v.id);
const truthy = (v: string | undefined): boolean => v === '1' || v === 'true';

export async function listContacts(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const a = await actorOf(req, deps);
  const scope = scopeOf(a.auth);
  const kind = q(req, 'kind');
  if (kind !== undefined && kind !== 'INTERNAL' && kind !== 'CUSTOMER') throw invalid('kind', 'kind must be INTERNAL or CUSTOMER.');
  const limit = limitOf(req);
  const after = decodeCursor(q(req, 'cursor'), isCursor);
  const needle = q(req, 'q')?.trim().toLowerCase();
  const node = await resolveNodeFilter(req, deps.repo, a.auth, scope);
  // The range: the caller's customers, narrowed by the node filter (which was looked up in the caller's own tree: 404 for the rest).
  const ids: readonly string[] | '*' = node ? node.customerIds.filter((id) => inIds(a.ids, id)) : a.ids;
  const world = await deps.repo.contactsWorld(ids, a.staff && kind !== 'CUSTOMER');
  const x = await viewCtx(deps, a, world);
  const wantsNeeds = truthy(q(req, 'needsAction'));
  // Project / service filter: CUSTOMER people with a scope at or above the node (or a Responder row), and every staff Responder of the customer.
  const projectOfService = node?.serviceId ? x.tree.services.find((s) => s.id === node.serviceId)?.projectId : undefined;
  const reaches = (c: ContactRow): boolean => {
    if (!node || (!node.projectId && !node.serviceId)) return true;
    if (c.kind === 'INTERNAL') return world.responders.some((r) => r.contactId === c.id && node.customerIds.includes(r.customerId));
    if (world.responders.some((r) => r.contactId === c.id && r.customerId === c.customerId)) return true;
    return world.scopes.some((s) => s.contactId === c.id && (s.scopeType === 'CUSTOMER' || (s.scopeType === 'PROJECT' && (s.scopeId === node.projectId || s.scopeId === projectOfService)) || (s.scopeType === 'SERVICE' && s.scopeId === node.serviceId)));
  };
  const inCustomer = (c: ContactRow): boolean => {
    if (!node) return true;
    if (c.kind === 'CUSTOMER') return !!c.customerId && node.customerIds.includes(c.customerId);
    return world.responders.some((r) => r.contactId === c.id && node.customerIds.includes(r.customerId)); // staff: only those who serve the asked customer(s)
  };
  const rows = world.contacts
    .filter((c) => (!kind || c.kind === kind) && inCustomer(c) && reaches(c) && (!needle || c.name.toLowerCase().includes(needle)))
    .map((c) => ({ c, v: contactView(c, x) }))
    .filter(({ v }) => !wantsNeeds || v.needsAction)
    // sort on the server, then cut (known-bugs 9-1, 9-2)
    .sort((p, r) => (p.c.name.toLowerCase() < r.c.name.toLowerCase() ? -1 : p.c.name.toLowerCase() > r.c.name.toLowerCase() ? 1 : p.c.id < r.c.id ? -1 : 1));
  const key = (c: ContactRow): string => c.name.toLowerCase();
  const rest = after ? rows.filter(({ c }) => key(c) > after.n || (key(c) === after.n && c.id > after.id)) : rows;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return ok({ items: page.map((p) => p.v), nextCursor: rest.length > limit && last ? encodeCursor({ n: key(last.c), id: last.c.id } satisfies Cursor) : null }, { 'cache-control': 'private, no-store' });
}

// ───────────────────────────── POST / PATCH / DELETE ─────────────────────────────

function readValues(b: Record<string, unknown>): { email?: string | null; phone?: string | null; slackUserId?: string | null } {
  const out: { email?: string | null; phone?: string | null; slackUserId?: string | null } = {};
  if ('email' in b) {
    const v = b.email === null ? null : typeof b.email === 'string' ? b.email.trim() : undefined;
    if (v === undefined || (v !== null && (!EMAIL_RE.test(v) || v.length > 200))) throw invalid('email', 'email is not valid.');
    out.email = v || null;
  }
  if ('phone' in b) {
    const v = b.phone === null ? null : typeof b.phone === 'string' ? b.phone.trim() : undefined;
    if (v === undefined || (v !== null && v !== '' && !PHONE_RE.test(v))) throw invalid('phone', 'phone is not valid.');
    out.phone = v || null;
  }
  if ('slackUserId' in b) {
    const v = b.slackUserId === null ? null : typeof b.slackUserId === 'string' ? b.slackUserId.trim() : undefined;
    if (v === undefined || (v !== null && v !== '' && !SLACK_ID_RE.test(v))) throw invalid('slackUserId', 'slackUserId must look like U01ABCDEF.');
    out.slackUserId = v || null;
  }
  return out;
}
const readName = (v: unknown): string => {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > NAME_MAX || CONTROL.test(name)) throw invalid('name', `name is required (1-${NAME_MAX} characters).`);
  return name;
};
const noKeys = (b: Record<string, unknown>, allowed: string[]): void => {
  const bad = Object.keys(b).filter((k) => !allowed.includes(k));
  if (bad.length) throw validation(bad.map((field) => ({ field, message: 'Not accepted here.' })));
};

export async function createContact(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const a = await actorOf(req, deps);
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  noKeys(b, ['kind', 'customerId', 'name', 'email', 'phone', 'slackUserId']);
  const kind = b.kind === undefined ? 'CUSTOMER' : b.kind;
  if (kind !== 'INTERNAL' && kind !== 'CUSTOMER') throw invalid('kind', 'kind must be INTERNAL or CUSTOMER.');
  const name = readName(b.name);
  const v = readValues(b);
  if (!v.email && !v.phone && !v.slackUserId) throw invalid('email', 'An e-mail, a phone number or a Slack id is required.');
  let customerId: string | null = null;
  if (kind === 'INTERNAL') {
    if (!adminStaff(a) || a.ids !== '*') throw notFound(); // portal users and staff with a narrower range: no such thing as creating MSP staff (B-1)
    if (b.customerId !== undefined && b.customerId !== null) throw invalid('customerId', 'An MSP staff contact has no customer.');
  } else {
    const wanted = b.customerId === undefined || b.customerId === null ? (a.ids !== '*' && a.ids.length === 1 ? a.ids[0]! : undefined) : b.customerId;
    if (typeof wanted !== 'string' || !isCleanId(wanted)) throw invalid('customerId', 'customerId is required for a customer person.');
    // another tenant's customer and a made-up one: the same 404
    const tree = await deps.repo.orgTree(scopeOf(a.auth));
    if (!inIds(a.ids, wanted) || !tree.customers.some((c) => c.id === wanted)) throw notFound();
    customerId = wanted;
    const st = await deps.repo.customerStatusState(customerId);
    if (!st) throw notFound();
    if (st.status === 'TERMINATED') throw new ApiError(409, 'CUSTOMER_TERMINATED', 'A terminated customer cannot get new contacts.');
  }
  if (a.auth.kind === 'CUSTOMER' && customerId) {
    const since = new Date(deps.now().getTime() - 24 * 3600_000);
    if ((await deps.repo.countAudits(customerId, a.auth.userId, 'contact.create', since)) >= PORTAL_CONTACTS_PER_DAY) throw rateLimited(`At most ${PORTAL_CONTACTS_PER_DAY} people can be added per day.`, 3600);
  }
  const r = await deps.repo.createContact(
    { kind, customerId, name, email: v.email ?? null, phone: v.phone ?? null, slackUserId: v.slackUserId ?? null },
    // never a value in an audit row (D-35, D-45): which channels were filled in, not what is in them
    { at: deps.now(), actorType: 'USER', actorId: a.auth.userId, action: 'contact.create', targetType: 'Contact', before: null, after: { kind, active: true, channels: Object.entries(v).filter(([, x]) => !!x).map(([k]) => k) }, requestId: req.requestId },
  );
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'SLACK_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'That Slack user is already linked to another contact.');
  return ok(await viewOf(deps, a, r), { 'cache-control': 'private, no-store' }, 201);
}

async function viewOf(deps: Deps, a: Actor, c: ContactRow) {
  const found = await deps.repo.findContact(a.ids, a.staff, c.id);
  const world: ContactsWorld = {
    contacts: [found?.contact ?? c], scopes: [], links: found?.links ?? [],
    responders: (found?.responderCustomerIds ?? []).map((customerId) => ({ customerId, contactId: c.id, role: 'NOTIFY_ONLY' as const })),
  };
  return contactView(found?.contact ?? c, await viewCtx(deps, a, world));
}

export async function patchContact(req: ApiRequest, deps: Deps, contactId: string): Promise<ApiResponse> {
  const a = await actorOf(req, deps, true);
  const found = await deps.repo.findContact(a.ids, a.staff, contactId, true);
  if (!found) throw notFound();
  await requireGrant(deps, a, found.contact.customerId);
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  noKeys(b, ['name', 'email', 'phone', 'slackUserId', 'active']);
  const patch: ContactPatch = { ...readValues(b) };
  if ('name' in b) patch.name = readName(b.name);
  if ('active' in b) {
    if (typeof b.active !== 'boolean') throw invalid('active', 'active must be true or false.');
    patch.active = b.active;
  }
  if (Object.keys(patch).length === 0) throw invalid('body', 'Nothing to change.');
  const c = found.contact;
  const result = { email: 'email' in patch ? patch.email : c.email, phone: 'phone' in patch ? patch.phone : c.phone, slack: 'slackUserId' in patch ? patch.slackUserId : c.slackUserId };
  if (!result.email && !result.phone && !result.slack) throw invalid('email', 'A contact needs an e-mail, a phone number or a Slack id.');
  const changedValues = (['email', 'phone', 'slackUserId'] as const).filter((k) => k in patch && (patch[k] ?? null) !== (c[k] ?? null));
  const r = await deps.repo.updateContact(c.id, c.customerId, patch, {
    at: deps.now(), actorType: 'USER', actorId: a.auth.userId, action: 'contact.update', targetType: 'Contact',
    // which fields changed, never what they held; a changed value also resets that channel's verification (in the store)
    before: { active: c.active }, after: { ...('active' in patch ? { active: patch.active } : {}), changed: [...('name' in patch ? ['name'] : []), ...changedValues], verificationReset: changedValues }, requestId: req.requestId,
  });
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'SLACK_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'That Slack user is already linked to another contact.');
  return ok(await viewOf(deps, a, r), { 'cache-control': 'private, no-store' });
}

export async function deleteContact(req: ApiRequest, deps: Deps, contactId: string): Promise<ApiResponse> {
  const a = await actorOf(req, deps, true);
  const found = await deps.repo.findContact(a.ids, a.staff, contactId, true);
  if (!found) throw notFound();
  await requireGrant(deps, a, found.contact.customerId);
  const c = found.contact;
  const r = await deps.repo.deleteContact(c.id, c.customerId, {
    at: deps.now(), actorType: 'USER', actorId: a.auth.userId, action: 'contact.delete', targetType: 'Contact', before: { kind: c.kind, active: c.active }, after: null, requestId: req.requestId,
  });
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'IN_USE') throw new ApiError(409, 'IN_USE', 'This person is still a responder, a rotation member, a running or future rotation pin, or named in a step. Remove them there first (or deactivate the contact).');
  return ok({ id: c.id, deleted: true });
}

// ───────────────────────────── verification ─────────────────────────────

const CHANNELS: readonly VerifyChannelValue[] = ['EMAIL', 'SMS', 'SLACK'];
const valueOf = (c: ContactRow, ch: VerifyChannelValue): string | null => (ch === 'EMAIL' ? c.email : ch === 'SMS' ? c.phone : c.slackUserId) || null;

/** Issue one link and hand it to the sender. 'COOLING' = too soon; 'FAILED' = the sender refused (the link is taken back). */
async function sendLink(deps: Deps, sender: VerificationSender, c: ContactRow, channel: 'EMAIL' | 'SMS', to: string): Promise<'SENT' | 'COOLING' | 'FAILED' | { capped: number }> {
  const token = newVerifyToken();
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + VERIFY_TTL_MS);
  // The hash is stored first so the link works the moment it arrives; if the sender then fails the row is taken back.
  const issued = await deps.repo.issueVerification({ customerId: c.customerId, contactId: c.id, channel, tokenHash: hashToken(token), sentAt: now, expiresAt, destinationHash: destinationHash(deps.verificationSecret!, c.customerId, channel, to) },
    { cooldownSec: VERIFY_COOLDOWN_SEC, perCustomerHour: VERIFY_CAP_PER_CUSTOMER_HOUR, perDestinationHour: VERIFY_CAP_PER_DESTINATION_HOUR });
  if (issued !== 'OK') return 'capped' in issued ? { capped: issued.retryAfterSec } : 'COOLING';
  try {
    await sender.send({ channel, to, contactId: c.id, customerId: c.customerId, token, expiresAt });
  } catch {
    await deps.repo.discardVerification(hashToken(token)).catch(() => undefined);
    deps.log?.('error', 'verification_send_failed', { contactId: c.id, channel }); // no address, no token, no adapter text
    return 'FAILED';
  }
  return 'SENT';
}

const senderMissing = (): ApiError => new ApiError(503, 'VERIFICATION_UNAVAILABLE', 'Verification links cannot be sent yet: no e-mail or SMS sender is configured. Mark the channel verified by hand instead, or try later.');

export async function verifyContact(req: ApiRequest, deps: Deps, contactId: string): Promise<ApiResponse> {
  const a = await actorOf(req, deps, true);
  const found = await deps.repo.findContact(a.ids, a.staff, contactId, true);
  if (!found) throw notFound();
  await requireGrant(deps, a, found.contact.customerId);
  const c = found.contact;
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  noKeys(b, ['channel', 'method', 'note']);
  if (typeof b.channel !== 'string' || !(CHANNELS as readonly string[]).includes(b.channel)) throw invalid('channel', 'channel must be EMAIL, SMS or SLACK.');
  const channel = b.channel as VerifyChannelValue;
  if (b.method !== 'link' && b.method !== 'manual') throw invalid('method', 'method must be link or manual.');
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > NOTE_MAX || CONTROL.test(b.note.replace(/[\n\t]/g, ' ')))) throw invalid('note', `note is text of at most ${NOTE_MAX} characters.`);
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
  if (!c.active) throw new ApiError(409, 'INVALID_TRANSITION', 'This contact is not active.');
  const value = valueOf(c, channel);
  if (value === null) throw new ApiError(422, 'VALIDATION_FAILED', 'This contact has nothing on file for that channel.', { fields: [{ field: 'channel', message: 'Nothing on file.' }] });
  const now = deps.now();

  if (b.method === 'manual') {
    // A person vouches for the channel (D-37 makes this the basis for SMS / voice): MSP ADMIN only, never the customer itself.
    if (!adminStaff(a)) throw new ApiError(403, 'FORBIDDEN', 'Only MSP staff can mark a channel verified by hand.');
    const via = `admin:${(a.auth.name ?? a.auth.userId).slice(0, 60)}`;
    const r = await deps.repo.markVerifiedManually(c.id, c.customerId, channel, via, note, now, {
      at: now, actorType: 'USER', actorId: a.auth.userId, action: 'contact.verify.manual', targetType: 'Contact', before: null, after: { channel, via: 'manual', ...(note ? { note } : {}) }, requestId: req.requestId,
    });
    if (r === 'NOT_FOUND') throw notFound();
    return ok({ status: 'VERIFIED', channel, method: 'manual', at: now.toISOString() }, { 'cache-control': 'no-store' });
  }

  if (channel === 'SLACK') throw invalid('channel', 'A Slack id is not verified by a link. Use method manual.');
  if (!deps.verification) throw senderMissing(); // nothing written, no token made
  const noSecret = secretMissing(deps);
  if (noSecret) throw noSecret;
  const sent = await sendLink(deps, deps.verification, c, channel, value);
  if (typeof sent === 'object') throw rateLimited('Too many verification links were sent recently. Try again later.', sent.capped);
  if (sent === 'COOLING') throw rateLimited('A link was sent a moment ago. Wait a minute before sending another.', VERIFY_COOLDOWN_SEC);
  if (sent === 'FAILED') throw new ApiError(502, 'SEND_FAILED', 'The link could not be sent. Try again.');
  await deps.repo.recordAudit({ at: now, customerId: c.customerId, actorType: 'USER', actorId: a.auth.userId, action: 'contact.verify.link_sent', targetType: 'Contact', targetId: c.id, before: null, after: { channel }, requestId: req.requestId });
  return ok({ status: 'LINK_SENT', channel, method: 'link', expiresAt: new Date(now.getTime() + VERIFY_TTL_MS).toISOString() }, { 'cache-control': 'no-store' }, 202);
}

/**
 * POST /contacts/verify-bulk. MSP ADMIN only (a portal user: no such path). Sends one link per unverified EMAIL / SMS channel;
 * channels with no value are returned in `notSet` ("Ask to add"), not sent. `throttled` = skipped because a link went out within
 * the last minute, `failed` = the sender refused. Without a sender: 503 before anything is looked at or written.
 */
export async function verifyBulk(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  if (auth.kind !== 'INTERNAL') throw notFound();
  const a = await actorOf(req, deps);
  if (!deps.verification) throw senderMissing();
  const noSecret = secretMissing(deps);
  if (noSecret) throw noSecret;
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  noKeys(b, ['contactIds', 'kind', 'customerId', 'filter']);
  let targets: ContactRow[];
  if (b.contactIds !== undefined) {
    if (!Array.isArray(b.contactIds) || b.contactIds.length === 0) throw invalid('contactIds', 'contactIds must be a non-empty list.');
    if (b.contactIds.length > BULK_MAX) throw invalid('contactIds', `At most ${BULK_MAX} contacts at a time.`);
    if (b.contactIds.some((i) => typeof i !== 'string' || !isCleanId(i))) throw invalid('contactIds', 'contactIds must be contact ids.');
    targets = [];
    for (const id of new Set(b.contactIds as string[])) {
      const f = await deps.repo.findContact(a.ids, a.staff, id, true);
      if (!f) throw notFound(); // one id out of range = the one 404 for the whole request, nothing sent
      targets.push(f.contact);
    }
  } else {
    if (b.filter !== 'needsAction') throw invalid('filter', 'Send contactIds, or filter: "needsAction".');
    if (b.kind !== undefined && b.kind !== 'INTERNAL' && b.kind !== 'CUSTOMER') throw invalid('kind', 'kind must be INTERNAL or CUSTOMER.');
    let ids = a.ids;
    if (b.customerId !== undefined) {
      if (typeof b.customerId !== 'string' || !isCleanId(b.customerId) || !inIds(a.ids, b.customerId)) throw notFound();
      ids = [b.customerId];
    }
    const world = await deps.repo.contactsWorld(ids, a.staff && a.ids === '*' && b.kind !== 'CUSTOMER' && b.customerId === undefined);
    const x = await viewCtx(deps, a, world);
    targets = world.contacts.filter((c) => (!b.kind || c.kind === b.kind) && contactView(c, x).needsAction);
    if (targets.length > BULK_MAX) throw invalid('filter', `More than ${BULK_MAX} contacts match. Narrow it down.`);
  }
  const now = deps.now();
  let sent = 0, throttled = 0, failed = 0;
  const notSet: Array<{ contactId: string; channel: 'EMAIL' | 'SMS' }> = [];
  for (const c of targets) {
    if (!c.active) continue;
    for (const channel of ['EMAIL', 'SMS'] as const) {
      const value = valueOf(c, channel);
      if (value === null) { notSet.push({ contactId: c.id, channel }); continue; }
      if (verifiedAt(channel === 'EMAIL' ? c.emailVerifiedAt : c.phoneVerifiedAt, now)) continue;
      const r = await sendLink(deps, deps.verification, c, channel, value);
      if (r === 'SENT') sent++; else if (r === 'COOLING' || typeof r === 'object') throttled++; else failed++;
    }
  }
  if (targets.length) await deps.repo.recordAudit({ at: now, customerId: null, actorType: 'USER', actorId: auth.userId, action: 'contact.verify.bulk', targetType: 'Contact', targetId: 'bulk', before: null, after: { contacts: targets.length, sent, throttled, failed, notSet: notSet.length }, requestId: req.requestId });
  return ok({ sent, notSet, throttled, failed }, { 'cache-control': 'no-store' });
}

const deadLink = (): ApiError => new ApiError(404, 'NOT_FOUND', 'This link is invalid or has expired.');

/**
 * GET /verify/{token}: SIDE-EFFECT FREE (mail scanners and link previews open links). Answers only whether the link is
 * pending: `200 { pending: true, channel }`, else the one 404 (unknown, used, expired, malformed). Nothing is consumed.
 */
export async function peekVerifyLink(_req: ApiRequest, deps: Deps, token: string): Promise<ApiResponse> {
  if (!TOKEN_RE.test(token)) throw deadLink();
  const p = await deps.repo.peekVerification(hashToken(token), deps.now());
  if (!p) throw deadLink();
  return ok({ pending: true, channel: p.channel }, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
}

/**
 * POST /verify/{token}: no session. A person pressed the confirm button on the console page. The token is looked up by its
 * SHA-256 (the plaintext is not stored); one transaction marks it used (only if unused and unexpired), verifies the channel
 * (via `link`) and writes the audit row. Unknown, used, expired and malformed are the same 404.
 */
export async function useVerifyLink(req: ApiRequest, deps: Deps, token: string): Promise<ApiResponse> {
  if (!TOKEN_RE.test(token)) throw deadLink();
  const now = deps.now();
  const taken = await deps.repo.takeVerification(hashToken(token), now, { at: now, actorType: 'CONTACT', actorId: null, action: 'contact.verify.link_used', targetType: 'Contact', before: null, after: { via: 'link' }, requestId: req.requestId });
  if (!taken) throw deadLink();
  return ok({ verified: true, channel: taken.channel }, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
}
