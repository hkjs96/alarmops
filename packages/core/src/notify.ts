/**
 * Notification dispatch port + outbox rules (notification R1, R3-2, R8, R9; D-11; DATA-MODEL §6).
 *
 * The engine writes NotificationJob rows (outbox). The tick drains them through `NotificationSender`s — one per
 * provider kind (Slack, SMS, voice, email). Providers are adapters behind this port; core has no SDK imports.
 */
import type { NotificationIntent, NotifyChannel, NotifyPurpose } from './escalation.js';
import { protectUnlessFalse } from './config.js';
import { BREAKER_MAX_OPEN_SEC, BREAKER_OPEN_SEC, MAINTENANCE_RECHECK_SEC, NON_SEV1_RESERVE_PCT, PROVIDER_ERROR_MAX_CHARS, SEND_TIMEOUT_MS, SMS_VOICE_REQUIRE_VERIFIED } from './limits.js';
import type { Contact } from './paging.js';
import type { Severity } from './types.js';

export type JobStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface NotificationJob extends NotificationIntent {
  id: string;
  status: JobStatus;
  /** Provider calls actually started (`beginSend`). A claim alone never counts (R-3). */
  attempts: number;
  /** Claim token: +1 on every claim. `beginSend`, `releaseJob` and `completeJob` only act for the current one (R-2). */
  claimSeq: number;
  /**
   * When the job may be taken (again) — the LEASE column. Claim writes now + CLAIM_LEASE_SEC; `beginSend` writes
   * retryAt(attempts), so a process that dies mid-send is retried when this passes (R1-2).
   */
  nextAttemptAt: Date;
  /**
   * When the job became due — the ORDER column (R-11). Set at insert, moved only by a real retry (`beginSend`), an
   * undo, or a maintenance deferral. A claim and a release never touch it: a job handed back because of the budget
   * or an open breaker keeps its place in the queue instead of being re-stamped "now".
   */
  dueAt: Date;
  /** Sanitised text (never a phone number or a key); for SKIPPED jobs the skip reason. */
  lastError: string | null;
  providerMessageId: string | null;
  createdAt: Date;
}

/** R1-2: retry after 30s, 1m, 2m, 5m, 10m; the 5th failure gives up. */
export const RETRY_DELAYS_SEC = [30, 60, 120, 300, 600] as const;
export const MAX_ATTEMPTS = 5;
export const NOTIFY_BATCH = 50; // R1-4

/** nextAttemptAt to write when a job is claimed for its `attempt`-th try (1-based). */
export function retryAt(attempt: number, now: Date): Date {
  const i = Math.max(1, Math.min(attempt, RETRY_DELAYS_SEC.length)) - 1;
  return new Date(now.getTime() + RETRY_DELAYS_SEC[i]! * 1000);
}

export type SenderKind = 'SLACK' | 'SMS' | 'VOICE' | 'EMAIL';
export const senderKind = (c: NotifyChannel): SenderKind =>
  c === 'SMS' ? 'SMS' : c === 'VOICE' ? 'VOICE' : c === 'EMAIL' ? 'EMAIL' : 'SLACK';

export interface OutboundMessage {
  /** Provider-side dedup key where the provider supports one. Same for every retry of a job. */
  idempotencyKey: string;
  kind: SenderKind;
  channel: NotifyChannel;
  /** Slack channel id / Slack user id / E.164 phone / email — read at send time (R3-2), never stored on the incident. */
  to: string;
  incidentId: string;
  customerId: string | null;
  purpose: NotifyPurpose;
  title: string;
  severity: Severity;
  text: string;
  stepLabel: string;
  contactId: string | null;
}

/** What the console shows instead of the provider's words (R-4). */
export type DeliveryReason = 'TIMEOUT' | 'INVALID_DESTINATION' | 'RATE_LIMITED' | 'PROVIDER_REJECTED' | 'PROVIDER_ERROR' | 'NOT_CONFIGURED' | 'GAVE_UP';

