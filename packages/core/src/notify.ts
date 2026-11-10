/**
 * Notification dispatch port + outbox rules (notification R1, R3-2, R8, R9; D-11; DATA-MODEL §6).
 *
 * The engine writes NotificationJob rows (outbox). The tick drains them through `NotificationSender`s — one per
 * provider kind (Slack, SMS, voice, email). Providers are adapters behind this port; core has no SDK imports.
 */
import type { NotificationIntent, NotifyChannel, NotifyPurpose } from './escalation.js';
import { SEND_TIMEOUT_MS, SMS_VOICE_REQUIRE_VERIFIED } from './limits.js';
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
   * When the job may be taken (again). Claim writes now + CLAIM_LEASE_SEC; `beginSend` writes retryAt(attempts),
   * so a process that dies mid-send is retried when this passes (R1-2).
   */
  nextAttemptAt: Date;
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
 * Provider text → storable text (R-4, D-35): phone numbers, e-mail addresses and anything that looks like a
 * credential are masked, and the text is cut at 300 characters. The mapped `DeliveryReason` is what the API exposes.
 */
export function sanitizeProviderError(raw: string): string {
  return String(raw)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(?:sk|pk|rk|key|token|secret|bearer|password|passwd|pwd|auth|acct|account|sid)\b[\s_:=-]*[A-Za-z0-9_\-./+]{3,}/gi, '[secret]')
    .replace(/\b[A-Za-z0-9_\-]{24,}\b/g, '[secret]')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '[number]')
    .slice(0, 300);
}

/**
 * One provider adapter (Slack bot, domestic SMS vendor, voice vendor, SMTP). Must not throw for delivery failures.
 * Adapter requirements (R-2): pass `idempotencyKey` to the provider where it supports one (a timed-out call may
 * have been delivered; the retry carries the same key), and honour its own network timeout below SEND_TIMEOUT_MS.
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
 * Where a job goes, decided at send time (R3-2). A deleted/inactive contact or a missing address is a skip.
 * - The recipient's tenant is checked again here (R-9): MSP staff, or a person of the job's own customer.
 * - SMS / voice go to verified numbers only while `requireVerifiedPhone` (SMS_VOICE_REQUIRE_VERIFIED, Q-DM-16);
 *   otherwise, and for Slack DM / e-mail, an unverified address is used and reported as a warning (R9-3).
 */
export function resolveDestination(
  job: Pick<NotificationJob, 'channel' | 'targetRef' | 'contactId'> & { customerId?: string | null },
  contact: Contact | null,
  slackChannels: string[],
  opts: { requireVerifiedPhone?: boolean } = {},
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
  if (phone && !verified && (opts.requireVerifiedPhone ?? SMS_VOICE_REQUIRE_VERIFIED)) return { ok: false, reason: 'UNVERIFIED' };
  return { ok: true, to: [addr], warnings: verified ? [] : ['UNVERIFIED_ADDRESS'] };
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
  /** A maintenance window covers the incident now and it is not SEV-1 (incidentMute) — R-10. */
  muted?: boolean;
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
 * - A page that waited into a maintenance window is skipped unless the incident is SEV-1 (R-10, D-17).
 * - The recipient is checked again: tenant (R-9), active, address, verified phone for SMS/voice (Q-DM-16).
 * - No sender configured for the channel → give up at once, never retried (R1-2).
 * - Several Slack destinations: one failing does not stop the others; failed only when all fail (R4-3).
 * - Every provider call has a timeout (R-2); a timeout is a retryable failure.
 */
export async function dispatchJob(job: NotificationJob, ctx: DispatchContext): Promise<DeliveryOutcome> {
  if (ctx.incidentStatus == null || ctx.incidentStatus === 'RESOLVED') return { status: 'SKIPPED', reason: 'incident_closed' };
  if ((job.purpose === 'INITIAL' || job.purpose === 'ESCALATION') && ctx.incidentStatus !== 'TRIGGERED') return { status: 'SKIPPED', reason: 'acknowledged' };
  if (job.purpose === 'RENOTIFY' && ctx.incidentStatus !== 'ACKNOWLEDGED') return { status: 'SKIPPED', reason: 'not_acknowledged' };
  if (ctx.muted && job.payload.severity !== 'SEV_1') return { status: 'SKIPPED', reason: 'muted_by_maintenance' };

  const dest = resolveDestination(job, ctx.contact, ctx.slackChannels, { requireVerifiedPhone: ctx.requireVerifiedPhone });
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

  const ids: string[] = [];
  const errors: string[] = [];
  let retryable = false;
  let code: DeliveryReason | null = null;
  for (const to of dest.to) {
    const r = await sendWithTimeout(sender, {
      idempotencyKey: dest.to.length > 1 ? `${job.idempotencyKey}@${to}` : job.idempotencyKey, kind, channel: job.channel, to,
      incidentId: job.incidentId, customerId: job.customerId, purpose: job.purpose, title: job.payload.title, severity: job.payload.severity,
      text: job.payload.text, stepLabel: job.payload.stepLabel, contactId: job.contactId,
    }, ctx.sendTimeoutMs ?? SEND_TIMEOUT_MS);
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
 * Order in which due jobs are claimed (R-1): round-robin over customers, so one tenant's backlog cannot hold back
 * another tenant's page by more than a tick; inside a customer SEV-1 first, then oldest; customers whose next job
 * is SEV-1 lead each round. The SQL adapter must produce the same order
 * (`ROW_NUMBER() OVER (PARTITION BY customerId ORDER BY sev1 DESC, nextAttemptAt, createdAt)` → `ORDER BY rn, sev1 DESC, nextAttemptAt`).
 */
export function fairOrder<T extends Pick<NotificationJob, 'customerId' | 'nextAttemptAt' | 'createdAt' | 'payload'>>(due: T[]): T[] {
  const sev1 = (j: T): number => (j.payload.severity === 'SEV_1' ? 0 : 1);
  const cmp = (a: T, b: T): number => sev1(a) - sev1(b) || a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime();
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
