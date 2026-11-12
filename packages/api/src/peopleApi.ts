/**
 * API-CONTRACT §8.3 / §8.4 parts the console's Call order screen and shell need: GET /me, GET /oncall/now (Call order
 * list), GET /customers/{id}/paging-health, Responders (GET/POST/PATCH/DELETE with a list version as If-Match and
 * 409 WOULD_BE_UNREACHABLE), GET /rotations, GET /staff.
 *
 * Everything below /oncall, /customers/{id}/responders, /rotations and /staff is MSP-internal: for portal users the
 * routes do not exist (the one 404, before any parameter is looked at), like /oncall/paging-path (security Q-1).
 */
import {
  isPageableFor, onCallAt, pagingHealth, pagingPath, resolvePagingConfig, sendCapViolation, shiftAt, verifiedAt,
  type Contact, type PagingConfig, type PagingWorld, type Responder, type Rotation,
} from '@alarmops/core';
import { effectiveRole, inScope, requireAuth, requireRole, scopeOf, type AuthContext } from './auth.js';
import { ApiError, ifMatch, invalid, isRecord, notFound, ok, q, versionConflict, type ApiRequest, type ApiResponse } from './http.js';
import { pathStepOut, visibleCustomer } from './pagingApi.js';
import type { ApiRepository, OrgTree, Principal, ResponderOp, RespondersState, RotationsWorld } from './repo.js';
import { resolveNodeFilter } from './scope.js';

interface Deps { repo: ApiRepository; now: () => Date }

/** The AuthContext a console session's user gets (adapter side). Staff: every customer (D-34); portal: its customer. */
export function authFromPrincipal(p: Principal): AuthContext {
  return p.customerId
    ? { userId: p.userId, name: p.name, email: p.email, kind: 'CUSTOMER', customerIds: [p.customerId], role: p.role, ...(p.subScopes.length ? { subScopes: p.subScopes } : {}) }
    : { userId: p.userId, name: p.name, email: p.email, kind: 'INTERNAL', customerIds: '*', role: p.role };
}

const internalOnly = (auth: AuthContext): void => { if (auth.kind !== 'INTERNAL') throw notFound(); };

// ───────────────────────────── GET /me ─────────────────────────────

export async function getMe(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  // The console adapter built `auth` from sessionPrincipal (authFromPrincipal) a moment ago, email included: no second
  // lookup. Only an adapter that did not pass the email gets it read here (display only; the gate was the adapter's).
  const p = auth.email === undefined ? await deps.repo.sessionPrincipal(auth.userId) : null;
  const email = auth.email ?? p?.email ?? '';
  // `role`: the one that counts (effectiveRole). Staff without a valid role read as VIEWER here; the API still refuses their writes.
  return ok({ id: auth.userId, name: auth.name ?? p?.name ?? '', email, role: effectiveRole(auth) ?? 'VIEWER', kind: auth.kind });
}

// ───────────────────────────── display helpers ─────────────────────────────

