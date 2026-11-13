/**
 * 1-minute tick orchestrator (API-CONTRACT §5, D-10, D-23). Framework-free: the route handler authenticates the
 * caller (TICK_SECRET) and calls `runTick` with a repository and senders.
 *
 * One tick = ① close due groups → collect → open/merge incidents ② auto-resolve ③ escalation steps + re-notify
 * ④ drain the notification outbox, one lane per provider (R-11) ⑤ heartbeats.
 *
 * Properties (tested in test/tick.test.ts):
 * - Safe to run twice: same minute → `{ skipped: 'duplicate' }`; even without that guard a second run finds nothing
 *   due, and every write is version-guarded with notification keys unique in the outbox.
 * - Safe to skip minutes: a late tick fires at most one step per incident (R4-4) and re-bases on now.
 * - Bounded: each phase takes at most `batch` rows and stops at the time budget; the rest waits for the next tick.
 * - One incident/group/job failing never stops the others (I-6 "한 인시던트의 오류가 틱 전체를 막지 않는다").
 */
import { MSP_DEFAULT_TARGET, buildSnapshot, clampMessage, incidentMute, planEscalation, scheduleNext, snapshotSummary, unownedInitialIntent, type NotificationIntent } from './escalation.js';
import { GROUP_GRACE_SEC, representative, type GroupRow } from './grouping.js';
import { addMember, mergeOrOpen, newIncident, incidentId, resolve, type IncidentRow } from './incident.js';
import { protectUnlessFalse } from './config.js';
import { errorTag } from './errorTag.js';
import { CLOCK_SKEW_LIMIT_MS, LANE_CONCURRENCY, NOTIFY_RESERVE_MS, SEND_TIMEOUT_MS, STORE_CALL_TIMEOUT_MS, TICK_RESPONSE_LIMIT_MS } from './limits.js';
import type { MaintenanceWindow } from './maintenance.js';
import {
  claimReserve, dispatchJob, LANES, MAX_ATTEMPTS, NOTIFY_BATCH, providerText, rotationKey,
  type DeliveryLog, type DeliveryReason, type NotificationJob, type SenderKind, type Senders,
} from './notify.js';
import type { Contact, PagingConfig, PagingWorld } from './paging.js';
import type { SuppressionPolicy } from './policy.js';
import type { CustomerStatus, PagingSuppressedReason, Severity, Source } from './types.js';
import { DEFAULT_RETENTION, runRetention, type RetentionConfig, type RetentionRepository, type RetentionSummary } from './retention.js';

export type TickJob = 'group' | 'reconcile' | 'escalation' | 'notify' | 'retention';
/** `retention` (D-45) is daily: the first tick of each KST day claims it, every other tick of the day does nothing and writes no heartbeat. */
export const TICK_JOBS: readonly TickJob[] = ['group', 'reconcile', 'escalation', 'notify', 'retention'];

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
  /** DEGRADED (notify only, N-12): the phase ran without an error but SEV-1 pages that were due were not attempted. */
  lastStatus: 'OK' | 'ERROR' | 'DEGRADED';
  lastDurationMs: number;
  lastStats: Record<string, unknown>;
  consecutiveFailures: number;
}
export type HeartbeatWrite = Omit<HeartbeatRow, 'consecutiveFailures'>;

/**
 * Persistence port of the tick. Production: `packages/store-sql` (explicit SQL on Postgres; each `commit*` is one
 * transaction, each guarded write is `UPDATE … WHERE version = ?`). Tests/local: MemoryTickStore. Both run the same
 * contract suite (test/contract).
 */
export interface TickRepository extends Partial<RetentionRepository> {
  /**
   * The STORE's clock (R-14, security review SQL R-2): SQL → the database's `now()`. `runTick` asks it first,
   * refuses to tick when the runner's clock is more than CLOCK_SKEW_LIMIT_MS away from it, and otherwise makes its
   * due decisions (groups, escalation, maintenance) on this time, so a runner with a wrong clock can neither page
   * early nor hold pages back. `null` = the store has no clock of its own (an in-memory store whose `clock` was
   * never set): the runner's clock is used as it is.
   */
  now(): Promise<Date | null>;
  /**
   * Claim this minute (one TickClaim row per scheduledAt minute). false = another call already took it.
   * `at` is the runner's clock when it asked: a store with its own clock answers 'CLOCK_SKEW' (and claims nothing)
   * when `at` is more than CLOCK_SKEW_LIMIT_MS away from it — the same rule as in `runTick`, enforced by the store
   * for callers that did not ask `now()` first.
   */
  claimTick(minuteKey: string, at: Date): Promise<boolean | 'CLOCK_SKEW'>;
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
  /**
   * D-43: Customer.status. A customer the store does not know is 'ACTIVE' (when in doubt, page). The tick reads it
   * once per customer and tick: when it opens an incident, before it escalates one, and right before a send.
   */
  customerStatus(customerId: string): Promise<CustomerStatus>;
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
  //
  // CLOCK RULE (R-14): the outbox methods take no time from the caller. "Is it due", "has the lease run out", the
  // new lease and the retry time are all computed from the STORE's clock — in SQL, `now()` inside the statement —
  // so two runners whose clocks disagree cannot both hold a job. The in-memory store has its own `clock`.
  // The runner's clock (`TickDeps.now`) is used for the tick budget and for timestamps in logs and events only.
  /**
   * Claim due jobs (QUEUED, or SENDING whose lease ran out, with nextAttemptAt ≤ store now) of the given provider
   * kinds, chosen by `selectForClaim` (fair order by customer, SEV-1 first, never-attempted before retries, a
   * reserved share for the oldest non-SEV-1 — R-1, R-11, N-17): status SENDING, claimSeq+1,
   * nextAttemptAt = store now + CLAIM_LEASE_SEC, all in the claiming UPDATE. `attempts` and `dueAt` are NOT touched
   * (R-3, R-11). A due job that already used MAX_ATTEMPTS sends (the process died during the last one) becomes
   * FAILED with a NotificationLog row (errorCode GAVE_UP) and is not returned.
   *
   * Two runners at once never get the same job and never an EMPTY claim while jobs are due: claims of one lane are
   * serialised (SQL: `pg_advisory_xact_lock` per lane at the start of the claim transaction), so the second runner
   * chooses among what the first left (security review SQL, B-1).
   *
   * `rotateAfter` (R-24): see `selectForClaim` — with more due customers than the claim holds, the customers after
   * this key come first. The result is in fair order either way.
   */
  claimDueJobs(limit: number, opts?: { kinds?: readonly SenderKind[]; rotateAfter?: string | null }): Promise<NotificationJob[]>;
  /**
   * Right before the provider call: `attempts+1, nextAttemptAt = dueAt = retryAt(attempts, store now) WHERE status='SENDING' AND claimSeq=?`.
   * Returns the new attempt number, or null when the claim is no longer ours (then the caller must not send).
   */
  beginSend(jobId: string, claimSeq: number): Promise<number | null>;
  /**
   * Give back a claimed job that was not sent. Guarded by the claim token. Status QUEUED, `attempts` unchanged.
   * - plain (budget ran out): `nextAttemptAt = dueAt` — the ORIGINAL due time, never "now" (R-11);
   * - `notBefore` (held by a maintenance window, N-13): `nextAttemptAt = dueAt = notBefore`, `lastError = note`,
   *   and `event` (if any) is written in the same transaction. The store never parks a job further ahead than its
   *   own now + RELEASE_HOLD_MAX_SEC, whatever `notBefore` says (R-2: the runner's clock is not trusted).
   */
  releaseJob(jobId: string, claimSeq: number, opts?: { notBefore?: Date; note?: string; event?: IncidentEventInput }): Promise<boolean>;
  /**
   * Due jobs nobody has tried yet (attempts = 0, QUEUED or lease expired, dueAt ≤ store now), read AFTER the drain.
   * `dueSev1Unattempted > 0` turns the notify heartbeat DEGRADED (N-12).
   */
  outboxBacklog(): Promise<{ dueUnattempted: number; dueSev1Unattempted: number; oldestDueAt: Date | null }>;
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

