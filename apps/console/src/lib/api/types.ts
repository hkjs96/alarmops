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
/**
 * Error codes of API-CONTRACT §2 the console knows how to word (lib/errors.ts). Anything else is shown with the
 * server's own message.
 */
export type ApiErrorCode =
  | "VALIDATION_FAILED" | "UNAUTHENTICATED" | "FORBIDDEN" | "ROLE_REQUIRED" | "PORTAL_GRANT_REQUIRED" | "CAPABILITY_DISABLED" | "NOT_FOUND" | "NOT_A_RESPONDER"
  | "EMERGENCY_REASON_REQUIRED" | "VERSION_CONFLICT" | "ALREADY_EXISTS" | "INVALID_TRANSITION" | "TAG_WINS" | "PAYLOAD_TOO_LARGE" | "ROLE_UPDATE_REQUIRED"
  | "MUTED_BY_MAINTENANCE" | "SEND_CAP_EXCEEDED" | "RESPONDER_LIMIT_EXCEEDED" | "IDEMPOTENCY_KEY_REUSED" | "CROSS_CUSTOMER" | "NOT_PAGEABLE" | "RATE_LIMITED" | "NOT_CONFIGURED";

export interface OrgRef {
  id: string;
  name: string;
  /** URL-safe name used in `?customer=&project=&service=` and `/c/<customer>/<project>/<service>/…` (API-CONTRACT §8.0: required, only sent inside the caller's scope) */
  slug: string;
}

/** service › project › customer resolution result shown as the org chain. */
export interface OrgChain {
  customer: OrgRef | null;
  project: OrgRef | null;
  service: OrgRef | null;
}

/** Portal (customer) users get `{ name }` only — no ids, no `via` (API-CONTRACT §8.1 "포털 사용자 응답 모양", D-36). */
export interface PersonRef {
  contactId?: string;
  name: string;
  /** e.g. "on shift in MSP night desk" */
  via?: string;
}

/** Incident.assignmentSnapshot.steps[] (DATA-MODEL oncall R3-1) */
export interface SnapshotStep {
  index: number;
  atMin: number;
  targetType: StepTargetType;
  /** absent for portal users */
  targetId?: string;
  resolved: PersonRef[];
  channels: StepChannel[];
  /** label for ALL_RESPONDERS / ROTATION, e.g. "everyone in Responders (5)" */
  label?: string;
}

export interface AssignmentSnapshot {
  capturedAt: string;
  /** absent for portal users */
  pagingConfigId?: string | null;
  /** the server's wording, e.g. "Custom steps · Urgent (edited)". The console words it itself (lib/call-order/plan-label.ts) so both screens say the same. */
  planLabel?: string;
  /** PROPOSED: the structured form of planLabel. When absent the console reads planLabel. */
  style?: PagingStyle;
  plan?: PagingPlan;
  edited?: boolean;
  level: "SERVICE" | "PROJECT" | "CUSTOMER" | "MSP";
  steps: SnapshotStep[];
  repeatCount: number;
}

/** PROPOSED by the backend (packages/api incidents.ts): why paging is or is not going on */
export type EscalationState = "PAGING" | "MUTED" | "STOPPED_ACKED" | "STOPPED_RESOLVED" | "STOPPED_EXHAUSTED" | "NEVER_ESCALATING" | "UNREACHABLE";
/** `escalation` of an incident. Always an object: an incident nobody is paged for has `state: "NEVER_ESCALATING"`. */
export interface EscalationProgress {
  state: EscalationState;
  step: number; // 0-based index of the last step that fired
  /** steps that have fired in this pass */
  firedSteps: number;
  totalSteps: number;
  repeat: number; // Incident.escalationRepeat
  repeatCount: number;
  nextAt: string | null;
  doneAt: string | null;
  /** what happens at nextAt, e.g. "Step 2 · call Yuna Seo (Mirae Pay)" */
  nextLabel: string | null;
  /** when the current step started (Incident.escalationBaseAt) */
  baseAt: string | null;
  /** when paging stopped (acknowledged, resolved or out of steps) */
  stoppedAt: string | null;
  /** when the reminder after an acknowledgement is due */
  renotifyAt: string | null;
  mutedByMaintenance: boolean;
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
  escalation: EscalationProgress;
  triggeredAt: string;
  acknowledgedAt: string | null;
  /** DATA-MODEL Incident.acknowledgedBy, resolved to a name for "Paging stopped at 03:16 — acknowledged by Haeun" */
  acknowledgedBy?: PersonRef | null;
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
  /**
   * Open = TRIGGERED (escalated included), nobody has acknowledged it. The one meaning of "open" on every screen:
   * the menu badge, the tree, the tiles, the "Outside this view" line. API-CONTRACT §8.0: counts.open + outside.open = the badge.
   */
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
 * API-CONTRACT §8.0: incidents the scope filter hides, over all customers the user may see. Scope filter only
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
  /** unmapped-account banner source (INTERNAL users only) */
  unmapped: UnmappedSummary[];
  /** null when no scope filter is set */
  outside: OutsideCounts | null;
}

