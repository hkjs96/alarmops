/**
 * Notification dispatch port + outbox rules (notification R1, R3-2, R8, R9; D-11; DATA-MODEL §6).
 *
 * The engine writes NotificationJob rows (outbox). The tick drains them through `NotificationSender`s — one per
 * provider kind (Slack, SMS, voice, email). Providers are adapters behind this port; core has no SDK imports.
 */
import type { NotificationIntent, NotifyChannel, NotifyPurpose } from './escalation.js';
import type { Contact } from './paging.js';
import type { Severity } from './types.js';

export type JobStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface NotificationJob extends NotificationIntent {
  id: string;
  status: JobStatus;
  attempts: number;
  /** Written at claim time, so a process that dies mid-send is retried when this passes (R1-2). */
  nextAttemptAt: Date;
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

export type SendResult =
  | { ok: true; providerMessageId: string }
  /** retryable=false: bad number, unknown channel, auth revoked — do not retry (R1-2 "채널 설정이 사라진 잡"). */
  | { ok: false; error: string; retryable: boolean };

/** One provider adapter (Slack bot, domestic SMS vendor, voice vendor, SMTP). Must not throw for delivery failures. */
export interface NotificationSender {
  send(msg: OutboundMessage): Promise<SendResult>;
}
export type Senders = Partial<Record<SenderKind, NotificationSender>>;

/** Test/local sender: records every message, can be told to fail. */
export class FakeSender implements NotificationSender {
  sent: OutboundMessage[] = [];
  attempts: OutboundMessage[] = [];
  private failures: Array<{ left: number; retryable: boolean; match?: (m: OutboundMessage) => boolean }> = [];
  private seq = 0;
  constructor(private readonly prefix = 'fake') {}
  /** Fail the next `n` matching sends. */
  failNext(n: number, opts: { retryable?: boolean; match?: (m: OutboundMessage) => boolean } = {}): this {
    this.failures.push({ left: n, retryable: opts.retryable ?? true, match: opts.match });
    return this;
  }
  async send(msg: OutboundMessage): Promise<SendResult> {
    this.attempts.push(msg);
    const f = this.failures.find((x) => x.left > 0 && (!x.match || x.match(msg)));
    if (f) {
      f.left--;
      return { ok: false, error: `${this.prefix}: simulated failure`, retryable: f.retryable };
    }
    this.sent.push(msg);
    return { ok: true, providerMessageId: `${this.prefix}-${++this.seq}` };
  }
}

export type DeliveryWarning = 'UNVERIFIED_ADDRESS';

export type Destination =
  | { ok: true; to: string[]; warnings: DeliveryWarning[] }
  | { ok: false; reason: 'NO_CONTACT' | 'CONTACT_INACTIVE' | 'NO_ADDRESS' | 'NO_CHANNEL' };

/**
 * Where a job goes, decided at send time (R3-2). A deleted/inactive contact or a missing address is a skip.
 * An unverified address is still used (R9-3: verification is display-only) and reported as a warning —
 * whether SMS/voice to unverified numbers should be blocked is open (Q-DM-16).
 */
export function resolveDestination(job: Pick<NotificationJob, 'channel' | 'targetRef' | 'contactId'>, contact: Contact | null, slackChannels: string[]): Destination {
  if (job.channel === 'SLACK_BOT' || job.channel === 'SLACK_WEBHOOK') {
    return slackChannels.length ? { ok: true, to: slackChannels, warnings: [] } : { ok: false, reason: 'NO_CHANNEL' };
  }
  if (!contact) return { ok: false, reason: 'NO_CONTACT' };
  if (!contact.active) return { ok: false, reason: 'CONTACT_INACTIVE' };
  const [addr, verified] = job.channel === 'SLACK_DM' ? [contact.slackUserId, contact.slackVerifiedAt]
    : job.channel === 'EMAIL' ? [contact.email, contact.emailVerifiedAt]
      : [contact.phone, contact.phoneVerifiedAt];
  if (!addr) return { ok: false, reason: 'NO_ADDRESS' };
  return { ok: true, to: [addr], warnings: verified ? [] : ['UNVERIFIED_ADDRESS'] };
}

/** NotificationLog row (append-only). Only SENT and FAILED are logged; skips are not (R1-3). */
export interface DeliveryLog {
  at: Date;
  customerId: string | null;
  incidentId: string;
  jobId: string;
  channel: NotifyChannel;
  status: 'SENT' | 'FAILED';
  targetSummary: string;
  escalationStep: number;
  attempt: number;
  providerMessageId: string | null;
  error: string | null;
  warnings: DeliveryWarning[];
}

export type DeliveryOutcome =
  | { status: 'SENT'; providerMessageId: string; warnings: DeliveryWarning[]; log: DeliveryLog }
  /** Stays QUEUED; nextAttemptAt was already written at claim time. */
  | { status: 'RETRY'; error: string }
  | { status: 'FAILED'; error: string; log: DeliveryLog }
  | { status: 'SKIPPED'; reason: string };

export interface DispatchContext {
  now: Date;
  senders: Senders;
  /** Current incident status; null when the incident is gone. */
  incidentStatus: 'TRIGGERED' | 'ACKNOWLEDGED' | 'RESOLVED' | null;
  contact: Contact | null;
  slackChannels: string[];
}

/**
 * Send one claimed job (job.attempts already counts this try).
 * - Ack stops paging: a page still queued/retrying when the incident is acknowledged or resolved is skipped (R6-3, D-24).
 * - No sender configured for the channel → give up at once, never retried (R1-2).
 * - Several Slack destinations: one failing does not stop the others; failed only when all fail (R4-3).
 */
export async function dispatchJob(job: NotificationJob, ctx: DispatchContext): Promise<DeliveryOutcome> {
  if (ctx.incidentStatus == null || ctx.incidentStatus === 'RESOLVED') return { status: 'SKIPPED', reason: 'incident_closed' };
  if ((job.purpose === 'INITIAL' || job.purpose === 'ESCALATION') && ctx.incidentStatus !== 'TRIGGERED') return { status: 'SKIPPED', reason: 'acknowledged' };
  if (job.purpose === 'RENOTIFY' && ctx.incidentStatus !== 'ACKNOWLEDGED') return { status: 'SKIPPED', reason: 'not_acknowledged' };

  const dest = resolveDestination(job, ctx.contact, ctx.slackChannels);
  if (!dest.ok) return { status: 'SKIPPED', reason: dest.reason.toLowerCase() };
  const kind = senderKind(job.channel);
  const log = (status: 'SENT' | 'FAILED', providerMessageId: string | null, error: string | null): DeliveryLog => ({
    at: ctx.now, customerId: job.customerId, incidentId: job.incidentId, jobId: job.id, channel: job.channel, status,
    targetSummary: job.contactName ?? dest.to.join(', '), escalationStep: job.stepIndex, attempt: job.attempts,
    providerMessageId, error, warnings: dest.warnings,
  });
  const sender = ctx.senders[kind];
  if (!sender) {
    const error = `No ${kind} sender is configured`;
    return { status: 'FAILED', error, log: log('FAILED', null, error) };
  }

  const ids: string[] = [];
  const errors: string[] = [];
  let retryable = false;
  for (const to of dest.to) {
    let r: SendResult;
    try {
      r = await sender.send({
        idempotencyKey: dest.to.length > 1 ? `${job.idempotencyKey}@${to}` : job.idempotencyKey, kind, channel: job.channel, to,
        incidentId: job.incidentId, customerId: job.customerId, purpose: job.purpose, title: job.payload.title, severity: job.payload.severity,
        text: job.payload.text, stepLabel: job.payload.stepLabel, contactId: job.contactId,
      });
    } catch (err) {
      r = { ok: false, error: String(err instanceof Error ? err.message : err), retryable: true };
    }
    if (r.ok) ids.push(r.providerMessageId);
    else { errors.push(r.error); retryable ||= r.retryable; }
  }
  if (ids.length) return { status: 'SENT', providerMessageId: ids.join(','), warnings: dest.warnings, log: log('SENT', ids.join(','), errors.length ? errors.join('; ') : null) };
  const error = errors.join('; ');
  if (retryable && job.attempts < MAX_ATTEMPTS) return { status: 'RETRY', error };
  return { status: 'FAILED', error, log: log('FAILED', null, error) };
}
