/**
 * API-CONTRACT §8.1 — incidents: list (+counts, outside, unmapped), detail, timeline, notifications,
 * ack / resolve / escalate with If-Match, bulk with per-item versions, undo.
 */
import { randomBytes } from 'node:crypto';
import {
  SEVERITIES, ack, escalationView, incidentMute, parseSnapshot, planEscalation, resolve, scheduleNext, unack,
  type IncidentCommit, type IncidentRow, type MaintenanceWindow, type Severity, type Source, type SuppressionPolicy,
} from '@alarmops/core';
import { requireAuth, requireRole, scopeOf, type AuthContext, type ScopeFilter } from './auth.js';
import {
  ApiError, decodeCursor, encodeCursor, ifMatch, invalid, invalidTransition, isRecord, limitOf, notFound, ok, q, validation, versionConflict,
  type ApiRequest, type ApiResponse,
} from './http.js';
import type { ApiRepository, IncidentFilter, NodeFilter, OrgTree, UndoRecord } from './repo.js';
import { resolveNodeFilter } from './scope.js';

export interface Deps { repo: ApiRepository; now: () => Date }

const UNDO_TTL_MS = 5 * 60_000;
const BULK_MAX = 200;
type Cursor = { t: string; id: string };
const isCursor = (v: unknown): v is Cursor => isRecord(v) && typeof v.t === 'string' && typeof v.id === 'string';

// ───────────────────────────── views ─────────────────────────────

interface ViewCtx {
  auth: AuthContext;
  now: Date;
  policy: SuppressionPolicy;
  org: OrgTree;
  windows: Map<string, MaintenanceWindow[]>;
  names: Map<string, string>;
}

