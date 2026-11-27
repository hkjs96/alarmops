/**
 * Responder templates (API-CONTRACT §8.3 "Responder 템플릿", D-31 개정, D-33, D-41).
 * GET/POST /responder-templates, PATCH /responder-templates/{id}, POST /responder-templates/{id}/preview.
 *
 * A template is MSP-level: staff who see every customer (portal users: the one 404; narrowed staff: 403). The impact of a
 * change is computed by ONE pure function (`planTemplateChange`) that the preview, the save and the stores all use, so the
 * `previewHash` of a preview and the hash re-computed inside the save transaction are the same thing.
 */
import { createHash } from 'node:crypto';
import { pagingHealth, resolvePagingConfig, sendCapViolation, type PagingWorld } from '@alarmops/core';
import { requireAuth, requireRole, type AuthContext } from './auth.js';
import { ApiError, ifMatch, invalid, isCleanId, isRecord, notFound, ok, validation, versionConflict, type ApiRequest, type ApiResponse } from './http.js';
import { visibleCustomer } from './pagingApi.js';
import type { ApiRepository, ResponderTemplateView, TemplateAttachInput, TemplateAttachPlan, TemplateBlockReason, TemplateBlocking, TemplateEffect, TemplateImpactInput, TemplatePaging, TemplatePlan, TemplateProposal } from './repo.js';

interface Deps { repo: ApiRepository; now: () => Date }

export const TEMPLATE_NAME_MAX = 80;
export const TEMPLATE_MEMBERS_MAX = 50;

const staffOnly = (auth: AuthContext): void => {
  if (auth.kind !== 'INTERNAL') throw notFound();
  // A template change reaches customers outside a narrowed range: only staff who see every customer (D-33 "MSP 전체 변경").
  if (auth.customerIds !== '*') throw new ApiError(403, 'FORBIDDEN', 'Responder templates need access to all customers.');
};

// ───────────────────────────── the impact of a change (pure) ─────────────────────────────

const stable = (v: unknown): string =>
  v === undefined ? 'null' : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : v !== null && typeof v === 'object' ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v) ?? 'null';

const KIND_RANK: Record<TemplateEffect['kind'], number> = { JOINS: 0, LEAVES: 1, STEP_NAMES: 2, STAYS_DIRECT: 3, ALREADY_DIRECT: 4 };
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What saving `proposal` would do to every customer that uses the template (the caller passes non-terminated customers only).
 * - added member: JOINS when the customer has no row for the person; ALREADY_DIRECT when the person was added directly (the row stays DIRECT).
 * - removed member: LEAVES when the row came from THIS template (+ STEP_NAMES when a PERSON step still names the person);
 *   STAYS_DIRECT when the person is a direct row (kept).
 */
export function planTemplateChange(input: TemplateImpactInput, proposal: TemplateProposal): TemplatePlan {
  const oldSet = new Set(input.members);
  const newSet = new Set(proposal.members);
  const added = [...newSet].filter((c) => !oldSet.has(c)).sort(byId);
  const removed = [...oldSet].filter((c) => !newSet.has(c)).sort(byId);
  const nameOf = (id: string): string => input.names[id] ?? id;
  const customers = [...input.customers].sort((a, b) => a.name.localeCompare(b.name) || byId(a.id, b.id)).map((c) => {
    const rowOf = (id: string) => c.responders.find((r) => r.contactId === id);
    const effects: TemplateEffect[] = [];
    for (const id of added) {
      const row = rowOf(id);
      if (!row) effects.push({ kind: 'JOINS', contactId: id, name: nameOf(id) });
      else if (row.source === 'DIRECT') effects.push({ kind: 'ALREADY_DIRECT', contactId: id, name: nameOf(id) });
    }
    for (const id of removed) {
      const row = rowOf(id);
      if (!row) continue;
      if (row.source === 'TEMPLATE' && row.templateId === input.templateId) {
        effects.push({ kind: 'LEAVES', contactId: id, name: nameOf(id) });
        const named = c.namedSteps.filter((s) => s.contactId === id).map((s) => s.stepIndex).sort((a, b) => a - b)[0];
        if (named !== undefined) effects.push({ kind: 'STEP_NAMES', contactId: id, name: nameOf(id), stepIndex: named });
      } else if (row.source === 'DIRECT') effects.push({ kind: 'STAYS_DIRECT', contactId: id, name: nameOf(id) });
    }
    effects.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name) || byId(a.contactId, b.contactId));
    return { id: c.id, name: c.name, effects };
  });
  const count = (k: TemplateEffect['kind']) => customers.reduce((n, c) => n + c.effects.filter((e) => e.kind === k).length, 0);
  const totals = { customers: customers.length, affected: customers.filter((c) => c.effects.some((e) => e.kind === 'JOINS' || e.kind === 'LEAVES')).length, joins: count('JOINS'), leaves: count('LEAVES'), warnings: count('STEP_NAMES') };
  const previewHash = createHash('sha256').update(stable({
    templateId: input.templateId, version: input.version, name: proposal.name, members: [...newSet].sort(byId),
    customers: customers.map((c) => ({ id: c.id, effects: c.effects.map((e) => ({ kind: e.kind, contactId: e.contactId, stepIndex: e.stepIndex ?? null })) })),
  })).digest('hex');
  return { customers, totals, previewHash, added, removed };
}