  // ⑥ housekeeping
  /**
   * Delete what has expired, on the store's clock, for EVERY owner (security review SQL, R-7): tick claims older
   * than two days, Idempotency-Key entries past `expiresAt`, undo records a day past theirs. Bounded per call.
   * Called once per tick after the phases; a failure is logged and never fails the tick.
   */
  purgeExpired(): Promise<number>;
}

export interface TickInput {
  /** Minute this call stands for (pg_cron). Defaults to now. Dedup key is the minute. */
  scheduledAt?: Date;
  jobs?: TickJob[];
}
export interface TickDeps {
  repo: TickRepository;
  senders: Senders;
  /**
   * The runner's clock. N-40 (security review 5): every time limit of the tick is computed from it, so it MUST be a
   * real, moving clock in production — leave it out (default `new Date()`) or pass the wall clock. A clock that
   * stands still (a constant) never shortens the guards. Tests only.
   */
  now?: () => Date;
  /** Max rows per phase (default 200; outbox 50 per R1-4). */
  batch?: number;
  notifyBatch?: number;
  /** D-45 retention periods (default DEFAULT_RETENTION; the app builds it with `retentionConfigFromEnv`). */
  retention?: RetentionConfig;
  /**
   * Wall-clock budget; phases stop taking new work after it (default 45 s). The call returns within
   * budget + sendTimeoutMs + 1 s ≤ TICK_RESPONSE_LIMIT_MS (60 s); a budget that would break that is cut down.
   * The phases before the outbox stop NOTIFY_RESERVE_MS earlier (at most a quarter of the budget), so pages go out
   * even when grouping and escalation are busy (R-3).
   */
  budgetMs?: number;
  /** Per provider call (default SEND_TIMEOUT_MS). */
  sendTimeoutMs?: number;
  /** Q-DM-16 / D-37 switch (default SMS_VOICE_REQUIRE_VERIFIED). Only the boolean `false` switches it off (R-15). */
  smsVoiceRequireVerified?: boolean;
  /** R-20 / STORE_PROVIDER_TEXT (default false). Only the boolean `true` keeps the masked provider text beyond the excerpt. */
  storeProviderText?: boolean;
  /** Provider calls in flight per lane (default LANE_CONCURRENCY). */
  laneConcurrency?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

export interface TickError { phase: TickJob; id: string; message: string }
export interface TickSummary {
  scheduledAt: string;
  group: { closed: number; delivered: number; opened: number; merged: number; empty: number; paused: number; conflicts: number };
  reconcile: { checked: number; resolved: number };
  escalation: {
    checked: number; escalated: number; muted: number; renotified: number; done: number; conflicts: number;
    /** D-43: skipped because the customer is not ACTIVE or the incident is pagingSuppressed. */
    suppressed: number;
  };
  notify: {
    sent: number; failed: number; retried: number; skipped: number;
    /** Held by a maintenance window (N-13). */
    deferred: number;
    /** Claimed but handed back unsent (budget). */
    released: number;
    /** Provider calls that timed out. */
    timeouts: number;
    /** Lanes where calls timed out and the provider answered none in this tick (R-17). Informational: the lane is never closed. */
    unanswered: SenderKind[];
    /** Due and never attempted after the drain (N-12). SEV-1 > 0 → heartbeat DEGRADED. */
    dueUnattempted: number;
    dueSev1Unattempted: number;
    /**
     * R-24: per lane that ended this tick without ANY answer, the customer key (`rotationKey`) the probing reached.
     * It is stored with the notify heartbeat (`lastStats.probeCursor`) and the next tick starts after it. A lane
     * that got an answer has no entry: its next tick starts in fair order again.
     */
    probeCursor: Partial<Record<SenderKind, string>>;
  };
  /** Present only when the daily retention job ran in this tick (D-45). */
  retention?: RetentionSummary;
  errors: TickError[];
  /** A phase hit its batch limit or the time budget; the remainder runs next tick. */
  truncated: boolean;
  durationMs: number;
}
export type TickResult =
  | TickSummary
  | { skipped: 'duplicate'; scheduledAt: string }
  /** R-2: the runner's clock and the store's clock disagree by `clockSkewMs` (runner − store); nothing ran. */
  | { skipped: 'clock-skew'; scheduledAt: string; clockSkewMs: number };

export const minuteKey = (d: Date): string => d.toISOString().slice(0, 16) + 'Z';
const MAX_VERSION_RETRIES = 3;
const DEFAULT_BATCH = 200;
const DEFAULT_BUDGET_MS = 45_000;
/** Time allowed for writing results after the last provider call was abandoned. */
const RESULT_WRITE_GRACE_MS = 1_000;
/** N-33: the tick aims to be finished this long before TICK_RESPONSE_LIMIT_MS. */
const HARD_STOP_MARGIN_MS = 500;
/** N-33: kept after the outbox for the backlog read and the notify heartbeat. */
const TAIL_RESERVE_MS = 1_500;
/** N-33: of that, kept for the heartbeat write while the backlog is read. */
const HEARTBEAT_KEEP_MS = 1_000;
/** N-33: an outbox that starts with less than this left does not send (a provider call needs time to answer). */
const LATE_OUTBOX_MIN_MS = 2_000;
/** N-33: a guard is never shorter than this (two guards after the hard stop still end before the limit). */
const MIN_GUARD_MS = 200;

export async function runTick(input: TickInput, deps: TickDeps): Promise<TickResult> {
  const clock = deps.now ?? (() => new Date());
  const started = clock();
  const scheduledAt = input.scheduledAt ?? started;
  const key = minuteKey(scheduledAt);
  const jobs = new Set<TickJob>(input.jobs?.length ? input.jobs : TICK_JOBS);
  // N-33: every store call of the tick is under a time guard, these four included. Whatever the store does, the
  // call answers within TICK_RESPONSE_LIMIT_MS.
  const hardStop = started.getTime() + TICK_RESPONSE_LIMIT_MS - HARD_STOP_MARGIN_MS;
  /** Guard for one store call outside the phases: at most STORE_CALL_TIMEOUT_MS, less when the tick is nearly over. */
  const guardMs = (keepMs = 0): number => Math.max(MIN_GUARD_MS, Math.min(STORE_CALL_TIMEOUT_MS, hardStop - clock().getTime() - keepMs));
  const firstJob = TICK_JOBS.find((j) => jobs.has(j)) ?? 'group';
  // R-2 (security review SQL): the store's clock decides. Asked first; the round trip is split in half.
  const asked = started.getTime();
  const storeClock = await guarded(deps.repo.now(), guardMs());
  const answered = clock().getTime();
  let skewMs = 0; // runner − store
  if (!storeClock.timedOut && storeClock.value) skewMs = Math.round((asked + answered) / 2 - storeClock.value.getTime());
  const skewed = async (ms: number): Promise<TickResult> => {
    const message = `runner clock is ${Math.abs(Math.round(ms / 1000))} s ${ms > 0 ? 'ahead of' : 'behind'} the store clock (limit ${CLOCK_SKEW_LIMIT_MS / 1000} s); this tick did nothing`;
    deps.log?.('error', 'tick_clock_skew', { clockSkewMs: ms, message });
    // On the record, and visible to the health check: status ERROR and NO finish time, so the job reads as stale.
    const storeNow = new Date(clock().getTime() - ms);
    for (const name of TICK_JOBS) {
      if (!jobs.has(name) || name === 'retention') continue;
      try {
        await guarded(deps.repo.writeHeartbeat({ name, lastStartedAt: storeNow, lastFinishedAt: null, lastStatus: 'ERROR', lastDurationMs: 0, lastStats: { skipped: 'clock-skew', clockSkewMs: ms, errors: 1 } }), guardMs());
      } catch { /* the heartbeat goes stale either way */ }
    }
    return { skipped: 'clock-skew', scheduledAt: key, clockSkewMs: ms };
  };
  if (Math.abs(skewMs) > CLOCK_SKEW_LIMIT_MS + (answered - asked) / 2) return skewed(skewMs);
  const claimed = storeClock.timedOut ? storeClock : await guarded(deps.repo.claimTick(key, started), guardMs());
  if (claimed.timedOut) {
    // Nobody knows whether the minute was claimed. Nothing runs and no heartbeat is written: the heartbeat goes
    // stale (D-10) and the next minute's tick is a separate call.
    const call = storeClock.timedOut ? 'now' : 'claimTick';
    const message = `${call} did not answer within ${STORE_CALL_TIMEOUT_MS} ms; this tick did nothing`;
    deps.log?.('error', 'tick_item_failed', { phase: firstJob, id: call, message });
    return { ...emptySummary(key), errors: [{ phase: firstJob, id: call, message }], truncated: true, durationMs: Math.max(0, clock().getTime() - started.getTime()) };
  }
  if (claimed.value === 'CLOCK_SKEW') return skewed(skewMs);
  if (!claimed.value) return { skipped: 'duplicate', scheduledAt: key };
  // Below a second the two clocks are treated as one (the measurement itself is not better than that).
  const offsetMs = Math.abs(skewMs) >= 1000 ? -skewMs : 0;
  const at = (): Date => (offsetMs ? new Date(clock().getTime() + offsetMs) : clock());

  const batch = deps.batch ?? DEFAULT_BATCH;
  // N-21: the call answers within budget + one send timeout (+ a second for the result writes), and that sum never
  // exceeds TICK_RESPONSE_LIMIT_MS — a larger budget or timeout is cut down here, not trusted.
  const sendTimeoutMs = Math.max(1, Math.min(deps.sendTimeoutMs ?? SEND_TIMEOUT_MS, TICK_RESPONSE_LIMIT_MS / 2));
  const budget = Math.max(0, Math.min(deps.budgetMs ?? DEFAULT_BUDGET_MS, TICK_RESPONSE_LIMIT_MS - sendTimeoutMs - RESULT_WRITE_GRACE_MS));
  const deadline = started.getTime() + budget;
  const softDeadline = deadline - Math.min(NOTIFY_RESERVE_MS, Math.floor(budget / 4));
  const sum = emptySummary(key);
  // N-33: the outbox does not need the policy. When it cannot be read in time the three phases that do are skipped
  // (heartbeat ERROR) and the pages that are already queued still go out.
  const policy = await guarded(deps.repo.loadPolicy(), guardMs());
  const ctx: Ctx = { ...deps, sendTimeoutMs, clock, at, batch, deadline, softDeadline, sum, policy: policy.timedOut ? null : policy.value };

  const phases: Array<[TickJob, () => Promise<void>, () => Record<string, unknown>]> = [
    ['group', () => groupPhase(ctx), () => sum.group],
    ['reconcile', () => reconcilePhase(ctx), () => sum.reconcile],
    ['escalation', () => escalationPhase(ctx), () => sum.escalation],
    ['notify', () => notifyPhase(ctx), () => sum.notify],
  ];
  const reserve = Math.min(NOTIFY_RESERVE_MS, Math.floor(budget / 4));
  for (const [name, run, stats] of phases) {
    if (!jobs.has(name)) continue;
    const t0 = clock();
    const errorsBefore = sum.errors.length;
    let degraded = false;
    try {
      if (name !== 'notify' && ctx.policy === null) {
        sum.truncated = true;
        sum.errors.push({ phase: name, id: 'policy', message: `loadPolicy did not answer within ${STORE_CALL_TIMEOUT_MS} ms; phase skipped, the outbox goes ahead` });
      } else if (name === 'notify') {
        // N-12: the outbox always gets its reserved share, counted from when it starts — even when an earlier
        // phase ran past the whole budget. N-33: but never so late that the call could not answer in time.
        const latestStart = hardStop - sendTimeoutMs - RESULT_WRITE_GRACE_MS - TAIL_RESERVE_MS;
        ctx.deadline = Math.min(Math.max(deadline, t0.getTime() + reserve), latestStart);
        if (t0.getTime() >= latestStart) {
          // The outbox starts too late for a call with the full timeout (an earlier phase held the process, or the
          // store was slow on every call). It still pages, with what is left: calls may start during the first half
          // of the remaining time and are abandoned after the second half. Below LATE_OUTBOX_MIN_MS it does not run.
          const room = hardStop - t0.getTime() - RESULT_WRITE_GRACE_MS - TAIL_RESERVE_MS;
          if (room >= LATE_OUTBOX_MIN_MS) { ctx.sendTimeoutMs = Math.floor(room / 2); ctx.deadline = t0.getTime() + Math.floor(room / 2); }
        }
        // No new call starts after the deadline and each call is abandoned at the send timeout, so the phase is
        // over by then. If it is not (a store call that hangs), stop waiting: the leases bring the jobs back.
        if ((await withinBudget(run(), Math.max(0, ctx.deadline - t0.getTime()) + ctx.sendTimeoutMs + RESULT_WRITE_GRACE_MS)) === 'TIMED_OUT') {
          sum.truncated = true;
          sum.errors.push({ phase: name, id: '*', message: 'outbox did not finish within budget + send timeout; left running, claimed jobs come back when their lease ends' });
        }
      } else {
        // N-12: an earlier phase that does not come back (one slow query) is left behind at the soft deadline so
        // the outbox still runs. Its writes are version-guarded; what it did not finish is picked up next tick.
        const left = softDeadline - t0.getTime();
        if (left <= 0) sum.truncated = true;
        else if ((await withinBudget(run(), left)) === 'TIMED_OUT') {
          sum.truncated = true;
          sum.errors.push({ phase: name, id: '*', message: 'phase did not finish within its share of the tick budget; left running, the outbox goes ahead' });
        }
      }
    } catch (err) {
      // A phase-level failure (e.g. the listing query) must not stop the later phases.
      sum.errors.push({ phase: name, id: '*', message: errMsg(err) });
    }
    if (name === 'notify') {
      // N-12: "ran without an error" is not "paged". Count what is due and was never tried.
      try {
        const read = await guarded(deps.repo.outboxBacklog(), guardMs(HEARTBEAT_KEEP_MS));
        if (read.timedOut) {
          // Unknown is not "nothing is waiting": the heartbeat is ERROR.
          sum.errors.push({ phase: name, id: 'backlog', message: 'outboxBacklog did not answer in time; what is still due is unknown' });
        } else {
          const backlog = read.value;
          sum.notify.dueUnattempted = backlog.dueUnattempted;
          sum.notify.dueSev1Unattempted = backlog.dueSev1Unattempted;
          degraded = backlog.dueSev1Unattempted > 0;
          if (backlog.dueUnattempted > 0) sum.truncated = true;
        }
      } catch (err) {
        sum.errors.push({ phase: name, id: 'backlog', message: errMsg(err) });
      }
    }
    const t1 = clock();
    const failed = sum.errors.length > errorsBefore;
    try {
      const wrote = await guarded(deps.repo.writeHeartbeat({
        name, lastStartedAt: new Date(t0.getTime() + offsetMs), lastFinishedAt: new Date(t1.getTime() + offsetMs), lastStatus: failed ? 'ERROR' : degraded ? 'DEGRADED' : 'OK',
        lastDurationMs: Math.max(0, t1.getTime() - t0.getTime()), lastStats: structuredClone({ ...stats(), errors: sum.errors.length - errorsBefore }),
      }), guardMs());
      // Not written → the row goes stale and the health check says so (D-10).
      if (wrote.timedOut) sum.errors.push({ phase: name, id: 'heartbeat', message: 'writeHeartbeat did not answer in time' });
    } catch (err) {
      sum.errors.push({ phase: name, id: 'heartbeat', message: errMsg(err) });
    }
  }
  // D-45: the daily retention job. After the pages went out; it takes what is left of the call (at most RETENTION_SHARE_MS).
  if (jobs.has('retention')) await retentionPhase(ctx, hardStop, offsetMs);
  // R-7: expired rows of every owner go here, not only when their owner happens to write again.
  try {
    const purged = await guarded(deps.repo.purgeExpired(), guardMs());
    if (purged.timedOut) deps.log?.('warn', 'tick_purge_failed', { message: 'purgeExpired did not answer in time' });
  } catch (err) {
    deps.log?.('warn', 'tick_purge_failed', { message: errMsg(err) });
  }
  for (const e of sum.errors) deps.log?.('error', 'tick_item_failed', { ...e });
  sum.durationMs = Math.max(0, clock().getTime() - started.getTime());
  return sum;
}

/** Time the retention job may take inside one tick (the response limit still holds: it also stops at the hard stop). */
const RETENTION_SHARE_MS = 8_000;

async function retentionPhase(c: Ctx, hardStop: number, offsetMs: number): Promise<void> {
  const left = hardStop - c.clock().getTime() - TAIL_RESERVE_MS;
  const share = Math.min(RETENTION_SHARE_MS, left);
  if (share < 1_500) return; // no time left: do not even claim the day, the next tick will
  const t0 = c.clock();
  let failed = false;
  try {
    const r = await guarded(runRetention(c.repo, c.retention ?? DEFAULT_RETENTION, c.at(), { deadlineMs: Date.now() + share, log: c.log }), share + 1_000);
    if (r.timedOut) {
      failed = true;
      c.sum.truncated = true;
      c.sum.errors.push({ phase: 'retention', id: '*', message: 'retention did not finish within its share of the tick; it continues on the next tick' });
    } else if (r.value.ran) {
      c.sum.retention = r.value;
      for (const e of r.value.errors) { failed = true; c.sum.errors.push({ phase: 'retention', id: e.customerId, message: `${e.stage}: ${e.message}` }); }
      if (r.value.partial) c.sum.truncated = true;
      // Nothing to retain (the usual day) leaves no heartbeat: it would only say "ran once today".
      if (r.value.customers === 0 && !failed) return;
    } else return;
  } catch (err) {
    failed = true;
    c.sum.errors.push({ phase: 'retention', id: '*', message: errMsg(err) });
  }
  const t1 = c.clock();
  try {
    await guarded(c.repo.writeHeartbeat({
      name: 'retention', lastStartedAt: new Date(t0.getTime() + offsetMs), lastFinishedAt: new Date(t1.getTime() + offsetMs), lastStatus: failed ? 'ERROR' : 'OK',
      lastDurationMs: Math.max(0, t1.getTime() - t0.getTime()), lastStats: structuredClone({ ...(c.sum.retention ?? {}), errors: c.sum.errors.filter((e) => e.phase === 'retention').length }),
    }), STORE_CALL_TIMEOUT_MS);
  } catch (err) {
    c.sum.errors.push({ phase: 'retention', id: 'heartbeat', message: errMsg(err) });
  }
}

const emptySummary = (key: string): TickSummary => ({
  scheduledAt: key,
  group: { closed: 0, delivered: 0, opened: 0, merged: 0, empty: 0, paused: 0, conflicts: 0 },
  reconcile: { checked: 0, resolved: 0 },
  escalation: { checked: 0, escalated: 0, muted: 0, renotified: 0, done: 0, conflicts: 0, suppressed: 0 },
  notify: { sent: 0, failed: 0, retried: 0, skipped: 0, deferred: 0, released: 0, timeouts: 0, unanswered: [], dueUnattempted: 0, dueSev1Unattempted: 0, probeCursor: {} },
  errors: [], truncated: false, durationMs: 0,
});

/** `withinBudget` for a call whose value is needed. A rejection stays a rejection. */
function guarded<T>(p: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => done({ timedOut: true }), ms);
    (timer as { unref?: () => void }).unref?.();
    p.then((value) => { clearTimeout(timer); done({ timedOut: false, value }); }, (err) => { clearTimeout(timer); fail(err); });
  });
}