async function viewCtx(deps: Deps, auth: AuthContext, scope: ScopeFilter, rows: IncidentRow[], now: Date): Promise<ViewCtx> {
  const windows = new Map<string, MaintenanceWindow[]>();
  for (const cid of new Set(rows.filter((r) => r.status !== 'RESOLVED').map((r) => r.customerId ?? ''))) windows.set(cid, await deps.repo.maintenanceWindows(cid || null, now));
  const userIds = [...new Set(rows.flatMap((r) => [r.acknowledgedBy, r.resolvedBy]).filter((x): x is string => !!x))];
  return { auth, now, policy: await deps.repo.loadPolicy(), org: await deps.repo.orgTree(scope), windows, names: await deps.repo.userNames(userIds) };
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
/** PROPOSED display key: INC-20261109-0312-7F3A (date and time of trigger in UTC + 4 hex of the id). */
export const displayKey = (inc: Pick<IncidentRow, 'id' | 'triggeredAt'>): string => {
  const t = inc.triggeredAt.toISOString();
  return `INC-${t.slice(0, 10).replace(/-/g, '')}-${t.slice(11, 16).replace(':', '')}-${(/^inc-([0-9a-f]{4})/.exec(inc.id)?.[1] ?? inc.id.slice(-4)).toUpperCase()}`;
};

export function listItem(inc: IncidentRow, c: ViewCtx) {
  const ref = <T extends { id: string; name: string; slug: string }>(xs: T[], id: string | null) => {
    const n = id ? xs.find((x) => x.id === id) : undefined;
    return n ? { id: n.id, name: n.name, slug: n.slug } : null; // slug only ever leaves inside the caller's scope (§8.0)
  };
  const snap = parseSnapshot(inc.assignmentSnapshot);
  const mute = incidentMute(
    { customerId: inc.customerId, projectId: inc.projectId, serviceId: inc.serviceId, accountIds: inc.accountIds, resourceTypes: inc.resourceTypes, severity: inc.severity },
    c.windows.get(inc.customerId ?? '') ?? [], c.now,
  );
  const v = escalationView(inc, { now: c.now, renotifyAfterSec: c.policy.renotifyAfterSec, mutedUntil: inc.status === 'RESOLVED' ? null : mute?.endsAt ?? null });
  const first = snap?.steps[0]?.resolved[0];
  const person = (id: string | null) => (id ? { contactId: id, name: c.names.get(id) ?? id } : null);
  return {
    id: inc.id, number: inc.number, key: displayKey(inc), title: inc.title, severity: inc.severity, status: inc.status,
    escalated: inc.status === 'TRIGGERED' && v.escalated,
    org: { customer: ref(c.org.customers, inc.customerId), project: ref(c.org.projects, inc.projectId), service: ref(c.org.services, inc.serviceId) },
    unmapped: inc.customerId == null,
    // Account ids are internal-only (security R-2).
    awsAccountIds: c.auth.kind === 'INTERNAL' ? inc.accountIds : [],
    resourceTypes: inc.resourceTypes, source: inc.source ?? 'CLOUDWATCH', memberCount: inc.memberCount,
    assignee: first ? { contactId: first.contactId, name: first.name, via: first.via } : null,
    escalation: {
      /** PROPOSED: PAGING | MUTED | STOPPED_ACKED | STOPPED_RESOLVED | STOPPED_EXHAUSTED | NEVER_ESCALATING | UNREACHABLE */
      state: v.state, step: v.step, firedSteps: v.firedSteps, totalSteps: v.totalSteps, repeat: v.repeat, repeatCount: v.repeatCount,
      nextAt: iso(v.nextAt), nextLabel: v.nextLabel, doneAt: iso(v.doneAt), baseAt: iso(v.baseAt), stoppedAt: iso(v.stoppedAt), renotifyAt: iso(v.renotifyAt),
      mutedByMaintenance: v.mutedByMaintenance,
    },
    triggeredAt: inc.triggeredAt.toISOString(), acknowledgedAt: iso(inc.acknowledgedAt), acknowledgedBy: person(inc.acknowledgedBy),
    resolvedAt: iso(inc.resolvedAt), ...(inc.resolvedVia ? { resolvedVia: inc.resolvedVia } : {}), version: inc.version,
  };
}

async function detailView(deps: Deps, auth: AuthContext, scope: ScopeFilter, inc: IncidentRow, now: Date) {
  const c = await viewCtx(deps, auth, scope, [inc], now);
  const item = listItem(inc, c);
  const snap = parseSnapshot(inc.assignmentSnapshot);
  const events = await deps.repo.incidentEvents(scope, inc.id, { limit: 200 });
  const notes = await deps.repo.incidentNotifications(scope, inc.id, { limit: 1 });
  const paged = events.rows.filter((e) => e.kind === 'NOTIFIED' || e.kind === 'ESCALATED').map((e) => ({ label: e.message, at: e.at.toISOString(), done: true }));
  if (item.escalation.nextAt && item.escalation.nextLabel) paged.push({ label: item.escalation.nextLabel, at: item.escalation.nextAt, done: false });
  return {
    ...item,
    alerts: (await deps.repo.incidentAlerts(scope, inc.id)).map((a) => ({ ...a, lastEventAt: a.lastEventAt.toISOString() })),
    assignmentSnapshot: snap && {
      capturedAt: snap.capturedAt, pagingConfigId: snap.pagingConfigId, planLabel: snap.planLabel, level: snap.level, repeatCount: snap.repeatCount,
      steps: snap.steps.map((s) => ({ index: s.index, atMin: s.atMin, targetType: s.targetType, ...(s.targetId ? { targetId: s.targetId } : {}), resolved: s.resolved, channels: s.channels, ...(s.label ? { label: s.label } : {}) })),
    },
    why: null, suppression: [], remediation: null,
    rcaPlaceholder: { availableAfterPoc: true as const }, // D-14
    details: { source: inc.source ?? 'CLOUDWATCH', resource: inc.resourceTypes.join(', '), alarm: inc.title },
    paged, notificationCount: notes.total,
  };
}

// ───────────────────────────── GET /incidents ─────────────────────────────

const STATUSES = ['active', 'TRIGGERED', 'ACKNOWLEDGED', 'RESOLVED'] as const;
const SOURCES: readonly Source[] = ['CLOUDWATCH', 'PROMETHEUS', 'GRAFANA'];

export async function listIncidents(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const now = deps.now();
  const limit = limitOf(req);
  const after = decodeCursor(q(req, 'cursor'), isCursor);
  const filter: IncidentFilter = {};
  const status = q(req, 'status');
  if (status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(status)) throw invalid('status', 'status must be active, TRIGGERED, ACKNOWLEDGED or RESOLVED.');
    filter.status = status as IncidentFilter['status'];
  }
  const severity = q(req, 'severity');
  if (severity !== undefined) {
    if (!(SEVERITIES as readonly string[]).includes(severity)) throw invalid('severity', 'severity must be SEV_1 … SEV_5.');
    filter.severity = severity as Severity;
  }
  const source = q(req, 'source');
  if (source !== undefined) {
    if (!(SOURCES as readonly string[]).includes(source)) throw invalid('source', 'Unknown source.');
    filter.source = source as Source;
  }
  if (q(req, 'q')) filter.q = q(req, 'q')!.slice(0, 200);
  const assignee = q(req, 'assignee');
  if (assignee !== undefined) {
    if (assignee !== 'me') throw invalid('assignee', 'assignee accepts only "me".');
    // The session user, never an id from the client. No linked contact → matches nothing.
    filter.assigneeContactId = (await deps.repo.contactIdForUser(auth.userId)) ?? '\u0000none';
  }
  if (q(req, 'unmapped') === 'true' || q(req, 'unmapped') === '1') filter.unmappedOnly = true;

  // Scope filter: 404 (never 403) for unknown and out-of-scope slugs alike — resolved inside the caller's scope.
  const node: NodeFilter | null = await resolveNodeFilter(req, deps.repo, auth, scope);
  const page = await deps.repo.queryIncidents(scope, node, filter, { limit, after }, now);
  const c = await viewCtx(deps, auth, scope, page.rows, now);
  const last = page.rows[page.rows.length - 1];
  return ok({
    items: page.rows.map((r) => listItem(r, c)),
    nextCursor: page.hasMore && last ? encodeCursor({ t: last.triggeredAt.toISOString(), id: last.id } satisfies Cursor) : null,
    counts: page.counts,
    // Internal only (security R-2): customer users get an empty banner and 0.
    unmapped: scope.unmapped ? page.unmapped : [],
    outside: node ? {
      open: page.all.open - page.inside.open,
      unmapped: scope.unmapped ? page.all.unmappedOpen - page.inside.unmappedOpen : 0,
      acknowledged: page.all.acknowledged - page.inside.acknowledged,
    } : null,
  });
}

