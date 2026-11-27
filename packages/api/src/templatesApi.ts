/**
 * Responder templates (API-CONTRACT §8.3 "Responder 템플릿", D-31 개정, D-33, D-41).
 * GET/POST /responder-templates, PATCH /responder-templates/{id}, POST /responder-templates/{id}/preview.
 *
 * A template is MSP-level: staff who see every customer (portal users: the one 404; narrowed staff: 403). The impact of a
 * change is computed by ONE pure function (`planTemplateChange`) that the preview, the save and the stores all use, so the
 * `previewHash` of a preview and the hash re-computed inside the save transaction are the same thing.
 */
import { createHash } from 'node:crypto';
import { requireAuth, requireRole, type AuthContext } from './auth.js';
import { ApiError, ifMatch, invalid, isCleanId, isRecord, notFound, ok, validation, versionConflict, type ApiRequest, type ApiResponse } from './http.js';
import type { ApiRepository, ResponderTemplateView, TemplateEffect, TemplateImpactInput, TemplatePlan, TemplateProposal } from './repo.js';

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
  return ok({ templateId: id, version: input.version, customers: plan.customers, totals: plan.totals, previewHash: plan.previewHash });
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
