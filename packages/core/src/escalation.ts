/**
 * Escalation engine (oncall-escalation R3–R6, D-17, D-20, D-24, D-30; API-CONTRACT §5 "에스컬레이션 판정").
 *
 * Pure: (incident state, frozen paging snapshot, clock) → what to send and the next state. No I/O.
 *
 * - The paging order is frozen at incident open (R3-1). Contact addresses are read at send time (R3-2).
 * - A step is due `wait` minutes after the previous page, where wait = atMin(i) − atMin(i−1) (R4-2: the base is the
 *   previous notification, not the incident start). With on-time ticks this lands on the `atMin` shown in the UI.
 * - One step per call (R4-4). Late calls (skipped ticks, mute just ended) fire ONE step and re-base on now, so a
 *   gap never produces a burst and never double pages.
 * - Every notification has a deterministic key (incident + purpose + step + repeat + channel + target), so planning
 *   the same state twice produces the same keys (outbox UQ absorbs duplicates).
 * - Ack stops paging (R6-3, D-24). Acked and unresolved incidents are re-notified (R5-2).
 * - Maintenance mutes everything but SEV-1 (D-17); the step counter is not touched while muted (R4-6).
 */
import { coveringWindow, type MaintenanceWindow } from './maintenance.js';
import { resolvePagingConfig, resolveStep, type PagingConfig, type PagingWorld, type ResolvedTarget, type ScopeLevel, type StepChannel, type TargetType } from './paging.js';
import type { Severity } from './types.js';

export interface SnapshotStep {
  index: number;
  atMin: number;
  targetType: TargetType;
  targetId: string | null;
  channels: StepChannel[];
  /** People this step reaches, resolved at open (shift → accepted override → leave). */
  resolved: ResolvedTarget[];
  advanceOnAllFail?: boolean;
  /** e.g. "MSP night desk" (rotation name) or "everyone in Responders (5)". */
  label?: string;
}

/** Incident.assignmentSnapshot (DATA-MODEL §2). JSON-safe: dates are ISO strings. */
export interface AssignmentSnapshot {
  capturedAt: string;
  pagingConfigId: string | null;
  level: ScopeLevel;
  planLabel: string;
  steps: SnapshotStep[];
  repeatCount: number;
  renotifyAfterAckSec: number | null;
  /** Contact ids that were replaced because of an active leave. */
  leaveApplied: string[];
}

const STYLE_LABEL: Record<PagingConfig['style'], string> = {
  ALL_AT_ONCE: 'All at once', CUSTOMER_ROTATION: 'Customer rotation', SHARED_ROTATION: 'Shared MSP rotation', CUSTOM: 'Custom steps',
};
const PLAN_LABEL: Record<PagingConfig['plan'], string> = { STANDARD: 'Standard', URGENT: 'Urgent', QUIET: 'Quiet' };
export const planLabel = (c: Pick<PagingConfig, 'style' | 'plan' | 'edited'>): string =>
  `${STYLE_LABEL[c.style]} · ${PLAN_LABEL[c.plan]}${c.edited ? ' (edited)' : ''}`;

/**
 * Freeze the paging order for an incident (R3-1): service › project › customer first existing config (D-30),
 * every step resolved to people at `at`. Returns null when no config applies — nobody will be paged (R1-9, 7-3).
 */