export type SendResult =
  | { ok: true; providerMessageId: string }
  /**
   * retryable=false: bad number, unknown channel, auth revoked — do not retry (R1-2 "채널 설정이 사라진 잡").
   * `error` is the provider's text; it is sanitised before it is stored and never shown to non-internal users.
   * `code` (optional) is the adapter's own classification; without it the failure is PROVIDER_REJECTED / PROVIDER_ERROR.
   */
  | { ok: false; error: string; retryable: boolean; code?: DeliveryReason };

/**
 * Provider text → storable text (R-4, R-13, D-35). The mapped `DeliveryReason` is what the API exposes to everyone;
 * this text is for OPERATOR+ staff only and must still never carry an address or a credential.
 *
 * 1. Cut to PROVIDER_ERROR_MAX_CHARS FIRST. Every pattern below then runs on at most 300 characters, so the cost
 *    is bounded whatever the provider sends (a 100k-character body used to hold the event loop for 12 s).
 * 2. NFKC-normalise (full-width digits, `＠`, compatibility hyphens become ASCII) and undo the percent-encodings
 *    that split an address (%40, %20, %2B).
 * 3. Mask, most specific first: JWTs, AWS access key ids, `Bearer …`, `name=value` / `name: value` / `name is value`
 *    for common secret names, e-mail-like `x@y` (no TLD needed, any script), Slack ids, long opaque tokens, and
 *    any run of 7+ digits of ANY script (`\p{Nd}`) with separators between them.
 * Patterns have no nested unbounded repetition over the same characters. Over-masking is accepted; leaking is not.
 */