type ChannelState = 'VERIFIED' | 'UNVERIFIED' | 'NOT_SET';
/** Verification state per channel — never the address itself (D-35). */
export function channelStates(c: Contact, now: Date): Partial<Record<'SLACK' | 'EMAIL' | 'SMS' | 'VOICE', ChannelState>> {
  const st = (value: unknown, at: Date | null | undefined): ChannelState => (!value ? 'NOT_SET' : verifiedAt(at, now) ? 'VERIFIED' : 'UNVERIFIED');
  const phone = st(c.phone, c.phoneVerifiedAt);
  return { SLACK: st(c.slackUserId, c.slackVerifiedAt), EMAIL: st(c.email, c.emailVerifiedAt), SMS: phone, VOICE: phone };
}
export const maskEmail = (e: string | null | undefined): string | undefined => {
  if (!e || !e.includes('@')) return undefined;
  return `${e[0]!.toLowerCase()}•••@${e.split('@').pop()}`;
};
export const maskPhone = (p: string | null | undefined): string | undefined => {
  const digits = (p ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? `${digits.slice(0, 3)}-••••-${digits.slice(-4)}` : undefined;
};
const display = (c: Contact | undefined, id: string, now: Date) => ({
  name: c?.name ?? id, channels: c ? channelStates(c, now) : {},
  ...(maskEmail(c?.email) ? { emailMasked: maskEmail(c?.email) } : {}), ...(maskPhone(c?.phone) ? { phoneMasked: maskPhone(c?.phone) } : {}),
});

// ───────────────────────────── GET /customers/{id}/paging-health ─────────────────────────────

async function healthOf(deps: Deps, customerId: string, configs: PagingConfig[], world: PagingWorld, now: Date) {
  const cfg = resolvePagingConfig(configs, { customerId })?.config ?? null;
  return pagingHealth(cfg, world, now, { slackChannelVerified: await deps.repo.slackChannelVerified(customerId) });
}

export async function getPagingHealth(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  internalOnly(auth);
  const { customer } = await visibleCustomer(deps, auth, customerId, 'CUSTOMER');
  const { configs, world } = await deps.repo.pagingContext(customer.id);
  return ok(await healthOf(deps, customer.id, configs, world, deps.now()));
}

// ───────────────────────────── Responders ─────────────────────────────

function respondersView(state: RespondersState, world: PagingWorld, slackVerified: boolean, customer: { id: string; name: string }, now: Date) {
  const staff = [];
  const people = [];
  for (const e of state.entries) {
    const c = world.contacts.get(e.contactId);
    if (c?.kind === 'CUSTOMER') {
      const mine = state.scopes.filter((s) => s.contactId === e.contactId);
      const extras = [...new Set(mine.filter((s) => s.role === 'APPROVER' || s.role === 'PORTAL_USER').map((s) => s.role))];
      const notify = mine.find((s) => s.role === 'NOTIFY') ?? mine[0];
      people.push({ contactId: e.contactId, role: e.role, extras, scope: notify ? { level: notify.scopeType, id: notify.scopeId, name: notify.scopeName } : { level: 'CUSTOMER', id: customer.id, name: customer.name }, ...display(c, e.contactId, now) });
    } else {
      staff.push({ contactId: e.contactId, source: e.source, ...(e.templateId ? { templateId: e.templateId } : {}), ...(e.templateName ? { templateName: e.templateName } : {}), ...display(c, e.contactId, now) });
    }
  }
  return { staff, people, templateId: state.templateId, version: state.version, slackChannel: slackVerified ? 'VERIFIED' : 'NOT_SET' };
}

export async function getResponders(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  internalOnly(auth);
  const { customer } = await visibleCustomer(deps, auth, customerId, 'CUSTOMER');
  const [state, { world }, slack] = await Promise.all([deps.repo.respondersState(customer.id), deps.repo.pagingContext(customer.id), deps.repo.slackChannelVerified(customer.id)]);
  return ok(respondersView(state, world, slack, customer, deps.now()), { etag: `"${state.version}"` });
}

const ROLES = ['PAGEABLE', 'NOTIFY_ONLY'] as const;
type RRole = (typeof ROLES)[number];
const truthy = (v: string | undefined): boolean => v === '1' || v === 'true';
const respondersConflict = (current: number) => versionConflict('The Responders', current);

/** A step that names this person (PERSON target) in any of the customer's call orders. */
const namedInSteps = (configs: PagingConfig[], contactId: string): boolean => configs.some((c) => c.steps.some((s) => s.targetType === 'PERSON' && s.targetId === contactId));

/** The world as it would be after the change, for the health and send-limit checks (same functions as the editor's). */
function simulate(world: PagingWorld, customerId: string, op: ResponderOp, newContact?: Contact): PagingWorld {
  let responders: Responder[] = world.responders;
  const contacts = new Map(world.contacts);
  if (op.kind === 'add') responders = [...responders, { customerId, contactId: op.contactId, role: op.role, order: Number.MAX_SAFE_INTEGER }];
  if (op.kind === 'create' && newContact) { contacts.set(newContact.id, newContact); responders = [...responders, { customerId, contactId: newContact.id, role: op.role, order: Number.MAX_SAFE_INTEGER }]; }
  if (op.kind === 'role') responders = responders.map((r) => (r.customerId === customerId && r.contactId === op.contactId ? { ...r, role: op.role } : r));
  if (op.kind === 'remove') responders = responders.filter((r) => !(r.customerId === customerId && r.contactId === op.contactId));
  return { ...world, contacts, responders };
}

async function writeResponders(req: ApiRequest, deps: Deps, customerId: string, target: string | null, build: (ctx: {
  auth: AuthContext; state: RespondersState; world: PagingWorld; configs: PagingConfig[]; customer: { id: string; name: string };
}) => Promise<{ op: ResponderOp; label: string; newContact?: Contact }>): Promise<ApiResponse> {
  const auth = requireAuth(req);
  internalOnly(auth);
  const { customer } = await visibleCustomer(deps, auth, customerId, 'CUSTOMER');
  const [state, { configs, world }] = await Promise.all([deps.repo.respondersState(customer.id), deps.repo.pagingContext(customer.id)]);
  // An unknown contact and a contact that is not in this list are the same 404, before the role check (§2).
  if (target !== null && !state.entries.some((e) => e.contactId === target)) throw notFound();
  requireRole(auth, 'ADMIN');
  const version = ifMatch(req);
  if (version !== state.version) throw respondersConflict(state.version);
  const { op, label, newContact } = await build({ auth, state, world, configs, customer });
  const now = deps.now();
  const after = simulate(world, customer.id, op, newContact);

  // D-38: a write that makes the list longer is refused by the same rule as a call order save (sendCapViolation).
  if (op.kind === 'add' || op.kind === 'create' || op.kind === 'role') {
    for (const cfg of configs) {
      const was = sendCapViolation(cfg, world);
      const will = sendCapViolation(cfg, after);
      if (!was && will?.code === 'RESPONDER_LIMIT_EXCEEDED') {
        throw new ApiError(422, 'RESPONDER_LIMIT_EXCEEDED', `A step that pages everyone in Responders can reach at most ${will.limit} people.`, { field: 'contactId', responders: will.responders, limit: will.limit });
      }
      if (!was && will && will.code !== 'RESPONDER_LIMIT_EXCEEDED') throw new ApiError(422, 'SEND_CAP_EXCEEDED', 'With this person the call order would send too many notifications per incident.', { perCycle: will.perCycle, perHour: will.perHour, limits: will.limits });
    }
  }
  // Security review 권고 6: a change that leaves the customer UNREACHABLE needs the user's explicit confirmation.
  if ((op.kind === 'remove' || op.kind === 'role') && !truthy(q(req, 'confirmUnreachable'))) {
    const before = await healthOf(deps, customer.id, configs, world, now);
    const later = await healthOf(deps, customer.id, configs, after, now);
    if (before.level !== 'UNREACHABLE' && later.level === 'UNREACHABLE') {
      throw new ApiError(409, 'WOULD_BE_UNREACHABLE', op.kind === 'remove' ? `Without ${label}, nobody for ${customer.name} would be reached.` : `With ${label} as Notify only, nobody for ${customer.name} would be reached.`, { level: later.level });
    }
  }
  const audit = {
    at: now, customerId: customer.id, actorType: 'USER' as const, actorId: auth.userId, action: `responders.${op.kind}`, targetType: 'Responders',
    targetId: op.kind === 'create' ? '' : op.contactId, before: { version: state.version },
    // never an address or a number in the audit row (contact values live in Contact only)
    after: { version: state.version + 1, ...(op.kind === 'remove' ? {} : { role: op.role }) }, requestId: req.requestId,
  };
  const r = await deps.repo.writeResponders(customer.id, version, op, audit);
  if (r === 'CONFLICT') throw respondersConflict((await deps.repo.respondersState(customer.id)).version);
  if (r === 'EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', `${label} is already in Responders.`);
  if (r === 'GONE') throw notFound();
  return ok(r, { etag: `"${r.version}"` }, op.kind === 'add' || op.kind === 'create' ? 201 : 200);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9][0-9 -]{6,18}$/;

/** POST /customers/{id}/responders — `{ contactId, role? }` or a new customer person `{ name, email?, phone?, role, extras? }`. */
export function postResponder(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  return writeResponders(req, deps, customerId, null, async ({ state, customer }) => {
    const b = req.body;
    if (!isRecord(b)) throw invalid('body', 'Body must be a JSON object.');
    if (b.role !== undefined && !(ROLES as readonly unknown[]).includes(b.role)) throw invalid('role', 'role must be PAGEABLE or NOTIFY_ONLY.');
    if (typeof b.contactId === 'string') {
      const c = await deps.repo.getContact(b.contactId);
      // Another customer's person is the same 404 as an id that does not exist (security review 권고 3).
      if (!c || !c.active || (c.kind === 'CUSTOMER' && c.customerId !== customer.id)) throw notFound();
      if (state.entries.some((e) => e.contactId === c.id)) throw new ApiError(409, 'ALREADY_EXISTS', `${c.name} is already in Responders.`);
      const role: RRole = c.kind === 'INTERNAL' ? 'PAGEABLE' : ((b.role as RRole | undefined) ?? 'NOTIFY_ONLY');
      return { op: { kind: 'add', contactId: c.id, role }, label: c.name };
    }
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 80) throw invalid('name', 'name is required (at most 80 characters).');
    if (b.role === undefined) throw invalid('role', 'role is required.');
    const email = typeof b.email === 'string' && b.email.trim() ? b.email.trim() : null;
    const phone = typeof b.phone === 'string' && b.phone.trim() ? b.phone.trim() : null;
    if (!email && !phone) throw invalid('email', 'An email or a phone number is required.');
    if (email && (!EMAIL_RE.test(email) || email.length > 200)) throw invalid('email', 'email is not valid.');
    if (phone && !PHONE_RE.test(phone)) throw invalid('phone', 'phone is not valid.');
    const extrasRaw = b.extras === undefined ? [] : b.extras;
    if (!Array.isArray(extrasRaw) || extrasRaw.some((x) => x !== 'APPROVER' && x !== 'PORTAL_USER')) throw invalid('extras', 'extras must be a list of APPROVER, PORTAL_USER.');
    const extras = [...new Set(extrasRaw as Array<'APPROVER' | 'PORTAL_USER'>)];
    const role = b.role as RRole;
    const newContact: Contact = { id: '__new__', kind: 'CUSTOMER', customerId: customer.id, name, active: true, email, phone };
    return { op: { kind: 'create', name, email, phone, role, extras }, label: name, newContact };
  });
}

