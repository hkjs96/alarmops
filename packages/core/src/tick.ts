/**
 * 1-minute tick orchestrator (API-CONTRACT §5, D-10, D-23). Framework-free: the route handler authenticates the
 * caller (TICK_SECRET) and calls `runTick` with a repository and senders.
 *
 * One tick = ① close due groups → collect → open/merge incidents ② auto-resolve ③ escalation steps + re-notify
 * ④ drain the notification outbox ⑤ heartbeats.
 *
 * Properties (tested in test/tick.test.ts):
 * - Safe to run twice: same minute → `{ skipped: 'duplicate' }`; even without that guard a second run finds nothing
 *   due, and every write is version-guarded with notification keys unique in the outbox.
 * - Safe to skip minutes: a late tick fires at most one step per incident (R4-4) and re-bases on now.
 * - Bounded: each phase takes at most `batch` rows and stops at the time budget; the rest waits for the next tick.
 * - One incident/group/job failing never stops the others (I-6 "한 인시던트의 오류가 틱 전체를 막지 않는다").
 */
import { buildSnapshot, incidentMute, planEscalation, scheduleNext, snapshotSummary, unownedInitialIntent, type NotificationIntent } from './escalation.js';
import { GROUP_GRACE_SEC, representative, type GroupRow } from './grouping.js';
import { addMember, mergeOrOpen, newIncident, incidentId, resolve, type IncidentRow } from './incident.js';
import { NOTIFY_RESERVE_MS, SMS_VOICE_REQUIRE_VERIFIED } from './limits.js';
import type { MaintenanceWindow } from './maintenance.js';
import { dispatchJob, NOTIFY_BATCH, type DeliveryLog, type DeliveryReason, type NotificationJob, type Senders } from './notify.js';
import type { Contact, PagingConfig, PagingWorld } from './paging.js';
import type { SuppressionPolicy } from './policy.js';
import type { Severity, Source } from './types.js';

export type TickJob = 'group' | 'reconcile' | 'escalation' | 'notify';
export const TICK_JOBS: readonly TickJob[] = ['group', 'reconcile', 'escalation', 'notify'];

/** One alert's firing events inside a group (RawEvent rows with this groupId, aggregated per alert). */
export interface GroupMember {
  alertId: string;
  fingerprint: string;
  severity: Severity;
  title: string;
  awsAccountId: string | null;
  resourceType: string | null;
  source: Source | null;
  /** Suppression decision at ingest (G-2: only NOTIFY/DEFER enter groups). */
  decision: 'NOTIFY' | 'DEFER';
  /** Is the alert's episode still open now (DEFER members only notify when still firing, G-7). */
  episodeOpen: boolean;
  eventCount: number;
}

export type IncidentEventKind = 'TRIGGERED' | 'MERGED' | 'ACKED' | 'RESOLVED' | 'ESCALATED' | 'NOTIFIED' | 'RENOTIFIED' | 'SUPPRESSED' | 'MUTED' | 'REMEDIATION' | 'NOTE';
export interface IncidentEventInput {
  incidentId: string;
  customerId: string | null;
  at: Date;
  kind: IncidentEventKind;
  actorType: 'USER' | 'CONTACT' | 'SYSTEM' | 'PROVIDER';
  actorId: string | null;
  message: string;
  data?: Record<string, unknown>;
}

export interface ResolutionInput {
  incidentId: string;
  customerId: string | null;
  via: 'MANUAL' | 'AUTO';
  kind: 'RESTART' | 'CONFIG' | 'AUTO' | 'OTHER' | null;
  note: string | null;
  serviceId: string | null;
  durationSec: number;
  escalationStep: number;
  resolvedBy: string | null;
  resolvedAt: Date;
}