// ───────────────────────────── what a change must not do (D-64) ─────────────────────────────

/**
 * Reasons the list change `joins`/`leaves` of ONE customer is refused: the customer's call-order health (the function behind
 * /paging-health and the tree's callHealth) goes from not-UNREACHABLE to UNREACHABLE, or a call order newly breaks a D-38 limit
 * (the check of the Responders writes). A customer that is already UNREACHABLE (no call order yet) is not blocked.
 */
export function blockReasons(customerId: string, paging: TemplatePaging | undefined, joins: string[], leaves: string[], now: Date): TemplateBlockReason[] {
  if (!paging || (!joins.length && !leaves.length)) return [];
  const w = paging.world;
  const after: PagingWorld = {
    ...w,
    responders: [
      ...w.responders.filter((r) => !(r.customerId === customerId && leaves.includes(r.contactId))),
      ...joins.map((contactId) => ({ customerId, contactId, role: 'PAGEABLE' as const, order: Number.MAX_SAFE_INTEGER })),
    ],
  };
  const cfg = resolvePagingConfig(paging.configs, { customerId })?.config ?? null;
  const opts = { slackChannelVerified: paging.slackVerified };
  const reasons: TemplateBlockReason[] = [];
  if (pagingHealth(cfg, w, now, opts).level !== 'UNREACHABLE' && pagingHealth(cfg, after, now, opts).level === 'UNREACHABLE') reasons.push('UNREACHABLE');
  for (const c of paging.configs) {
    const was = sendCapViolation(c, w);
    const will = sendCapViolation(c, after);
    if (!was && will && !reasons.includes(will.code)) reasons.push(will.code);
  }
  return reasons;
}

const flat = (byCustomer: Array<{ customerId: string; reasons: TemplateBlockReason[] }>): TemplateBlocking[] =>
  byCustomer.flatMap((x) => x.reasons.map((reason) => ({ customerId: x.customerId, reason })));

/** The blocking list of a template save (input and plan as `planTemplateChange` got them), customer id order. */
export function templateBlocking(input: TemplateImpactInput, plan: TemplatePlan, now: Date): TemplateBlocking[] {
  return flat(plan.customers.map((c) => ({
    customerId: c.id,
    reasons: blockReasons(c.id, input.customers.find((x) => x.id === c.id)?.paging,
      c.effects.filter((e) => e.kind === 'JOINS').map((e) => e.contactId), c.effects.filter((e) => e.kind === 'LEAVES').map((e) => e.contactId), now),
  }))).sort((a, b) => byId(a.customerId, b.customerId));
}

/** The error of a refused change: UNREACHABLE first (409), else the D-38 limit (422). */
export function blockedError(blocking: TemplateBlocking[]): ApiError {
  const ids = (reason: TemplateBlockReason) => [...new Set(blocking.filter((b) => b.reason === reason).map((b) => b.customerId))].sort(byId);
  if (blocking.some((b) => b.reason === 'UNREACHABLE')) {
    return new ApiError(409, 'WOULD_BE_UNREACHABLE', 'After this change nobody could be reached for at least one customer.', { customerIds: ids('UNREACHABLE'), blocking });
  }
  const reason: TemplateBlockReason = blocking.some((b) => b.reason === 'RESPONDER_LIMIT_EXCEEDED') ? 'RESPONDER_LIMIT_EXCEEDED' : 'SEND_CAP_EXCEEDED';
  return new ApiError(422, reason, reason === 'RESPONDER_LIMIT_EXCEEDED'
    ? 'After this change a step that pages everyone in Responders would reach more people than the limit allows.'
    : 'After this change a call order would send too many notifications per incident.', { customerIds: ids(reason), blocking });
}

export const busy = (): ApiError => new ApiError(503, 'BUSY', 'The system was busy with another change. Send the same request again.', { retryAfterSec: 1 }, { 'retry-after': '1' });

