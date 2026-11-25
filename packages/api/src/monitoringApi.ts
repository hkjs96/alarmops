/**
 * API-CONTRACT §8.5 — Monitoring (first slice, D-16):
 *   GET  /resources                    list (scope filter, type, monitoringState), `outside`
 *   GET  /resources/{id}               resource, tags, managed alarms
 *   POST /resources/{id}/monitoring    { action: stop | tag_on | keep } -> 202 { commandId, status: "queued" }
 *   GET  /managed-alarms               read-only list
 *
 * Reads and the write target are found inside the caller's scope (`findResourceDetail(scope, id)`): another tenant's
 * id and an unknown id are the same 404 (D-33). A role rule (403) is only reached for a resource the caller can see.
 * The API never changes a Resource row: it queues the command, the alarm engine does the work (and the state change).
 * Account ids follow the onboarding rule (security R-2): only INTERNAL users get `awsAccountId`.
 */
import { randomBytes } from 'node:crypto';
import { SEVERITIES, type Severity } from '@alarmops/core';
import { requireAuth, requireRole, scopeOf, type AuthContext } from './auth.js';
import type { AlarmCommand, CommandPublisher } from './customerApi.js';
import { ApiError, decodeCursor, encodeCursor, invalid, invalidTransition, isRecord, limitOf, notFound, ok, q, validation, type ApiRequest, type ApiResponse } from './http.js';
import { MONITORING_STATES, type ApiRepository, type ManagedAlarmRecord, type MonitoringCursor, type MonitoringStateValue, type OrgTree, type ResourceRecord } from './repo.js';
import { resolveNodeFilter } from './scope.js';

interface Deps { repo: ApiRepository; now: () => Date; commands?: CommandPublisher; log?: (level: 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void }

const ALARM_STATES = ['OK', 'ALARM', 'INSUFFICIENT_DATA'] as const;
const TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
// eslint-disable-next-line no-control-regex
const isCursor = (v: unknown): v is MonitoringCursor => isRecord(v) && typeof v.k === 'string' && v.k.length <= 600 && !/[\u0000-\u001f\u007f]/.test(v.k) && typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v.id);

const orgRef = <T extends { id: string; name: string; slug: string }>(xs: T[], id: string | null) => {
  const n = id ? xs.find((x) => x.id === id) : undefined;
  return n ? { id: n.id, name: n.name, slug: n.slug } : null; // slug only ever leaves inside the caller's scope (§8.0)
};
const orgOf = (org: OrgTree, r: { customerId: string; projectId: string | null; serviceId: string | null }) =>
  ({ customer: orgRef(org.customers, r.customerId), project: orgRef(org.projects, r.projectId), service: orgRef(org.services, r.serviceId) });

export function resourceItem(r: ResourceRecord, org: OrgTree, auth: AuthContext) {
  return {
    id: r.id, name: r.name ?? r.resourceKey, resourceKey: r.resourceKey, resourceType: r.resourceType, region: r.region,
    account: { id: r.cloudAccountId, alias: r.accountAlias, awsAccountId: auth.kind === 'INTERNAL' ? r.awsAccountId : null, alarmWriterEnabled: r.alarmWriterEnabled, tagWriterEnabled: r.tagWriterEnabled },
    org: orgOf(org, r),
    monitoringState: r.monitoringState, needsReviewSince: iso(r.needsReviewSince), needsReviewReason: r.needsReviewReason,
    alarmCount: r.alarmCount, lastSeenAt: r.lastSeenAt.toISOString(),
  };
}

export function alarmItem(a: ManagedAlarmRecord, org: OrgTree) {
  return {
    id: a.id, resourceId: a.resourceId, resourceName: a.resourceName, resourceType: a.resourceType, region: a.region, metricKey: a.metricKey, alarmName: a.alarmName,
    org: orgOf(org, a),
    severity: a.severity, threshold: a.threshold, thresholdSource: a.thresholdSource, evalM: a.evalM, evalN: a.evalN, comparison: a.comparison, statistic: a.statistic, period: a.period,
    state: a.state, driftStatus: a.driftStatus, lastSyncedAt: iso(a.lastSyncedAt),
  };
}