export interface AuditInput {
  at: Date;
  customerId: string | null;
  actorType: 'USER' | 'CONTACT' | 'SYSTEM' | 'SLACK';
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

/** One transaction: group → DELIVERED together with the incident write it caused. */
export interface GroupDeliveryCommit {
  groupId: string;
  groupVersion: number;
  deliveredAt: Date;
  incident:
    | null
    | { mode: 'CREATE'; row: IncidentRow; demoteId: string | null }
    | { mode: 'MERGE'; row: IncidentRow; expectedVersion: number };
  /** IncidentAlert upserts: new member → insert, known → eventCount += n (I-4). */
  members: Array<{ alertId: string; fingerprint: string; eventCount: number }>;
  events: IncidentEventInput[];
  jobs: NotificationIntent[];
  /** RawEvent.finalAction per member (G-7). */
  finalized: Array<{ alertId: string; finalAction: 'NOTIFY' | 'SUPPRESS'; finalReason: string }>;
}

/** One transaction: incident row (version-guarded) + its timeline events + outbox rows + optional resolution/audit. */
export interface IncidentCommit {
  row: IncidentRow;
  expectedVersion: number;
  /** false = bookkeeping only (re-scheduling the next look): guarded by version but does not bump it, so open screens keep their If-Match. */
  bump: boolean;
  events?: IncidentEventInput[];
  jobs?: NotificationIntent[];
  resolution?: ResolutionInput;
  audit?: AuditInput;
  /** D-24: an incident ack acknowledges every member alert (Alert.status FIRING → ACKNOWLEDGED); UNACK reverts that. */
  memberEffect?: 'ACK' | 'UNACK';
  /**
   * Undo of an ack (R-8): pages of this step/repeat that were cancelled BECAUSE of the ack
   * (status SKIPPED, reason `acknowledged`, purpose INITIAL/ESCALATION) go back to QUEUED, due at `at`.
   * Pages of earlier steps are never restored; sent or failed pages are not touched.
   */
  restoreAckSkipped?: { stepIndex: number; repeat: number; at: Date };
}

export interface HeartbeatRow {
  name: TickJob;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastStatus: 'OK' | 'ERROR';
  lastDurationMs: number;
  lastStats: Record<string, unknown>;
  consecutiveFailures: number;
}
export type HeartbeatWrite = Omit<HeartbeatRow, 'consecutiveFailures'>;

/**
 * Persistence port of the tick. Production: Prisma/Postgres (each `commit*` is one transaction, each guarded
 * write is `UPDATE … WHERE version = ?`). Tests/local: MemoryTickStore.
 */
export interface TickRepository {
  /** Claim this minute (TickHeartbeat row per scheduledAt minute). false = another call already took it. */
  claimTick(minuteKey: string, at: Date): Promise<boolean>;
  loadPolicy(): Promise<SuppressionPolicy>;

  // ① groups
  /** OPEN groups with closeAt ≤ now (includes stale ones, G-6), oldest first. */
  listGroupsToClose(now: Date, limit: number): Promise<GroupRow[]>;
  /** Close only if still OPEN with this id (G-5). */
  closeGroup(groupId: string, at: Date): Promise<boolean>;
  /** CLOSED, not delivered, closed at or before `closedBefore` — "미발송 그룹 재선택" is the normal path (known-bugs 3-1). */
  listGroupsToDeliver(closedBefore: Date, limit: number): Promise<GroupRow[]>;
  groupMembers(groupId: string): Promise<GroupMember[]>;
  /** The axis' merge target (partial UQ(axis) where isMergeTarget). */
  findMergeTarget(axis: string): Promise<IncidentRow | null>;
  incidentIdExists(id: string): Promise<boolean>;
  incidentFingerprints(incidentId: string): Promise<string[]>;
  /** CloudAccount → Service → Project for the incident's org position; null when the account has no service. Tenant-checked. */
  orgForAccount(customerId: string, awsAccountId: string): Promise<{ projectId: string; serviceId: string } | null>;
  /** Paging configs + responders/rotations/overrides/leaves of ONE customer (shared MSP rotations included). */
  pagingContext(customerId: string): Promise<{ configs: PagingConfig[]; world: PagingWorld }>;
  commitGroupDelivery(c: GroupDeliveryCommit): Promise<'OK' | 'CONFLICT' | 'ALREADY_DELIVERED'>;

  // ② / ③ incidents
  /** Active incidents with ≥1 member and no member episode open (I-5), oldest first. */
  listAutoResolvable(limit: number): Promise<IncidentRow[]>;
  /** nextEscalationAt ≤ now, earliest first. `excludeIds`: incidents that already failed in this tick (N-8). */
  listEscalationDue(now: Date, limit: number, excludeIds?: string[]): Promise<IncidentRow[]>;
  /** Not revoked, covering `at`, for this customer (plus MSP-wide windows). */
  maintenanceWindows(customerId: string | null, at: Date): Promise<MaintenanceWindow[]>;
  /** True when the step has notifications and all of them ended FAILED or SKIPPED. */
  stepAllFailed(incidentId: string, stepIndex: number, repeat: number): Promise<boolean>;
  commitIncident(c: IncidentCommit): Promise<IncidentRow | 'CONFLICT'>;

