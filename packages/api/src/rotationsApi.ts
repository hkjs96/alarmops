/**
 * Rotations (API-CONTRACT §8.3 "/rotations", D-28 shift handover, D-41 roles).
 * GET /rotations/{id}/shifts, GET /rotations/{id}/usage, POST /rotations, POST /rotations/{id}/preview, PATCH|DELETE /rotations/{id}.
 *
 * What happens to the person on shift when the order, the members or the handover time change is computed by ONE pure function
 * (`planRotationChange`, core) that the preview, the save and both stores use: `evaluateRotationChange` below.
 */
import {
  applyLeave, baseSegmentAt, handoverOf, kstDate, latestHandover, orderedMemberIds, planRotationChange, rotationPreviewHash,
  type Contact, type Handover, type RotationPlan,
} from '@alarmops/core';
import { customerWide, requireAuth, requireRole, scopeOf, seesCustomer, type AuthContext, type ScopeFilter } from './auth.js';
import { ApiError, ifMatch, invalid, isCleanId, isRecord, notFound, ok, q, validation, versionConflict, type ApiRequest, type ApiResponse } from './http.js';
import { rotationSummary } from './peopleApi.js';
import type { ApiRepository, RotationState, RotationUsageRow } from './repo.js';
import { busy } from './templatesApi.js';

interface Deps { repo: ApiRepository; now: () => Date }

export const ROTATION_NAME_MAX = 80;
export const ROTATION_MEMBERS_MAX = 50;
const DAY_MS = 86_400_000;
const SHIFTS_MAX_DAYS = 62;

// ───────────────────────────── the plan of a change (pure) ─────────────────────────────