// ───────────────────────────── attach / detach / switch one customer (D-64) ─────────────────────────────

const hashAttach = (input: TemplateAttachInput, effects: TemplateEffect[]): string => createHash('sha256').update(stable({
  customerId: input.customer.id, from: input.from?.id ?? null, to: input.to?.id ?? null, toVersion: input.to?.version ?? null,
  effects: effects.map((e) => ({ kind: e.kind, contactId: e.contactId, stepIndex: e.stepIndex ?? null })),
})).digest('hex');

/**
 * What giving the customer `input.to` (instead of `input.from`) does to its Responders list. Pure — preview, save and stores share it.
 * - leaving: the customer's rows of the OLD template for people who are not in the new one → LEAVES (+ STEP_NAMES); a DIRECT row of an old member → STAYS_DIRECT.
 * - people in both templates keep their row; it moves to the new template (`retarget`, no list change, no effect).
 * - joining: a new member without a row → JOINS; with a DIRECT row → ALREADY_DIRECT (the row stays DIRECT).
 */
export function planTemplateAttach(input: TemplateAttachInput): TemplateAttachPlan {
  const { customer: c, from, to } = input;
  const nameOf = (id: string): string => input.names[id] ?? id;
  const rowOf = (id: string) => c.responders.find((r) => r.contactId === id);
  const effects: TemplateEffect[] = [];
  const leaves: string[] = [];
  const retarget: string[] = [];
  const joins: string[] = [];
  if ((from?.id ?? null) === (to?.id ?? null)) return { effects, joins, leaves, retarget, totals: { joins: 0, leaves: 0, warnings: 0 }, previewHash: hashAttach(input, effects) };
  const oldIds = from?.members ?? [];
  const newIds = to?.members ?? [];
  for (const id of [...oldIds].sort(byId)) {
    const row = rowOf(id);
    if (!row) continue;
    if (row.source === 'TEMPLATE' && row.templateId === from!.id) {
      if (newIds.includes(id)) { retarget.push(id); continue; }
      leaves.push(id);
      effects.push({ kind: 'LEAVES', contactId: id, name: nameOf(id) });
      const named = c.namedSteps.filter((s) => s.contactId === id).map((s) => s.stepIndex).sort((a, b) => a - b)[0];
      if (named !== undefined) effects.push({ kind: 'STEP_NAMES', contactId: id, name: nameOf(id), stepIndex: named });
    } else if (row.source === 'DIRECT' && !newIds.includes(id)) effects.push({ kind: 'STAYS_DIRECT', contactId: id, name: nameOf(id) });
  }
  for (const id of [...newIds].sort(byId)) {
    if (retarget.includes(id)) continue;
    const row = rowOf(id);
    if (!row) { joins.push(id); effects.push({ kind: 'JOINS', contactId: id, name: nameOf(id) }); }
    else if (row.source === 'DIRECT') effects.push({ kind: 'ALREADY_DIRECT', contactId: id, name: nameOf(id) });
  }
  effects.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name) || byId(a.contactId, b.contactId));
  const count = (k: TemplateEffect['kind']) => effects.filter((e) => e.kind === k).length;
  return { effects, joins, leaves, retarget, totals: { joins: joins.length, leaves: leaves.length, warnings: count('STEP_NAMES') }, previewHash: hashAttach(input, effects) };
}

export function attachBlocking(input: TemplateAttachInput, plan: TemplateAttachPlan, now: Date): TemplateBlocking[] {
  return flat([{ customerId: input.customer.id, reasons: blockReasons(input.customer.id, input.customer.paging, plan.joins, plan.leaves, now) }]);
}

// ───────────────────────────── helpers ─────────────────────────────

function readName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > TEMPLATE_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw invalid('name', `name is required (at most ${TEMPLATE_NAME_MAX} characters).`);
  return name;
}

function readMembers(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > TEMPLATE_MEMBERS_MAX) throw invalid('members', `members must be a list of 1-${TEMPLATE_MEMBERS_MAX} staff contact ids.`);
  if (v.some((x) => !isCleanId(x))) throw invalid('members', 'members must be active MSP staff.');
  const ids = v as string[];
  if (new Set(ids).size !== ids.length) throw invalid('members', 'members must not repeat a person.');
  return ids;
}

/** Unknown ids, customer people and inactive contacts all give the same 400 (no id of another tenant is confirmed). */
async function assertStaff(deps: Deps, ids: string[]): Promise<void> {
  const staff = new Set((await deps.repo.staffContacts()).map((c) => c.id));
  if (ids.some((id) => !staff.has(id))) throw invalid('members', 'members must be active MSP staff.');
}

