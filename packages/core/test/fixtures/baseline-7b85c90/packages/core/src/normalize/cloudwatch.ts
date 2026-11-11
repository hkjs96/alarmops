import { cloudwatchFingerprint, FINGERPRINT_VERSION } from '../fingerprint.js';
import { sha256 } from '../hash.js';
import { capRaw } from '../raw.js';
import { cloudwatchSeverity } from '../severity.js';
import type { CustomerResolvedBy, NormalizedEvent } from '../types.js';
import { cloudwatchState } from './state.js';

/** EventBridge `CloudWatch Alarm State Change` / `... Configuration Change` envelope (subset). */
export interface CloudWatchEventBridgeEvent {
  id: string;
  'detail-type': string;
  source: string;
  account: string;
  time: string;
  region: string;
  resources?: string[];
  detail: {
    alarmName?: string;
    state?: { value?: string; reason?: string; timestamp?: string; reasonData?: string };
    previousState?: { value?: string };
    configuration?: {
      description?: string;
      metrics?: Array<{ metricStat?: { metric?: { namespace?: string; name?: string; dimensions?: Record<string, string> } } }>;
    };
  };
}

/** Alarm description JSON metadata written by our alarm engine (F-2). Ownership is decided by this only (f376969). */
export interface AlarmMetadata {
  managedBy?: string;
  resourceId?: string;
  resourceType?: string;
  metricKey?: string;
  severity?: string;
  resourceName?: string;
}

export function parseAlarmMetadata(description: string | undefined): AlarmMetadata | null {
  if (!description) return null;
  const start = description.indexOf('{');
  if (start < 0) return null;
  try {
    const o = JSON.parse(description.slice(start)) as Record<string, unknown>;
    const str = (a: string, b: string) => (typeof o[a] === 'string' ? (o[a] as string) : typeof o[b] === 'string' ? (o[b] as string) : undefined);
    const md: AlarmMetadata = {
      managedBy: str('managedBy', 'managed_by'),
      resourceId: str('resourceId', 'resource_id'),
      resourceType: str('resourceType', 'resource_type'),
      metricKey: str('metricKey', 'metric_key'),
      severity: str('severity', 'severity'),
      resourceName: str('resourceName', 'resource_name'),
    };
    return md.resourceId || md.metricKey ? md : null;
  } catch {
    return null;
  }
}

/** Name-format fallback `[{type}] {label} {metric} (TagName: {shortId})` — identity only, never ownership (F-2). */
const NAME_RE = /^\[([^\]]+)\]\s+(.*?)\s+\(TagName:\s*([^)]+)\)\s*$/;

export interface CloudWatchContext {
  /** Trusted account→customer map lookup (envelope `account`, never body values). */
  customerForAccount: (awsAccountId: string) => string | null;
  receivedAt: Date;
}

export function normalizeCloudWatch(ev: CloudWatchEventBridgeEvent, ctx: CloudWatchContext): NormalizedEvent {
  const d = ev.detail ?? {};
  const alarmName = d.alarmName ?? null;
  const alarmArn = ev.resources?.[0] ?? null;
  const md = parseAlarmMetadata(d.configuration?.description);
  const metric0 = d.configuration?.metrics?.find((m) => m.metricStat?.metric)?.metricStat?.metric;

  let resourceKey = md?.resourceId ?? null;
  let resourceType = md?.resourceType ?? null;
  let parseError: string | null = null;
  if (!md) {
    const m = alarmName ? NAME_RE.exec(alarmName) : null;
    if (m) {
      resourceType = m[1] ?? null;
      resourceKey = m[3]?.trim() ?? null;
    } else {
      parseError = 'unmanaged alarm format';
    }
  }
  const metricKey = md?.metricKey ?? metric0?.name ?? null;
  const managed = md != null;
  const sev = cloudwatchSeverity(md?.severity, metricKey, managed);
  const occurredAt = toIso(d.state?.timestamp ?? ev.time, ctx.receivedAt);
  const customerId = ctx.customerForAccount(ev.account);
  const resolvedBy: CustomerResolvedBy = customerId ? 'ACCOUNT_MAP' : 'UNMAPPED';
  const isState = ev['detail-type'] === 'CloudWatch Alarm State Change';

  return {
    schemaVersion: 1,
    // Security B-3: tenant-scoped (account) and the full EventBridge event id; RawEvent.dedupKey is a global UQ.
    dedupKey: cloudwatchDedupKey(ev.account, ev.id),
    source: 'CLOUDWATCH',
    sourceId: null,
    customerId,
    customerResolvedBy: resolvedBy,
    awsAccountId: ev.account,
    region: ev.region ?? null,
    fingerprint: cloudwatchFingerprint({ account: ev.account, resourceKey, alarmArn, alarmName, metricKey }),
    fingerprintVersion: FINGERPRINT_VERSION,
    state: cloudwatchState(d.state?.value),
    previousState: d.previousState?.value ?? null,
    eventType: isState ? 'STATE_CHANGE' : 'CONFIG_CHANGE',
    severity: sev.severity,
    severityRaw: sev.severityRaw,
    resource: { type: resourceType, key: resourceKey, name: md?.resourceName ?? null, arn: null },
    metric: { key: metricKey, namespace: metric0?.namespace ?? null, value: null, threshold: null, comparison: null },
    alarm: { name: alarmName, arn: alarmArn, managed },
    title: alarmName ?? 'CloudWatch alarm',
    reason: d.state?.reason ?? null,
    occurredAt,
    receivedAt: ctx.receivedAt.toISOString(),
    parseError,
    raw: capRaw(ev),
  };
}

export function toIso(v: string | undefined | null, fallback: Date): string {
  const t = v ? Date.parse(v) : NaN;
  return new Date(Number.isFinite(t) ? t : fallback.getTime()).toISOString().replace(/\.\d{3}Z$/, (m) => (m === '.000Z' ? 'Z' : m));
}

/** Security B-3: `sha256("cloudwatch:{account}:{full event id}")`. Never truncate the id or drop the account. */
export function cloudwatchDedupKey(account: string, eventId: string): string {
  return sha256(`cloudwatch:${account}:${eventId ?? ''}`);
}