export function buildSnapshot(
  configs: PagingConfig[],
  path: { customerId: string; projectId?: string | null; serviceId?: string | null },
  w: PagingWorld,
  at: Date,
): AssignmentSnapshot | null {
  const hit = resolvePagingConfig(configs, path);
  if (!hit) return null;
  const leaveApplied = new Set<string>();
  const steps: SnapshotStep[] = [...hit.config.steps].sort((a, b) => a.index - b.index).map((s, i) => {
    const resolved = resolveStep(s, w, at);
    if (s.targetType === 'PERSON' && s.targetId && resolved[0] && resolved[0].contactId !== s.targetId) leaveApplied.add(s.targetId);
    const label = s.targetType === 'ROTATION' ? w.rotations.get(s.targetId ?? '')?.name
      : s.targetType === 'ALL_RESPONDERS' ? `everyone in Responders (${resolved.length})` : undefined;
    return {
      index: i, atMin: s.atMin, targetType: s.targetType, targetId: s.targetId, channels: [...s.channels], resolved,
      ...(s.advanceOnAllFail ? { advanceOnAllFail: true } : {}), ...(label ? { label } : {}),
    };
  });
  return {
    capturedAt: at.toISOString(), pagingConfigId: hit.config.id, level: hit.inheritedFrom, planLabel: planLabel(hit.config),
    steps, repeatCount: Math.max(0, Math.floor(hit.config.repeatCount)), renotifyAfterAckSec: hit.config.renotifyAfterAckSec ?? null,
    leaveApplied: [...leaveApplied],
  };
}

/** R3-3: a broken snapshot is "no snapshot" (the screen must not crash and nobody is paged from garbage). */
export function parseSnapshot(raw: unknown): AssignmentSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<AssignmentSnapshot>;
  if (typeof s.capturedAt !== 'string' || !Array.isArray(s.steps) || typeof s.repeatCount !== 'number') return null;
  for (const st of s.steps) {
    if (!st || typeof st.atMin !== 'number' || !Number.isFinite(st.atMin) || !Array.isArray(st.channels) || !Array.isArray(st.resolved)) return null;
    if (st.resolved.some((r) => !r || typeof r.contactId !== 'string')) return null;
  }
  return s as AssignmentSnapshot;
}

/** "Haeun Kim → Yuna Seo → everyone in Responders (5)" — the timeline line written at open. */
export function snapshotSummary(s: AssignmentSnapshot): string {
  return s.steps.map((st) => st.label ?? (st.resolved.map((r) => r.name).join(', ') || 'nobody')).join(' → ');
}

// ───────────────────────────── state & timing ─────────────────────────────

/** The Incident columns the engine reads and writes. */
export interface EscalationState {
  id: string;
  customerId: string | null;
  title: string;
  severity: Severity;
  status: 'TRIGGERED' | 'ACKNOWLEDGED' | 'RESOLVED';
  triggeredAt: Date;
  acknowledgedAt: Date | null;
  escalationStep: number;
  escalationRepeat: number;
  escalationBaseAt: Date | null;
  escalationDoneAt: Date | null;
  nextEscalationAt: Date | null;
  renotifiedAt: Date | null;
  renotifyCount: number;
  assignmentSnapshot: AssignmentSnapshot | null;
}
export type EscalationPatch = Partial<Pick<EscalationState,
  'escalationStep' | 'escalationRepeat' | 'escalationBaseAt' | 'escalationDoneAt' | 'nextEscalationAt' | 'renotifiedAt' | 'renotifyCount'>>;

/** PROPOSED: wait before a repeat cycle starts = the last interval of the ladder, or this when the ladder has one step. */
export const REPEAT_GAP_DEFAULT_MIN = 5;
/** A step fired at most this late keeps its scheduled time as the new base (no drift from tick jitter); later → base = now. */
export const CATCHUP_TOLERANCE_MS = 90_000;
/** While muted (or waiting on advanceOnAllFail) the tick looks again at least this often. */
export const RECHECK_MS = 5 * 60_000;
const MIN = 60_000;

export function repeatGapMin(steps: SnapshotStep[]): number {
  const n = steps.length;
  const d = n >= 2 ? steps[n - 1]!.atMin - steps[n - 2]!.atMin : 0;
  return d > 0 ? d : REPEAT_GAP_DEFAULT_MIN;
}

export interface NextStep {
  index: number;
  /** escalationRepeat after this step fires. */
  repeat: number;
  waitMin: number;
  baseAt: Date;
  dueAt: Date;
  /** What `baseAt` is, for the event wording (R4-3). */
  basis: 'INCIDENT_OPEN' | 'PREVIOUS_PAGE';
}