async function view(deps: Deps, t: ResponderTemplateView) {
  const by = t.updatedBy ? (await deps.repo.staffNames([t.updatedBy])).get(t.updatedBy) : undefined;
  return {
    id: t.id, name: t.name, version: t.version, updatedAt: t.updatedAt.toISOString(), ...(by ? { updatedByName: by } : {}),
    members: t.members.map((m) => ({ contactId: m.contactId, name: m.name })), customers: t.customers.map((c) => ({ id: c.id, name: c.name })),
  };
}

const rejectUnknown = (b: Record<string, unknown>, allowed: string[]): void => {
  const bad = Object.keys(b).filter((k) => b[k] !== undefined && !allowed.includes(k));
  if (bad.length) throw validation(bad.map((field) => ({ field, message: 'Not accepted here.' })));
};

async function readProposal(req: ApiRequest, deps: Deps, cur: ResponderTemplateView, extra: string[] = []): Promise<TemplateProposal> {
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = req.body;
  rejectUnknown(b, ['name', 'members', ...extra]);
  if (b.name === undefined && b.members === undefined) throw invalid('members', 'name or members is required.');
  const name = b.name === undefined ? cur.name : readName(b.name);
  const members = b.members === undefined ? cur.members.map((m) => m.contactId) : readMembers(b.members);
  if (b.members !== undefined) await assertStaff(deps, members);
  return { name, members };
}

// ───────────────────────────── endpoints ─────────────────────────────

export async function listTemplates(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  staffOnly(auth);
  const rows = await deps.repo.listResponderTemplates();
  return ok(await Promise.all(rows.map((t) => view(deps, t))));
}

