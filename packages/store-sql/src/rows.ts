/** Row ↔ domain mapping shared by the repositories. Column names are the Prisma field names (quoted identifiers). */
import { randomBytes } from 'node:crypto';
import type { Contact, DeliveryLog, GroupRow, IncidentEventInput, IncidentRow, NotificationJob } from '@alarmops/core';
import type { SqlRow } from './client.js';

/** timestamptz arrives as a Date (drivers) or as an ISO string (inside jsonb aggregates). */
export const d = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v as string));
export const dReq = (v: unknown): Date => d(v) ?? new Date(NaN);
export const iso = (v: Date | null | undefined): string | null => (v ? v.toISOString() : null);
/** json parameter: always text + `::jsonb` in the statement (a JS array would otherwise become a Postgres array). */
export const js = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
export const num = (v: unknown): number | null => (v == null ? null : Number(v));

let counter = 0;
/**
 * Row ids are made here (the schema's `cuid()` default lives in Prisma Client, not in the database).
 * Time-ordered within a process: `<prefix>_<ms, base36><counter><random>`.
 */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_679_616; // 36^4
  return `${prefix}_${Date.now().toString(36).padStart(9, '0')}${counter.toString(36).padStart(4, '0')}${randomBytes(5).toString('hex')}`;
}

/** Positional parameter collector: `p.add(v)` → `$n`. */
export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

export const INCIDENT_COLS = [
  'id', 'axis', 'customerId', 'number', 'title', 'severity', 'status', 'triggeredAt', 'acknowledgedAt', 'resolvedAt', 'acknowledgedBy', 'resolvedBy',
  'resolvedVia', 'mttaSec', 'mttrSec', 'memberCount', 'eventCount', 'accountIds', 'resourceTypes', 'assignmentSnapshot', 'pagingConfigId',
  'escalationStep', 'escalationRepeat', 'escalationBaseAt', 'escalationDoneAt', 'renotifiedAt', 'version', 'isMergeTarget', 'nextEscalationAt',
  'lastMergedAt', 'renotifyCount', 'projectId', 'serviceId', 'source', 'lastManualEscalationAt', 'pagingSuppressed',
] as const;
export const incidentCols = (alias = ''): string => INCIDENT_COLS.map((c) => `${alias ? `${alias}.` : ''}"${c}"`).join(', ');

export function toIncident(r: SqlRow): IncidentRow {
  return {
    id: r.id, axis: r.axis, customerId: r.customerId ?? null, title: r.title, severity: r.severity, status: r.status,
    triggeredAt: dReq(r.triggeredAt), acknowledgedAt: d(r.acknowledgedAt), acknowledgedBy: r.acknowledgedBy ?? null,
    resolvedAt: d(r.resolvedAt), resolvedBy: r.resolvedBy ?? null, resolvedVia: r.resolvedVia ?? null,
    mttaSec: r.mttaSec ?? null, mttrSec: r.mttrSec ?? null, memberCount: r.memberCount, eventCount: r.eventCount,
    accountIds: r.accountIds ?? [], resourceTypes: r.resourceTypes ?? [], isMergeTarget: r.isMergeTarget,
    escalationStep: r.escalationStep, escalationRepeat: r.escalationRepeat, escalationBaseAt: d(r.escalationBaseAt), escalationDoneAt: d(r.escalationDoneAt),
    nextEscalationAt: d(r.nextEscalationAt), renotifiedAt: d(r.renotifiedAt), renotifyCount: r.renotifyCount,
    lastManualEscalationAt: d(r.lastManualEscalationAt), lastMergedAt: d(r.lastMergedAt), pagingSuppressed: r.pagingSuppressed ?? null,
    pagingConfigId: r.pagingConfigId ?? null, assignmentSnapshot: r.assignmentSnapshot ?? null,
    projectId: r.projectId ?? null, serviceId: r.serviceId ?? null, source: r.source ?? null, number: r.number, version: r.version,
  };
}

export const GROUP_COLS = '"id", "groupKey", "customerId", "severity", "status", "openedAt", "groupWaitSec", "closeAt", "closedAt", "pauseUntil", "staleAfter", "deliveredAt", "version"';
export function toGroup(r: SqlRow): GroupRow {
  return {
    id: r.id, groupKey: r.groupKey, customerId: r.customerId ?? null, severity: r.severity, status: r.status, openedAt: dReq(r.openedAt),
    groupWaitSec: r.groupWaitSec, closeAt: dReq(r.closeAt), closedAt: d(r.closedAt), pauseUntil: d(r.pauseUntil), staleAfter: dReq(r.staleAfter),
    deliveredAt: d(r.deliveredAt), version: r.version,
  };
}

export const JOB_COLS = [
  'id', 'idempotencyKey', 'customerId', 'incidentId', 'purpose', 'channel', 'targetRef', 'status', 'attempts', 'nextAttemptAt', 'lastError', 'payload',
  'stepIndex', 'repeat', 'contactId', 'contactName', 'claimSeq', 'dueAt', 'providerMessageId', 'createdAt', 'seq',
] as const;
export const jobCols = (alias = ''): string => JOB_COLS.map((c) => `${alias ? `${alias}.` : ''}"${c}"`).join(', ');
export function toJob(r: SqlRow): NotificationJob {
  return {
    id: r.id, idempotencyKey: r.idempotencyKey, incidentId: r.incidentId, customerId: r.customerId ?? null, purpose: r.purpose, channel: r.channel,
    targetRef: r.targetRef, contactId: r.contactId ?? null, contactName: r.contactName ?? null, stepIndex: r.stepIndex, repeat: r.repeat, payload: r.payload,
    status: r.status, attempts: r.attempts, claimSeq: r.claimSeq, nextAttemptAt: dReq(r.nextAttemptAt), dueAt: dReq(r.dueAt), lastError: r.lastError ?? null,
    providerMessageId: r.providerMessageId ?? null, createdAt: dReq(r.createdAt),
  };
}

export const CONTACT_COLS = '"id", "kind", "customerId", "name", "active", "email", "phone", "slackUserId", "emailVerifiedAt", "phoneVerifiedAt", "slackVerifiedAt"';
export function toContact(r: SqlRow): Contact {
  return {
    id: r.id, kind: r.kind, customerId: r.customerId ?? null, name: r.name, active: r.active, email: r.email ?? null, phone: r.phone ?? null,
    slackUserId: r.slackUserId ?? null, emailVerifiedAt: d(r.emailVerifiedAt), phoneVerifiedAt: d(r.phoneVerifiedAt), slackVerifiedAt: d(r.slackVerifiedAt),
  };
}

export function toEvent(r: SqlRow): IncidentEventInput & { id: string } {
  const e: IncidentEventInput & { id: string } = { id: r.id, incidentId: r.incidentId, customerId: r.customerId ?? null, at: dReq(r.at), kind: r.kind, actorType: r.actorType, actorId: r.actorId ?? null, message: r.message };
  if (r.data != null) e.data = r.data;
  return e;
}

export function toLog(r: SqlRow): DeliveryLog & { id: string } {
  return {
    id: r.id, at: dReq(r.at), customerId: r.customerId ?? null, incidentId: r.incidentId, jobId: r.jobId ?? '', channel: r.channel, status: r.status,
    targetSummary: r.targetSummary, targetKind: r.targetKind, contactId: r.contactId ?? null, escalationStep: r.escalationStep ?? 0, attempt: r.attempt,
    providerMessageId: r.providerMessageId ?? null, error: r.error ?? null, errorCode: r.errorCode ?? null, warnings: r.warnings ?? [],
  };
}