// ───────────────────────────── GET /incidents/{id} (+timeline, notifications) ─────────────────────────────

async function visibleIncident(deps: Deps, scope: ScopeFilter, id: string): Promise<IncidentRow> {
  const inc = await deps.repo.findIncident(scope, id);
  if (!inc) throw notFound();
  return inc;
}

export async function getIncident(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const inc = await visibleIncident(deps, scope, id);
  return ok(await detailView(deps, auth, scope, inc, deps.now()), { etag: `"${inc.version}"` });
}

export async function getTimeline(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const limit = limitOf(req);
  const after = decodeCursor(q(req, 'cursor'), isCursor);
  await visibleIncident(deps, scope, id);
  const page = await deps.repo.incidentEvents(scope, id, { limit, after });
  const last = page.rows[page.rows.length - 1];
  return ok({
    items: page.rows.map((e) => ({ id: e.id, at: e.at.toISOString(), kind: e.kind, actorType: e.actorType, actorId: e.actorId, message: e.message })),
    nextCursor: page.hasMore && last ? encodeCursor({ t: last.at.toISOString(), id: last.id }) : null,
  });
}

export async function getNotifications(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const limit = limitOf(req);
  const after = decodeCursor(q(req, 'cursor'), isCursor);
  await visibleIncident(deps, scope, id);
  const page = await deps.repo.incidentNotifications(scope, id, { limit, after });
  const last = page.rows[page.rows.length - 1];
  return ok({
    items: page.rows.map((l) => ({
      id: l.id, at: l.at.toISOString(), channel: l.channel, status: l.status, targetSummary: l.targetSummary, escalationStep: l.escalationStep, error: l.error,
      providerMessageId: l.providerMessageId, attempt: l.attempt, warnings: l.warnings,
    })),
    nextCursor: page.hasMore && last ? encodeCursor({ t: last.at.toISOString(), id: last.id }) : null,
  });
}

// ───────────────────────────── transitions ─────────────────────────────

type Action = 'ack' | 'resolve' | 'escalate';
type Outcome = { ok: true; commit: IncidentCommit } | { ok: false; code: 'INVALID_TRANSITION'; message: string };

const actorName = (auth: AuthContext): string => auth.name ?? auth.userId;