// ───────────────────────────── GET /resources ─────────────────────────────

export async function listResources(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const limit = limitOf(req);
  const after = decodeCursor(q(req, 'cursor'), isCursor);
  const type = q(req, 'type');
  if (type !== undefined && !TYPE_RE.test(type)) throw invalid('type', 'type must be a resource type key such as EC2.');
  const state = q(req, 'monitoringState');
  if (state !== undefined && !(MONITORING_STATES as readonly string[]).includes(state)) throw invalid('monitoringState', 'monitoringState must be MONITORED, NEEDS_REVIEW, NOT_MONITORED or DELETED.');
  const node = await resolveNodeFilter(req, deps.repo, auth, scope);
  const page = await deps.repo.queryResources(scope, node, { type, monitoringState: state as MonitoringStateValue | undefined }, { limit, after });
  const org = await deps.repo.orgTree(scope);
  const last = page.rows[page.rows.length - 1];
  return ok({
    items: page.rows.map((r) => resourceItem(r, org, auth)),
    nextCursor: page.hasMore && last ? encodeCursor({ k: last.name ?? last.resourceKey, id: last.id } satisfies MonitoringCursor) : null,
    outside: node ? page.outside : null,
  });
}

// ───────────────────────────── GET /resources/{id} ─────────────────────────────

export async function getResource(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const found = await deps.repo.findResourceDetail(scope, id);
  if (!found) throw notFound();
  const org = await deps.repo.orgTree(scope);
  return ok({ ...resourceItem(found.resource, org, auth), tags: found.resource.tags, alarms: found.alarms.map((a) => alarmItem(a, org)) });
}

// ───────────────────────────── GET /managed-alarms ─────────────────────────────

export async function listManagedAlarms(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const limit = limitOf(req);
  const after = decodeCursor(q(req, 'cursor'), isCursor);
  const resourceId = q(req, 'resourceId');
  if (resourceId !== undefined && !isCursor({ k: '', id: resourceId })) throw invalid('resourceId', 'resourceId is not valid.');
  const state = q(req, 'state');
  if (state !== undefined && !(ALARM_STATES as readonly string[]).includes(state)) throw invalid('state', 'state must be OK, ALARM or INSUFFICIENT_DATA.');
  const severity = q(req, 'severity');
  if (severity !== undefined && !(SEVERITIES as readonly string[]).includes(severity)) throw invalid('severity', 'severity must be SEV_1 … SEV_5.');
  const node = await resolveNodeFilter(req, deps.repo, auth, scope);
  const page = await deps.repo.queryManagedAlarms(scope, node, { resourceId, state: state as (typeof ALARM_STATES)[number] | undefined, severity: severity as Severity | undefined }, { limit, after });
  const org = await deps.repo.orgTree(scope);
  const last = page.rows[page.rows.length - 1];
  return ok({
    items: page.rows.map((a) => alarmItem(a, org)),
    nextCursor: page.hasMore && last ? encodeCursor({ k: last.alarmName, id: last.id } satisfies MonitoringCursor) : null,
    outside: node ? page.outside : null,
  });
}

// ───────────────────────────── POST /resources/{id}/monitoring ─────────────────────────────

const ACTIONS = ['stop', 'keep', 'tag_on'] as const;
type Action = (typeof ACTIONS)[number];
const newCommandId = (): string => `cmd_${randomBytes(12).toString('hex')}`;

