import type { NormalizedEvent, Severity, SuppressionPolicy, MaintenanceWindow, GroupRow, FingerprintState } from '@alarmops/core';

/** Queue message on `alert-events` (API-CONTRACT §3, §5 GROUP_CLOSE proposal Q-API-04). */
export type AlertEventsMessage = NormalizedEvent | { type: 'GROUP_CLOSE'; schemaVersion: 1; groupId: string; groupKey: string };

export interface OutgoingMessage {
  id: string; // unique within one batch
  body: AlertEventsMessage;
  attributes: Record<string, string>;
  delaySec?: number;
}

export interface QueueSender {
  /** Sends all messages; throws if any could not be enqueued (caller turns this into a retryable 5xx). */
  send(messages: OutgoingMessage[]): Promise<void>;
}

export interface IntegrationSourceRow {
  id: string;
  customerId: string;
  kind: 'CLOUDWATCH' | 'PROMETHEUS' | 'GRAFANA';
  tokenHash: string | null;
  enabled: boolean;
  /** Security B-2: accept `?token=` for this source only when true (default false). */
  allowQueryToken: boolean;
}

export interface IngestRejectionInput {
  customerId?: string | null;
  sourceId?: string | null;
  kind: string;
  reason: string;
  awsAccountId?: string | null;
  title?: string | null;
}

/** Read side used by the webhook receiver and normalizer λ. Every query is keyed by a trusted value. */
export interface SourceRepository {
  findSourceByTokenHash(tokenHash: string): Promise<IntegrationSourceRow | null>;
  touchSource(sourceId: string, at: Date): Promise<void>;
  recordRejection(r: IngestRejectionInput): Promise<void>;
  /** CloudAccount.awsAccountId → customerId, null if unmapped. */
  customerForAccount(awsAccountId: string): Promise<string | null>;
  severityTable(): Promise<Record<string, Severity>>;
}

export interface AlertRow extends FingerprintState {
  id: string;
  fingerprint: string;
  fingerprintVersion: number;
  customerId: string | null;
  sourceId: string | null;
  source: NormalizedEvent['source'];
  awsAccountId: string | null;
  region: string | null;
  resourceType: string | null;
  metricKey: string | null;
  namespace: string | null;
  title: string;
  status: 'FIRING' | 'ACKNOWLEDGED' | 'RESOLVED' | 'INSUFFICIENT_DATA';
  severity: Severity;
  severityRaw: string | null;
  value: number | null;
  threshold: number | null;
  comparison: string | null;
  fireCount: number;
  firstSeenAt: Date;
  lastEventAt: Date;
  version: number;
}

export interface RawEventDecision {
  decision: 'NOTIFY' | 'SUPPRESS' | 'DEFER';
  decisionReason: string;
  groupId?: string | null;
}

/**
 * Write side for the alert-consumer λ. Implemented with Prisma in production (RawEvent INSERT … ON CONFLICT,
 * `updateMany where version`, partial unique on open group) and in memory for tests.
 * Every row carries customerId (tenant column, DATA-MODEL §0).
 */
export interface AlertRepository {
  /** INSERT RawEvent; 'DUPLICATE' when dedupKey already exists (F-3, G-8). */
  insertRawEvent(ev: NormalizedEvent, alertId: string): Promise<{ id: string } | 'DUPLICATE'>;
  setRawEventDecision(rawEventId: string, d: RawEventDecision): Promise<void>;
  /**
   * Alert identity is (customerId, fingerprint) — UQ NULLS NOT DISTINCT in Postgres (security B-4/B-6).
   * Never look an alert up by fingerprint alone: an account moved to another customer must open a new alert.
   */
  findAlert(customerId: string | null, fingerprint: string): Promise<AlertRow | null>;
  /** Most recent alert with this fingerprint owned by a different customer scope (reassignment audit only). */
  findAlertInOtherScope(customerId: string | null, fingerprint: string): Promise<{ id: string; customerId: string | null } | null>;
  /** Create; 'EXISTS' on unique conflict (P2002) so the caller re-reads (F-7, known-bugs 1-6). */
  createAlert(row: AlertRow): Promise<AlertRow | 'EXISTS'>;
  /** Conditional update `WHERE id = ? AND version = ?`, bumps version. 'CONFLICT' if version moved. */
  updateAlert(row: AlertRow, expectedVersion: number): Promise<AlertRow | 'CONFLICT'>;
  loadPolicy(): Promise<SuppressionPolicy>;
  activeMaintenance(customerId: string | null, at: Date): Promise<MaintenanceWindow[]>;
  /** Safe without customerId: group keys always embed the customer scope (fingerprint.ts TENANT SCOPE INVARIANT). */
  findOpenGroup(groupKey: string): Promise<GroupRow | null>;
  groupIdExists(id: string): Promise<boolean>;
  /** INSERT; 'EXISTS' when another OPEN group for the key won the race (partial UQ). */
  createGroup(g: GroupRow, replaceStaleId?: string): Promise<GroupRow | 'EXISTS'>;
  /** G-5: close only if still OPEN with this id. */
  closeGroup(groupId: string, at: Date): Promise<boolean>;
}