/** Pure: what the action writes, given the row the caller's version matched. */
function transition(action: Action, inc: IncidentRow, auth: AuthContext, now: Date, policy: SuppressionPolicy, requestId: string, body: { kind: ResolveKind | null; note: string | null }): Outcome {
  const audit = (after: unknown) => ({
    at: now, customerId: inc.customerId, actorType: 'USER' as const, actorId: auth.userId, action: `incident.${action}`, targetType: 'Incident', targetId: inc.id,
    before: { status: inc.status, version: inc.version }, after, requestId,
  });
  const sched = { now, renotifyAfterSec: policy.renotifyAfterSec };
  const ev = (kind: 'ACKED' | 'RESOLVED', message: string) => ({ incidentId: inc.id, customerId: inc.customerId, at: now, kind, actorType: 'USER' as const, actorId: auth.userId, message });
  if (action === 'ack') {
    const next = ack(inc, auth.userId, now);
    if (!next) return { ok: false, code: 'INVALID_TRANSITION', message: inc.status === 'ACKNOWLEDGED' ? 'Incident is already acknowledged.' : 'Incident is already resolved.' };
    const row = { ...next, nextEscalationAt: scheduleNext(next, sched) };
    return { ok: true, commit: { row, expectedVersion: inc.version, bump: true, memberEffect: 'ACK', events: [ev('ACKED', `Acknowledged by ${actorName(auth)}. Paging stopped.`)], audit: audit({ status: 'ACKNOWLEDGED' }) } };
  }
  if (action === 'resolve') {
    const next = resolve(inc, 'MANUAL', auth.userId, now);
    if (!next) return { ok: false, code: 'INVALID_TRANSITION', message: 'Incident is already resolved.' };
    return { ok: true, commit: {
      row: next, expectedVersion: inc.version, bump: true, events: [ev('RESOLVED', `Resolved by ${actorName(auth)}.`)], audit: audit({ status: 'RESOLVED', kind: body.kind }),
      resolution: { incidentId: inc.id, customerId: inc.customerId, via: 'MANUAL', kind: body.kind, note: body.note, serviceId: inc.serviceId, durationSec: next.mttrSec ?? 0, escalationStep: inc.escalationStep, resolvedBy: auth.userId, resolvedAt: now },
    } };
  }
  if (inc.status !== 'TRIGGERED') return { ok: false, code: 'INVALID_TRANSITION', message: 'Only a triggered incident can be escalated.' };
  const plan = planEscalation(inc, { ...sched, force: { by: actorName(auth) } });
  if (plan.kind !== 'STEP') return { ok: false, code: 'INVALID_TRANSITION', message: plan.kind === 'NONE' && plan.reason === 'NO_SNAPSHOT' ? 'No call order applies to this incident: there is nobody to escalate to.' : 'There is no further step to escalate to.' };
  return { ok: true, commit: {
    row: { ...inc, ...plan.patch }, expectedVersion: inc.version, bump: true, jobs: plan.intents, audit: audit({ step: plan.stepIndex, repeat: plan.repeat }),
    events: [{ incidentId: inc.id, customerId: inc.customerId, at: now, kind: plan.event.kind, actorType: 'USER', actorId: auth.userId, message: plan.event.message, data: plan.event.data }],
  } };
}

type ResolveKind = 'RESTART' | 'CONFIG' | 'AUTO' | 'OTHER';
const KINDS: readonly ResolveKind[] = ['RESTART', 'CONFIG', 'AUTO', 'OTHER'];

function resolveBody(body: unknown): { kind: ResolveKind | null; note: string | null } {
  if (body === undefined || body === null) return { kind: null, note: null };
  if (!isRecord(body)) throw invalid('body', 'Body must be a JSON object.');
  const { kind, note } = body;
  if (kind !== undefined && kind !== null && !(typeof kind === 'string' && (KINDS as readonly string[]).includes(kind))) throw invalid('kind', 'kind must be RESTART, CONFIG, AUTO or OTHER.');
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 2000)) throw invalid('note', 'note must be text of at most 2000 characters.');
  return { kind: (kind as ResolveKind | undefined) ?? null, note: (note as string | undefined) ?? null };
}

const newUndoToken = (): string => `undo_${randomBytes(24).toString('base64url')}`;