  // ④ outbox
  /**
   * Claim due jobs (QUEUED, or SENDING whose lease ran out) with nextAttemptAt ≤ now, in `fairOrder` (round-robin
   * by customer, SEV-1 first — R-1): status SENDING, claimSeq+1, nextAttemptAt = now + CLAIM_LEASE_SEC, all in the
   * claiming UPDATE. `attempts` is NOT touched (R-3). A due job that already used MAX_ATTEMPTS sends (the process
   * died during the last one) becomes FAILED with a NotificationLog row (errorCode GAVE_UP) and is not returned.
   */
  claimDueJobs(now: Date, limit: number): Promise<NotificationJob[]>;
  /**
   * Right before the provider call: `attempts+1, nextAttemptAt = retryAt(attempts) WHERE status='SENDING' AND claimSeq=?`.
   * Returns the new attempt number, or null when the claim is no longer ours (then the caller must not send).
   */
  beginSend(jobId: string, claimSeq: number, now: Date): Promise<number | null>;
  /** Give back a claimed job that was not reached (budget): QUEUED, due now. Guarded by the claim token. */
  releaseJob(jobId: string, claimSeq: number, now: Date): Promise<boolean>;
  /** The incident a job belongs to (status for the ack check, org position and severity for the maintenance check). */
  findIncidentById(incidentId: string): Promise<IncidentRow | null>;
  getContact(contactId: string): Promise<Contact | null>;
  /** Slack destinations for a job: the incident's most specific scope channels (R4-3), or the MSP default. */
  slackDestinations(job: NotificationJob): Promise<{ channels: string[]; owner: 'CUSTOMER' | 'MSP' }>;
  /**
   * Write the result `WHERE status='SENDING' AND claimSeq=?` (R-2): a run that lost its claim changes nothing and
   * gets false — a SENT job can never go back to QUEUED. `log` and `event` are written in the same transaction.
   */
  completeJob(
    jobId: string, claimSeq: number,
    r: { status: 'SENT' | 'FAILED' | 'SKIPPED' | 'QUEUED'; providerMessageId?: string | null; error?: string | null; errorCode?: DeliveryReason | null },
    log?: DeliveryLog, event?: IncidentEventInput,
  ): Promise<boolean>;