/** PATCH /customers/{id}/responders/{contactId} `{ role }` — customer people only. */
export function patchResponder(req: ApiRequest, deps: Deps, customerId: string, contactId: string): Promise<ApiResponse> {
  return writeResponders(req, deps, customerId, contactId, async ({ world, configs }) => {
    const c = world.contacts.get(contactId);
    if (!c || c.kind !== 'CUSTOMER') throw notFound();
    const b = req.body;
    if (!isRecord(b) || !(ROLES as readonly unknown[]).includes(b.role)) throw invalid('role', 'role must be PAGEABLE or NOTIFY_ONLY.');
    const role = b.role as RRole;
    if (role === 'NOTIFY_ONLY' && namedInSteps(configs, contactId)) throw new ApiError(409, 'IN_USE', `${c.name} is named in a step. Change the step first.`);
    return { op: { kind: 'role', contactId, role }, label: c.name };
  });
}

/** DELETE /customers/{id}/responders/{contactId} */
export function deleteResponder(req: ApiRequest, deps: Deps, customerId: string, contactId: string): Promise<ApiResponse> {
  return writeResponders(req, deps, customerId, contactId, async ({ state, world, configs }) => {
    const e = state.entries.find((x) => x.contactId === contactId)!;
    const name = world.contacts.get(contactId)?.name ?? contactId;
    if (e.source === 'TEMPLATE') throw new ApiError(409, 'FROM_TEMPLATE', `${name} comes from the template ${e.templateName ?? ''}. Change the template in Call order › Templates.`.replace(' .', '.'));
    if (namedInSteps(configs, contactId)) throw new ApiError(409, 'IN_USE', `${name} is named in a step. Change the step first.`);
    return { op: { kind: 'remove', contactId }, label: name };
  });
}