export interface RotationProposal { name: string; members: string[] | null; handover: Handover | null }
export interface RotationEvaluation {
  plan: RotationPlan; previewHash: string; members: string[]; handover: Handover;
  membersChanged: boolean; handoverChanged: boolean; scheduleChanged: boolean; nameChanged: boolean;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Plan and hash of a proposal against a rotation as the store read it. Pure: the preview, the save and both stores call this. */
export function evaluateRotationChange(state: RotationState, p: RotationProposal, now: Date): RotationEvaluation {
  const r = state.rotation;
  const current = orderedMemberIds(r.members);
  const curH = handoverOf(r.cadence, r.anchorAt);
  const members = p.members ?? current;
  const membersChanged = p.members !== null && !sameList(p.members, current);
  const handoverChanged = p.handover !== null && (p.handover.minute !== curH.minute || (r.cadence === 'WEEKLY' && p.handover.dow !== curH.dow));
  const plan = planRotationChange({
    rotation: { cadence: r.cadence, anchorAt: r.anchorAt, members: r.members }, pins: r.pins ?? [],
    overrides: state.overrides.filter((o) => o.rotationId === r.id),
    proposal: { ...(p.members ? { members: p.members } : {}), ...(p.handover ? { handover: p.handover } : {}) }, now,
  });
  const handover = handoverOf(r.cadence, plan.anchorAt);
  const previewHash = rotationPreviewHash({
    rotationId: r.id, version: r.version ?? 0, proposal: { name: p.name, members, handover }, plan, customerIds: state.customers.map((c) => c.id),
  });
  return { plan, previewHash, members, handover, membersChanged, handoverChanged, scheduleChanged: membersChanged || handoverChanged, nameChanged: p.name !== r.name };
}

/** The body of GET /rotations/{id}/usage (and `details.usage` of IN_USE): customers by name, their steps by level then step. `shared` = the rotation is an MSP rotation shared by all customers. */
export function usageBody(rotationId: string, rows: RotationUsageRow[], shared: boolean) {
  const level = { CUSTOMER: 0, PROJECT: 1, SERVICE: 2 } as const;
  const by = new Map<string, { id: string; name: string; slug: string; status: string; steps: Array<{ pagingConfigId: string; level: string; scopeId: string; stepIndex: number; shared: boolean }> }>();
  for (const r of rows) {
    const c = by.get(r.customerId) ?? { id: r.customerId, name: r.customerName, slug: r.customerSlug, status: r.customerStatus, steps: [] };
    c.steps.push({ pagingConfigId: r.pagingConfigId, level: r.level, scopeId: r.scopeId, stepIndex: r.stepIndex, shared });
    by.set(r.customerId, c);
  }
  const customers = [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  for (const c of customers) c.steps.sort((a, b) => level[a.level as keyof typeof level] - level[b.level as keyof typeof level] || (a.scopeId < b.scopeId ? -1 : a.scopeId > b.scopeId ? 1 : 0) || a.stepIndex - b.stepIndex);
  return { rotationId, customers };
}

// ───────────────────────────── gates ─────────────────────────────

const narrowed = (auth: AuthContext): boolean => auth.customerIds !== '*' || (auth.subScopes?.length ?? 0) > 0;
const forbidden = (): ApiError => new ApiError(403, 'FORBIDDEN', 'Rotations shared by all customers need access to all customers.');
const staffOnly = (auth: AuthContext): void => { if (auth.kind !== 'INTERNAL') throw notFound(); };

/**
 * The write gate on an existing rotation (D-41): portal 404 → unknown id 404 → MSP rotation: narrowed staff 403 FORBIDDEN / CUSTOMER rotation: anyone who
 * does not have the whole customer gets the same 404 as for an unknown id → ROLE_REQUIRED (ADMIN). The caller reads If-Match and the body after it.
 */
async function writeGate(req: ApiRequest, deps: Deps, id: string): Promise<{ auth: AuthContext; state: RotationState; customerStatus: string | null }> {
  const auth = requireAuth(req);
  staffOnly(auth);
  const state = await deps.repo.rotationState(id);
  if (!state) throw notFound();
  const r = state.rotation;
  const scope = scopeOf(auth);
  let customerStatus: string | null = null;
  if (r.scope === 'CUSTOMER') {
    if (!r.customerId || !customerWide(scope, r.customerId)) throw notFound();
    customerStatus = (await deps.repo.orgTree(scope)).customers.find((c) => c.id === r.customerId)?.status ?? null;
    if (customerStatus === null) throw notFound();
  } else if (narrowed(auth)) throw forbidden();
  requireRole(auth, 'ADMIN');
  return { auth, state, customerStatus };
}

/** The read gate: portal 404; a CUSTOMER rotation outside the scope is the same 404 as an unknown id. */
async function readGate(req: ApiRequest, deps: Deps, id: string): Promise<{ auth: AuthContext; scope: ScopeFilter; state: RotationState }> {
  const auth = requireAuth(req);
  staffOnly(auth);
  const scope = scopeOf(auth);
  const state = await deps.repo.rotationState(id);
  if (!state) throw notFound();
  const r = state.rotation;
  if (r.scope === 'CUSTOMER' && (!r.customerId || !seesCustomer(scope, r.customerId))) throw notFound();
  return { auth, scope, state };
}

const terminated = (): ApiError => new ApiError(409, 'CUSTOMER_TERMINATED', 'A terminated customer keeps its data as it is.');

// ───────────────────────────── body readers ─────────────────────────────

function rejectUnknown(b: Record<string, unknown>, allowed: string[]): void {
  const bad = Object.keys(b).filter((k) => b[k] !== undefined && !allowed.includes(k));
  if (bad.length) throw validation(bad.map((field) => ({ field, message: 'Not accepted here.' })));
}
function readName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > ROTATION_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw invalid('name', `name is required (at most ${ROTATION_NAME_MAX} characters).`);
  return name;
}
function readMembers(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > ROTATION_MEMBERS_MAX) throw invalid('members', `members must be a list of 1-${ROTATION_MEMBERS_MAX} people.`);
  if (v.some((x) => !isCleanId(x))) throw invalid('members', 'members must be people who can be paged.');
  const ids = v as string[];
  if (new Set(ids).size !== ids.length) throw invalid('members', 'members must not repeat a person.');
  return ids;
}
function readHandover(v: unknown, cadence: 'DAILY' | 'WEEKLY'): Handover {
  if (!isRecord(v)) throw invalid('handover', 'handover must be an object with minute (and dow for WEEKLY).');
  const bad = Object.keys(v).filter((k) => v[k] !== undefined && k !== 'minute' && k !== 'dow');
  if (bad.length) throw validation(bad.map((k) => ({ field: `handover.${k}`, message: 'Not accepted here.' })));
  if (typeof v.minute !== 'number' || !Number.isInteger(v.minute) || v.minute < 0 || v.minute > 1439) throw invalid('handover.minute', 'minute must be a whole number from 0 to 1439 (minutes after midnight, Seoul time).');
  if (cadence === 'DAILY') {
    if (v.dow !== undefined) throw invalid('handover.dow', 'A daily rotation has no weekday.');
    return { minute: v.minute };
  }
  if (typeof v.dow !== 'number' || !Number.isInteger(v.dow) || v.dow < 0 || v.dow > 6) throw invalid('handover.dow', 'dow must be a whole number from 0 (Sunday) to 6 (Saturday).');
  return { minute: v.minute, dow: v.dow };
}
const readCadence = (v: unknown): 'DAILY' | 'WEEKLY' => {
  if (v !== 'DAILY' && v !== 'WEEKLY') throw invalid('cadence', 'cadence must be DAILY or WEEKLY.');
  return v;
};