export interface IncidentListQuery {
  /** "active" = not resolved (open + acknowledged): the default list. "open" is never used for this (see IncidentCounts.open). */
  status?: "active" | IncidentStatus;
  severity?: Severity;
  customerId?: string;
  /** Scope filter by slug (API-CONTRACT §2). project needs customer, service needs project. Unknown or out-of-scope slug → 404. */
  customer?: string;
  project?: string;
  service?: string;
  /** only customers the signed-in user is a responder for (plus unmapped accounts); the server works it out from the session */
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
  /** why it failed, for every audience; null when it did not */
  reason: NotificationFailReason | null;
  attempt: number;
  /** the provider's own words (redacted): internal OPERATOR and ADMIN only; null for an internal VIEWER, absent for portal users */
  error?: string | null;
  /** internal users only */
  providerMessageId?: string | null;
  warnings?: string[];
}
export type NotificationFailReason = "TIMEOUT" | "INVALID_DESTINATION" | "RATE_LIMITED" | "PROVIDER_REJECTED" | "PROVIDER_ERROR" | "NOT_CONFIGURED" | "GAVE_UP";

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
  /** `reason` is a code: VERSION_CONFLICT, NOT_FOUND, INVALID_TRANSITION */
  skipped: { id: string; reason: string }[];
}

/** One target of POST /incidents/bulk: the id and the version the user saw (security R-3). */
export interface BulkItem {
  id: string;
  version: number;
}

/** POST /incidents/bulk (preview:false) — API-CONTRACT §8.1 */
export interface BulkResult {
  done: string[];
  /** skipped: the version moved on (VERSION_CONFLICT), not visible (NOT_FOUND), or not in a state the action applies to */
  conflicts: { id: string; code: string }[];
  undoToken: string;
}

/** POST /incidents/{id}/ack — the token goes to /incidents/bulk/undo (5 min, the person who acknowledged) */
export interface AckResult {
  incident: IncidentDetail;
  undoToken: string;
}

/** POST /incidents/bulk/undo: what went back, and what did not because someone touched it since (VERSION_CONFLICT) */
export interface UndoResult {
  restored: string[];
  skipped: { id: string; code: string }[];
}