/**
 * POST /incidents/{id}/ack | resolve | escalate.
 * Order: header shape (independent of the target) → scoped lookup (404) → role (403, only for a visible target)
 * → If-Match (409 VERSION_CONFLICT) → state (409 INVALID_TRANSITION).
 */
export async function actOnIncident(req: ApiRequest, deps: Deps, id: string, action: Action): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const version = ifMatch(req);
  const body = action === 'resolve' ? resolveBody(req.body) : { kind: null, note: null };
  const inc = await visibleIncident(deps, scope, id);
  requireRole(auth, 'OPERATOR');
  if (inc.version !== version) throw versionConflict('Incident', inc.version);
  const now = deps.now();
  const t = transition(action, inc, auth, now, await deps.repo.loadPolicy(), req.requestId, body);
  if (!t.ok) throw invalidTransition(t.message);
  const saved = await deps.repo.commitIncident(t.commit);
  if (saved === 'CONFLICT') throw versionConflict('Incident'); // the tick or someone else won between read and write
  const detail = await detailView(deps, auth, scope, saved, now);
  if (action !== 'ack') return ok(detail, { etag: `"${saved.version}"` });
  const undoToken = newUndoToken();
  await deps.repo.saveUndo({ token: undoToken, userId: auth.userId, action: 'ack', expiresAt: new Date(now.getTime() + UNDO_TTL_MS), items: [{ id: saved.id, versionAfter: saved.version, prev: prevOf(inc) }] });
  return ok({ incident: detail, undoToken }, { etag: `"${saved.version}"` });
}

const prevOf = (inc: IncidentRow): UndoRecord['items'][number]['prev'] =>
  ({ status: inc.status, acknowledgedAt: inc.acknowledgedAt, acknowledgedBy: inc.acknowledgedBy, mttaSec: inc.mttaSec });

// ───────────────────────────── POST /incidents/bulk ─────────────────────────────

function bulkBody(body: unknown): { action: 'ack' | 'resolve'; items: Array<{ id: string; version: number }>; preview: boolean } {
  if (!isRecord(body)) throw invalid('body', 'Body must be a JSON object.');
  const { action, items, preview } = body;
  const errors: Array<{ field: string; message: string }> = [];
  if (action !== 'ack' && action !== 'resolve') errors.push({ field: 'action', message: 'action must be "ack" or "resolve".' });
  // Security R-3: ids without versions are not accepted in any form.
  if ('ids' in body) errors.push({ field: 'ids', message: 'Send items: [{ id, version }]; ids without versions are not accepted.' });
  if (typeof preview !== 'boolean') errors.push({ field: 'preview', message: 'preview must be true or false.' });
  if (!Array.isArray(items) || items.length === 0 || items.length > BULK_MAX) errors.push({ field: 'items', message: `items must hold 1 to ${BULK_MAX} entries.` });
  else {
    items.forEach((it, i) => {
      if (!isRecord(it) || typeof it.id !== 'string' || !it.id) errors.push({ field: `items[${i}].id`, message: 'id is required.' });
      else if (typeof it.version !== 'number' || !Number.isInteger(it.version) || it.version < 0) errors.push({ field: `items[${i}].version`, message: 'version (the one you saw) is required for every item.' });
    });
    const ids = items.filter(isRecord).map((it) => it.id);
    if (new Set(ids).size !== ids.length) errors.push({ field: 'items', message: 'Each incident may appear once.' });
  }
  if (errors.length) throw validation(errors);
  return { action: action as 'ack' | 'resolve', items: items as Array<{ id: string; version: number }>, preview: preview as boolean };
}