/** Real-time guard (not the injectable clock): resolves 'TIMED_OUT' when `p` is still pending after `ms`. */
function withinBudget(p: Promise<void>, ms: number): Promise<'DONE' | 'TIMED_OUT'> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => done('TIMED_OUT'), ms);
    (timer as { unref?: () => void }).unref?.();
    p.then(() => { clearTimeout(timer); done('DONE'); }, (err) => { clearTimeout(timer); fail(err); });
  });
}

interface Ctx extends TickDeps {
  /** The runner's clock: budget and deadlines only. */
  clock: () => Date;
  /** The store's time (runner clock + the offset measured at the start, R-2): every due decision and every stored timestamp. */
  at: () => Date;
  /** R-24: where the last tick's probing stopped, per lane that got no answer (from the notify heartbeat). */
  probeCursor?: Partial<Record<SenderKind, string>>;
  batch: number;
  deadline: number;
  /** Deadline of every phase before the outbox. */
  softDeadline: number;
  sum: TickSummary;
  /** Per provider call in this tick (the caller's value, cut to the bound; shorter when the outbox starts late). */
  sendTimeoutMs: number;
  /** null: the policy could not be read in time (N-33); only the outbox runs. */
  policy: SuppressionPolicy | null;
  /** D-43: customer status, read once per customer in this tick (a rejected read is not cached). */
  statuses?: Map<string, Promise<CustomerStatus>>;
}
const suppressionReason = (s: CustomerStatus): PagingSuppressedReason => (s === 'TERMINATED' ? 'CUSTOMER_TERMINATED' : 'CUSTOMER_SUSPENDED');
/** D-43. null customer (unmapped account) is never inactive: nobody owns it, the MSP default path handles it. */
function statusOf(c: Ctx, customerId: string | null): Promise<CustomerStatus> {
  if (!customerId) return Promise.resolve('ACTIVE');
  const cache = (c.statuses ??= new Map());
  let p = cache.get(customerId);
  if (!p) {
    p = c.repo.customerStatus(customerId);
    cache.set(customerId, p);
    p.catch(() => cache.delete(customerId));
  }
  return p;
}
const policyOf = (c: Ctx): SuppressionPolicy => {
  if (!c.policy) throw new Error('suppression policy was not loaded');
  return c.policy;
};
/** What a thrown error becomes in the summary, the log and the job record: its name/code tag, never its raw message. */
const errMsg = (e: unknown): string => errorTag(e);
const overBudget = (c: Ctx, phase: TickJob = 'group'): boolean => {
  if (c.clock().getTime() < (phase === 'notify' ? c.deadline : c.softDeadline)) return false;
  c.sum.truncated = true;
  return true;
};