/** name / members / handover of PATCH and preview. cadence may be sent but must equal the stored one (a different one: build a new rotation). */
async function readChange(req: ApiRequest, deps: Deps, state: RotationState, extra: string[]): Promise<{ proposal: RotationProposal; body: Record<string, unknown> }> {
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = req.body;
  rejectUnknown(b, ['name', 'members', 'handover', 'cadence', ...extra]);
  const r = state.rotation;
  if (b.cadence !== undefined && readCadence(b.cadence) !== r.cadence) throw invalid('cadence', 'The cadence of a rotation does not change. Create a new rotation instead.');
  if (b.name === undefined && b.members === undefined && b.handover === undefined) throw invalid('members', 'name, members or handover is required.');
  const name = b.name === undefined ? r.name : readName(b.name);
  const members = b.members === undefined ? null : readMembers(b.members);
  const handover = b.handover === undefined ? null : readHandover(b.handover, r.cadence);
  // only people being added are checked: a rename (or an order change) must not fail because an existing member was deactivated since
  if (members) {
    const have = new Set(r.members.map((m) => m.contactId));
    const added = members.filter((id) => !have.has(id));
    if (added.length && !(await deps.repo.rotationMembersOk(r.customerId, added))) throw invalid('members', 'members must be active people who can be paged for this rotation.');
  }
  return { proposal: { name, members, handover }, body: b };
}

const nameOf = (contacts: Map<string, Contact>, id: string | null): string | null => (id ? contacts.get(id)?.name ?? id : null);

// ───────────────────────────── reads ─────────────────────────────

/** GET /rotations/{id}/shifts?from=&to= — the base timetable (pins included), with Override requests and Leave shown on the rows they touch. */
export async function getRotationShifts(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const { state } = await readGate(req, deps, id);
  const r = state.rotation;
  const now = deps.now();
  const iso = (v: string | undefined, field: string): number | undefined => {
    if (v === undefined) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v) || Number.isNaN(Date.parse(v))) throw invalid(field, `${field} must be an ISO 8601 time.`);
    return Date.parse(v);
  };
  const from = iso(q(req, 'from'), 'from') ?? now.getTime();
  const to = iso(q(req, 'to'), 'to') ?? from + (r.cadence === 'DAILY' ? 8 : 28) * DAY_MS;
  if (to <= from) throw invalid('to', 'to must be later than from.');
  if (to - from > SHIFTS_MAX_DAYS * DAY_MS) throw invalid('to', `The range is at most ${SHIFTS_MAX_DAYS} days.`);
  const nm = (cid: string | null) => (cid ? { contactId: cid, name: nameOf(state.contacts, cid)! } : null);
  const rows = [];
  for (let t = from; t < to && rows.length < 400;) {
    const seg = baseSegmentAt(r, new Date(t));
    const a = seg.start.getTime(); const b = seg.end.getTime();
    const overrides = state.overrides
      .filter((o) => o.rotationId === r.id && (o.status === 'PENDING' || o.status === 'ACCEPTED') && o.startAt.getTime() < b && o.endAt.getTime() > a)
      .sort((x, y) => x.startAt.getTime() - y.startAt.getTime())
      .map((o) => ({ contactId: o.contactId, name: nameOf(state.contacts, o.contactId), startAt: o.startAt.toISOString(), endAt: o.endAt.toISOString(), kind: o.kind ?? 'COVER', status: o.status }));
    const d0 = kstDate(seg.start); const d1 = kstDate(new Date(b - 1));
    const leave = seg.contactId ? state.leaves.find((l) => !l.cancelledAt && l.contactId === seg.contactId && l.startDate <= d1 && d0 <= l.endDate) : undefined;
    const replacement = leave ? applyLeave(state.leaves, seg.contactId!, new Date(Math.max(a, Date.parse(`${leave.startDate}T00:00:00+09:00`)))) : null;
    rows.push({
      start: seg.start.toISOString(), end: seg.end.toISOString(), contactId: seg.contactId, name: nameOf(state.contacts, seg.contactId), scheduled: nm(seg.contactId), pinned: seg.pinned, overrides,
      ...(leave ? { leave: { startDate: leave.startDate, endDate: leave.endDate, replacement: nm(replacement) } } : {}),
    });
    t = b;
  }
  return ok({ rotationId: r.id, version: r.version ?? 0, cadence: r.cadence, handover: handoverOf(r.cadence, r.anchorAt), from: new Date(from).toISOString(), to: new Date(to).toISOString(), rows });
}