  // ⑤ heartbeat
  writeHeartbeat(hb: HeartbeatWrite): Promise<void>;
  readHeartbeats(): Promise<HeartbeatRow[]>;
}

export interface TickInput {
  /** Minute this call stands for (pg_cron). Defaults to now. Dedup key is the minute. */
  scheduledAt?: Date;
  jobs?: TickJob[];
}
export interface TickDeps {
  repo: TickRepository;
  senders: Senders;
  now?: () => Date;
  /** Max rows per phase (default 200; outbox 50 per R1-4). */
  batch?: number;
  notifyBatch?: number;
  /**
   * Wall-clock budget; phases stop taking new work after it (default 45s of the 50s response limit).
   * The phases before the outbox stop NOTIFY_RESERVE_MS earlier (at most a quarter of the budget), so pages go out
   * even when grouping and escalation are busy (R-3).
   */
  budgetMs?: number;
  /** Per provider call (default SEND_TIMEOUT_MS). */
  sendTimeoutMs?: number;
  /** Q-DM-16 switch (default SMS_VOICE_REQUIRE_VERIFIED). */
  smsVoiceRequireVerified?: boolean;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

export interface TickError { phase: TickJob; id: string; message: string }
export interface TickSummary {
  scheduledAt: string;
  group: { closed: number; delivered: number; opened: number; merged: number; empty: number; paused: number; conflicts: number };
  reconcile: { checked: number; resolved: number };
  escalation: { checked: number; escalated: number; muted: number; renotified: number; done: number; conflicts: number };
  notify: { sent: number; failed: number; retried: number; skipped: number };
  errors: TickError[];
  /** A phase hit its batch limit or the time budget; the remainder runs next tick. */
  truncated: boolean;
  durationMs: number;
}
export type TickResult = TickSummary | { skipped: 'duplicate'; scheduledAt: string };

export const minuteKey = (d: Date): string => d.toISOString().slice(0, 16) + 'Z';
const MAX_VERSION_RETRIES = 3;
const DEFAULT_BATCH = 200;
const DEFAULT_BUDGET_MS = 45_000;

export async function runTick(input: TickInput, deps: TickDeps): Promise<TickResult> {
  const clock = deps.now ?? (() => new Date());
  const started = clock();
  const scheduledAt = input.scheduledAt ?? started;
  const key = minuteKey(scheduledAt);
  if (!(await deps.repo.claimTick(key, started))) return { skipped: 'duplicate', scheduledAt: key };

  const jobs = new Set<TickJob>(input.jobs?.length ? input.jobs : TICK_JOBS);
  const batch = deps.batch ?? DEFAULT_BATCH;
  const budget = Math.max(0, deps.budgetMs ?? DEFAULT_BUDGET_MS);
  const deadline = started.getTime() + budget;
  const softDeadline = deadline - Math.min(NOTIFY_RESERVE_MS, Math.floor(budget / 4));
  const sum: TickSummary = {
    scheduledAt: key,
    group: { closed: 0, delivered: 0, opened: 0, merged: 0, empty: 0, paused: 0, conflicts: 0 },
    reconcile: { checked: 0, resolved: 0 },
    escalation: { checked: 0, escalated: 0, muted: 0, renotified: 0, done: 0, conflicts: 0 },
    notify: { sent: 0, failed: 0, retried: 0, skipped: 0 },
    errors: [], truncated: false, durationMs: 0,
  };
  const ctx: Ctx = { ...deps, clock, batch, deadline, softDeadline, sum, policy: await deps.repo.loadPolicy() };

  const phases: Array<[TickJob, () => Promise<void>, () => Record<string, unknown>]> = [
    ['group', () => groupPhase(ctx), () => sum.group],
    ['reconcile', () => reconcilePhase(ctx), () => sum.reconcile],
    ['escalation', () => escalationPhase(ctx), () => sum.escalation],
    ['notify', () => notifyPhase(ctx), () => sum.notify],
  ];
  for (const [name, run, stats] of phases) {
    if (!jobs.has(name)) continue;
    const t0 = clock();
    const errorsBefore = sum.errors.length;
    try {
      await run();
    } catch (err) {
      // A phase-level failure (e.g. the listing query) must not stop the later phases.
      sum.errors.push({ phase: name, id: '*', message: errMsg(err) });
    }
    const t1 = clock();
    const failed = sum.errors.length > errorsBefore;
    try {
      await deps.repo.writeHeartbeat({
        name, lastStartedAt: t0, lastFinishedAt: t1, lastStatus: failed ? 'ERROR' : 'OK',
        lastDurationMs: Math.max(0, t1.getTime() - t0.getTime()), lastStats: { ...stats(), errors: sum.errors.length - errorsBefore },
      });
    } catch (err) {
      sum.errors.push({ phase: name, id: 'heartbeat', message: errMsg(err) });
    }
  }
  for (const e of sum.errors) deps.log?.('error', 'tick_item_failed', { ...e });
  sum.durationMs = Math.max(0, clock().getTime() - started.getTime());
  return sum;
}

interface Ctx extends TickDeps {
  clock: () => Date;
  batch: number;
  deadline: number;
  /** Deadline of every phase before the outbox. */
  softDeadline: number;
  sum: TickSummary;
  policy: SuppressionPolicy;
}
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const overBudget = (c: Ctx, phase: TickJob = 'group'): boolean => {
  if (c.clock().getTime() < (phase === 'notify' ? c.deadline : c.softDeadline)) return false;
  c.sum.truncated = true;
  return true;
};

// ───────────────────────────── ① groups → incidents ─────────────────────────────

async function groupPhase(c: Ctx): Promise<void> {
  const now = c.clock();
  // Close first, collect later (G-5): groups this tick closes are collected once the grace has passed (next tick).
  const toClose = await c.repo.listGroupsToClose(now, c.batch);
  if (toClose.length >= c.batch) c.sum.truncated = true;
  for (const g of toClose) {
    if (overBudget(c)) return;
    try {
      if (await c.repo.closeGroup(g.id, now)) c.sum.group.closed++;
    } catch (err) {
      c.sum.errors.push({ phase: 'group', id: g.id, message: errMsg(err) });
    }
  }
  const ready = await c.repo.listGroupsToDeliver(new Date(now.getTime() - GROUP_GRACE_SEC * 1000), c.batch);
  if (ready.length >= c.batch) c.sum.truncated = true;
  for (const g of ready) {
    if (overBudget(c)) return;
    try {
      await deliverGroup(c, g, now);
    } catch (err) {
      c.sum.errors.push({ phase: 'group', id: g.id, message: errMsg(err) });
    }
  }
}

async function deliverGroup(c: Ctx, g: GroupRow, now: Date): Promise<void> {
  const members = await c.repo.groupMembers(g.id);
  // PauseWait (S-10): DEFER members get the severity's auto-pause before we decide whether they still fire.
  const pauseSec = c.policy.autoPauseSec[g.severity] ?? 0;
  const closedAt = g.closedAt ?? g.closeAt;
  if (pauseSec > 0 && members.some((m) => m.decision === 'DEFER') && now.getTime() < closedAt.getTime() + pauseSec * 1000) {
    c.sum.group.paused++;
    return;
  }
  const firing = members.filter((m) => m.fingerprint && (m.decision === 'NOTIFY' || m.episodeOpen));
  const finalized = members.map((m) => {
    const notify = m.decision === 'NOTIFY' || m.episodeOpen;
    return { alertId: m.alertId, finalAction: notify ? 'NOTIFY' as const : 'SUPPRESS' as const, finalReason: m.decision === 'NOTIFY' ? 'notify' : notify ? 'auto_pause_expired' : 'cleared' };
  });
  if (firing.length === 0) {
    const r = await c.repo.commitGroupDelivery({ groupId: g.id, groupVersion: g.version, deliveredAt: now, incident: null, members: [], events: [], jobs: [], finalized });
    if (r === 'OK') { c.sum.group.delivered++; c.sum.group.empty++; }
    return;
  }

  for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
    const target = await c.repo.findMergeTarget(g.groupKey);
    const decision = mergeOrOpen(target, now, c.policy);
    const memberRows = firing.map((m) => ({ alertId: m.alertId, fingerprint: m.fingerprint, eventCount: Math.max(1, m.eventCount) }));
    let commit: GroupDeliveryCommit;
    if (decision.action === 'MERGE' && target) {
      const fps = new Set(await c.repo.incidentFingerprints(target.id));
      let inc = target;
      let added = 0;
      for (const m of firing) {
        const r = addMember(inc, fps, m);
        inc = { ...r.incident, eventCount: r.incident.eventCount + Math.max(1, m.eventCount) - 1 };
        if (r.memberAdded) added++;
      }
      inc = { ...inc, lastMergedAt: now };
      commit = {
        groupId: g.id, groupVersion: g.version, deliveredAt: now, incident: { mode: 'MERGE', row: inc, expectedVersion: target.version },
        members: memberRows, finalized, jobs: [],
        // Ack is sticky (R6-2): merging into an acknowledged incident does not page again.
        events: [{ incidentId: inc.id, customerId: inc.customerId, at: now, kind: 'MERGED', actorType: 'SYSTEM', actorId: null,
          message: `${firing.length} alert${firing.length === 1 ? '' : 's'} merged (${added} new).`, data: { groupId: g.id, alertIds: firing.map((m) => m.alertId) } }],
      };
    } else {
      const built = await openIncident(c, g, firing, now);
      commit = {
        groupId: g.id, groupVersion: g.version, deliveredAt: now,
        incident: { mode: 'CREATE', row: built.row, demoteId: decision.action === 'OPEN' ? decision.demote : null },
        members: memberRows, finalized, events: built.events, jobs: built.jobs,
      };
    }
    const r = await c.repo.commitGroupDelivery(commit);
    if (r === 'ALREADY_DELIVERED') return; // another tick delivered it
    if (r === 'OK') {
      c.sum.group.delivered++;
      if (commit.incident?.mode === 'CREATE') c.sum.group.opened++; else c.sum.group.merged++;
      return;
    }
    // CONFLICT: the incident moved (ack, another merge) or someone else opened the axis → re-read and re-apply (I-7).
  }
  c.sum.group.conflicts++; // still CLOSED and undelivered → picked up again next tick
}

async function openIncident(c: Ctx, g: GroupRow, firing: GroupMember[], now: Date): Promise<{ row: IncidentRow; events: IncidentEventInput[]; jobs: NotificationIntent[] }> {
  const rep = representative(firing)!;
  // Same-second id collision → +1s (I-3). Pre-check the candidates newIncident may try.
  const taken = new Set<string>();
  const base = Math.floor(now.getTime() / 1000) * 1000;
  for (let s = 0; s <= 5; s++) {
    const id = incidentId(g.groupKey, new Date(base + s * 1000));
    if (await c.repo.incidentIdExists(id)) taken.add(id);
  }
  let inc = newIncident(g.groupKey, { customerId: g.customerId, severity: rep.severity, title: rep.title }, now, (id) => taken.has(id));
  const fps = new Set<string>();
  for (const m of firing) {
    const r = addMember(inc, fps, m);
    inc = { ...r.incident, eventCount: r.incident.eventCount + Math.max(1, m.eventCount) - 1 };
  }
  inc = { ...inc, source: rep.source, lastMergedAt: now };
  const events: IncidentEventInput[] = [{
    incidentId: inc.id, customerId: inc.customerId, at: inc.triggeredAt, kind: 'TRIGGERED', actorType: 'SYSTEM', actorId: null,
    message: `Incident opened with ${firing.length} alert${firing.length === 1 ? '' : 's'}: ${rep.title}`, data: { groupId: g.groupKey, alertIds: firing.map((m) => m.alertId) },
  }];
  const jobs: NotificationIntent[] = [];
  if (inc.customerId) {
    const account = rep.awsAccountId ?? firing.find((m) => m.awsAccountId)?.awsAccountId ?? null;
    const org = account ? await c.repo.orgForAccount(inc.customerId, account) : null;
    const { configs, world } = await c.repo.pagingContext(inc.customerId);
    const snapshot = buildSnapshot(configs, { customerId: inc.customerId, projectId: org?.projectId, serviceId: org?.serviceId }, world, now);
    inc = { ...inc, projectId: org?.projectId ?? null, serviceId: org?.serviceId ?? null, assignmentSnapshot: snapshot, pagingConfigId: snapshot?.pagingConfigId ?? null };
    if (snapshot) {
      events.push({ incidentId: inc.id, customerId: inc.customerId, at: inc.triggeredAt, kind: 'NOTE', actorType: 'SYSTEM', actorId: null,
        message: `Paging steps at open: ${snapshotSummary(snapshot)}`, data: { note: 'PAGING_ORDER', pagingConfigId: snapshot.pagingConfigId, level: snapshot.level } });
    }
  }
  if (!inc.assignmentSnapshot) {
    // Unmapped account or no call order: nobody is paged (R1-9). Say so once on the MSP channel and the timeline.
    jobs.push(unownedInitialIntent(inc));
    events.push({ incidentId: inc.id, customerId: inc.customerId, at: inc.triggeredAt, kind: 'NOTE', actorType: 'SYSTEM', actorId: null,
      message: inc.customerId ? 'Nobody is paged: no call order is configured for this customer.' : 'Nobody is paged: the AWS account is not assigned to a customer.', data: { note: 'NO_OWNER' } });
  }
  inc = { ...inc, nextEscalationAt: scheduleNext(inc, { now, renotifyAfterSec: c.policy.renotifyAfterSec }) };
  return { row: inc, events, jobs };
}

// ───────────────────────────── ② auto-resolve (I-5, I-6 step 1) ─────────────────────────────

async function reconcilePhase(c: Ctx): Promise<void> {
  const list = await c.repo.listAutoResolvable(c.batch);
  if (list.length >= c.batch) c.sum.truncated = true;
  for (const inc of list) {
    if (overBudget(c)) return;
    c.sum.reconcile.checked++;
    try {
      const now = c.clock();
      // I-5: never in the same tick that merged a fire into it (a stored time, so a second run of this tick agrees).
      if (inc.lastMergedAt && inc.lastMergedAt.getTime() >= now.getTime()) continue;
      const next = resolve(inc, 'AUTO', null, now);
      if (!next) continue;
      const r = await c.repo.commitIncident({
        row: next, expectedVersion: inc.version, bump: true,
        events: [{ incidentId: inc.id, customerId: inc.customerId, at: now, kind: 'RESOLVED', actorType: 'SYSTEM', actorId: null, message: 'Resolved automatically: every alert in this incident has cleared.' }],
        resolution: { incidentId: inc.id, customerId: inc.customerId, via: 'AUTO', kind: 'AUTO', note: null, serviceId: inc.serviceId, durationSec: next.mttrSec ?? 0, escalationStep: inc.escalationStep, resolvedBy: null, resolvedAt: now },
      });
      if (r !== 'CONFLICT') c.sum.reconcile.resolved++; // CONFLICT: someone acked/merged meanwhile → next tick decides again
    } catch (err) {
      c.sum.errors.push({ phase: 'reconcile', id: inc.id, message: errMsg(err) });
    }
  }
}

// ───────────────────────────── ③ escalation + re-notify ─────────────────────────────

async function escalationPhase(c: Ctx): Promise<void> {
  // N-8: an incident that fails stays first in the due list. Ask again without the ones that failed, so a block
  // of broken incidents cannot starve the rest of the batch (they are tried again next tick, not pushed back).
  const failed: string[] = [];
  for (let round = 0; round < MAX_ESCALATION_ROUNDS; round++) {
    const due = await c.repo.listEscalationDue(c.clock(), c.batch, failed.length ? failed : undefined);
    if (due.length >= c.batch) c.sum.truncated = true;
    let failedNow = 0;
    for (const inc of due) {
      if (overBudget(c)) return;
      c.sum.escalation.checked++;
      try {
        await escalateOne(c, inc);
      } catch (err) {
        failed.push(inc.id);
        failedNow++;
        c.sum.errors.push({ phase: 'escalation', id: inc.id, message: errMsg(err) });
      }
    }
    if (failedNow === 0 || due.length < c.batch) return;
  }
}
const MAX_ESCALATION_ROUNDS = 3;

async function escalateOne(c: Ctx, inc: IncidentRow): Promise<void> {
  const now = c.clock();
  const mute = incidentMute(
    { customerId: inc.customerId, projectId: inc.projectId, serviceId: inc.serviceId, accountIds: inc.accountIds, resourceTypes: inc.resourceTypes, severity: inc.severity },
    await c.repo.maintenanceWindows(inc.customerId, now), now,
  );
  const lastStep = inc.assignmentSnapshot?.steps?.[inc.escalationStep - 1];
  const lastStepAllFailed = inc.status === 'TRIGGERED' && lastStep?.advanceOnAllFail
    ? await c.repo.stepAllFailed(inc.id, lastStep.index, inc.escalationRepeat) : false;
  const plan = planEscalation(inc, { now, renotifyAfterSec: c.policy.renotifyAfterSec, mutedUntil: mute?.endsAt ?? null, lastStepAllFailed });

  if (plan.kind === 'NONE' || plan.kind === 'MUTED') {
    if (plan.kind === 'MUTED') c.sum.escalation.muted++;
    // Re-schedule only: no version bump, so nobody's open screen gets a 409 because of bookkeeping.
    if (plan.patch) await c.repo.commitIncident({ row: { ...inc, ...plan.patch }, expectedVersion: inc.version, bump: false });
    return;
  }
  // Claim first (version guard), then the outbox sends (R4-5). Lost the race (ack, another tick) → skip this tick.
  const r = await c.repo.commitIncident({
    row: { ...inc, ...plan.patch }, expectedVersion: inc.version, bump: true, jobs: plan.intents,
    events: [{ incidentId: inc.id, customerId: inc.customerId, at: now, kind: plan.event.kind, actorType: 'SYSTEM', actorId: null, message: plan.event.message, data: plan.event.data }],
  });
  if (r === 'CONFLICT') { c.sum.escalation.conflicts++; return; }
  if (plan.kind === 'RENOTIFY') c.sum.escalation.renotified++;
  else {
    c.sum.escalation.escalated++;
    if (plan.done) c.sum.escalation.done++;
  }
}

// ───────────────────────────── ④ outbox ─────────────────────────────

async function notifyPhase(c: Ctx): Promise<void> {
  const limit = c.notifyBatch ?? NOTIFY_BATCH;
  // R-3: look at the budget BEFORE claiming — a tick that cannot send must not touch the jobs at all.
  if (overBudget(c, 'notify')) return;
  const jobs = await c.repo.claimDueJobs(c.clock(), limit);
  if (jobs.length >= limit) c.sum.truncated = true;
  const windows = new Map<string, MaintenanceWindow[]>();
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    if (overBudget(c, 'notify')) {
      // Not reached: hand the claims back untouched (no attempt counted, due at once for the next tick).
      for (const rest of jobs.slice(i)) {
        try { await c.repo.releaseJob(rest.id, rest.claimSeq, c.clock()); } catch (err) { c.sum.errors.push({ phase: 'notify', id: rest.id, message: errMsg(err) }); }
      }
      return;
    }
    try {
      const now = c.clock();
      const inc = await c.repo.findIncidentById(job.incidentId);
      const person = job.contactId ? await c.repo.getContact(job.contactId) : null;
      const slack = job.channel === 'SLACK_BOT' || job.channel === 'SLACK_WEBHOOK' ? await c.repo.slackDestinations(job) : { channels: [], owner: 'MSP' as const };
      let muted = false;
      if (inc && inc.status !== 'RESOLVED' && inc.severity !== 'SEV_1') {
        const k = inc.customerId ?? '';
        if (!windows.has(k)) windows.set(k, await c.repo.maintenanceWindows(inc.customerId, now));
        muted = !!incidentMute({ customerId: inc.customerId, projectId: inc.projectId, serviceId: inc.serviceId, accountIds: inc.accountIds, resourceTypes: inc.resourceTypes, severity: inc.severity }, windows.get(k)!, now);
      }
      const out = await dispatchJob(job, {
        now, senders: c.senders, incidentStatus: inc?.status ?? null, contact: person, slackChannels: slack.channels, slackOwner: slack.owner, muted,
        requireVerifiedPhone: c.smsVoiceRequireVerified ?? SMS_VOICE_REQUIRE_VERIFIED, sendTimeoutMs: c.sendTimeoutMs,
        beginSend: () => c.repo.beginSend(job.id, job.claimSeq, c.clock()),
      });
      if (out.status === 'LOST') continue;
      let written: boolean;
      if (out.status === 'SENT') {
        written = await c.repo.completeJob(job.id, job.claimSeq, { status: 'SENT', providerMessageId: out.providerMessageId }, out.log);
        if (written) c.sum.notify.sent++;
      } else if (out.status === 'FAILED') {
        written = await c.repo.completeJob(job.id, job.claimSeq, { status: 'FAILED', error: out.error, errorCode: out.errorCode }, out.log);
        if (written) c.sum.notify.failed++;
      } else if (out.status === 'RETRY') {
        written = await c.repo.completeJob(job.id, job.claimSeq, { status: 'QUEUED', error: out.error, errorCode: out.errorCode });
        if (written) c.sum.notify.retried++;
      } else {
        written = await c.repo.completeJob(job.id, job.claimSeq, { status: 'SKIPPED', error: out.reason }, undefined, inc ? skipEvent(job, out.reason, now) : undefined);
        if (written) c.sum.notify.skipped++;
        // R-9: a recipient outside the job's tenant means a broken snapshot or job row — never silent.
        if (out.reason === 'tenant_mismatch') c.sum.errors.push({ phase: 'notify', id: job.id, message: 'recipient does not belong to the incident customer; not sent' });
      }
      if (!written) c.log?.('warn', 'notify_result_discarded', { jobId: job.id, claimSeq: job.claimSeq, outcome: out.status });
    } catch (err) {
      c.sum.errors.push({ phase: 'notify', id: job.id, message: errMsg(err) });
    }
  }
}

