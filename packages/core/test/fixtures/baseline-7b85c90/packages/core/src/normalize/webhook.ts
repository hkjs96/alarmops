import { FINGERPRINT_VERSION, webhookFingerprint } from '../fingerprint.js';
import { sha256 } from '../hash.js';
import { capRaw } from '../raw.js';
import { DEFAULT_SEVERITY_TABLE, mapExternalSeverity } from '../severity.js';
import type { NormalizedEvent, Severity } from '../types.js';
import { toIso } from './cloudwatch.js';
import { webhookState } from './state.js';

/** Alertmanager webhook v4 / Grafana unified alerting payload (common subset). */
export interface WebhookAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
}
export interface WebhookPayload {
  version?: string;
  groupKey?: string;
  status?: string;
  orgId?: number;
  alerts?: WebhookAlert[];
  [k: string]: unknown;
}

export interface WebhookContext {
  /** Trusted, from the token → IntegrationSource lookup. Body values are never used for tenancy. */
  sourceId: string;
  customerId: string;
  receivedAt: Date;
  severityTable?: Readonly<Record<string, Severity>>;
}

export interface WebhookNormalizeResult {
  events: NormalizedEvent[];
  rejected: Array<{ index: number; reason: string }>;
}

const ZERO_TIME = /^0001-01-01/;

/** One payload → one event per alert (batch split, fingerprint 새 구현 회귀 테스트). */
export function normalizeWebhook(source: 'PROMETHEUS' | 'GRAFANA', payload: WebhookPayload, ctx: WebhookContext): WebhookNormalizeResult {
  const events: NormalizedEvent[] = [];
  const rejected: WebhookNormalizeResult['rejected'] = [];
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
  if (alerts.length === 0) rejected.push({ index: -1, reason: 'no_alerts' });

  alerts.forEach((a, index) => {
    const labels = a.labels ?? {};
    const ann = a.annotations ?? {};
    const alertname = labels.alertname ?? null;
    if (!alertname && !ann.summary) {
      rejected.push({ index, reason: 'missing_alertname' }); // F-6: dropped
      return;
    }
    let state = webhookState(a.status ?? payload.status);
    const gstate = (labels.grafana_state ?? '').toLowerCase();
    if (source === 'GRAFANA' && (gstate === 'nodata' || gstate === 'paused' || alertname === 'DatasourceNoData')) {
      state = state === 'RESOLVED' ? 'RESOLVED' : 'INSUFFICIENT_DATA'; // ec8caf4
    }
    const fingerprint = webhookFingerprint(source, ctx.sourceId, a.fingerprint, labels);
    const sev = mapExternalSeverity(labels.severity, ctx.severityTable ?? DEFAULT_SEVERITY_TABLE);
    const startsAt = toIso(a.startsAt, ctx.receivedAt);
    const endsValid = a.endsAt && !ZERO_TIME.test(a.endsAt) ? a.endsAt : undefined;
    const occurredAt = state === 'RESOLVED' ? toIso(endsValid, ctx.receivedAt) : startsAt;
    const instance = labels.instance ?? labels.pod ?? labels.job ?? null;

    events.push({
      schemaVersion: 1,
      dedupKey: sha256(`${ctx.sourceId}:${fingerprint}:${startsAt}:${state}`),
      source,
      sourceId: ctx.sourceId,
      customerId: ctx.customerId,
      customerResolvedBy: 'SOURCE_TOKEN',
      awsAccountId: null,
      region: null,
      fingerprint,
      fingerprintVersion: FINGERPRINT_VERSION,
      state,
      previousState: null,
      eventType: 'STATE_CHANGE',
      severity: sev.severity,
      severityRaw: sev.severityRaw,
      resource: { type: labels.job ?? null, key: instance, name: instance, arn: null },
      metric: { key: alertname, namespace: labels.job ?? null, value: null, threshold: null, comparison: null },
      alarm: { name: alertname, arn: null, managed: false },
      title: ann.summary ?? alertname ?? 'Alert',
      reason: ann.description ?? null,
      occurredAt,
      receivedAt: ctx.receivedAt.toISOString(),
      parseError: null,
      raw: capRaw(a),
    });
  });
  return { events, rejected };
}

/** F-5 path is explicit (`/ingest/v1/{source}`); this only checks the body shape matches the path. */
export function detectWebhookKind(payload: WebhookPayload): 'GRAFANA' | 'PROMETHEUS' | null {
  if (!payload || !Array.isArray(payload.alerts)) return null;
  if (payload.orgId !== undefined || payload.version === '1' || 'dashboardURL' in (payload.alerts[0] ?? {})) return 'GRAFANA';
  if (payload.version === '4' || payload.groupKey !== undefined) return 'PROMETHEUS';
  return null;
}
