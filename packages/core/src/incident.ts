import { sha1, stamp14 } from './hash.js';
import type { SuppressionPolicy } from './policy.js';
import { severityRank, type Severity } from './types.js';

export const MAX_MEMBERS = 200; // I-4

export const incidentId = (axis: string, triggeredAt: Date): string => `inc-${sha1(axis).slice(0, 12)}-${stamp14(triggeredAt)}`;

export interface IncidentRow {
  id: string;
  axis: string;
  customerId: string | null;
  title: string;
  severity: Severity;
  status: 'TRIGGERED' | 'ACKNOWLEDGED' | 'RESOLVED';
  triggeredAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedVia: 'MANUAL' | 'AUTO' | 'RECONCILE' | null;
  mttaSec: number | null;
  mttrSec: number | null;
  memberCount: number;
  eventCount: number;
  accountIds: string[];
  resourceTypes: string[];
  isMergeTarget: boolean;
  escalationStep: number;
  escalationRepeat: number;
  escalationBaseAt: Date | null;
  version: number;
}

export type MergeDecision = { action: 'MERGE'; incidentId: string } | { action: 'OPEN'; demote: string | null };

/** I-3: open when no target, target resolved, or target older than the merge cap (6h, known-bugs 3-4). */
export function mergeOrOpen(target: IncidentRow | null, now: Date, p: SuppressionPolicy): MergeDecision {
  if (!target || !target.isMergeTarget) return { action: 'OPEN', demote: null };
  if (target.status === 'RESOLVED') return { action: 'OPEN', demote: target.id };
  if (now.getTime() - target.triggeredAt.getTime() >= p.incidentMergeMaxSec * 1000) return { action: 'OPEN', demote: target.id };
  return { action: 'MERGE', incidentId: target.id };
}

export function newIncident(axis: string, m: { customerId: string | null; severity: Severity; title: string }, now: Date, idTaken?: (id: string) => boolean): IncidentRow {
  let at = new Date(Math.floor(now.getTime() / 1000) * 1000);
  let id = incidentId(axis, at);
  for (let i = 0; i < 5 && idTaken?.(id); i++) {
    at = new Date(at.getTime() + 1000);
    id = incidentId(axis, at);
  }
  return {
    id, axis, customerId: m.customerId, title: m.title, severity: m.severity, status: 'TRIGGERED', triggeredAt: at,
    acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolvedVia: null, mttaSec: null, mttrSec: null,
    memberCount: 0, eventCount: 0, accountIds: [], resourceTypes: [], isMergeTarget: true,
    escalationStep: 0, escalationRepeat: 0, escalationBaseAt: at, version: 0,
  };
}

export interface MemberEvent {
  fingerprint: string;
  severity: Severity;
  title: string;
  awsAccountId: string | null;
  resourceType: string | null;
}

/**
 * I-4: add/merge one member. Known member → only eventCount grows. Cap 200 members. Empty fingerprint ignored.
 * Severity/title follow the most severe member (G-9). Returns whether the member set changed.
 */
export function addMember(inc: IncidentRow, members: Set<string>, ev: MemberEvent): { incident: IncidentRow; memberAdded: boolean } {
  if (!ev.fingerprint) return { incident: inc, memberAdded: false };
  const known = members.has(ev.fingerprint);
  const canAdd = !known && members.size < MAX_MEMBERS;
  if (canAdd) members.add(ev.fingerprint);
  const moreSevere = severityRank(ev.severity) < severityRank(inc.severity);
  const next: IncidentRow = {
    ...inc,
    eventCount: inc.eventCount + 1,
    memberCount: members.size,
    accountIds: ev.awsAccountId && !inc.accountIds.includes(ev.awsAccountId) ? [...inc.accountIds, ev.awsAccountId] : inc.accountIds,
    resourceTypes: ev.resourceType && !inc.resourceTypes.includes(ev.resourceType) ? [...inc.resourceTypes, ev.resourceType] : inc.resourceTypes,
    severity: moreSevere ? ev.severity : inc.severity,
    title: moreSevere ? ev.title : inc.title,
  };
  return { incident: next, memberAdded: canAdd };
}

/** I-5 ack: TRIGGERED only. D-24: incident-level ack stops escalation. */
export function ack(inc: IncidentRow, by: string, now: Date): IncidentRow | null {
  if (inc.status !== 'TRIGGERED') return null;
  return { ...inc, status: 'ACKNOWLEDGED', acknowledgedAt: now, acknowledgedBy: by, mttaSec: Math.max(0, Math.round((now.getTime() - inc.triggeredAt.getTime()) / 1000)) };
}

/** I-5 resolve: already resolved → no-op (MTTR not pushed). */
export function resolve(inc: IncidentRow, via: 'MANUAL' | 'AUTO' | 'RECONCILE', by: string | null, now: Date): IncidentRow | null {
  if (inc.status === 'RESOLVED') return null;
  return {
    ...inc, status: 'RESOLVED', resolvedAt: now, resolvedBy: by, resolvedVia: via, isMergeTarget: false,
    mttrSec: Math.max(0, Math.round((now.getTime() - inc.triggeredAt.getTime()) / 1000)),
  };
}

/** I-5: auto-resolve only with ≥1 member and no member episode open; never right after merging a fire. */
export function shouldAutoResolve(memberEpisodeOpen: boolean[], justMergedFire: boolean): boolean {
  return !justMergedFire && memberEpisodeOpen.length > 0 && memberEpisodeOpen.every((o) => !o);
}

/** Optimistic-lock retry (I-7, known-bugs 3-2): up to 3 attempts, re-reading each time. */
export async function withVersionRetry<T>(attempt: () => Promise<T | 'CONFLICT'>, tries = 3): Promise<T | 'CONFLICT'> {
  for (let i = 0; i < tries; i++) {
    const r = await attempt();
    if (r !== 'CONFLICT') return r;
  }
  return 'CONFLICT';
}