export async function bulkIncidents(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const { action, items, preview } = bulkBody(req.body);
  requireRole(auth, 'OPERATOR');
  const now = deps.now();
  const policy = await deps.repo.loadPolicy();
  const done: IncidentRow[] = [];
  const targets: Array<{ id: string; key: string; title: string; status: string }> = [];
  const conflicts: Array<{ id: string; code: string }> = [];
  const undoItems: UndoRecord['items'] = [];
  for (const it of items) {
    // Out-of-scope and unknown ids both come back as NOT_FOUND; the others still run.
    const inc = await deps.repo.findIncident(scope, it.id);
    if (!inc) { conflicts.push({ id: it.id, code: 'NOT_FOUND' }); continue; }
    if (inc.version !== it.version) { conflicts.push({ id: it.id, code: 'VERSION_CONFLICT' }); continue; }
    const t = transition(action, inc, auth, now, policy, req.requestId, { kind: null, note: null });
    if (!t.ok) { conflicts.push({ id: it.id, code: t.code }); continue; }
    if (preview) { targets.push({ id: inc.id, key: displayKey(inc), title: inc.title, status: inc.status }); continue; }
    const saved = await deps.repo.commitIncident(t.commit);
    if (saved === 'CONFLICT') { conflicts.push({ id: it.id, code: 'VERSION_CONFLICT' }); continue; }
    done.push(saved);
    undoItems.push({ id: saved.id, versionAfter: saved.version, prev: prevOf(inc) });
  }
  if (preview) return ok({ action, targets, skipped: conflicts.map((c) => ({ id: c.id, reason: c.code })) });
  const undoToken = newUndoToken();
  if (undoItems.length) await deps.repo.saveUndo({ token: undoToken, userId: auth.userId, action, expiresAt: new Date(now.getTime() + UNDO_TTL_MS), items: undoItems });
  return ok({ done: done.map((d) => d.id), conflicts, undoToken });
}

/**
 * POST /incidents/bulk/undo — 5 minutes, the person who acted, and only items nobody touched since
 * (version unchanged). Unknown, used, expired and other people's tokens are the same 404.
 * An undone ack continues the ladder from the step where it stopped.
 */
export async function undoIncidents(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  if (!isRecord(req.body) || typeof req.body.undoToken !== 'string' || !req.body.undoToken) throw invalid('undoToken', 'undoToken is required.');
  requireRole(auth, 'OPERATOR');
  const now = deps.now();
  const rec = await deps.repo.takeUndo(req.body.undoToken);
  if (!rec || rec.userId !== auth.userId || rec.expiresAt.getTime() <= now.getTime()) {
    if (rec && rec.userId !== auth.userId) await deps.repo.saveUndo(rec); // someone else's token stays usable by its owner
    throw notFound();
  }
  const policy = await deps.repo.loadPolicy();
  const restored: string[] = [];
  const skipped: Array<{ id: string; code: string }> = [];
  for (const it of rec.items) {
    const inc = await deps.repo.findIncident(scope, it.id);
    if (!inc) { skipped.push({ id: it.id, code: 'NOT_FOUND' }); continue; }
    if (inc.version !== it.versionAfter) { skipped.push({ id: it.id, code: 'VERSION_CONFLICT' }); continue; }
    let row: IncidentRow | null;
    if (rec.action === 'ack') row = unack(inc);
    else {
      // Undo of a resolve: back to the state before. It does not become the axis' merge target again
      // (a newer incident may hold it); new alerts open a new incident instead.
      row = inc.status === 'RESOLVED' ? { ...inc, ...it.prev, resolvedAt: null, resolvedBy: null, resolvedVia: null, mttrSec: null } : null;
    }
    if (!row) { skipped.push({ id: it.id, code: 'INVALID_TRANSITION' }); continue; }
    row = { ...row, nextEscalationAt: scheduleNext(row, { now, renotifyAfterSec: policy.renotifyAfterSec }) };
    const saved = await deps.repo.commitIncident({
      row, expectedVersion: inc.version, bump: true, ...(rec.action === 'ack' ? { memberEffect: 'UNACK' as const } : {}),
      events: [{ incidentId: inc.id, customerId: inc.customerId, at: now, kind: 'NOTE', actorType: 'USER', actorId: auth.userId,
        message: rec.action === 'ack' ? `Acknowledgement undone by ${actorName(auth)}. Paging continues.` : `Resolve undone by ${actorName(auth)}.` }],
      audit: { at: now, customerId: inc.customerId, actorType: 'USER', actorId: auth.userId, action: `incident.${rec.action}.undo`, targetType: 'Incident', targetId: inc.id, before: { status: inc.status }, after: { status: row.status }, requestId: req.requestId },
    });
    if (saved === 'CONFLICT') skipped.push({ id: it.id, code: 'VERSION_CONFLICT' });
    else restored.push(saved.id);
  }
  return ok({ restored, skipped });
}

export { ApiError };