/**
 * Order: scoped lookup (404) -> role OPERATOR (403) -> body shape (400) -> `keep` (409
 * NOT_SUPPORTED) -> state (409 INVALID_TRANSITION) -> account capability (403 CAPABILITY_DISABLED) -> queue (503) -> audit -> publish (502 on failure).
 * - stop: only NEEDS_REVIEW (D-16: alarms are deleted only after a person chose to stop). The command is STOP_MONITORING { resourceId, deleteAlarms: true }; AlarmWriter must be on.
 * - tag_on: NEEDS_REVIEW or NOT_MONITORED; SET_MONITORING_TAG { resourceId, value: "on" }; TagWriter must be on.
 * - keep: the engine has no command that records "keep monitoring" (the resource stays NEEDS_REVIEW) -> 409 NOT_SUPPORTED, nothing is written.
 */
export async function postMonitoring(req: ApiRequest, deps: Deps, id: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const found = await deps.repo.findResourceDetail(scope, id);
  if (!found) throw notFound();
  requireRole(auth, 'OPERATOR'); // after the 404: an unknown id never reveals a role rule
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const unknown = Object.keys(req.body).filter((k) => k !== 'action');
  if (unknown.length) throw validation(unknown.map((field) => ({ field, message: 'Not accepted here.' })));
  const action = req.body.action;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) throw invalid('action', 'action must be stop, keep or tag_on.');
  const r = found.resource;
  const act = action as Action;
  if (act === 'keep') throw new ApiError(409, 'NOT_SUPPORTED', 'Keep monitoring is not available yet. The resource stays in Needs review until you re-tag it or stop monitoring.');
  if (act === 'stop' && r.monitoringState !== 'NEEDS_REVIEW') throw invalidTransition('Only a resource that needs review can be taken out of monitoring.');
  if (act === 'tag_on' && r.monitoringState !== 'NEEDS_REVIEW' && r.monitoringState !== 'NOT_MONITORED') throw invalidTransition('This resource does not need the Monitoring tag.');
  if (act === 'stop' && !r.alarmWriterEnabled) throw new ApiError(403, 'CAPABILITY_DISABLED', 'The AlarmWriter role is not enabled for this AWS account.', { role: 'alarmWriter' });
  if (act === 'tag_on' && !r.tagWriterEnabled) throw new ApiError(403, 'CAPABILITY_DISABLED', 'The TagWriter role is not enabled for this AWS account.', { role: 'tagWriter' });
  if (!deps.commands) throw new ApiError(503, 'COMMANDS_UNAVAILABLE', 'The command queue is not configured; nothing was queued.');
  const now = deps.now();
  const commandId = newCommandId();
  const base = { schemaVersion: 1 as const, commandId, customerId: r.customerId, cloudAccountId: r.cloudAccountId, requestedBy: { type: 'USER' as const, id: auth.userId }, requestedAt: now.toISOString() };
  const cmd: AlarmCommand = act === 'stop'
    ? { ...base, type: 'STOP_MONITORING', payload: { resourceId: r.id, deleteAlarms: true } }
    : { ...base, type: 'SET_MONITORING_TAG', payload: { resourceId: r.id, value: 'on' } };
  const audit = (name: string) => ({ at: now, customerId: r.customerId, actorType: 'USER' as const, actorId: auth.userId, action: name, targetType: 'Resource', targetId: r.id, before: { monitoringState: r.monitoringState }, after: { commandId, command: cmd.type }, requestId: req.requestId });
  await deps.repo.recordAudit(audit(`resource.${act}_monitoring`)); // a failed audit write stops the request before anything is queued
  try {
    await deps.commands.publish(cmd);
  } catch {
    deps.log?.('error', 'monitoring_publish_failed', { requestId: req.requestId, resourceId: r.id, type: cmd.type });
    await deps.repo.recordAudit(audit(`resource.${act}_monitoring_failed`)).catch(() => undefined);
    throw new ApiError(502, 'COMMAND_PUBLISH_FAILED', 'The command could not be queued. Try again.');
  }
  return ok({ commandId, status: 'queued' }, {}, 202);
}
