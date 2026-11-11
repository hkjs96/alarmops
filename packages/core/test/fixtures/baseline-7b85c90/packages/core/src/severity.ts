import { SEVERITIES, type Severity } from './types.js';

/**
 * Severity normalisation (D-18 single mapping table, D-25 critical→SEV-2, severity.md V-4 / 새 구현 2).
 * Order for non-CloudWatch-managed alarms: `sev[-\s]?n` pattern (1..5 only) → SeverityMapping table → default.
 */

/** Fallback when nothing matches. Q-DM-08 is still open (SEV-3 vs SEV-5); spec proposal is SEV-3. */
export const DEFAULT_UNMAPPED_SEVERITY: Severity = 'SEV_3';

/** Seed/default contents of the SeverityMapping table (keys lower-case). D-25: critical → SEV_2. */
export const DEFAULT_SEVERITY_TABLE: Readonly<Record<string, Severity>> = Object.freeze({
  critical: 'SEV_2',
  high: 'SEV_2',
  error: 'SEV_2',
  warning: 'SEV_3',
  warn: 'SEV_3',
  medium: 'SEV_3',
  low: 'SEV_4',
  info: 'SEV_5',
  informational: 'SEV_5',
  none: 'SEV_5',
});

/** `SEV-1`, `sev1`, `Sev 2`, `SEV_3` → SEV_n. Out-of-range digits (SEV-0, SEV-9) → null (fixes AH V-6). */
export function parseSevPattern(value: string | null | undefined): Severity | null {
  if (!value) return null;
  const m = /^\s*sev[\s_-]?(\d+)\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 5 ? (SEVERITIES[n - 1] as Severity) : null;
}

export interface SeverityResult {
  severity: Severity;
  severityRaw: string | null;
  matchedBy: 'PATTERN' | 'TABLE' | 'METADATA' | 'REGISTRY' | 'DEFAULT';
}

/** Map an external severity label (Prometheus/Grafana `severity` label, etc.). */
export function mapExternalSeverity(
  raw: string | null | undefined,
  table: Readonly<Record<string, Severity>> = DEFAULT_SEVERITY_TABLE,
): SeverityResult {
  const severityRaw = raw == null || raw === '' ? null : String(raw);
  const pat = parseSevPattern(severityRaw);
  if (pat) return { severity: pat, severityRaw, matchedBy: 'PATTERN' };
  const key = severityRaw?.trim().toLowerCase();
  if (key && table[key]) return { severity: table[key] as Severity, severityRaw, matchedBy: 'TABLE' };
  return { severity: DEFAULT_UNMAPPED_SEVERITY, severityRaw, matchedBy: 'DEFAULT' };
}

/**
 * Metric-key default severity registry (severity V-2, subset ported from AAM alarm_registry `_DEFAULT_SEVERITY`).
 * Full registry is owned by the alarm-engine port (D-05); unknown metric → SEV_5 (V-2).
 */
export const METRIC_SEVERITY_REGISTRY: Readonly<Record<string, Severity>> = Object.freeze({
  StatusCheckFailed: 'SEV_1', StatusCheckFailed_Application: 'SEV_1', HealthyHostCount: 'SEV_1',
  TunnelState: 'SEV_1', ConnectionState: 'SEV_1', HealthCheckStatus: 'SEV_1', ActiveControllerCount: 'SEV_1',
  ClusterStatusRed: 'SEV_1',
  ELB5XX: 'SEV_2', HTTPCode_ELB_5XX_Count: 'SEV_2', CLB5XX: 'SEV_2', Errors: 'SEV_2', UnHealthyHostCount: 'SEV_2',
  Api5XXError: 'SEV_2', DatabaseMemoryUsagePercentage: 'SEV_2',
  CPU: 'SEV_3', CPUUtilization: 'SEV_3', Memory: 'SEV_3', FreeStorageSpace: 'SEV_3', FreeableMemory: 'SEV_3',
  ReplicaLag: 'SEV_3', DaysToExpiry: 'SEV_3',
  TargetResponseTime: 'SEV_4', Latency: 'SEV_4', HTTPCode_ELB_4XX_Count: 'SEV_4', BurstCreditBalance: 'SEV_4',
});

export function registrySeverity(metricKey: string | null | undefined): Severity {
  if (!metricKey) return 'SEV_5';
  if (metricKey.startsWith('Disk_') || metricKey.startsWith('disk_used_percent_')) return 'SEV_3';
  return METRIC_SEVERITY_REGISTRY[metricKey] ?? 'SEV_5';
}

/**
 * CloudWatch (severity V-4): alarm description metadata `severity` (must be SEV-1..5, else ignored)
 * → registry by metric key. Name and tags are never read.
 * Unmanaged customer alarms (no metadata): registry if metric known, else default (severity 새 구현 2 proposal).
 */
export function cloudwatchSeverity(metadataSeverity: unknown, metricKey: string | null, managed: boolean): SeverityResult {
  const raw = typeof metadataSeverity === 'string' ? metadataSeverity : null;
  const pat = parseSevPattern(raw);
  if (pat) return { severity: pat, severityRaw: raw, matchedBy: 'METADATA' };
  if (managed || (metricKey && METRIC_SEVERITY_REGISTRY[metricKey])) {
    return { severity: registrySeverity(metricKey), severityRaw: raw, matchedBy: 'REGISTRY' };
  }
  return { severity: DEFAULT_UNMAPPED_SEVERITY, severityRaw: raw, matchedBy: 'DEFAULT' };
}

/** V-6 update rule: a weak follow-up never downgrades a known severity to a default guess. */
export function mergeSeverity(stored: Severity | null, incoming: SeverityResult): Severity {
  if (stored && incoming.matchedBy === 'DEFAULT') return stored;
  return incoming.severity;
}