const CHANNEL_WORD: Partial<Record<NotificationJob['channel'], string>> = { SMS: 'SMS', VOICE: 'Call' };

/** Skips an operator has to know about get a timeline line (Q-DM-16: unverified phone). Others stay silent (R1-3). */
function skipEvent(job: NotificationJob, reason: string, now: Date): IncidentEventInput | undefined {
  if (reason !== 'unverified') return undefined;
  return {
    incidentId: job.incidentId, customerId: job.customerId, at: now, kind: 'NOTE', actorType: 'SYSTEM', actorId: null,
    message: `${job.payload.stepLabel}: ${CHANNEL_WORD[job.channel] ?? job.channel} to ${job.contactName ?? 'this person'} was not sent — the phone number is not verified.`,
    data: { note: 'SKIPPED_UNVERIFIED', stepIndex: job.stepIndex, repeat: job.repeat, channel: job.channel, contactId: job.contactId },
  };
}

// ───────────────────────────── heartbeat staleness (D-10) ─────────────────────────────

export const HEARTBEAT_STALE_SEC = 180;

export interface HeartbeatHealth {
  stale: boolean;
  jobs: Array<{ name: TickJob; ageSec: number | null; stale: boolean; lastStatus: 'OK' | 'ERROR' | null; consecutiveFailures: number }>;
}

/**
 * Has the tick stopped? A job is stale when it never finished or its last finish is older than `maxAgeSec`
 * (default 3 minutes, D-10). The caller (GET /health, an external probe — Q-DM-17) raises the alarm: the tick
 * cannot report its own death.
 */
export function heartbeatHealth(rows: HeartbeatRow[], now: Date, opts: { maxAgeSec?: number; jobs?: readonly TickJob[] } = {}): HeartbeatHealth {
  const max = opts.maxAgeSec ?? HEARTBEAT_STALE_SEC;
  const jobs = (opts.jobs ?? TICK_JOBS).map((name) => {
    const hb = rows.find((r) => r.name === name);
    const ageSec = hb?.lastFinishedAt ? Math.max(0, Math.floor((now.getTime() - hb.lastFinishedAt.getTime()) / 1000)) : null;
    return { name, ageSec, stale: ageSec == null || ageSec > max, lastStatus: hb?.lastStatus ?? null, consecutiveFailures: hb?.consecutiveFailures ?? 0 };
  });
  return { stale: jobs.some((j) => j.stale), jobs };
}