// ───────────────────────────── GET /rotations, GET /staff ─────────────────────────────

function rotationSummary(r: Rotation, w: RotationsWorld, now: Date) {
  const pw = { overrides: w.overrides, leaves: w.leaves };
  const oc = onCallAt(r, pw, now);
  const shift = shiftAt(r, now);
  const nextId = onCallAt(r, pw, shift.end).contactId;
  const c = oc.contactId ? w.contacts.get(oc.contactId) : undefined;
  return {
    id: r.id, scope: r.scope, ...(r.customerId ? { customerId: r.customerId } : {}), name: r.name,
    onShift: oc.contactId ? { contactId: oc.contactId, name: c?.name ?? oc.contactId, until: shift.end.toISOString(), channels: c ? channelStates(c, now) : {} } : null,
    next: nextId ? w.contacts.get(nextId)?.name ?? null : null,
  };
}

export async function listRotations(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  internalOnly(auth);
  const kind = q(req, 'scope');
  if (kind !== undefined && kind !== 'MSP' && kind !== 'CUSTOMER') throw invalid('scope', 'scope must be MSP or CUSTOMER.');
  const scope = scopeOf(auth);
  const customerId = q(req, 'customerId');
  if (customerId !== undefined) {
    const tree = await deps.repo.orgTree(scope);
    if (!tree.customers.some((c) => c.id === customerId)) throw notFound();
  }
  const w = await deps.repo.rotationsWorld(scope);
  const now = deps.now();
  const rows = w.rotations
    .filter((r) => (kind === undefined || r.scope === kind) && (customerId === undefined || r.scope === 'MSP' || r.customerId === customerId))
    .sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'MSP' ? -1 : 1))
    .map((r) => rotationSummary(r, w, now));
  return ok(rows);
}

