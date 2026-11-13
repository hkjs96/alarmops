/**
 * D-45: retention of a TERMINATED customer's data. The daily job (tick job "retention") decides which stages are due;
 * the STORE does the deletes (it knows the tables) and writes one purge-log row per stage that removed something.
 *
 * Stages, each measured from `Customer.statusChangedAt` (the moment of termination) unless noted:
 *   CONNECTIONS   offboarding completedAt is set  -> role ARNs, ExternalId, webhook tokens, Resource, ManagedAlarm
 *   RETURN_PERIOD + returnDays (30)               -> customer contacts, portal users, payloads, incident details; incidents
 *                                                    become pseudonymized SLA records; contact values masked in AuditLog
 *   AUDIT_EXPIRY  + auditDays (2 years)           -> AuditLog (except PROTECTED_AUDIT_TARGET_TYPES), ContactRevealLog
 *   SLA_EXPIRY    + slaDays (5 years)             -> the SLA records (Incident rows)
 * A customer with a legal hold is skipped by every stage; the stores re-check hold and status inside each delete.
 */
import type { TickJob } from './tick.js';

export type RetentionStage = 'CONNECTIONS' | 'RETURN_PERIOD' | 'AUDIT_EXPIRY' | 'SLA_EXPIRY';
export const RETENTION_STAGES: readonly RetentionStage[] = ['CONNECTIONS', 'RETURN_PERIOD', 'AUDIT_EXPIRY', 'SLA_EXPIRY'];
/** Stages that show up in the purge log: the four above plus the ADMIN's hold changes. */
export type PurgeLogStage = RetentionStage | 'LEGAL_HOLD_SET' | 'LEGAL_HOLD_RELEASED';

/**
 * AuditLog rows of these targetTypes are NEVER deleted by retention: the Responders version and the customer status
 * version are COUNTS of these rows (DATA-MODEL "AuditLog" note). Deleting them would reset a version.
 */
export const PROTECTED_AUDIT_TARGET_TYPES: readonly string[] = ['CustomerStatus', 'Responders'];
/** Top-level JSON keys of AuditLog.before/after that can hold a customer contact's value; removed at the RETURN_PERIOD stage. */
export const AUDIT_CONTACT_VALUE_KEYS: readonly string[] = ['email', 'phone', 'slackUserId', 'name', 'contactName'];

export interface RetentionConfig {
  /** Days after termination that customer contacts, portal users and confidential content are deleted; also the CSV export window. */
  returnDays: number;
  /** Days after termination that AuditLog / ContactRevealLog are deleted (2 years). */
  auditDays: number;
  /** Days after termination that the SLA records are deleted (5 years). */
  slaDays: number;
}
export const DEFAULT_RETENTION: RetentionConfig = { returnDays: 30, auditDays: 730, slaDays: 1826 };

/** Lowest values the environment may set (security review D-45 R-3): a typo or a hostile env must not shrink retention to nothing. */
export const RETENTION_FLOORS: RetentionConfig = { returnDays: 7, auditDays: 90, slaDays: 365 };

/**
 * `RETENTION_RETURN_DAYS`, `RETENTION_AUDIT_DAYS`, `RETENTION_SLA_DAYS` (D-45: periods are configurable). A value that is
 * not a whole number, or is below RETENTION_FLOORS (7 / 90 / 365 days), is ignored (the default stays) and `warn` is called.
 * The order return <= audit <= sla is enforced; otherwise the whole override is ignored.
 * NOTE: not wired into the console app yet (console follow-up): until then the defaults apply.
 */
export function retentionConfigFromEnv(env: Record<string, string | undefined>, warn: (msg: string) => void = () => undefined): RetentionConfig {
  const num = (name: string, key: keyof RetentionConfig): number => {
    const v = env[name];
    if (v === undefined || v === '') return DEFAULT_RETENTION[key];
    if (/^\d{1,5}$/.test(v.trim()) && Number(v) >= RETENTION_FLOORS[key]) return Number(v);
    warn(`${name}=${v} ignored: must be a whole number of at least ${RETENTION_FLOORS[key]}; using ${DEFAULT_RETENTION[key]}`);
    return DEFAULT_RETENTION[key];
  };
  const c: RetentionConfig = { returnDays: num('RETENTION_RETURN_DAYS', 'returnDays'), auditDays: num('RETENTION_AUDIT_DAYS', 'auditDays'), slaDays: num('RETENTION_SLA_DAYS', 'slaDays') };
  if (c.returnDays <= c.auditDays && c.auditDays <= c.slaDays) return c;
  warn('RETENTION_* ignored: the order return <= audit <= sla does not hold; using the defaults');
  return { ...DEFAULT_RETENTION };
}

/** Removes the contact-value keys at every depth of a JSON value (AuditLog before/after). Pure; the SQL function retention_mask_json does the same. */
export function maskContactValues(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskContactValues);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as object).filter(([k]) => !AUDIT_CONTACT_VALUE_KEYS.includes(k)).map(([k, x]) => [k, maskContactValues(x)]));
  return v;
}

export interface RetentionCandidate {
  customerId: string;
  statusChangedAt: Date;
  /** CustomerOffboarding.completedAt (all five steps DONE). null = offboarding not finished. */
  offboardingCompletedAt: Date | null;
}
export interface PurgeLogEntry { id: string; customerId: string; stage: PurgeLogStage; counts: Record<string, number>; actor: string; at: Date }
export interface StageResult {
  counts: Record<string, number>;
  /** The deadline stopped the stage; call it again (the next tick does). */
  partial: boolean;
  /** The customer is held or not TERMINATED any more: nothing was touched. */
  skipped?: boolean;
}