export async function createTemplate(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  staffOnly(auth);
  requireRole(auth, 'ADMIN');
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  rejectUnknown(req.body, ['name', 'members']);
  const name = readName(req.body.name);
  const members = readMembers(req.body.members);
  await assertStaff(deps, members);
  const now = deps.now();
  const r = await deps.repo.createResponderTemplate({ name, members, actorId: auth.userId, at: now }, {
    at: now, customerId: null, actorType: 'USER', actorId: auth.userId, action: 'responder_template.create', targetType: 'ResponderTemplate', targetId: '',
    before: null, after: { name, members: [...members].sort(byId), version: 0 }, requestId: req.requestId,
  });
  if (r === 'NAME_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'A template with that name already exists.');
  if (r === 'BAD_MEMBER') throw invalid('members', 'members must be active MSP staff.');
  return ok(await view(deps, r), { etag: `"${r.version}"` }, 201);
}

export async function previewTemplate(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  staffOnly(auth);
  const cur = await deps.repo.getResponderTemplate(id);
  if (!cur) throw notFound();
  requireRole(auth, 'ADMIN');
  const proposal = await readProposal(req, deps, cur);
  const input = await deps.repo.responderTemplateImpactInput(id, proposal.members);
  if (!input) throw notFound();
  const plan = planTemplateChange(input, proposal);
  return ok({ templateId: id, version: input.version, customers: plan.customers, totals: plan.totals, blocking: templateBlocking(input, plan, deps.now()), previewHash: plan.previewHash });
}

export async function patchTemplate(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  staffOnly(auth);
  const cur = await deps.repo.getResponderTemplate(id);
  if (!cur) throw notFound();
  requireRole(auth, 'ADMIN');
  const version = ifMatch(req);
  if (version !== cur.version) throw versionConflict('The template', cur.version);
  const proposal = await readProposal(req, deps, cur, ['previewHash']);
  const hash = (req.body as Record<string, unknown>).previewHash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw invalid('previewHash', 'previewHash from the preview of this change is required.');
  const sameMembers = proposal.members.length === cur.members.length && cur.members.every((m) => proposal.members.includes(m.contactId));
  if (proposal.name === cur.name && sameMembers) return ok({ ...(await view(deps, cur)), affected: 0 }, { etag: `"${cur.version}"` });
  const now = deps.now();
  const r = await deps.repo.updateResponderTemplate({ id, expectedVersion: version, proposal, previewHash: hash, actorId: auth.userId, at: now }, {
    at: now, customerId: null, actorType: 'USER', actorId: auth.userId, action: 'responder_template.update', targetType: 'ResponderTemplate', targetId: id,
    before: null, after: null, requestId: req.requestId,
  });
  if (r === 'BUSY') throw busy();
  if (typeof r === 'object' && 'blocking' in r) throw blockedError(r.blocking);
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'CONFLICT' || r === 'STALE') {
    const latest = await deps.repo.getResponderTemplate(id);
    if (!latest) throw notFound();
    if (r === 'CONFLICT') throw versionConflict('The template', latest.version);
    throw new ApiError(409, 'PREVIEW_STALE', 'The template or the customers changed after the preview. Preview again.', { currentVersion: latest.version });
  }
  if (r === 'NAME_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'A template with that name already exists.');
  if (r === 'BAD_MEMBER') throw invalid('members', 'members must be active MSP staff.');
  return ok({ ...(await view(deps, r.view)), affected: r.affected }, { etag: `"${r.view.version}"` });
}

// ───────────────────────────── POST/PUT /customers/{id}/responders/template (D-64) ─────────────────────────────

/** The same gate for both: portal 404 → narrow staff 403 → unknown customer 404 → ADMIN 403. Returns the customer. */
async function attachGate(req: ApiRequest, deps: Deps, customerId: string) {
  const auth = requireAuth(req);
  staffOnly(auth);
  const { customer } = await visibleCustomer(deps, auth, customerId, 'CUSTOMER');
  requireRole(auth, 'ADMIN');
  return { auth, customer };
}

function readTarget(body: unknown, extra: string[]): string | null {
  if (!isRecord(body)) throw invalid('body', 'Body must be a JSON object.');
  rejectUnknown(body, ['templateId', ...extra]);
  const t = body.templateId;
  if (t === null) return null;
  if (!isCleanId(t)) throw invalid('templateId', 'templateId must be a template id or null.');
  return t;
}

async function attachInput(deps: Deps, customerId: string, to: string | null): Promise<TemplateAttachInput> {
  const input = await deps.repo.customerTemplateAttachInput(customerId, to);
  if (input === null) throw notFound();
  if (input === 'NO_TEMPLATE') throw invalid('templateId', 'Unknown template.');
  if (input.customer.status === 'TERMINATED') throw new ApiError(409, 'CUSTOMER_TERMINATED', 'A terminated customer keeps its data as it is.');
  return input;
}

const ref = (t: { id: string; name: string } | null) => (t ? { id: t.id, name: t.name } : null);

export async function previewCustomerTemplate(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { customer } = await attachGate(req, deps, customerId);
  const to = readTarget(req.body, []);
  const input = await attachInput(deps, customer.id, to);
  const plan = planTemplateAttach(input);
  return ok({
    customerId: customer.id, version: input.customer.version, from: ref(input.from), to: ref(input.to), effects: plan.effects, totals: plan.totals,
    blocking: attachBlocking(input, plan, deps.now()), previewHash: plan.previewHash,
  });
}

export async function putCustomerTemplate(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { auth, customer } = await attachGate(req, deps, customerId);
  const version = ifMatch(req);
  const to = readTarget(req.body, ['previewHash']);
  const hash = (req.body as Record<string, unknown>).previewHash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw invalid('previewHash', 'previewHash from the preview of this change is required.');
  const input = await attachInput(deps, customer.id, to);
  if (version !== input.customer.version) throw versionConflict('The Responders', input.customer.version);
  if ((input.from?.id ?? null) === (input.to?.id ?? null)) return ok({ customerId: customer.id, templateId: to, version: input.customer.version, joins: 0, leaves: 0 }, { etag: `"${input.customer.version}"` });
  const now = deps.now();
  const kind = to === null ? 'detach' : input.from ? 'switch' : 'attach';
  const r = await deps.repo.setCustomerTemplate({ customerId: customer.id, toTemplateId: to, expectedVersion: version, previewHash: hash, actorId: auth.userId, at: now }, {
    at: now, customerId: customer.id, actorType: 'USER', actorId: auth.userId, action: `responders.template.${kind}`, targetType: 'Responders', targetId: to ?? input.from?.id ?? '',
    before: null, after: null, requestId: req.requestId,
  });
  if (r === 'BUSY') throw busy();
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'NO_TEMPLATE') throw invalid('templateId', 'Unknown template.');
  if (r === 'TERMINATED') throw new ApiError(409, 'CUSTOMER_TERMINATED', 'A terminated customer keeps its data as it is.');
  if (r === 'CONFLICT') throw versionConflict('The Responders', (await deps.repo.respondersState(customer.id)).version);
  if (r === 'STALE') throw new ApiError(409, 'PREVIEW_STALE', 'The template or the customer changed after the preview. Preview again.', { currentVersion: (await deps.repo.respondersState(customer.id)).version });
  if ('blocking' in r) throw blockedError(r.blocking);
  return ok({ customerId: customer.id, templateId: r.templateId, version: r.version, joins: r.joins, leaves: r.leaves }, { etag: `"${r.version}"` });
}