// ───────────────────────────── ① groups → incidents ─────────────────────────────

async function groupPhase(c: Ctx): Promise<void> {
  const now = c.at();
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
  const pauseSec = policyOf(c).autoPauseSec[g.severity] ?? 0;
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
    let decision = mergeOrOpen(target, now, policyOf(c));
    // D-43: an incident opened while the customer was suspended stays silent for good. If the customer is ACTIVE
    // again, a new fire must not disappear into it: it opens a new incident (the silent one stops being the merge
    // target), which is paged as usual — "다음 이벤트부터 평소대로 호출".
    if (decision.action === 'MERGE' && target?.pagingSuppressed && (await statusOf(c, g.customerId)) === 'ACTIVE') {
      decision = { action: 'OPEN', demote: target.id };
    }
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
  // D-43: SUSPENDED / TERMINATED customer: the incident is recorded, nobody is paged (MSP staff included), and it stays
  // silent after the customer is ACTIVE again. No paging order is frozen and no job is queued.
  const openStatus = inc.customerId ? await statusOf(c, inc.customerId) : 'ACTIVE';
  if (inc.customerId && openStatus !== 'ACTIVE') {
    const reason = suppressionReason(openStatus);
    events.push({ incidentId: inc.id, customerId: inc.customerId, at: inc.triggeredAt, kind: 'NOTE', actorType: 'SYSTEM', actorId: null,
      message: `Nobody is paged: the customer is ${openStatus === 'TERMINATED' ? 'terminated' : 'suspended'}.`, data: { note: 'PAGING_SUPPRESSED', reason } });
    return { row: { ...inc, pagingSuppressed: reason, nextEscalationAt: null }, events, jobs };
  }
  if (inc.customerId) {
    const account = rep.awsAccountId ?? firing.find((m) => m.awsAccountId)?.awsAccountId ?? null;
    const org = account ? await c.repo.orgForAccount(inc.customerId, account) : null;
    const { configs, world } = await c.repo.pagingContext(inc.customerId);
    const snapshot = buildSnapshot(configs, { customerId: inc.customerId, projectId: org?.projectId, serviceId: org?.serviceId }, world, now);
    inc = { ...inc, projectId: org?.projectId ?? null, serviceId: org?.serviceId ?? null, assignmentSnapshot: snapshot, pagingConfigId: snapshot?.pagingConfigId ?? null };
    if (snapshot) {
      events.push({ incidentId: inc.id, customerId: inc.customerId, at: inc.triggeredAt, kind: 'NOTE', actorType: 'SYSTEM', actorId: null,
        message: `Paging steps at open: ${snapshotSummary(snapshot)}`, data: { note: 'PAGING_ORDER', pagingConfigId: snapshot.pagingConfigId, level: snapshot.level } });
      // R-12: the engine cut the order down to the send caps — say so where the operator looks.
      if (snapshot.clamped) {
        events.push({ incidentId: inc.id, customerId: inc.customerId, at: inc.triggeredAt, kind: 'NOTE', actorType: 'SYSTEM', actorId: null,
          message: clampMessage(snapshot.clamped), data: { note: 'SEND_CAP_CLAMPED', ...snapshot.clamped } });
        c.log?.('warn', 'send_cap_clamped', { incidentId: inc.id, customerId: inc.customerId, pagingConfigId: snapshot.pagingConfigId, ...snapshot.clamped });
      }
    }
  }
  if (!inc.assignmentSnapshot) {
    // Unmapped account or no call order: nobody is paged (R1-9). Say so once on the MSP channel and the timeline.
    jobs.push(unownedInitialIntent(inc));
    events.push({ incidentId: inc.id, customerId: inc.customerId, at: inc.triggeredAt, kind: 'NOTE', actorType: 'SYSTEM', actorId: null,
      message: inc.customerId ? 'Nobody is paged: no call order is configured for this customer.' : 'Nobody is paged: the AWS account is not assigned to a customer.', data: { note: 'NO_OWNER' } });
  }
  inc = { ...inc, nextEscalationAt: scheduleNext(inc, { now, renotifyAfterSec: policyOf(c).renotifyAfterSec }) };
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
      const now = c.at();
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
    const due = await c.repo.listEscalationDue(c.at(), c.batch, failed.length ? failed : undefined);
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
  const now = c.at();
  // D-43: no paging for a customer that is not ACTIVE, nor for an incident opened while it was suspended. Nothing is
  // queued. The incident is parked for good (nextEscalationAt null) and marked, so that a customer that comes back
  // to ACTIVE is not paged late for it. Bookkeeping only: no version bump, no open screen gets a 409.
  const status = await statusOf(c, inc.customerId);
  if (inc.pagingSuppressed || status !== 'ACTIVE') {
    c.sum.escalation.suppressed++;
    if (inc.pagingSuppressed && inc.nextEscalationAt == null) return;
    const first = !inc.pagingSuppressed;
    await c.repo.commitIncident({
      row: { ...inc, pagingSuppressed: suppressionReason(status), nextEscalationAt: null }, expectedVersion: inc.version, bump: false,
      events: first ? [{ incidentId: inc.id, customerId: inc.customerId, at: now, kind: 'NOTE', actorType: 'SYSTEM', actorId: null,
        message: `Paging stopped: the customer is ${status === 'TERMINATED' ? 'terminated' : 'suspended'}.`, data: { note: 'PAGING_SUPPRESSED', reason: suppressionReason(status) } }] : undefined,
    });
    return;
  }
  const mute = incidentMute(
    { customerId: inc.customerId, projectId: inc.projectId, serviceId: inc.serviceId, accountIds: inc.accountIds, resourceTypes: inc.resourceTypes, severity: inc.severity },
    await c.repo.maintenanceWindows(inc.customerId, now), now,
  );
  const lastStep = inc.assignmentSnapshot?.steps?.[inc.escalationStep - 1];
  const lastStepAllFailed = inc.status === 'TRIGGERED' && lastStep?.advanceOnAllFail
    ? await c.repo.stepAllFailed(inc.id, lastStep.index, inc.escalationRepeat) : false;
  const plan = planEscalation(inc, { now, renotifyAfterSec: policyOf(c).renotifyAfterSec, mutedUntil: mute?.endsAt ?? null, lastStepAllFailed });

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

/**
 * Drain the outbox in LANES (R-11): one lane per provider kind (voice, SMS, Slack, e-mail), all running side by
 * side, each with at most `laneConcurrency` provider calls in flight. Lanes never wait for each other.
 *
 * There is NO lane-wide circuit breaker (security review 3, R-17): a lane is never closed and nothing about a
 * provider is remembered between ticks. What protects the queue instead:
 * - fair selection (`selectForClaim`): round-robin over customers, SEV-1 first, never-attempted before retries;
 * - per-job backoff (`beginSend` → RETRY_DELAYS_SEC): a job that timed out is not due again for 30 s … 10 min;
 * - the SEND ORDER inside one tick (`drainLane`, security review 4, R-22): a customer or a recipient whose call
 *   timed out in this tick goes behind everyone else for the rest of the tick, and while the provider has not
 *   answered anything yet the lane probes up to `laneConcurrency` DIFFERENT recipients at once (different customers
 *   first) instead of one call at a time.
 * Nothing is carried over: the next tick starts without penalties.
 *
 * What this gives, at the defaults (timeout 10 s, budget 45 s, width 5), measured with the real `runTick` in
 * test/security-review-4.lanes.test.ts, test/security-review-5.lanes.test.ts and test/r24-rotation.test.ts: a healthy
 * customer's page is attempted in the tick in which it is due as long as at most 24 OTHER customers' calls hang in
 * front of it on that lane (5 probes × 5 rounds − 1) and the store is fast. Beyond that it slips by whole ticks, but
 * by few (R-24, the probe cursor in `drainLane`): with n customers due on the lane and P customers probed per tick,
 * at most ⌈n ÷ P⌉ − 1 ticks. P is what the tick really does — 25 with a fast store, 20 when a store call takes
 * 0.4 – 1 s, 15 at 2.5 s — and the bound holds for whatever P turns out to be, because the next tick starts where
 * this one stopped (the cursor is stored, not computed from the minute).
 */
async function notifyPhase(c: Ctx): Promise<void> {
  const limit = c.notifyBatch ?? NOTIFY_BATCH;
  // R-3: look at the budget BEFORE claiming — a tick that cannot send must not touch the jobs at all.
  if (overBudget(c, 'notify')) return;
  // R-24: where did the probing of a lane that got no answer stop last time? One read; without it (slow, failing)
  // the lanes start in fair order, as a first tick does.
  try {
    const left = Math.max(MIN_GUARD_MS, Math.min(STORE_CALL_TIMEOUT_MS, c.deadline - c.clock().getTime()));
    const read = await guarded(c.repo.readHeartbeats(), left);
    const saved = read.timedOut ? undefined : read.value.find((h) => h.name === 'notify')?.lastStats?.probeCursor;
    if (saved && typeof saved === 'object') {
      c.probeCursor = Object.fromEntries(Object.entries(saved as Record<string, unknown>).filter(([k, v]) => (LANES as readonly string[]).includes(k) && typeof v === 'string'));
    }
  } catch { /* fair order */ }
  if (overBudget(c, 'notify')) return;
  const windows = new Map<string, Promise<MaintenanceWindow[]>>();
  await Promise.all(LANES.map(async (kind) => {
    try {
      await drainLane(c, kind, limit, windows);
    } catch (err) {
      c.sum.errors.push({ phase: 'notify', id: `lane:${kind}`, message: errMsg(err) });
    }
  }));
}

type SendSignal = 'ANSWERED' | 'TIMEOUT' | 'NONE';

const customerKeyOf = (j: NotificationJob): string => j.customerId ?? '\u0000msp';
/** Who a call rings: the person, the MSP default channel (one for all customers), or the customer's own channel(s). */
const recipientKeyOf = (j: NotificationJob): string =>
  j.contactId ? `c:${j.contactId}` : j.targetRef === MSP_DEFAULT_TARGET ? 't:msp' : `t:${customerKeyOf(j)}:${j.targetRef}`;

/**
 * One lane, one tick. `pending` is the claim in fair order; `pick` decides which job is sent next:
 *
 * PENALTIES (this tick only): a TIMEOUT marks the job's customer and its recipient. A job is
 *   class 0 — neither marked, class 1 — customer marked, another recipient, class 2 — recipient marked.
 *
 * - ANSWERED (the provider answered at least one call in this tick, success or refusal): `width` calls in flight,
 *   lowest class first; inside a class a recipient who is not being called right now first, then fair order. So a customer whose calls hang waits until every other customer
 *   was served, and a number that hangs waits until the other numbers of the same customer were tried.
 * - UNANSWERED (no answer yet): up to `width` calls in flight, each to a DIFFERENT recipient that has not timed out
 *   in this tick; customers without a timeout and without a call in flight first, then a second recipient of a
 *   customer that is in flight, then other recipients of a marked customer. When only marked recipients are left:
 *   ONE call at a time, in fair order. A dead provider therefore costs at most one call per distinct recipient
 *   plus about one per SEND_TIMEOUT_MS per tick, never more than `width` at once.
 *
 * PROBE CURSOR (R-24; security review SQL, R-1). While the lane is unanswered the customers are probed in KEY order
 * (`rotationKey`, code-unit order — stable from tick to tick, unlike the position in a claim), around the circle:
 * - no cursor (the previous tick of this lane got an answer, or there was none): start at the customer the fair
 *   order puts first;
 * - cursor K (the previous tick got NO answer and probed up to customer K): start at the first customer after K,
 *   and the claim itself is rotated the same way (`claimDueJobs({ rotateAfter: K })`), so with more due customers
 *   than one claim holds the window follows the cursor.
 * A tick that ends without an answer stores the key of the last customer it probed in that order
 * (`notify.probeCursor[lane]` → notify heartbeat `lastStats`). So tick k probes the customers at circle positions
 * [s, s + P) and tick k + 1 starts at s + P, whatever P was: every customer is probed within ⌈n ÷ P⌉ ticks. No
 * stride, no gcd, and nothing depends on the minute number. (The first rule replaced `start = minute × stride mod
 * n`, which stood still or skipped positions whenever a tick made fewer probes than the stride.)
 * Not covered: the cursor is advisory state in the heartbeat — if that write or the read at the start of the phase
 * fails, the lane starts in fair order again; two runners overlapping on one lane both move it (last write wins).
 * Customers that share a recipient with a call in flight (the MSP default channel) are passed over in that tick.
 */
async function drainLane(c: Ctx, kind: SenderKind, limit: number, windows: Map<string, Promise<MaintenanceWindow[]>>): Promise<void> {
  const cursor = c.probeCursor?.[kind] ?? null;
  const jobs = await c.repo.claimDueJobs(limit, cursor == null ? { kinds: [kind] } : { kinds: [kind], rotateAfter: cursor });
  if (jobs.length >= limit) c.sum.truncated = true;
  const width = Math.max(1, c.laneConcurrency ?? LANE_CONCURRENCY);
  const pending = [...jobs];
  let inFlight = 0;
  let answered = 0;
  let timeouts = 0;
  const badCustomers = new Set<string>();
  const badRecipients = new Set<string>();
  const flyingCustomers = new Map<string, number>();
  const flyingRecipients = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, d: number): void => { const n = (m.get(k) ?? 0) + d; if (n > 0) m.set(k, n); else m.delete(k); };
  const penalty = (j: NotificationJob): number => (badRecipients.has(recipientKeyOf(j)) ? 2 : badCustomers.has(customerKeyOf(j)) ? 1 : 0);
  const keys = [...new Set(jobs.map(rotationKey))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const nCust = keys.length;
  const keyPos = new Map(keys.map((k, i) => [k, i]));
  let startPos = 0;
  if (cursor != null) startPos = Math.max(0, keys.findIndex((k) => k > cursor));
  else if (jobs.length) startPos = keyPos.get(rotationKey(jobs[0]!)) ?? 0;
  /** Steps around the circle from this tick's starting customer (0 = the start). */
  const dist = (j: NotificationJob): number => ((keyPos.get(rotationKey(j)) ?? 0) - startPos + nCust) % nCust;
  /** 0 ≤ x < 1 */
  const turn = (j: NotificationJob): number => dist(j) / (nCust + 1);
  // How far the cursor may move: only over customers that are certainly ALL in this claim. A full claim holds the
  // first `limit − reserve` customers after the cursor without a gap (`selectForClaim`); the reserve slots may
  // belong to customers anywhere on the circle.
  const contiguous = jobs.length < limit ? nCust : Math.min(nCust, Math.max(1, limit - claimReserve(limit)));
  /** Furthest customer (in `dist`) probed while the lane was unanswered; −1 = none. */
  let reach = -1;
  // Kept current while the lane runs (not written at its end): a lane that is left running at the end of the tick
  // (slow store) has its cursor in the heartbeat all the same.
  const publishCursor = (): void => {
    if (answered > 0) delete c.sum.notify.probeCursor[kind];
    else if (timeouts > 0 && reach >= 0 && nCust > 0) c.sum.notify.probeCursor[kind] = keys[(startPos + Math.min(reach, contiguous - 1)) % nCust]!;
  };
  /** Index in `pending` of the job to send now, or −1: nothing may start until a call in flight comes back. */
  const pick = (): number => {
    if (inFlight >= width) return -1;
    let best = -1;
    let bestRank = Infinity;
    if (answered > 0) {
      for (let i = 0; i < pending.length && bestRank > 0; i++) {
        // inside a class, a recipient who is not being called right now goes first
        const rank = penalty(pending[i]!) * 2 + (flyingRecipients.has(recipientKeyOf(pending[i]!)) ? 1 : 0);
        if (rank < bestRank) { best = i; bestRank = rank; }
      }
      return best;
    }
    for (let i = 0; i < pending.length; i++) {
      const j = pending[i]!;
      const r = recipientKeyOf(j);
      if (badRecipients.has(r) || flyingRecipients.has(r)) continue;
      const ck = customerKeyOf(j);
      const rank = (badCustomers.has(ck) ? 2 : flyingCustomers.has(ck) ? 1 : 0) + turn(j);
      if (rank < bestRank) { best = i; bestRank = rank; }
    }
    if (best >= 0) return best;
    // only recipients that already timed out (or are being called right now) are left: one call at a time
    return inFlight === 0 ? 0 : -1;
  };
  // Not reached (budget): hand the claims back untouched — no attempt counted, due time kept. This happens AS SOON AS
  // the budget is over (no call can start any more), side by side, and not after the calls in flight have come back:
  // with a slow store those return after the next tick has started, and a job that is still claimed then is
  // missing from that tick's claim (R-1: the probe cursor would pass its customer).
  let handedBack: Promise<void> | null = null;
  const handBack = (): Promise<void> => (handedBack ??= Promise.all(pending.splice(0).map(async (j) => {
    try { if (await c.repo.releaseJob(j.id, j.claimSeq)) c.sum.notify.released++; } catch (err) { c.sum.errors.push({ phase: 'notify', id: j.id, message: errMsg(err) }); }
  })).then(() => undefined));
  let released = 0;
  // The pump only runs when a call comes back; the deadline may pass in between (a round of slow calls).
  const atDeadline = setTimeout(() => { if (pending.length > 0 && overBudget(c, 'notify')) { released = pending.length; void handBack(); } }, Math.max(0, c.deadline - c.clock().getTime()) + 1);
  (atDeadline as { unref?: () => void }).unref?.();
  await new Promise<void>((done) => {
    const pump = (): void => {
      while (pending.length > 0) {
        const i = pick();
        if (i < 0) break;
        if (overBudget(c, 'notify')) { released = pending.length; void handBack(); break; }
        const job = pending.splice(i, 1)[0]!;
        const ck = customerKeyOf(job);
        const rk = recipientKeyOf(job);
        if (answered === 0 && !badCustomers.has(ck) && !flyingCustomers.has(ck)) { reach = Math.max(reach, dist(job)); publishCursor(); }
        inFlight++; bump(flyingCustomers, ck, 1); bump(flyingRecipients, rk, 1);
        // sendOne never rejects: it records its own errors.
        void sendOne(c, job, windows).then((signal) => {
          inFlight--; bump(flyingCustomers, ck, -1); bump(flyingRecipients, rk, -1);
          if (signal === 'ANSWERED') answered++;
          else if (signal === 'TIMEOUT') { timeouts++; badCustomers.add(ck); badRecipients.add(rk); }
          publishCursor();
          pump();
        });
      }
      if (inFlight === 0) done();
    };
    pump();
  });
  clearTimeout(atDeadline);
  released ||= pending.length;
  await handBack();
  if (timeouts > 0 && answered === 0) {
    c.sum.notify.unanswered.push(kind);
    c.log?.('warn', 'notify_lane_unanswered', { kind, timeouts, released });
  }
}

/** Send one claimed job and write its result. Returns what the provider did, for the lane's probe mode. */
async function sendOne(c: Ctx, job: NotificationJob, windows: Map<string, Promise<MaintenanceWindow[]>>): Promise<SendSignal> {
  let attempt: number | null | undefined;
  try {
    const now = c.at();
    const inc = await c.repo.findIncidentById(job.incidentId);
    const person = job.contactId ? await c.repo.getContact(job.contactId) : null;
    const slack = job.channel === 'SLACK_BOT' || job.channel === 'SLACK_WEBHOOK' ? await c.repo.slackDestinations(job) : { channels: [], owner: 'MSP' as const };
    let mutedUntil: Date | null = null;
    if (inc && inc.status !== 'RESOLVED' && inc.severity !== 'SEV_1') {
      const k = inc.customerId ?? '';
      if (!windows.has(k)) windows.set(k, c.repo.maintenanceWindows(inc.customerId, now));
      mutedUntil = incidentMute({ customerId: inc.customerId, projectId: inc.projectId, serviceId: inc.serviceId, accountIds: inc.accountIds, resourceTypes: inc.resourceTypes, severity: inc.severity }, await windows.get(k)!, now)?.endsAt ?? null;
    }
    // D-43: the customer may have been suspended or terminated after this job was queued — look again right before the send.
    // Read fresh, not from the per-tick cache (which may hold a value from the group step): this is the last gate before a page.
    const owner = job.customerId ?? inc?.customerId ?? null;
    const customerInactive = !!inc?.pagingSuppressed || (owner != null && (await c.repo.customerStatus(owner)) !== 'ACTIVE');
    const out = await dispatchJob(job, {
      now, senders: c.senders, customerInactive, incidentStatus: inc?.status ?? null, contact: person, slackChannels: slack.channels, slackOwner: slack.owner, mutedUntil,
      requireVerifiedPhone: protectUnlessFalse(c.smsVoiceRequireVerified), sendTimeoutMs: c.sendTimeoutMs, storeProviderText: c.storeProviderText === true,
      beginSend: async () => (attempt = await c.repo.beginSend(job.id, job.claimSeq)),
    });
    if (out.status === 'LOST') return 'NONE';
    if (out.status === 'DEFERRED') {
      // N-13: held, not dropped. One timeline line the first time; the re-checks are silent.
      const first = job.lastError !== out.reason;
      const ok = await c.repo.releaseJob(job.id, job.claimSeq, { notBefore: out.until, note: out.reason, event: first ? deferEvent(job, mutedUntil!, now) : undefined });
      if (ok) c.sum.notify.deferred++;
      return 'NONE';
    }
    let written: boolean;
    let signal: SendSignal = 'NONE';
    if (out.status === 'SENT') {
      signal = 'ANSWERED';
      written = await c.repo.completeJob(job.id, job.claimSeq, { status: 'SENT', providerMessageId: out.providerMessageId }, out.log);
      if (written) c.sum.notify.sent++;
    } else if (out.status === 'FAILED') {
      signal = out.errorCode === 'TIMEOUT' ? 'TIMEOUT' : out.errorCode === 'NOT_CONFIGURED' ? 'NONE' : 'ANSWERED';
      written = await c.repo.completeJob(job.id, job.claimSeq, { status: 'FAILED', error: out.error, errorCode: out.errorCode }, out.log);
      if (written) c.sum.notify.failed++;
    } else if (out.status === 'RETRY') {
      signal = out.errorCode === 'TIMEOUT' ? 'TIMEOUT' : 'ANSWERED';
      written = await c.repo.completeJob(job.id, job.claimSeq, { status: 'QUEUED', error: out.error, errorCode: out.errorCode });
      if (written) c.sum.notify.retried++;
    } else {
      written = await c.repo.completeJob(job.id, job.claimSeq, { status: 'SKIPPED', error: out.reason }, undefined, inc ? skipEvent(job, out.reason, now) : undefined);
      if (written) c.sum.notify.skipped++;
      // R-9: a recipient outside the job's tenant means a broken snapshot or job row — never silent.
      if (out.reason === 'tenant_mismatch') c.sum.errors.push({ phase: 'notify', id: job.id, message: 'recipient does not belong to the incident customer; not sent' });
    }
    if (signal === 'TIMEOUT') c.sum.notify.timeouts++;
    if (!written) c.log?.('warn', 'notify_result_discarded', { jobId: job.id, claimSeq: job.claimSeq, outcome: out.status });
    return signal;
  } catch (err) {
    c.sum.errors.push({ phase: 'notify', id: job.id, message: errMsg(err) });
    // N-18: a job whose lookups (or result write) keep throwing must not circle forever with attempts 0. The
    // failure uses an attempt like a failed send does; after MAX_ATTEMPTS it is FAILED on the record.
    try {
      if (attempt === undefined) attempt = await c.repo.beginSend(job.id, job.claimSeq);
      if (attempt != null) {
        const error = providerText(`internal error before or after the send: ${errMsg(err)}`, c.storeProviderText);
        if (attempt >= MAX_ATTEMPTS) {
          const channel = job.channel === 'SLACK_BOT' || job.channel === 'SLACK_WEBHOOK';
          const ok = await c.repo.completeJob(job.id, job.claimSeq, { status: 'FAILED', error, errorCode: 'GAVE_UP' }, {
            at: c.at(), customerId: job.customerId, incidentId: job.incidentId, jobId: job.id, channel: job.channel, status: 'FAILED',
            targetSummary: channel ? 'Slack channel' : job.contactName ?? 'Unknown person', targetKind: channel ? 'MSP_CHANNEL' : 'STAFF', contactId: channel ? null : job.contactId,
            escalationStep: job.stepIndex, attempt, providerMessageId: null, error, errorCode: 'GAVE_UP', warnings: [],
          });
          if (ok) c.sum.notify.failed++;
        } else if (await c.repo.completeJob(job.id, job.claimSeq, { status: 'QUEUED', error, errorCode: 'PROVIDER_ERROR' })) c.sum.notify.retried++;
      }
    } catch { /* the store is down: the lease runs out and the next claim counts or gives up (claimDueJobs) */ }
    return 'NONE';
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

function deferEvent(job: NotificationJob, until: Date, now: Date): IncidentEventInput {
  return {
    incidentId: job.incidentId, customerId: job.customerId, at: now, kind: 'NOTE', actorType: 'SYSTEM', actorId: null,
    message: `${job.payload.stepLabel}: ${CHANNEL_WORD[job.channel] ?? job.channel} to ${job.contactName ?? 'the channel'} is held by a maintenance window until ${until.toISOString().slice(0, 16)}Z. It is sent then if the incident is still unacknowledged.`,
    data: { note: 'DEFERRED_MAINTENANCE', stepIndex: job.stepIndex, repeat: job.repeat, channel: job.channel, contactId: job.contactId, until: until.toISOString() },
  };
}

// ───────────────────────────── heartbeat staleness (D-10) ─────────────────────────────

export const HEARTBEAT_STALE_SEC = 180;

export interface HeartbeatHealth {
  /** A job has not finished within `maxAgeSec`. */
  stale: boolean;
  /** A job finished but reported DEGRADED (notify: due SEV-1 pages were not attempted, N-12). */
  degraded: boolean;
  /** Neither stale nor degraded. This — not `!stale` — is what a health endpoint reports as healthy. */
  ok: boolean;
  jobs: Array<{ name: TickJob; ageSec: number | null; stale: boolean; degraded: boolean; lastStatus: 'OK' | 'ERROR' | 'DEGRADED' | null; consecutiveFailures: number }>;
}

/**
 * Has the tick stopped, or is it running without paging? A job is stale when it never finished or its last finish
 * is older than `maxAgeSec` (default 3 minutes, D-10); degraded when its last run said so. The caller
 * (GET /health, an external probe — Q-DM-17) raises the alarm: the tick cannot report its own death.
 */
export function heartbeatHealth(rows: HeartbeatRow[], now: Date, opts: { maxAgeSec?: number; jobs?: readonly TickJob[] } = {}): HeartbeatHealth {
  const max = opts.maxAgeSec ?? HEARTBEAT_STALE_SEC;
  const jobs = (opts.jobs ?? TICK_JOBS.filter((j) => j !== 'retention')).map((name) => {
    const hb = rows.find((r) => r.name === name);
    const ageSec = hb?.lastFinishedAt ? Math.max(0, Math.floor((now.getTime() - hb.lastFinishedAt.getTime()) / 1000)) : null;
    return { name, ageSec, stale: ageSec == null || ageSec > max, degraded: hb?.lastStatus === 'DEGRADED', lastStatus: hb?.lastStatus ?? null, consecutiveFailures: hb?.consecutiveFailures ?? 0 };
  });
  // D-45: the retention job runs once a day, so its age is never "stale"; a failed last run is degraded until the next run succeeds.
  const ret = opts.jobs ? undefined : rows.find((r) => r.name === 'retention');
  if (ret) jobs.push({ name: 'retention', ageSec: ret.lastFinishedAt ? Math.max(0, Math.floor((now.getTime() - ret.lastFinishedAt.getTime()) / 1000)) : null, stale: false, degraded: ret.lastStatus === 'ERROR', lastStatus: ret.lastStatus, consecutiveFailures: ret.consecutiveFailures });
  const stale = jobs.some((j) => j.stale);
  const degraded = jobs.some((j) => j.degraded);
  return { stale, degraded, ok: !stale && !degraded, jobs };
}