/** The step that fires next for a TRIGGERED incident, or null when the ladder (and repeats) is exhausted or empty. */
export function nextStep(inc: EscalationState): NextStep | null {
  const snap = parseSnapshot(inc.assignmentSnapshot);
  if (!snap || snap.steps.length === 0 || inc.escalationDoneAt) return null;
  const steps = snap.steps;
  const n = steps.length;
  const fired = Math.max(0, Math.min(inc.escalationStep, n));
  const baseAt = inc.escalationBaseAt ?? inc.triggeredAt;
  if (Number.isNaN(baseAt.getTime())) return null; // R4-2: no usable base → do nothing
  if (fired < n) {
    const waitMin = fired === 0 ? steps[0]!.atMin : Math.max(0, steps[fired]!.atMin - steps[fired - 1]!.atMin);
    const first = fired === 0 && inc.escalationRepeat === 0;
    return { index: fired, repeat: inc.escalationRepeat, waitMin, baseAt, dueAt: new Date(baseAt.getTime() + waitMin * MIN), basis: first ? 'INCIDENT_OPEN' : 'PREVIOUS_PAGE' };
  }
  if (inc.escalationRepeat < snap.repeatCount) {
    const waitMin = repeatGapMin(steps) + steps[0]!.atMin;
    return { index: 0, repeat: inc.escalationRepeat + 1, waitMin, baseAt, dueAt: new Date(baseAt.getTime() + waitMin * MIN), basis: 'PREVIOUS_PAGE' };
  }
  return null;
}

const renotifyAfterSec = (inc: EscalationState, policySec: number): number => {
  const own = parseSnapshot(inc.assignmentSnapshot)?.renotifyAfterAckSec;
  return Math.max(0, own ?? policySec);
};

/** When an ACKNOWLEDGED incident is re-notified next (R5-2, I-6 4), or null when re-notify is off / nobody to notify. */
export function renotifyDueAt(inc: EscalationState, policySec: number): Date | null {
  if (inc.status !== 'ACKNOWLEDGED') return null;
  const snap = parseSnapshot(inc.assignmentSnapshot);
  const after = renotifyAfterSec(inc, policySec);
  const base = inc.renotifiedAt ?? inc.acknowledgedAt;
  if (!snap || !snap.steps.length || after <= 0 || !base) return null;
  return new Date(base.getTime() + after * 1000);
}

/** Value for Incident.nextEscalationAt given the state as it is now (used after every transition: fire, ack, undo, resolve). */
export function scheduleNext(inc: EscalationState, ctx: { now: Date; renotifyAfterSec: number }): Date | null {
  if (inc.status === 'RESOLVED') return null;
  if (inc.status === 'ACKNOWLEDGED') return renotifyDueAt(inc, ctx.renotifyAfterSec);
  const next = nextStep(inc);
  if (!next) return null;
  const snap = parseSnapshot(inc.assignmentSnapshot)!;
  const last = inc.escalationStep > 0 ? snap.steps[Math.min(inc.escalationStep, snap.steps.length) - 1] : undefined;
  // advanceOnAllFail: look again every minute so a fully failed step can move on early.
  if (last?.advanceOnAllFail) return new Date(Math.min(next.dueAt.getTime(), ctx.now.getTime() + MIN));
  return next.dueAt;
}

// ───────────────────────────── maintenance (D-17) ─────────────────────────────

export interface MuteTarget { customerId: string | null; projectId?: string | null; serviceId?: string | null; accountIds?: string[]; resourceTypes?: string[]; severity: Severity }

/**
 * The window that mutes paging for this incident, or null. SEV-1 is never muted (D-17, fixed rule).
 * ACCOUNT / RESOURCE_TYPE windows mute an incident only when they cover all of its accounts / types;
 * ALERT-scoped windows silence one alert at ingest and never a whole incident.
 */
