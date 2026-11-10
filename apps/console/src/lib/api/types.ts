/**
 * Console REST types for docs/API-CONTRACT.md §8.1 (Incidents & alerts).
 * Field names follow DATA-MODEL.md (Incident, IncidentEvent, NotificationLog, Alert).
 * Where the contract does not pin the response shape yet, fields are the minimum the
 * screens in docs/ui/screens/incidents-list.md / incident-detail.md need — flagged "PROPOSED".
 */
import type { ScopeCustomerNode, Severity, ThresholdSource } from "@alarmops/design-system";

export type { Severity };
export type IncidentStatus = "TRIGGERED" | "ACKNOWLEDGED" | "RESOLVED";
export type AlertSource = "CLOUDWATCH" | "PROMETHEUS" | "GRAFANA";
export type StepTargetType = "PERSON" | "ROTATION" | "ALL_RESPONDERS";
export type Channel = "SLACK_BOT" | "SLACK_WEBHOOK" | "SLACK_DM" | "EMAIL" | "SMS" | "VOICE";

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId: string };
}

export interface OrgRef {
  id: string;
  name: string;
  /** PROPOSED: URL-safe name used in `?customer=&project=&service=` and `/c/<customer>/<project>/<service>/…` */
  slug?: string;
}

/** service › project › customer resolution result shown as the org chain. */
export interface OrgChain {
  customer: OrgRef | null;
  project: OrgRef | null;
  service: OrgRef | null;
}

export interface PersonRef {
  contactId: string;
  name: string;
  /** e.g. "on shift in MSP night desk" */
  via?: string;
}

/** Incident.assignmentSnapshot.steps[] (DATA-MODEL oncall R3-1) */
export interface SnapshotStep {
  index: number;
  atMin: number;
  targetType: StepTargetType;
  targetId?: string;
  resolved: PersonRef[];
  channels: Channel[];
  /** label for ALL_RESPONDERS / ROTATION, e.g. "everyone in Responders (5)" */
  label?: string;
}

export interface AssignmentSnapshot {
  capturedAt: string;
  pagingConfigId: string | null;
  /** PROPOSED: "Custom steps · Urgent (edited)" */
  planLabel?: string;
  level: "SERVICE" | "PROJECT" | "CUSTOMER" | "MSP";
  steps: SnapshotStep[];
  repeatCount: number;
}

export interface EscalationProgress {
  step: number; // 0-based current step (Incident.escalationStep)
  totalSteps: number;
  repeat: number; // Incident.escalationRepeat
  repeatCount: number;
  nextAt: string | null;
  doneAt: string | null;
  /** short human summary, e.g. "voice in 2m 48s" — PROPOSED */
  summary?: string;
  /** what happens at nextAt, e.g. "Step 2 · call Yuna Seo (Mirae Pay)" — PROPOSED */
  nextLabel?: string;
  /** when the current step started (Incident.escalationBaseAt) */
  baseAt?: string | null;
  mutedByMaintenance?: boolean;
}

export interface IncidentListItem {
  id: string;
  number: number;
  /** display key e.g. INC-20261109-0312-7F3A — PROPOSED */
  key: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  /** PROPOSED: TRIGGERED and at least one escalation step fired without ack → shown as "Escalated" */
  escalated: boolean;
  org: OrgChain;
  unmapped: boolean;
  awsAccountIds: string[];
  resourceTypes: string[];
  source: AlertSource;
  env?: string;
  memberCount: number;
  assignee: PersonRef | null;
  /** second line under the assignee: "next: Junho Park", "ack'd 02:58" */
  assigneeNote?: string;
  escalation: EscalationProgress | null;
  triggeredAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolvedVia?: "MANUAL" | "AUTO" | "RECONCILE";
  version: number;
}

/** `counts` on GET /incidents — same filter basis as items (known-bugs 9-5). */
export interface IncidentCounts {
  triggered: number;
  escalated: number;
  acknowledged: number;
  resolved24h: number;
  muted: number;
  open: number;
  /** PROPOSED tile sub-lines */
  meta?: {
    triggeredSev1: number;
    oldestTriggeredAt: string | null;
    medianAckSec: number | null;
    resolvedAuto: number;
    resolvedManual: number;
    maintenanceWindows: number;
    escalatedNext?: string | null;
  };
}

export interface UnmappedSummary {
  awsAccountId: string;
  alertCount: number;
}

/**
 * PROPOSED: incidents the scope filter hides, over all customers the user may see. Scope filter only
 * (customer/project/service or mine); status, severity and search do not change it.
 * Invariant: open incidents in the filtered list + `open` = the nav badge.
 */
export interface OutsideCounts {
  /** triggered or escalated, nobody acknowledged; includes `unmapped` */
  open: number;
  /** of `open`: from an AWS account that is not assigned to a customer */
  unmapped: number;
  acknowledged: number;
}

