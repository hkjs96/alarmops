import type { Severity } from './types.js';

/** Runtime form of the SuppressionPolicy row (DATA-MODEL §3). DB → code defaults; no env layer (D-19, suppression 새 구현 3). */
export interface SuppressionPolicy {
  repeatIntervalSec: number;
  flappingPerDay: number;
  flappingWindowDays: number;
  flappingQuarantineSec: number;
  groupWaitSec: number;
  autoPauseSec: Partial<Record<Severity, number>>;
  renotifyAfterSec: number;
  incidentMergeMaxSec: number;
}

export const DEFAULT_POLICY: Readonly<SuppressionPolicy> = Object.freeze({
  repeatIntervalSec: 900,
  flappingPerDay: 3,
  flappingWindowDays: 1,
  flappingQuarantineSec: 3600,
  groupWaitSec: 30,
  autoPauseSec: {},
  renotifyAfterSec: 3600,
  incidentMergeMaxSec: 21600,
});

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * Build the policy from a DB row (partial OK). Every field is mapped explicitly — regression for the AAM
 * defect where `renotify_after_sec` was never reassembled from the DB item (suppression S-11, 새 구현 4).
 */
export function policyFromRow(row: Partial<Record<keyof SuppressionPolicy, unknown>> | null | undefined): SuppressionPolicy {
  const r = row ?? {};
  const d = DEFAULT_POLICY;
  const pause: Partial<Record<Severity, number>> = {};
  const raw = r.autoPauseSec;
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const key = k.replace('-', '_') as Severity;
      if (/^SEV_[1-5]$/.test(key)) pause[key] = clamp(v, 0, 3600, 0);
    }
  }
  return {
    repeatIntervalSec: clamp(r.repeatIntervalSec, 0, 86400, d.repeatIntervalSec),
    flappingPerDay: clamp(r.flappingPerDay, 1, 1000, d.flappingPerDay),
    flappingWindowDays: clamp(r.flappingWindowDays, 1 / 24, 30, d.flappingWindowDays),
    flappingQuarantineSec: clamp(r.flappingQuarantineSec, 0, 86400, d.flappingQuarantineSec),
    groupWaitSec: clamp(r.groupWaitSec, 0, 300, d.groupWaitSec),
    autoPauseSec: pause,
    renotifyAfterSec: clamp(r.renotifyAfterSec, 0, 86400, d.renotifyAfterSec),
    incidentMergeMaxSec: clamp(r.incidentMergeMaxSec, 0, 30 * 86400, d.incidentMergeMaxSec),
  };
}

export const maxAutoPauseSec = (p: SuppressionPolicy): number => Math.max(0, ...Object.values(p.autoPauseSec).map((v) => v ?? 0));