export function incidentMute(t: MuteTarget, windows: MaintenanceWindow[], at: Date): MaintenanceWindow | null {
  if (t.severity === 'SEV_1') return null;
  const base = { customerId: t.customerId, projectId: t.projectId ?? null, serviceId: t.serviceId ?? null };
  const hits = windows.filter((w) => {
    if (w.scopeType === 'ALERT') return false;
    if (w.scopeType === 'ACCOUNT') {
      const ids = t.accountIds ?? [];
      return ids.length > 0 && ids.every((a) => coveringWindow([w], { ...base, awsAccountId: a }, at));
    }
    if (w.scopeType === 'RESOURCE_TYPE') {
      const ts = t.resourceTypes ?? [];
      return ts.length > 0 && ts.every((r) => coveringWindow([w], { ...base, resourceType: r }, at));
    }
    return !!coveringWindow([w], base, at);
  });
  return hits.sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0] ?? null;
}

// ───────────────────────────── notifications ─────────────────────────────

export type NotifyPurpose = 'INITIAL' | 'ESCALATION' | 'RENOTIFY';
/** DATA-MODEL NotificationJob.channel. Step channel SLACK_CHANNEL becomes SLACK_BOT (destination resolved at send time). */
export type NotifyChannel = 'SLACK_BOT' | 'SLACK_WEBHOOK' | 'SLACK_DM' | 'EMAIL' | 'SMS' | 'VOICE';

export interface NotificationIntent {
  /** `{incidentId}:{purpose}:{step}:{repeat}:{channel}:{targetRef}` (DATA-MODEL NotificationJob.idempotencyKey). */
  idempotencyKey: string;
  incidentId: string;
  customerId: string | null;
  purpose: NotifyPurpose;
  channel: NotifyChannel;
  /** contactId for person channels, `scope` for the customer's Slack channel(s), `msp-default` for the MSP channel. */
  targetRef: string;
  contactId: string | null;
  contactName: string | null;
  stepIndex: number;
  repeat: number;
  payload: { title: string; severity: Severity; text: string; stepLabel: string };
}

export const notificationKey = (incidentId: string, purpose: NotifyPurpose, step: number, repeat: number, channel: NotifyChannel, targetRef: string): string =>
  `${incidentId}:${purpose}:${step}:${repeat}:${channel}:${targetRef}`;

export const SCOPE_CHANNEL_TARGET = 'scope';
export const MSP_DEFAULT_TARGET = 'msp-default';

function intentsFor(inc: EscalationState, step: SnapshotStep, purpose: NotifyPurpose, repeat: number, text: string, stepLabel: string): NotificationIntent[] {
  const out = new Map<string, NotificationIntent>();
  const add = (channel: NotifyChannel, targetRef: string, c: ResolvedTarget | null) => {
    const idempotencyKey = notificationKey(inc.id, purpose, step.index, repeat, channel, targetRef);
    if (!out.has(idempotencyKey)) {
      out.set(idempotencyKey, {
        idempotencyKey, incidentId: inc.id, customerId: inc.customerId, purpose, channel, targetRef,
        contactId: c?.contactId ?? null, contactName: c?.name ?? null, stepIndex: step.index, repeat,
        payload: { title: inc.title, severity: inc.severity, text, stepLabel },
      });
    }
  };
  for (const ch of step.channels) {
    if (ch === 'SLACK_CHANNEL') add('SLACK_BOT', SCOPE_CHANNEL_TARGET, null);
    else for (const r of step.resolved) add(ch, r.contactId, r);
  }
  return [...out.values()];
}

/** Incident with no paging snapshot (unmapped account, no config): one post to the MSP default channel, nobody is paged (R1-9). */
export function unownedInitialIntent(inc: Pick<EscalationState, 'id' | 'customerId' | 'title' | 'severity'>): NotificationIntent {
  return {
    idempotencyKey: notificationKey(inc.id, 'INITIAL', 0, 0, 'SLACK_BOT', MSP_DEFAULT_TARGET), incidentId: inc.id, customerId: inc.customerId,
    purpose: 'INITIAL', channel: 'SLACK_BOT', targetRef: MSP_DEFAULT_TARGET, contactId: null, contactName: null, stepIndex: 0, repeat: 0,
    payload: { title: inc.title, severity: inc.severity, text: 'Nobody is paged for this incident: no call order applies.', stepLabel: 'No owner' },
  };
}