/** GET /rotations/{id}/usage — who pages this rotation (customers, call-order nodes, step numbers), only what the caller may see. */
export async function getRotationUsage(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const { scope, state } = await readGate(req, deps, id);
  const rows = await deps.repo.rotationUsage(id, scope);
  return ok(usageBody(state.rotation.id, rows, state.rotation.scope === 'MSP'));
}

// ───────────────────────────── POST /rotations ─────────────────────────────

export async function createRotation(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  staffOnly(auth);
  const scope = scopeOf(auth);
  const wide = !narrowed(auth);
  // Staff who see every customer have nothing to hide: the role comes first, before the body is read (D-41 table).
  if (wide) requireRole(auth, 'ADMIN');
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = req.body;
  if (b.scope !== 'MSP' && b.scope !== 'CUSTOMER') throw invalid('scope', 'scope must be MSP or CUSTOMER.');
  let customerStatus: string | null = null;
  if (b.scope === 'MSP') {
    if (!wide) throw forbidden();
  } else {
    if (!isCleanId(b.customerId)) throw invalid('customerId', 'customerId is required for a customer rotation.');
    const customer = (await deps.repo.orgTree(scope)).customers.find((c) => c.id === b.customerId);
    if (!customer || !customerWide(scope, customer.id)) throw notFound();
    customerStatus = customer.status;
    requireRole(auth, 'ADMIN');
  }
  rejectUnknown(b, ['scope', 'customerId', 'name', 'cadence', 'handover', 'members']);
  if (b.scope === 'MSP' && b.customerId !== undefined) throw invalid('customerId', 'An MSP rotation belongs to no customer.');
  const name = readName(b.name);
  const cadence = readCadence(b.cadence);
  const handover = readHandover(b.handover, cadence);
  const members = readMembers(b.members);
  const customerId = b.scope === 'CUSTOMER' ? (b.customerId as string) : null;
  if (!(await deps.repo.rotationMembersOk(customerId, members))) throw invalid('members', 'members must be active people who can be paged for this rotation.');
  if (customerStatus === 'TERMINATED') throw terminated();
  const now = deps.now();
  const anchorAt = latestHandover(cadence, handover, now);
  const r = await deps.repo.createRotation({ scope: b.scope, customerId, name, cadence, anchorAt, members, actorId: auth.userId, at: now }, {
    at: now, actorType: 'USER', actorId: auth.userId, action: 'rotation.create', targetType: 'Rotation',
    before: null, after: { scope: b.scope, name, cadence, handover: handoverOf(cadence, anchorAt), anchorAt: anchorAt.toISOString(), memberIds: members }, requestId: req.requestId,
  });
  if (r === 'BUSY') throw busy();
  if (r === 'NAME_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'A rotation with that name already exists.');
  if (r === 'BAD_MEMBER') throw invalid('members', 'members must be active people who can be paged for this rotation.');
  if (r === 'CUSTOMER_TERMINATED') throw terminated();
  const state = await deps.repo.rotationState(r.id);
  if (!state) throw notFound();
  return ok(rotationSummary(state.rotation, state, now), { etag: `"${state.rotation.version ?? 0}"` }, 201);
}

// ───────────────────────────── preview, PATCH, DELETE ─────────────────────────────

const pers = (state: RotationState, id: string | null) => (id ? { contactId: id, name: nameOf(state.contacts, id)! } : null);

/** POST /rotations/{id}/preview — what a change does, row by row (old and new timetable), writes nothing. */
export async function previewRotation(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const { state: first } = await writeGate(req, deps, id);
  const { proposal } = await readChange(req, deps, first, []);
  const state = (await deps.repo.rotationState(id, proposal.members ?? [])) ?? first;
  const ev = evaluateRotationChange(state, proposal, deps.now());
  const seg = (s: { start: Date; end: Date; contactId: string | null } | null) => (s ? { contactId: s.contactId, name: nameOf(state.contacts, s.contactId), start: s.start.toISOString(), end: s.end.toISOString() } : null);
  return ok({
    rotationId: id, version: state.rotation.version ?? 0, handover: ev.handover, anchorAt: ev.plan.anchorAt.toISOString(),
    rows: ev.plan.rows.map((r) => ({ start: r.start.toISOString(), end: r.end.toISOString(), before: pers(state, r.before), after: pers(state, r.after), kept: r.kept, changed: r.changed })),
    nextShift: { before: seg(ev.plan.nextShift.before), after: seg(ev.plan.nextShift.after) },
    pins: ev.plan.pins.map((p) => ({ contactId: p.contactId, name: nameOf(state.contacts, p.contactId), startAt: p.startAt.toISOString(), endAt: p.endAt.toISOString(), reason: p.reason })),
    customers: state.customers,
    totals: { customers: state.customers.length, changedRows: ev.plan.changedRows, pins: ev.plan.pins.length },
    previewHash: ev.previewHash,
  });
}

export async function patchRotation(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const { auth, state, customerStatus } = await writeGate(req, deps, id);
  const r = state.rotation;
  const version = ifMatch(req);
  if (version !== (r.version ?? 0)) throw versionConflict('The rotation', r.version ?? 0);
  const { proposal, body } = await readChange(req, deps, state, ['previewHash']);
  const touchesSchedule = body.members !== undefined || body.handover !== undefined;
  let hash: string | null = null;
  if (body.previewHash !== undefined || (touchesSchedule && r.scope === 'MSP')) {
    if (typeof body.previewHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.previewHash)) throw invalid('previewHash', 'previewHash from the preview of this change is required.');
    hash = body.previewHash;
  }
  if (customerStatus === 'TERMINATED') throw terminated();
  const now = deps.now();
  const ev = evaluateRotationChange(state, proposal, now);
  const reply = async (affected: number): Promise<ApiResponse> => {
    const fresh = await deps.repo.rotationState(id);
    if (!fresh) throw notFound();
    return ok({ ...rotationSummary(fresh.rotation, fresh, now), affected }, { etag: `"${fresh.rotation.version ?? 0}"` });
  };
  if (!ev.scheduleChanged && !ev.nameChanged) return reply(0);
  const out = await deps.repo.updateRotation({ id, expectedVersion: version, name: proposal.name, members: proposal.members, handover: proposal.handover, previewHash: hash, actorId: auth.userId, at: now }, {
    at: now, actorType: 'USER', actorId: auth.userId, action: 'rotation.update', targetType: 'Rotation', before: null, after: null, requestId: req.requestId,
  });
  if (out === 'BUSY') throw busy();
  if (out === 'NOT_FOUND') throw notFound();
  if (out === 'NOOP') return reply(0);
  if (out === 'NAME_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'A rotation with that name already exists.');
  if (out === 'BAD_MEMBER') throw invalid('members', 'members must be active people who can be paged for this rotation.');
  if (out === 'CONFLICT' || out === 'STALE') {
    const latest = await deps.repo.rotationState(id);
    if (!latest) throw notFound();
    const cur = latest.rotation.version ?? 0;
    if (out === 'CONFLICT') throw versionConflict('The rotation', cur);
    throw new ApiError(409, 'PREVIEW_STALE', 'The rotation, its cover requests or the customers that use it changed after the preview. Preview again.', { currentVersion: cur });
  }
  return reply(out.affected);
}

export async function deleteRotation(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const { auth, state, customerStatus } = await writeGate(req, deps, id);
  const version = ifMatch(req);
  if (version !== (state.rotation.version ?? 0)) throw versionConflict('The rotation', state.rotation.version ?? 0);
  if (customerStatus === 'TERMINATED') throw terminated();
  const now = deps.now();
  const out = await deps.repo.deleteRotation(id, version, {
    at: now, actorType: 'USER', actorId: auth.userId, action: 'rotation.delete', targetType: 'Rotation', before: null, after: null, requestId: req.requestId,
  });
  if (out === 'BUSY') throw busy();
  if (out === 'NOT_FOUND') throw notFound();
  if (out === 'CONFLICT') throw versionConflict('The rotation', (await deps.repo.rotationState(id))?.rotation.version ?? 0);
  if (typeof out === 'object') throw new ApiError(409, 'IN_USE', 'Customers still page this rotation. Change their call orders first.', { usage: usageBody(id, out.inUse, state.rotation.scope === 'MSP') });
  return ok({ id, deleted: true });
}
