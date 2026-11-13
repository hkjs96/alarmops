// Shared domain types (mirror db/prisma/schema.prisma enums and API-CONTRACT §3).
export const SEVERITIES = ['SEV_1', 'SEV_2', 'SEV_3', 'SEV_4', 'SEV_5'] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Source = 'CLOUDWATCH' | 'PROMETHEUS' | 'GRAFANA';
export type EventState = 'FIRING' | 'RESOLVED' | 'INSUFFICIENT_DATA';
export type EventType = 'STATE_CHANGE' | 'CONFIG_CHANGE';
export type CustomerResolvedBy = 'ACCOUNT_MAP' | 'SOURCE_TOKEN' | 'UNMAPPED';
export type Decision = 'NOTIFY' | 'SUPPRESS' | 'DEFER';
/** Customer.status (D-42, D-43). */
export type CustomerStatus = 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
/** Incident.pagingSuppressed (D-43): the incident is recorded but never paged, even after the customer is ACTIVE again. */
export type PagingSuppressedReason = 'CUSTOMER_SUSPENDED' | 'CUSTOMER_TERMINATED';

/** SQS `alert-events` body (API-CONTRACT §3). */
export interface NormalizedEvent {
  schemaVersion: 1;
  dedupKey: string;
  source: Source;
  sourceId: string | null;
  customerId: string | null;
  customerResolvedBy: CustomerResolvedBy;
  awsAccountId: string | null;
  region: string | null;
  fingerprint: string;
  fingerprintVersion: number;
  state: EventState;
  previousState: string | null;
  eventType: EventType;
  severity: Severity;
  severityRaw: string | null;
  resource: { type: string | null; key: string | null; name: string | null; arn: string | null } | null;
  metric: { key: string | null; namespace: string | null; value: number | null; threshold: number | null; comparison: string | null } | null;
  alarm: { name: string | null; arn: string | null; managed: boolean } | null;
  title: string;
  reason: string | null;
  occurredAt: string;
  receivedAt: string;
  parseError: string | null;
  raw: unknown;
}

export const severityRank = (s: string | null | undefined): number => {
  const i = SEVERITIES.indexOf(s as Severity);
  return i < 0 ? 9 : i + 1; // G-9: unknown sorts last
};
export const sevLabel = (s: Severity): string => s.replace('_', '-');