const CH_LABEL: Record<StepChannel, string> = { SLACK_CHANNEL: 'Slack', SLACK_DM: 'Slack DM', SMS: 'SMS', VOICE: 'call', EMAIL: 'email' };
const fmtAt = (d: Date): string => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}Z`;
const who = (s: SnapshotStep): string => (s.resolved.length ? s.resolved.map((r) => r.name).join(', ') : 'nobody (no reachable responder)');
const how = (s: SnapshotStep): string => s.channels.map((c) => CH_LABEL[c]).join(' + ') || 'no channel';

export interface PlannedEvent {
  kind: 'NOTIFIED' | 'ESCALATED' | 'RENOTIFIED';
  /** Carries the base time it counted from (R4-3, known-bugs 7-2). */
  message: string;
  data: Record<string, unknown>;
}

export type EscalationPlan =
  /** Nothing to send. `patch` (if any) only re-schedules the next look. */
  | { kind: 'NONE'; reason: 'RESOLVED' | 'ACKED' | 'NO_SNAPSHOT' | 'DONE' | 'NOT_DUE'; patch: EscalationPatch | null }
  /** Due but covered by maintenance (not SEV-1): step and base untouched (R4-6). */
  | { kind: 'MUTED'; patch: EscalationPatch | null }
  | { kind: 'STEP'; stepIndex: number; repeat: number; done: boolean; reachesNobody: boolean; patch: EscalationPatch; intents: NotificationIntent[]; event: PlannedEvent }
  | { kind: 'RENOTIFY'; patch: EscalationPatch; intents: NotificationIntent[]; event: PlannedEvent };

export interface PlanContext {
  now: Date;
  /** SuppressionPolicy.renotifyAfterSec (used when the paging config has no own value). */
  renotifyAfterSec: number;
  /** Result of incidentMute(): the covering window's end, or null when not muted. */
  mutedUntil?: Date | null;
  /** All notifications of the last fired step ended FAILED/SKIPPED (only matters when that step has advanceOnAllFail). */
  lastStepAllFailed?: boolean;
  /** Manual "Escalate now": fire the next step regardless of wait and mute. */
  force?: { by: string };
}

const reschedule = (inc: EscalationState, at: Date | null): EscalationPatch | null =>
  (inc.nextEscalationAt?.getTime() ?? null) === (at?.getTime() ?? null) ? null : { nextEscalationAt: at };

/**
 * Decide what the tick does for one incident right now. Idempotent: applying the returned patch and calling again
 * with the same clock returns NONE; calling again WITHOUT applying it returns the same notification keys.
 */
export function planEscalation(inc: EscalationState, ctx: PlanContext): EscalationPlan {
  const { now } = ctx;
  if (inc.status === 'RESOLVED') return { kind: 'NONE', reason: 'RESOLVED', patch: reschedule(inc, null) };
  const snap = parseSnapshot(inc.assignmentSnapshot);
  const muted = !!ctx.mutedUntil && !ctx.force;
  const muteRecheck = ctx.mutedUntil ? new Date(Math.min(ctx.mutedUntil.getTime(), now.getTime() + RECHECK_MS)) : null;

  if (inc.status === 'ACKNOWLEDGED') {
    const due = renotifyDueAt(inc, ctx.renotifyAfterSec);
    if (!due || !snap) return { kind: 'NONE', reason: 'ACKED', patch: reschedule(inc, null) };
    if (now.getTime() < due.getTime()) return { kind: 'NONE', reason: 'ACKED', patch: reschedule(inc, due) };
    if (muted) return { kind: 'MUTED', patch: reschedule(inc, muteRecheck) };
    // Same routing as the first notification (R5-2, known-bugs 6-1): step 1 of the frozen order.
    const first = snap.steps[0]!;
    const n = inc.renotifyCount + 1;
    const base = inc.renotifiedAt ?? inc.acknowledgedAt!;
    const mins = Math.round(renotifyAfterSec(inc, ctx.renotifyAfterSec) / 60);
    const message = `Still unresolved ${mins} min after ${inc.renotifiedAt ? 'the last reminder' : 'acknowledgement'} ${fmtAt(base)} → reminder ${n}: ${how(first)} ${who(first)}.`;
    const after: EscalationState = { ...inc, renotifiedAt: now, renotifyCount: n };
    return {
      kind: 'RENOTIFY',
      patch: { renotifiedAt: now, renotifyCount: n, nextEscalationAt: scheduleNext(after, ctx) },
      intents: intentsFor(inc, first, 'RENOTIFY', n, message, `Reminder ${n}`),
      event: { kind: 'RENOTIFIED', message, data: { baseAt: base.toISOString(), renotifyCount: n, contactIds: first.resolved.map((r) => r.contactId) } },
    };
  }

  // TRIGGERED
  if (!snap || snap.steps.length === 0) return { kind: 'NONE', reason: 'NO_SNAPSHOT', patch: reschedule(inc, null) };
  const next = nextStep(inc);
  if (!next) return { kind: 'NONE', reason: 'DONE', patch: reschedule(inc, null) };
  const n = snap.steps.length;
  const lastFired = inc.escalationStep > 0 ? snap.steps[Math.min(inc.escalationStep, n) - 1] : undefined;
  const early = !!(lastFired?.advanceOnAllFail && ctx.lastStepAllFailed);
  if (!ctx.force && !early && now.getTime() < next.dueAt.getTime()) {
    return { kind: 'NONE', reason: 'NOT_DUE', patch: reschedule(inc, scheduleNext(inc, ctx)) };
  }
  if (muted) return { kind: 'MUTED', patch: reschedule(inc, muteRecheck) };

  const step = snap.steps[next.index]!;
  const onTime = !ctx.force && !early && now.getTime() - next.dueAt.getTime() <= CATCHUP_TOLERANCE_MS;
  const newBase = onTime ? next.dueAt : now;
  const firedAfter = next.index + 1;
  const done = firedAfter >= n && next.repeat >= snap.repeatCount;
  const purpose: NotifyPurpose = next.index === 0 && next.repeat === 0 ? 'INITIAL' : 'ESCALATION';
  const pos = `step ${next.index + 1}/${n}${next.repeat > 0 ? ` (repeat ${next.repeat}/${snap.repeatCount})` : ''}`;
  const target = `${how(step)} ${who(step)}`;
  const message = ctx.force
    ? `Escalated manually by ${ctx.force.by} → ${pos}: ${target}.`
    : early
      ? `Every notification of the previous step failed → ${pos}: ${target}.`
      : purpose === 'INITIAL' && next.waitMin === 0
        ? `Paged ${pos}: ${target}.`
        : `No ack within ${next.waitMin} min of ${next.basis === 'INCIDENT_OPEN' ? 'incident open' : 'the previous page'} ${fmtAt(next.baseAt)} → ${pos}: ${target}.`;
  const after: EscalationState = {
    ...inc, escalationStep: firedAfter, escalationRepeat: next.repeat, escalationBaseAt: newBase, escalationDoneAt: done ? now : null,
  };
  return {
    kind: 'STEP', stepIndex: next.index, repeat: next.repeat, done, reachesNobody: step.resolved.length === 0 && !step.channels.includes('SLACK_CHANNEL'),
    patch: {
      escalationStep: firedAfter, escalationRepeat: next.repeat, escalationBaseAt: newBase, escalationDoneAt: done ? now : null,
      nextEscalationAt: scheduleNext(after, ctx),
    },
    intents: intentsFor(inc, step, purpose, next.repeat, message, `Step ${next.index + 1}/${n}`),
    event: {
      kind: purpose === 'INITIAL' ? 'NOTIFIED' : 'ESCALATED', message,
      data: { stepIndex: next.index, repeat: next.repeat, baseAt: next.baseAt.toISOString(), dueAt: next.dueAt.toISOString(), waitMin: next.waitMin,
        contactIds: step.resolved.map((r) => r.contactId), channels: step.channels, manual: !!ctx.force, done },
    },
  };
}

// ───────────────────────────── view for the UI ─────────────────────────────

export type PagingState =
  /** TRIGGERED, a next step (or repeat) is scheduled. */
  | 'PAGING'
  /** TRIGGERED, covered by a maintenance window and not SEV-1. */
  | 'MUTED'
  /** Paging stopped: someone acknowledged (D-24). A reminder may still be scheduled (`renotifyAt`). */
  | 'STOPPED_ACKED'
  | 'STOPPED_RESOLVED'
  /** Paging stopped: every step and repeat was sent and nobody acknowledged (D-20). */
  | 'STOPPED_EXHAUSTED'
  /** No call order applies (unmapped account, no paging config, or no steps): nobody was or will be paged. */
  | 'NEVER_ESCALATING'
  /** A call order applies but none of its steps reaches a person. */
  | 'UNREACHABLE';

export interface EscalationView {
  state: PagingState;
  /** 0-based step that was paged last (0 before anything fired). */
  step: number;
  firedSteps: number;
  totalSteps: number;
  repeat: number;
  repeatCount: number;
  /** When the next step fires; null when paging is stopped, muted or impossible. */
  nextAt: Date | null;
  nextLabel: string | null;
  renotifyAt: Date | null;
  baseAt: Date | null;
  doneAt: Date | null;
  /** When paging stopped (ack, resolve or exhaustion). */
  stoppedAt: Date | null;
  mutedByMaintenance: boolean;
  /** True once any step after the first was paged without an ack ("Escalated"). */
  escalated: boolean;
}

export function escalationView(
  inc: EscalationState & { resolvedAt?: Date | null },
  ctx: { now: Date; renotifyAfterSec: number; mutedUntil?: Date | null },
): EscalationView {
  const snap = parseSnapshot(inc.assignmentSnapshot);
  const n = snap?.steps.length ?? 0;
  const fired = Math.max(0, Math.min(inc.escalationStep, n));
  const base: EscalationView = {
    state: 'PAGING', step: Math.max(0, fired - 1), firedSteps: fired, totalSteps: n, repeat: inc.escalationRepeat, repeatCount: snap?.repeatCount ?? 0,
    nextAt: null, nextLabel: null, renotifyAt: null, baseAt: inc.escalationBaseAt, doneAt: inc.escalationDoneAt, stoppedAt: null,
    mutedByMaintenance: false, escalated: inc.escalationStep > 1 || inc.escalationRepeat > 0,
  };
  if (inc.status === 'RESOLVED') return { ...base, state: 'STOPPED_RESOLVED', stoppedAt: inc.acknowledgedAt ?? inc.resolvedAt ?? null };
  if (inc.status === 'ACKNOWLEDGED') return { ...base, state: 'STOPPED_ACKED', stoppedAt: inc.acknowledgedAt, renotifyAt: renotifyDueAt(inc, ctx.renotifyAfterSec) };
  if (!snap || n === 0) return { ...base, state: 'NEVER_ESCALATING' };
  if (inc.escalationDoneAt) return { ...base, state: 'STOPPED_EXHAUSTED', stoppedAt: inc.escalationDoneAt };
  const next = nextStep(inc);
  if (!next) return { ...base, state: 'STOPPED_EXHAUSTED', stoppedAt: inc.escalationBaseAt };
  const st = snap.steps[next.index]!;
  const nextLabel = `Step ${next.index + 1} · ${how(st)} ${who(st)}`;
  const reachesAnyone = snap.steps.some((s) => s.resolved.length > 0 || s.channels.includes('SLACK_CHANNEL'));
  if (ctx.mutedUntil && inc.severity !== 'SEV_1') return { ...base, state: 'MUTED', mutedByMaintenance: true, nextLabel };
  return { ...base, state: reachesAnyone ? 'PAGING' : 'UNREACHABLE', nextAt: next.dueAt, nextLabel };
}