export async function listStaff(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  internalOnly(auth);
  const needle = q(req, 'q')?.trim().toLowerCase();
  const now = deps.now();
  const rows = (await deps.repo.staffContacts())
    .filter((c) => !needle || c.name.toLowerCase().includes(needle))
    .map((c) => ({ contactId: c.id, name: c.name, channels: channelStates(c, now) }));
  return ok(rows);
}

// ───────────────────────────── GET /oncall/now (Call order list) ─────────────────────────────

const RANK = { UNREACHABLE: 0, AT_RISK: 1, OK: 2 } as const;

/**
 * One row per customer, per project / service with its own steps, and one for the asked node (inherited rows say
 * where from). Same resolution as /oncall/paging-path and the tick. `rotations[]`: who is on shift now.
 */
export async function getOncallNow(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  internalOnly(auth);
  const scope = scopeOf(auth);
  const onlyProblems = truthy(q(req, 'onlyProblems'));
  const node = await resolveNodeFilter(req, deps.repo, auth, scope);
  const [tree, counts, rw] = await Promise.all([deps.repo.orgTree(scope), deps.repo.openIncidentCounts(scope), deps.repo.rotationsWorld(scope)]);
  const now = deps.now();
  const customers = tree.customers.filter((c) => !node || node.customerIds.includes(c.id));
  const listed = [];
  for (const c of customers) {
    const ctx = await deps.repo.pagingContext(c.id);
    const health = await healthOf(deps, c.id, ctx.configs, ctx.world, now);
    const open = counts.some((x) => x.customerId === c.id && x.open > 0);
    if (onlyProblems && health.level === 'OK' && !open) continue;
    listed.push({ c, ctx, health });
  }
  listed.sort((a, b) => RANK[a.health.level] - RANK[b.health.level] || a.c.name.localeCompare(b.c.name));

  const rows = [];
  for (const { c, ctx, health } of listed) {
    const { configs, world } = ctx;
    const responderCount = world.responders.filter((r) => r.customerId === c.id && r.role === 'PAGEABLE' && isPageableFor(world, r.contactId)).length;
    const level = (cfg: PagingConfig | null) => {
      if (!cfg || cfg.scopeType === 'CUSTOMER') return { level: 'CUSTOMER' as const, id: c.id, name: c.name };
      const n = cfg.scopeType === 'PROJECT' ? tree.projects.find((p) => p.id === cfg.scopeId) : tree.services.find((s) => s.id === cfg.scopeId);
      return { level: cfg.scopeType, id: cfg.scopeId, name: n?.name ?? cfg.scopeId };
    };
    const ref = (n: { id: string; name: string; slug: string } | undefined) => (n ? { id: n.id, name: n.name, slug: n.slug } : null);
    const row = (cfg: PagingConfig | null, p: OrgTree['projects'][number] | undefined, s: OrgTree['services'][number] | undefined, own: boolean) => {
      const steps = cfg ? (pagingPath([cfg], { customerId: c.id, projectId: cfg.scopeType === 'PROJECT' ? cfg.scopeId : null, serviceId: cfg.scopeType === 'SERVICE' ? cfg.scopeId : null }, world, now)?.steps ?? []) : [];
      return {
        key: [c.slug, p?.slug, s?.slug].filter(Boolean).join('/'), org: { customer: ref(c), project: ref(p), service: ref(s) },
        level: s ? 'SERVICE' : p ? 'PROJECT' : 'CUSTOMER', own, inheritedFrom: own ? null : level(cfg),
        style: cfg?.style ?? 'CUSTOM', plan: cfg?.plan ?? 'STANDARD', edited: !!cfg && cfg.steps.length > 0 && cfg.edited,
        steps: steps.map((x) => pathStepOut(x, world)), repeatCount: cfg?.repeatCount ?? 1, responderCount,
        health: p ? null : { level: health.level, problems: health.problems.length, ...(health.problems[0] ? { first: health.problems[0].message } : {}) },
      };
    };
    const custCfg = configs.find((x) => x.scopeType === 'CUSTOMER' && x.scopeId === c.id) ?? null;
    const at = node && node.customerIds.length === 1 ? node : null;
    const out = [];
    out.push({ path: { customerId: c.id, projectId: null, serviceId: null }, r: row(custCfg, undefined, undefined, true) });
    for (const p of tree.projects.filter((x) => x.customerId === c.id).sort((a, b) => a.name.localeCompare(b.name))) {
      const inP = !at?.projectId || at.projectId === p.id;
      const pOv = configs.find((x) => x.scopeType === 'PROJECT' && x.scopeId === p.id) ?? null;
      if (inP && pOv) out.push({ path: { customerId: c.id, projectId: p.id, serviceId: null }, r: row(pOv, p, undefined, true) });
      else if (at?.projectId === p.id && !at.serviceId) out.push({ path: { customerId: c.id, projectId: p.id, serviceId: null }, r: row(custCfg, p, undefined, false) });
      for (const s of tree.services.filter((x) => x.projectId === p.id).sort((a, b) => a.name.localeCompare(b.name))) {
        const sOv = configs.find((x) => x.scopeType === 'SERVICE' && x.scopeId === s.id) ?? null;
        if (inP && (!at?.serviceId || at.serviceId === s.id) && sOv) out.push({ path: { customerId: c.id, projectId: p.id, serviceId: s.id }, r: row(sOv, p, s, true) });
        else if (at?.serviceId === s.id) out.push({ path: { customerId: c.id, projectId: p.id, serviceId: s.id }, r: row(pOv ?? custCfg, p, s, false) });
      }
    }
    // R-6: staff narrowed to a subtree see the rows of that subtree only (not the customer's own call order).
    for (const x of out) if (inScope(scope, x.path)) rows.push(x.r);
  }
  const rotations = rw.rotations.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'MSP' ? -1 : 1)).map((r) => rotationSummary(r, rw, now));
  return ok({ rotations, rows });
}