/** Store side of the job. Optional on TickRepository: a store without it simply never retains anything. */
export interface RetentionRepository {
  /** Claim the KST day; false = already claimed. A claim that was never finished and is older than RETENTION_CLAIM_TTL_MIN minutes can be taken again. */
  claimRetentionDay(day: string): Promise<boolean>;
  /** The run for the day ended (also with per-customer errors): the claim can no longer be taken again. */
  finishRetentionDay(day: string): Promise<void>;
  /** Give the day back (the job stopped early and must continue on the next tick). */
  releaseRetentionDay(day: string): Promise<void>;
  /** TERMINATED customers without legal hold and with statusChangedAt set whose SLA_EXPIRY stage has not been logged yet (all stages done = left out, so they cannot starve the rest), oldest termination first. */
  retentionCandidates(limit: number): Promise<RetentionCandidate[]>;
  /**
   * Run ONE stage for ONE customer. Every statement is scoped by customerId and re-checks "TERMINATED and no hold".
   * Writes one RetentionPurgeLog row (actor 'system') when it removed or changed anything. Idempotent.
   * `deadlineMs` = epoch ms after which no new chunk starts. `days` = the period of the stage (null for CONNECTIONS): the SQL store checks
   * `statusChangedAt + days <= its own now()` inside the statements, so a runner clock that runs early cannot purge early (R-2).
   */
  runRetentionStage(customerId: string, stage: RetentionStage, opts: { deadlineMs: number; now: Date; days: number | null }): Promise<StageResult>;
}

const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
/** 'YYYY-MM-DD' of the instant in Korea Standard Time (UTC+9, no DST). */
export const kstDay = (d: Date): string => new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);

/** Stages that are due for this customer at `now`, in the order they must run. */
/** Period of a stage in days (null: CONNECTIONS is due when the offboarding is complete). */
export const stageDays = (stage: RetentionStage, cfg: RetentionConfig): number | null =>
  stage === 'RETURN_PERIOD' ? cfg.returnDays : stage === 'AUDIT_EXPIRY' ? cfg.auditDays : stage === 'SLA_EXPIRY' ? cfg.slaDays : null;

export function dueStages(c: RetentionCandidate, cfg: RetentionConfig, now: Date): RetentionStage[] {
  const t = now.getTime();
  const base = c.statusChangedAt.getTime();
  const out: RetentionStage[] = [];
  if (c.offboardingCompletedAt) out.push('CONNECTIONS');
  if (t >= base + cfg.returnDays * DAY_MS) out.push('RETURN_PERIOD');
  if (t >= base + cfg.auditDays * DAY_MS) out.push('AUDIT_EXPIRY');
  if (t >= base + cfg.slaDays * DAY_MS) out.push('SLA_EXPIRY');
  return out;
}

/** When each time-based stage becomes due. For the purge-log screen. */
export function retentionSchedule(statusChangedAt: Date, cfg: RetentionConfig): { returnPeriodEndsAt: Date; auditExpiresAt: Date; slaExpiresAt: Date } {
  const at = (days: number): Date => new Date(statusChangedAt.getTime() + days * DAY_MS);
  return { returnPeriodEndsAt: at(cfg.returnDays), auditExpiresAt: at(cfg.auditDays), slaExpiresAt: at(cfg.slaDays) };
}

export interface RetentionSummary {
  /** false = nothing was started (already ran today, store without retention). */
  ran: boolean;
  skipped?: 'already-ran' | 'unsupported';
  customers: number;
  stages: number;
  /** Rows deleted or scrubbed, all entities. */
  rows: number;
  /** A stage stopped at the deadline; the day was given back so the next tick continues. */
  partial: boolean;
  errors: Array<{ customerId: string; stage: RetentionStage; message: string }>;
}

/** A claim that never finished is taken over after this long (the run died). */
export const RETENTION_CLAIM_TTL_MIN = 30;
export const RETENTION_JOB: TickJob = 'retention';
const CANDIDATE_LIMIT = 500;

export async function runRetention(
  repo: Partial<RetentionRepository>, cfg: RetentionConfig, now: Date, opts: { deadlineMs: number; log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void },
): Promise<RetentionSummary> {
  const sum: RetentionSummary = { ran: false, customers: 0, stages: 0, rows: 0, partial: false, errors: [] };
  if (!repo.claimRetentionDay || !repo.retentionCandidates || !repo.runRetentionStage) return { ...sum, skipped: 'unsupported' };
  const day = kstDay(now);
  if (!(await repo.claimRetentionDay(day))) return { ...sum, skipped: 'already-ran' };
  sum.ran = true;
  try {
    for (const c of await repo.retentionCandidates(CANDIDATE_LIMIT)) {
      sum.customers++;
      for (const stage of dueStages(c, cfg, now)) {
        if (Date.now() >= opts.deadlineMs) { sum.partial = true; break; }
        try {
          const r = await repo.runRetentionStage(c.customerId, stage, { deadlineMs: opts.deadlineMs, now, days: stageDays(stage, cfg) });
          if (r.skipped) break;
          sum.stages++;
          sum.rows += Object.values(r.counts).reduce((a, b) => a + b, 0);
          if (r.partial) { sum.partial = true; break; }
        } catch (err) {
          // One customer's failure never stops the others; the day stays claimed (the next try is tomorrow).
          sum.errors.push({ customerId: c.customerId, stage, message: err instanceof Error ? err.message.slice(0, 200) : 'failed' });
          opts.log?.('error', 'retention_stage_failed', { customerId: c.customerId, stage });
          break;
        }
      }
      if (sum.partial) break;
    }
  } finally {
    // Unfinished work continues on the next tick instead of waiting a day; a finished run closes the claim.
    if (sum.partial) await repo.releaseRetentionDay?.(day).catch(() => undefined);
    else await repo.finishRetentionDay?.(day).catch(() => undefined);
  }
  return sum;
}
