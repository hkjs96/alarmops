import { sha256 } from './hash.js';

/**
 * TENANT SCOPE INVARIANT (security review B-6). Every fingerprint and every group key MUST embed a customer
 * scope: CloudWatch → AWS account id, Prometheus/Grafana → IntegrationSource id (owned by exactly one
 * customer), group key → customerId, else account, else source (grouping.ts `groupKey`).
 * The repository additionally keys Alert by (customerId, fingerprint) (B-4), but read paths such as
 * `findOpenGroup(groupKey)` rely on this invariant. Changing a rule here without a scope breaks tenant
 * isolation; `test/tenant-scope.test.ts` guards it.
 */

/** Bump when a rule changes (fingerprint 제안 5, Q-DM-04 still open). */
export const FINGERPRINT_VERSION = 1;

/**
 * CloudWatch (F-1, API-CONTRACT §3.1): `cloudwatch:{account}:{resource or alarmArn or alarmName}#{metricKey}`.
 * The alarm name is only the last fallback: thresholds are not in our alarm names (D-08) but customer
 * alarm names may still change, so a resolved resource id is always preferred.
 * known-bugs 1-3: an empty resource must never collapse different alarms into `{account}##`.
 */
export function cloudwatchFingerprint(input: {
  account: string;
  resourceKey?: string | null;
  alarmArn?: string | null;
  alarmName?: string | null;
  metricKey?: string | null;
}): string {
  const resource = nonEmpty(input.resourceKey) ?? nonEmpty(input.alarmArn) ?? nonEmpty(input.alarmName) ?? 'unknown';
  return `cloudwatch:${input.account}:${resource}#${input.metricKey ?? ''}`;
}

/** Labels that change across the life of one series and therefore must not split it (fingerprint 제안 3). */
export const VOLATILE_LABELS = new Set(['severity', 'grafana_state', '__alert_rule_uid__', 'alertstate']);

/**
 * Prometheus/Grafana (F-6, 제안 3): native `fingerprint` required; fallback = hash of alertname + all sorted
 * labels minus volatile ones (NOT AH's `alertname:instance`, which merged different devices — 충돌 4).
 * `tenant` = IntegrationSource id so two customers' identical label sets never collide.
 */
export function webhookFingerprint(
  source: 'PROMETHEUS' | 'GRAFANA',
  tenant: string,
  nativeFingerprint: string | null | undefined,
  labels: Record<string, string>,
): string {
  const prefix = source === 'GRAFANA' ? 'grafana' : 'prometheus';
  const fp = nonEmpty(nativeFingerprint);
  if (fp) return `${prefix}:${tenant}:${fp}`;
  const parts = Object.keys(labels)
    .filter((k) => !VOLATILE_LABELS.has(k))
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return `${prefix}:${tenant}:h${sha256(parts.join('\u0000')).slice(0, 16)}`;
}

function nonEmpty(v: string | null | undefined): string | null {
  return v != null && String(v).trim() !== '' ? String(v) : null;
}