export interface IncidentListResponse extends Paginated<IncidentListItem> {
  counts: IncidentCounts;
  /** PROPOSED: unmapped-account banner source */
  unmapped: UnmappedSummary[];
  /** PROPOSED: null when no scope filter is set */
  outside: OutsideCounts | null;
}

export interface IncidentListQuery {
  status?: "open" | IncidentStatus;
  severity?: Severity;
  customerId?: string;
  /** PROPOSED scope filter by slug. project needs customer, service needs project. Unknown or out-of-scope slug → 404. */
  customer?: string;
  project?: string;
  service?: string;
  /** PROPOSED: only customers the signed-in user is a responder for (plus unmapped accounts) */
  mine?: boolean;
  assignee?: "me";
  unmapped?: boolean;
  source?: AlertSource;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface AlertMember {
  id: string;
  fingerprint: string;
  title: string;
  status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED" | "INSUFFICIENT_DATA";
  severity: Severity;
  metricKey: string | null;
  resourceId: string | null;
  value: number | null;
  threshold: number | null;
  eventCount: number;
  lastEventAt: string;
}

export interface WhyItFired {
  metricKey: string;
  statistic: string;
  periodLabel: string;
  current: string;
  threshold: string;
  thresholdSource: ThresholdSource;
  thresholdSourceNote: string;
  evaluation: string;
  evaluationSource: ThresholdSource;
  evaluationNote: string;
  reason: string;
  /** sparkline values, oldest first */
  series: number[];
  seriesThreshold: number;
  seriesLabels: [string, string, string];
  resourceId: string | null;
}

export type RemediationStage = "NOTIFIED" | "PENDING_APPROVAL" | "APPROVED" | "EXECUTING" | "SUCCEEDED" | "REJECTED" | "EXPIRED";

export interface RemediationSummary {
  id: string;
  mode: "NOTIFY_ONLY" | "APPROVAL";
  action: string;
  target: string;
  trigger: string;
  stage: RemediationStage;
  notifiedAt: string;
  expiresAt: string | null;
  approvers: string[];
  slackThreadUrl: string | null;
  slackChannel: string | null;
}

export interface SuppressionDecision {
  at: string;
  alertId: string;
  reason: string;
  detail: string;
}

export interface IncidentDetail extends IncidentListItem {
  region?: string;
  alerts: AlertMember[];
  assignmentSnapshot: AssignmentSnapshot | null;
  why: WhyItFired | null;
  suppression: SuppressionDecision[];
  remediation: RemediationSummary | null;
  /** D-14: placeholder only */
  rcaPlaceholder: { availableAfterPoc: true };
  details: { source: string; resource: string; alarm: string; runbookUrl?: string; runbookLabel?: string; lastTime?: string };
  /** "Paged" line in hero — PROPOSED */
  paged: { label: string; at: string; done: boolean }[];
  notificationCount: number;
}

export type IncidentEventKind =
  | "TRIGGERED" | "MERGED" | "ACKED" | "RESOLVED" | "ESCALATED" | "NOTIFIED" | "RENOTIFIED" | "SUPPRESSED" | "MUTED" | "REMEDIATION" | "NOTE";

export interface IncidentEvent {
  id: string;
  at: string;
  kind: IncidentEventKind;
  actorType: "USER" | "CONTACT" | "SYSTEM" | "PROVIDER";
  actorId: string | null;
  message: string;
  detail?: string;
}

export interface NotificationLogEntry {
  id: string;
  at: string;
  channel: Channel;
  status: "SENT" | "FAILED";
  targetSummary: string;
  escalationStep: number;
  error: string | null;
}

export interface OncallNowEntry {
  contactId: string | null;
  name: string;
  initials: string;
  rotation: string;
  detail: string;
  openCount: number;
}

export type ResolveKind = "RESTART" | "CONFIG" | "AUTO" | "OTHER";

export interface BulkPreview {
  action: "ack" | "resolve";
  targets: { id: string; key: string; title: string; status: IncidentStatus }[];
  skipped: { id: string; reason: string }[];
}

export interface BulkResult {
  updated: string[];
  undoToken: string;
  undoExpiresAt: string;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  role: "VIEWER" | "OPERATOR" | "ADMIN";
}

/**
 * PROPOSED: GET /scope-tree — customer › project › service with what the tree shows per node:
 * openIncidents (same definition as the nav badge), callHealth (customer level, D-32 paging-health level),
 * ownSteps (project/service has a paging override), mine (signed-in user is a responder). slug is unique within its parent.
 */
export type ScopeTreeCustomer = ScopeCustomerNode;
export interface ScopeTreeResponse {
  customers: ScopeTreeCustomer[];
}