const SECRET_NAME = '(?:apikey|api|key|secret|token|password|passwd|pwd|pw|pass|auth|authorization|bearer|basic|session|sid|cookie|signature|credentials?|acct|account)';
const MASKS: Array<[RegExp, string]> = [
  [/eyJ[\w-]{4,}\.[\w-]{4,}(?:\.[\w-]*)?/g, '[secret]'],
  [/(?<![A-Za-z0-9])(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA)[A-Z0-9]{12,}/g, '[secret]'],
  [/(?<![A-Za-z0-9])(?:sk|pk|rk)_[A-Za-z0-9_]{3,}/g, '[secret]'],
  [/(?<![A-Za-z0-9])(?:bearer|basic)\s+[^\s"',;]+/gi, '[secret]'],
  [new RegExp(`(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_.-])*${SECRET_NAME}(?:[_.-][A-Za-z0-9]+)*\\s*(?:[:=]\\s*|\\s+is\\s+|\\s+)["']?(?:\\[(?:secret|email|number|id)\\]|[^\\s"',;&)\\]]+)`, 'gi'), '[secret]'],
  [/[^\s@<>()"',;:[\]]{1,64}@[^\s@<>()"',;[\]]{1,255}/gu, '[email]'],
  [/(?<![A-Za-z0-9])[CUWDGTB](?=[A-Z0-9]{8,11}(?![A-Za-z0-9]))[A-Z]*\d[A-Z0-9]*/g, '[id]'],
  [/[A-Za-z0-9_\-+=]{24,}/g, '[secret]'],
  [/\+?\p{Nd}(?:[\s().\-\u2010-\u2015\u2212/_]{0,3}\p{Nd}){6,}/gu, '[number]'],
];

export function sanitizeProviderError(raw: unknown): string {
  let s = (typeof raw === 'string' ? raw : String(raw)).slice(0, PROVIDER_ERROR_MAX_CHARS);
  s = s.normalize('NFKC').slice(0, PROVIDER_ERROR_MAX_CHARS).replace(/%(?:40|20|2[bB])/g, (m) => (m === '%40' ? '@' : m === '%20' ? ' ' : '+'));
  for (const [re, to] of MASKS) s = s.replace(re, to);
  return s.slice(0, PROVIDER_ERROR_MAX_CHARS);
}

/**
 * One provider adapter (Slack bot, domestic SMS vendor, voice vendor, SMTP). Must not throw for delivery failures.
 * Adapter requirements — the sender port (R-2, R-14, API-CONTRACT §5 "발송 포트"):
 * - The provider MUST honour `idempotencyKey`: a timed-out call may have been delivered and the retry carries the
 *   same key; so does a second runner that took the job over after the lease. Where the provider has no such key,
 *   the adapter keeps its own (key → providerMessageId) record and answers from it.
 * - Its own network timeout stays below SEND_TIMEOUT_MS; the tick abandons the call at SEND_TIMEOUT_MS either way.
 * - It must tolerate LANE_CONCURRENCY calls in flight at once.
 */
export interface NotificationSender {
  send(msg: OutboundMessage): Promise<SendResult>;
}
export type Senders = Partial<Record<SenderKind, NotificationSender>>;

/** Test/local sender: records every message, can be told to fail. */
export class FakeSender implements NotificationSender {
  sent: OutboundMessage[] = [];
  attempts: OutboundMessage[] = [];
  private failures: Array<{ left: number; retryable: boolean; error?: string; match?: (m: OutboundMessage) => boolean }> = [];
  private seq = 0;
  constructor(private readonly prefix = 'fake') {}
  /** Fail the next `n` matching sends. */
  failNext(n: number, opts: { retryable?: boolean; error?: string; match?: (m: OutboundMessage) => boolean } = {}): this {
    this.failures.push({ left: n, retryable: opts.retryable ?? true, error: opts.error, match: opts.match });
    return this;
  }
  async send(msg: OutboundMessage): Promise<SendResult> {
    this.attempts.push(msg);
    const f = this.failures.find((x) => x.left > 0 && (!x.match || x.match(msg)));
    if (f) {
      f.left--;
      return { ok: false, error: f.error ?? `${this.prefix}: simulated failure`, retryable: f.retryable };
    }
    this.sent.push(msg);
    return { ok: true, providerMessageId: `${this.prefix}-${++this.seq}` };
  }
}

export type DeliveryWarning = 'UNVERIFIED_ADDRESS';

export type Destination =
  | { ok: true; to: string[]; warnings: DeliveryWarning[] }
  | { ok: false; reason: 'NO_CONTACT' | 'CONTACT_INACTIVE' | 'NO_ADDRESS' | 'NO_CHANNEL' | 'TENANT_MISMATCH' | 'UNVERIFIED' };

/**
 * N-20: a verification time counts only when it is a real date that is not in the future. An Invalid Date, a
 * string, a number or tomorrow's date is "not verified".
 */
export function verifiedAt(v: unknown, now: Date): boolean {
  return v instanceof Date && !Number.isNaN(v.getTime()) && v.getTime() <= now.getTime();
}

/**
 * Where a job goes, decided at send time (R3-2). A deleted/inactive contact or a missing address is a skip.
 * - The recipient's tenant is checked again here (R-9): MSP staff, or a person of the job's own customer.
 * - SMS / voice go to verified numbers only while `requireVerifiedPhone` (SMS_VOICE_REQUIRE_VERIFIED, Q-DM-16);
 *   otherwise, and for Slack DM / e-mail, an unverified address is used and reported as a warning (R9-3).
 */
export function resolveDestination(
  job: Pick<NotificationJob, 'channel' | 'targetRef' | 'contactId'> & { customerId?: string | null },
  contact: Contact | null,
  slackChannels: string[],
  opts: { requireVerifiedPhone?: boolean; now?: Date } = {},
): Destination {
  if (job.channel === 'SLACK_BOT' || job.channel === 'SLACK_WEBHOOK') {
    return slackChannels.length ? { ok: true, to: slackChannels, warnings: [] } : { ok: false, reason: 'NO_CHANNEL' };
  }
  if (!contact) return { ok: false, reason: 'NO_CONTACT' };
  if (contact.kind !== 'INTERNAL' && (contact.customerId == null || contact.customerId !== (job.customerId ?? null))) return { ok: false, reason: 'TENANT_MISMATCH' };
  if (!contact.active) return { ok: false, reason: 'CONTACT_INACTIVE' };
  const phone = job.channel === 'SMS' || job.channel === 'VOICE';
  const [addr, verified] = job.channel === 'SLACK_DM' ? [contact.slackUserId, contact.slackVerifiedAt]
    : job.channel === 'EMAIL' ? [contact.email, contact.emailVerifiedAt]
      : [contact.phone, contact.phoneVerifiedAt];
  if (!addr) return { ok: false, reason: 'NO_ADDRESS' };
  const isVerified = verifiedAt(verified, opts.now ?? new Date());
  // R-15: only an explicit `false` switches the rule off; undefined, 'false', 0 … keep it on.
  const require = opts.requireVerifiedPhone === undefined ? SMS_VOICE_REQUIRE_VERIFIED : protectUnlessFalse(opts.requireVerifiedPhone);
  if (phone && !isVerified && require) return { ok: false, reason: 'UNVERIFIED' };
  return { ok: true, to: [addr], warnings: isVerified ? [] : ['UNVERIFIED_ADDRESS'] };
}

/** Who a log row is about, so each audience can be given the right words (R-4, Q-1). No address, no channel id. */
export type DeliveryTargetKind = 'STAFF' | 'CUSTOMER_PERSON' | 'CUSTOMER_CHANNEL' | 'MSP_CHANNEL';

/** NotificationLog row (append-only). Only SENT and FAILED are logged; skips are not (R1-3). */
export interface DeliveryLog {
  at: Date;
  customerId: string | null;
  incidentId: string;
  jobId: string;
  channel: NotifyChannel;
  status: 'SENT' | 'FAILED';
  /** A person's name, or "Customer Slack channel" / "MSP Slack channel". Never a channel id or an address. */
  targetSummary: string;
  targetKind: DeliveryTargetKind;
  contactId: string | null;
  escalationStep: number;
  attempt: number;
  /** Internal only. */
  providerMessageId: string | null;
  /** Internal only: sanitised provider text (sanitizeProviderError). */
  error: string | null;
  /** The reason code every audience may see. */
  errorCode: DeliveryReason | null;
  warnings: DeliveryWarning[];
}

export type DeliveryOutcome =
  | { status: 'SENT'; providerMessageId: string; warnings: DeliveryWarning[]; log: DeliveryLog }
  /** Stays QUEUED; nextAttemptAt was already written by beginSend. */
  | { status: 'RETRY'; error: string; errorCode: DeliveryReason }
  | { status: 'FAILED'; error: string; errorCode: DeliveryReason; log: DeliveryLog }
  | { status: 'SKIPPED'; reason: string }
  /** Held by a maintenance window (N-13): goes back to the outbox, due at `until`, no attempt counted. */
  | { status: 'DEFERRED'; reason: 'deferred_by_maintenance'; until: Date }
  /** Another run holds the job now (claim token moved on): nothing was sent and nothing may be written. */
  | { status: 'LOST' };

export interface DispatchContext {
  now: Date;
  senders: Senders;
  /** Current incident status; null when the incident is gone. */
  incidentStatus: 'TRIGGERED' | 'ACKNOWLEDGED' | 'RESOLVED' | null;
  contact: Contact | null;
  slackChannels: string[];
  /** Whose channels `slackChannels` are (the customer's own, or the MSP default as the fallback). */
  slackOwner?: 'CUSTOMER' | 'MSP';
  /**
   * A maintenance window covers the incident now and it is not SEV-1 (incidentMute) — R-10, N-13: the window's end.
   * The page is not sent and not dropped: it waits and is decided again when the window is over.
   */
  mutedUntil?: Date | null;
  /** Default: SMS_VOICE_REQUIRE_VERIFIED. */
  requireVerifiedPhone?: boolean;
  /** Default: SEND_TIMEOUT_MS. */
  sendTimeoutMs?: number;
  /**
   * Called once, right before the first provider call: counts the attempt and writes the retry time, guarded by the
   * claim token. Returns the attempt number, or null when the claim was lost (then nothing is sent).
   * Without it (unit tests) `job.attempts` is taken as the attempt number.
   */
  beginSend?: () => Promise<number | null>;
}

function sendWithTimeout(sender: NotificationSender, msg: OutboundMessage, ms: number): Promise<SendResult> {
  return new Promise<SendResult>((done) => {
    const timer = setTimeout(() => done({ ok: false, error: `no answer from the provider within ${ms} ms`, retryable: true, code: 'TIMEOUT' }), ms);
    const finish = (r: SendResult) => { clearTimeout(timer); done(r); };
    let p: Promise<SendResult>;
    try { p = sender.send(msg); } catch (err) { finish({ ok: false, error: String(err instanceof Error ? err.message : err), retryable: true }); return; }
    p.then(finish, (err) => finish({ ok: false, error: String(err instanceof Error ? err.message : err), retryable: true }));
  });
}

/**
 * Send one claimed job.
 * - Ack stops paging: a page still queued/retrying when the incident is acknowledged or resolved is skipped (R6-3, D-24).
 * - A page that waited into a maintenance window is HELD unless the incident is SEV-1 (R-10, N-13, D-17): it goes
 *   back to the outbox due at the window's end (looked at again every MAINTENANCE_RECHECK_SEC in case the window
 *   is revoked), without using an attempt. When the window is over it is sent if the incident is still
 *   unacknowledged, and skipped (`acknowledged` / `incident_closed`) otherwise.
 * - The recipient is checked again: tenant (R-9), active, address, verified phone for SMS/voice (Q-DM-16).
 * - No sender configured for the channel → give up at once, never retried (R1-2).
 * - Several Slack destinations: sent in parallel under one timeout (N-11); failed only when all fail (R4-3).
 * - Every provider call has a timeout (R-2); a timeout is a retryable failure.
 */
export async function dispatchJob(job: NotificationJob, ctx: DispatchContext): Promise<DeliveryOutcome> {
  if (ctx.incidentStatus == null || ctx.incidentStatus === 'RESOLVED') return { status: 'SKIPPED', reason: 'incident_closed' };
  if ((job.purpose === 'INITIAL' || job.purpose === 'ESCALATION') && ctx.incidentStatus !== 'TRIGGERED') return { status: 'SKIPPED', reason: 'acknowledged' };
  if (job.purpose === 'RENOTIFY' && ctx.incidentStatus !== 'ACKNOWLEDGED') return { status: 'SKIPPED', reason: 'not_acknowledged' };
  if (ctx.mutedUntil && job.payload.severity !== 'SEV_1') {
    const recheck = ctx.now.getTime() + MAINTENANCE_RECHECK_SEC * 1000;
    return { status: 'DEFERRED', reason: 'deferred_by_maintenance', until: new Date(Math.max(ctx.now.getTime() + 1000, Math.min(ctx.mutedUntil.getTime(), recheck))) };
  }

  const dest = resolveDestination(job, ctx.contact, ctx.slackChannels, { requireVerifiedPhone: ctx.requireVerifiedPhone, now: ctx.now });
  if (!dest.ok) return { status: 'SKIPPED', reason: dest.reason.toLowerCase() };
  const kind = senderKind(job.channel);
  const toChannel = job.channel === 'SLACK_BOT' || job.channel === 'SLACK_WEBHOOK';
  const targetKind: DeliveryTargetKind = toChannel ? (ctx.slackOwner === 'CUSTOMER' ? 'CUSTOMER_CHANNEL' : 'MSP_CHANNEL') : ctx.contact?.kind === 'CUSTOMER' ? 'CUSTOMER_PERSON' : 'STAFF';
  const targetSummary = toChannel ? (targetKind === 'CUSTOMER_CHANNEL' ? 'Customer Slack channel' : 'MSP Slack channel') : job.contactName ?? ctx.contact?.name ?? 'Unknown person';

  const attempt = ctx.beginSend ? await ctx.beginSend() : job.attempts;
  if (attempt == null) return { status: 'LOST' };
  const log = (status: 'SENT' | 'FAILED', providerMessageId: string | null, error: string | null, errorCode: DeliveryReason | null): DeliveryLog => ({
    at: ctx.now, customerId: job.customerId, incidentId: job.incidentId, jobId: job.id, channel: job.channel, status,
    targetSummary, targetKind, contactId: toChannel ? null : job.contactId, escalationStep: job.stepIndex, attempt,
    providerMessageId, error, errorCode, warnings: dest.warnings,
  });
  const sender = ctx.senders[kind];
  if (!sender) {
    const error = `No ${kind} sender is configured`;
    return { status: 'FAILED', error, errorCode: 'NOT_CONFIGURED', log: log('FAILED', null, error, 'NOT_CONFIGURED') };
  }

  // N-11: all destinations of one job go out together, each under the same timeout — a job with five Slack
  // channels costs one timeout, not five, and can never outlast its own retry delay.
  const ms = ctx.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  const results = await Promise.all(dest.to.map((to) => sendWithTimeout(sender, {
    idempotencyKey: dest.to.length > 1 ? `${job.idempotencyKey}@${to}` : job.idempotencyKey, kind, channel: job.channel, to,
    incidentId: job.incidentId, customerId: job.customerId, purpose: job.purpose, title: job.payload.title, severity: job.payload.severity,
    text: job.payload.text, stepLabel: job.payload.stepLabel, contactId: job.contactId,
  }, ms)));
  const ids: string[] = [];
  const errors: string[] = [];
  let retryable = false;
  let code: DeliveryReason | null = null;
  for (const r of results) {
    if (r.ok) ids.push(r.providerMessageId);
    else {
      errors.push(sanitizeProviderError(r.error));
      retryable ||= r.retryable;
      code ??= r.code ?? (r.retryable ? 'PROVIDER_ERROR' : 'PROVIDER_REJECTED');
    }
  }
  if (ids.length) return { status: 'SENT', providerMessageId: ids.join(','), warnings: dest.warnings, log: log('SENT', ids.join(','), errors.length ? errors.join('; ') : null, null) };
  const error = errors.join('; ');
  const errorCode = code ?? 'PROVIDER_ERROR';
  if (retryable && attempt < MAX_ATTEMPTS) return { status: 'RETRY', error, errorCode };
  return { status: 'FAILED', error, errorCode, log: log('FAILED', null, error, errorCode) };
}

/**
 * Order in which due jobs are claimed (R-1, R-11): round-robin over customers, so one tenant's backlog cannot hold
 * back another tenant's page by more than a tick. Inside a customer: SEV-1 first, then jobs that were NEVER
 * attempted before retries (a retry storm cannot push fresh pages back), then the original due time (`dueAt`,
 * which a release does not re-stamp), then creation. Customers whose next job is SEV-1 lead each round.
 * The SQL adapter must produce the same order:
 * `ROW_NUMBER() OVER (PARTITION BY customerId ORDER BY sev1 DESC, (attempts > 0), dueAt, createdAt)` → `ORDER BY rn, sev1 DESC, (attempts > 0), dueAt`.
 */
type Orderable = Pick<NotificationJob, 'customerId' | 'createdAt' | 'payload'> & { nextAttemptAt?: Date; dueAt?: Date; attempts?: number };
const dueOf = (j: Orderable): number => (j.dueAt ?? j.nextAttemptAt ?? j.createdAt).getTime();
const isSev1 = (j: Orderable): boolean => j.payload.severity === 'SEV_1';

export function fairOrder<T extends Orderable>(due: T[]): T[] {
  const cmp = (a: T, b: T): number => (isSev1(a) ? 0 : 1) - (isSev1(b) ? 0 : 1) || ((a.attempts ?? 0) > 0 ? 1 : 0) - ((b.attempts ?? 0) > 0 ? 1 : 0)
    || dueOf(a) - dueOf(b) || a.createdAt.getTime() - b.createdAt.getTime();
  const queues = new Map<string, T[]>();
  for (const j of due) {
    const k = j.customerId ?? '\u0000msp';
    const q = queues.get(k);
    if (q) q.push(j); else queues.set(k, [j]);
  }
  for (const q of queues.values()) q.sort(cmp);
  const out: T[] = [];
  for (let round = 0; out.length < due.length; round++) {
    const heads = [...queues.values()].filter((q) => q.length > round).map((q) => q[round]!).sort(cmp);
    out.push(...heads);
  }
  return out;
}

/**
 * The jobs one claim takes (N-17): the first `limit − reserve` in `fairOrder`, plus `reserve` slots
 * (NON_SEV1_RESERVE_PCT of the limit, at least 1 once the limit is 5 or more) for the OLDEST non-SEV-1 jobs that
 * the fair order did not reach. Unused reserve goes back to the fair order. So even when more customers hold SEV-1
 * pages than the batch is wide, a lower-severity page still moves every tick, oldest first.
 */
export function selectForClaim<T extends Orderable>(due: T[], limit: number): T[] {
  const ordered = fairOrder(due);
  if (ordered.length <= limit) return ordered;
  const reserve = limit >= 5 ? Math.max(1, Math.floor((limit * NON_SEV1_RESERVE_PCT) / 100)) : 0;
  const chosen = new Set<T>(ordered.slice(0, limit - reserve));
  const low = ordered.filter((j) => !chosen.has(j) && !isSev1(j)).sort((a, b) => dueOf(a) - dueOf(b) || a.createdAt.getTime() - b.createdAt.getTime());
  for (const j of low.slice(0, reserve)) chosen.add(j);
  for (const j of ordered) { if (chosen.size >= limit) break; chosen.add(j); }
  return ordered.filter((j) => chosen.has(j));
}

// ───────────────────────────── lanes and circuit breakers (R-11) ─────────────────────────────

/** One lane per provider kind. Voice first only matters for the order lanes are started in; they run side by side. */
export const LANES: readonly SenderKind[] = ['VOICE', 'SMS', 'SLACK', 'EMAIL'];
export const LANE_CHANNELS: Record<SenderKind, readonly NotifyChannel[]> = {
  VOICE: ['VOICE'], SMS: ['SMS'], EMAIL: ['EMAIL'], SLACK: ['SLACK_BOT', 'SLACK_WEBHOOK', 'SLACK_DM'],
};

/**
 * Circuit breaker of one provider lane, kept in the store so every runner and every tick sees it.
 * CLOSED → (BREAKER_TIMEOUTS consecutive timeouts) → OPEN: the lane's jobs are not claimed at all (they keep their
 * place and their attempts). Once `nextProbeAt` has passed the next tick sends ONE job (half-open probe): an answer
 * of any kind closes the breaker and the lane drains normally in the same tick; another timeout re-opens it with
 * twice the wait (up to BREAKER_MAX_OPEN_SEC).
 */
export interface ProviderBreaker {
  kind: SenderKind;
  state: 'CLOSED' | 'OPEN';
  /** Failed probes in a row since it opened (0 while closed). */
  trips: number;
  openedAt: Date | null;
  nextProbeAt: Date | null;
}
export const closedBreaker = (kind: SenderKind): ProviderBreaker => ({ kind, state: 'CLOSED', trips: 0, openedAt: null, nextProbeAt: null });
export function tripBreaker(b: ProviderBreaker, now: Date): ProviderBreaker {
  const trips = b.state === 'OPEN' ? b.trips + 1 : 1;
  const waitSec = Math.min(BREAKER_MAX_OPEN_SEC, BREAKER_OPEN_SEC * 2 ** (trips - 1));
  return { kind: b.kind, state: 'OPEN', trips, openedAt: b.state === 'OPEN' ? b.openedAt ?? now : now, nextProbeAt: new Date(now.getTime() + waitSec * 1000) };
}