export type Role = "VIEWER" | "OPERATOR" | "ADMIN";
/** GET /me — the session's user. The console reads `role` to decide what to offer; the server decides what is allowed. */
export interface Me {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/**
 * GET /scope-tree (API-CONTRACT §8.0) — customer › project › service with what the tree shows per node:
 * openIncidents (same definition as the nav badge), callHealth (customer level, D-32 paging-health level),
 * ownSteps (project/service has a paging override), mine (signed-in user is a responder). slug is unique within its parent.
 */
export type ScopeTreeCustomer = ScopeCustomerNode;
export interface ScopeTreeResponse {
  customers: ScopeTreeCustomer[];
}

/* ------------------------------------------------------------------------------------------------------------------
 * Call order (API-CONTRACT §8.3, D-30 · D-32). Fields marked PROPOSED are not pinned by the contract yet; the list
 * is in docs of the PR that introduced them (feat/console-call-order) and at the top of lib/call-order/model.ts.
 * ---------------------------------------------------------------------------------------------------------------- */
export type PagingStyle = "ALL_AT_ONCE" | "CUSTOMER_ROTATION" | "SHARED_ROTATION" | "CUSTOM";
export type PagingPlan = "STANDARD" | "URGENT" | "QUIET";
/** channels a paging step can use (DATA-MODEL EscalationStep.channels). SLACK_CHANNEL is the customer's channel, the others go to the person. */
export type StepChannel = "SLACK_CHANNEL" | "SLACK_DM" | "SMS" | "VOICE" | "EMAIL";
export type ScopeLevelName = "CUSTOMER" | "PROJECT" | "SERVICE";
export interface LevelRef { level: ScopeLevelName; id: string; name: string }

/** One step as it is stored: PUT /customers/{id}/paging and /paging-overrides bodies */
export interface PagingStep {
  atMin: number;
  targetType: StepTargetType;
  /** PERSON → contactId, ROTATION → rotationId, ALL_RESPONDERS → absent */
  targetId?: string;
  channels: StepChannel[];
}

/** Body of PUT /customers/{id}/paging and PUT /customers/{id}/paging-overrides/{scopeType}/{scopeId} */
export interface PagingConfigInput {
  style: PagingStyle;
  plan: PagingPlan;
  sharedRotationId?: string;
  steps: PagingStep[];
  repeatCount: number;
}

/** What one incident would send with these steps and today's responders, against the limits (API-CONTRACT §2 "한도", D-38) */
export interface SendCap {
  perCycle: number;
  perHour: number;
  limits: { perCycle: number; perHour: number; allResponders: number };
  /** null, or the code a PUT of these same steps would get today */
  exceeded: "SEND_CAP_EXCEEDED" | "RESPONDER_LIMIT_EXCEEDED" | null;
}
/**
 * Response of GET/PUT /customers/{id}/paging (and the override PUT). A customer with no steps saved yet answers GET
 * with `id: null`, `version: 0`, `steps: []`; the first PUT goes with `If-Match: 0` and is answered 201.
 */
export interface PagingConfig extends PagingConfigInput {
  id: string | null;
  customerId: string;
  scopeType: ScopeLevelName;
  scopeId: string;
  edited: boolean;
  version: number;
  /** PROPOSED: DATA-MODEL PagingConfig.updatedBy resolved to a name, for "edited by Junho Park, Oct 29" */
  updatedByName?: string | null;
  updatedAt?: string | null;
  sentence: string;
  sendCap?: SendCap;
  /** GET only: the project / service levels of this customer that have their own steps */
  overrides?: { scopeType: "PROJECT" | "SERVICE"; scopeId: string; name: string; id: string; version: number; style: PagingStyle; plan: PagingPlan; edited: boolean }[];
}

/** A step of GET /oncall/paging-path: the stored step plus who it reaches right now */
export interface PagingPathStep extends PagingStep {
  /** contacts this step reaches now (Leave and Override applied) */
  nowIds: string[];
  names: string[];
  /** PROPOSED: name of the rotation (ROTATION) or the person (PERSON) the step names — the contract has only targetId */
  targetName?: string;
  /** PROPOSED: the named person is a customer person, shown as "Yuna Seo (Mirae Pay)" */
  targetIsCustomerPerson?: boolean;
}

/** GET /oncall/paging-path */
export interface PagingPath {
  path: LevelRef[];
  customer: { id: string; name: string };
  /** the level whose steps apply. Equal to the asked level when it has its own steps. null: nothing is configured anywhere up the chain (`warning: "NO_CALL_ORDER"`) */
  inheritedFrom: LevelRef | null;
  /** PROPOSED: true when the asked level itself holds the steps (saves comparing ids) */
  own: boolean;
  style: PagingStyle | null;
  plan: PagingPlan | null;
  edited: boolean;
  pagingConfigId: string | null;
  /** 0 when nothing is saved yet: the If-Match of the first PUT */
  version: number;
  /** NO_CALL_ORDER: no steps anywhere up the chain. NOBODY_REACHABLE: steps exist and reach nobody right now */
  warning?: "NO_CALL_ORDER" | "NOBODY_REACHABLE";
  /** PROPOSED: needed to send the config back unchanged in a PUT */
  sharedRotationId?: string;
  steps: PagingPathStep[];
  repeatCount: number;
  stopAtMin: number;
  sentence: string;
  customerNotified: { contactId: string; name: string; scope: LevelRef }[];
  /** PROPOSED: who last changed the steps that apply */
  updatedByName?: string | null;
  updatedAt?: string | null;
}

/** PROPOSED query of GET /oncall/paging-path: the contract has ?q= / ?resourceId= / ?serviceId= only; the panel asks by scope slugs */
export interface PagingPathQuery { customer: string; project?: string; service?: string }

export type PagingProblemCode = "NO_PAGEABLE_RESPONDER" | "NO_VERIFIED_PHONE" | "STEP_UNVERIFIED_ONLY" | "ROTATION_GAP" | "SEND_CAP_EXCEEDED";
export interface PagingProblem {
  code: PagingProblemCode;
  stepIndex?: number;
  contactIds: string[];
  rotationId?: string;
  from?: string;
  to?: string;
  message: string;
  /** NO_VERIFIED_PHONE: the SMS / call of this step to these people is not sent */
  skipped?: boolean;
}
/** GET /customers/{id}/paging-health (D-32) */
export interface PagingHealth { level: "OK" | "AT_RISK" | "UNREACHABLE"; problems: PagingProblem[] }

/** PROPOSED: verification state per channel. Never the address itself. */
export type ChannelState = "VERIFIED" | "UNVERIFIED" | "EXPIRED" | "LINK_SENT" | "NOT_SET";
export type ContactChannelKey = "SLACK" | "EMAIL" | "SMS" | "VOICE";
/**
 * PROPOSED display fields on responders. The contract lists ids only (`staff[{contactId, source, templateId}]`,
 * `people[{contactId, role, extras[], scope}]`); the panel needs a name, the channel states for the D-32 checks and the
 * masked contact (D-35 — full values only through POST /contacts/{id}/reveal, which this screen does not call yet).
 */
export interface ResponderDisplay {
  name: string;
  title?: string;
  channels: Partial<Record<ContactChannelKey, ChannelState>>;
  emailMasked?: string;
  phoneMasked?: string;
}
export interface StaffResponder extends ResponderDisplay { contactId: string; source: "TEMPLATE" | "DIRECT"; templateId?: string; templateName?: string }
export type CustomerPersonRole = "PAGEABLE" | "NOTIFY_ONLY";
export interface CustomerPersonResponder extends ResponderDisplay {
  contactId: string;
  role: CustomerPersonRole;
  extras: ("APPROVER" | "PORTAL_USER")[];
  scope: LevelRef;
}
/**
 * GET /customers/{id}/responders.
 * PROPOSED `version` (security review 권고 2): the list has a version like the steps have. POST / PATCH / DELETE send it
 * as If-Match and answer 409 VERSION_CONFLICT when someone else changed the Responders meanwhile; each write returns
 * the new version. PROPOSED `slackChannel`: whether the customer's Slack channel is connected, which is what a
 * SLACK_CHANNEL step needs (the D-32 checks in the editor).
 */
export interface RespondersResponse { staff: StaffResponder[]; people: CustomerPersonResponder[]; templateId: string | null; version: number; slackChannel?: ChannelState }
/** PROPOSED answer of the Responders writes: the new version of the list */
export interface RespondersWriteResult { contactId: string; version: number }
/**
 * PROPOSED (security review 권고 6): a change that would leave the customer UNREACHABLE is refused with 409
 * `WOULD_BE_UNREACHABLE` unless the request says the user was told (`confirmUnreachable: true`).
 */
export interface ResponderWriteOptions { version: number; confirmUnreachable?: boolean }
/** POST /customers/{id}/responders: an existing staff contact, or a new customer person */
export type AddResponderInput =
  | { contactId: string; role?: CustomerPersonRole }
  | { name: string; email?: string; phone?: string; role: CustomerPersonRole; extras?: ("APPROVER" | "PORTAL_USER")[] };

/** GET /rotations and the `rotations[]` of GET /oncall/now. Read-only on this screen. */
export interface RotationSummary {
  id: string;
  scope: "MSP" | "CUSTOMER";
  customerId?: string;
  name: string;
  /** `channels` is PROPOSED: the D-32 checks in the editor need to know whether the person on shift can be reached */
  onShift: { contactId: string; name: string; until: string; channels?: Partial<Record<ContactChannelKey, ChannelState>> } | null;
  next?: string | null;
}

/** GET /staff?q= (People) — the minimum the "add staff" picker needs */
export interface StaffSummary { contactId: string; name: string; title?: string; /** PROPOSED, as on responders */ channels?: Partial<Record<ContactChannelKey, ChannelState>> }

/**
 * One row of the Call order list. PROPOSED shape: the contract gives `customers[{id, name, style, plan, edited,
 * firstStep, steps[], responderCount}]` and says (§8.0) that the list also has a row per project/service with own
 * steps and a row for the asked node. `rows[]` is that list, already resolved.
 */
export interface CallOrderRow {
  /** "<customer>/<project>/<service>" slugs of the row's scope */
  key: string;
  org: OrgChain;
  level: ScopeLevelName;
  /** the row's scope has its own steps (customer rows: always) */
  own: boolean;
  inheritedFrom: LevelRef | null;
  style: PagingStyle;
  plan: PagingPlan;
  edited: boolean;
  steps: PagingPathStep[];
  repeatCount: number;
  responderCount: number;
  /** customer level only (Q-API-10) */
  health: { level: PagingHealth["level"]; problems: number; first?: string } | null;
}
export interface CallOrderListQuery { customer?: string; project?: string; service?: string; mine?: boolean; onlyProblems?: boolean }
/** GET /oncall/now */
export interface CallOrderListResponse { rotations: RotationSummary[]; rows: CallOrderRow[] }
