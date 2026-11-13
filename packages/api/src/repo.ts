/**
 * Persistence port of the console API. Every read takes the caller's ScopeFilter and must apply it inside the query
 * (`WHERE customerId IN (…)`), so "does not exist" and "not yours" cost the same and look the same (API-CONTRACT §2).
 * Production: Prisma. Tests/local: MemoryApiStore.
 */
import type {
  AuditInput, Contact, Leave, Override, Rotation, DeliveryLog, IncidentCommit, IncidentEventInput, IncidentRow, MaintenanceWindow, PagingConfig, PagingWorld, Severity, Source, SuppressionPolicy,
} from '@alarmops/core';
import type { DigestData, PurgeLogEntry } from '@alarmops/core';
import type { UserInfo } from './audience.js';
import type { Role, ScopeFilter } from './auth.js';

export interface OrgNode { id: string; name: string; slug: string }
export interface CustomerNode extends OrgNode { status: CustomerStatusValue }
export interface ProjectNode extends OrgNode { customerId: string }
export interface ServiceNode extends OrgNode { customerId: string; projectId: string }
/** Customers, projects and services inside the scope — nothing else (out-of-scope nodes are absent, not zeroed). */
export interface OrgTree { customers: CustomerNode[]; projects: ProjectNode[]; services: ServiceNode[] }

export interface IncidentFilter {
  /** 'active' = TRIGGERED + ACKNOWLEDGED. */
  status?: 'active' | 'TRIGGERED' | 'ACKNOWLEDGED' | 'RESOLVED';
  severity?: Severity;
  source?: Source;
  /** Case-insensitive title search. */
  q?: string;
  /** Incidents whose frozen paging order contains this contact. */
  assigneeContactId?: string;
  /** Only unmapped-account incidents. */
  unmappedOnly?: boolean;
}

/** The scope part of a list request (customer/project/service slugs resolved to ids, or `mine`). null = no scope filter. */
export interface NodeFilter {
  /** One customer (and below), or the `mine` set. */
  customerIds: string[];
  projectId?: string;
  serviceId?: string;
  /** Unmapped-account incidents stay in the list (only for `mine`, INTERNAL). */
  includeUnmapped: boolean;
}

export interface StatusCounts { triggered: number; escalated: number; acknowledged: number; resolved24h: number; muted: number; open: number }
export interface OpenCounts { open: number; unmappedOpen: number; acknowledged: number }

export interface IncidentPage {
  rows: IncidentRow[];
  hasMore: boolean;
  /** Same basis as the list: scope + node filter + severity/source/q/assignee (not status) — known-bugs 9-5. */
  counts: StatusCounts;
  /** Scope + node filter only. */
  inside: OpenCounts;
  /** Scope only (what the caller could see without any filter). `all − inside` = "Outside this view". */
  all: OpenCounts;
  /** Active unmapped-account incidents by account. Empty unless scope.unmapped. */
  unmapped: Array<{ awsAccountId: string; alertCount: number }>;
}

export interface AlertMemberRow {
  id: string; fingerprint: string; title: string; status: 'FIRING' | 'ACKNOWLEDGED' | 'RESOLVED' | 'INSUFFICIENT_DATA'; severity: Severity;
  metricKey: string | null; resourceId: string | null; value: number | null; threshold: number | null; eventCount: number; lastEventAt: Date;
}

export interface UndoRecord {
  token: string;
  userId: string;
  action: 'ack' | 'resolve';
  expiresAt: Date;
  items: Array<{ id: string; versionAfter: number; prev: Pick<IncidentRow, 'status' | 'acknowledgedAt' | 'acknowledgedBy' | 'mttaSec'> }>;
}

export interface NotifiedPerson { contactId: string; name: string; scope: { level: 'CUSTOMER' | 'PROJECT' | 'SERVICE'; id: string; name: string } }

export interface StoredResponse { status: number; headers: Record<string, string>; body: unknown }
/** `fingerprint` binds the key to the request it was first used for (method + path + If-Match + body hash, R-5). */
export interface IdempotentEntry { fingerprint: string; res: StoredResponse }


/**
 * A console session's user as the store knows it (GET /me, and the adapter that turns a session into an AuthContext).
 * Only ACTIVE users are returned. `customerId` set = portal user of that customer; null = MSP staff.
 * `subScopes`: a portal user's PORTAL_USER grants on a project or service of its customer (narrowing, §8.0 rule 1).
 */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  customerId: string | null;
  role: Role;
  contactId: string | null;
  subScopes: Array<{ customerId: string; projectId?: string; serviceId?: string }>;
}

export type ResponderSourceKind = 'DIRECT' | 'TEMPLATE';
export interface ResponderEntry {
  contactId: string;
  role: 'PAGEABLE' | 'NOTIFY_ONLY';
  source: ResponderSourceKind;
  templateId: string | null;
  templateName: string | null;
  order: number;
}
/** ContactScope rows of the customer's own people (NOTIFY / APPROVER / PORTAL_USER), with the scope's name. */
export interface PersonScopeRow { contactId: string; scopeType: 'CUSTOMER' | 'PROJECT' | 'SERVICE'; scopeId: string; scopeName: string; role: 'NOTIFY' | 'APPROVER' | 'PORTAL_USER' }
/**
 * The Responders list of one customer. `version` is the list's optimistic-lock version (API-CONTRACT §8.3
 * "Responders 버전"): it goes up by one with every write through `writeResponders` and never restarts.
 */
export interface RespondersState { version: number; templateId: string | null; entries: ResponderEntry[]; scopes: PersonScopeRow[] }

export type ResponderOp =
  | { kind: 'add'; contactId: string; role: 'PAGEABLE' | 'NOTIFY_ONLY' }
  | { kind: 'create'; name: string; email: string | null; phone: string | null; role: 'PAGEABLE' | 'NOTIFY_ONLY'; extras: Array<'APPROVER' | 'PORTAL_USER'> }
  | { kind: 'role'; contactId: string; role: 'PAGEABLE' | 'NOTIFY_ONLY' }
  | { kind: 'remove'; contactId: string };
/**
 * 'CONFLICT': the list is no longer at `expectedVersion`. 'EXISTS': the contact is already a responder (add).
 * 'GONE': the contact is not a responder (role / remove).
 */
export type ResponderWriteOutcome = { contactId: string; version: number } | 'CONFLICT' | 'EXISTS' | 'GONE';

/** Rotations a caller may see (MSP ones + those of customers in the scope) with what decides who is on shift. */
export interface RotationsWorld { rotations: Rotation[]; overrides: Override[]; leaves: Leave[]; contacts: Map<string, Contact> }

// ── customer status / offboarding (D-42, D-43) ──
export type CustomerStatusValue = 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
export const OFFBOARD_STEP_KEYS = ['PAGING_STOPPED', 'ALARMS_DELETED', 'CUSTOMER_STACK_REMOVED', 'ACCOUNTS_DISABLED', 'BUS_ALLOWLIST_REMOVED'] as const;
export type OffboardStepKey = (typeof OFFBOARD_STEP_KEYS)[number];
export interface OffboardStep { state: 'DONE' | 'PENDING' | 'MANUAL'; at?: string; byUserId?: string; detail?: string; [extra: string]: unknown }
/**
 * `version` of the status: the number of 'CustomerStatus' audit rows of the customer (written in the same transaction as
 * each change, like the Responders version). A no-op write writes no audit row, so the version does not move.
 */
export interface CustomerStatusState { name: string; status: CustomerStatusValue; statusChangedAt: Date | null; version: number }
export interface OffboardingState {
  id: string; customerId: string; startedByUserId: string; reason: string; startedAt: Date; completedAt: Date | null;
  steps: Record<OffboardStepKey, OffboardStep>;
  /** OffboardResidual summed over the customer's sources (events that still arrive after TERMINATED). */
  residual: { lastEventAt: Date | null; count: number };
}
/** 'CONFLICT': not at `expectedVersion`. 'CUSTOMER_TERMINATED': TERMINATED never changes to another status. 'NOT_FOUND': no such customer. */
export type ChangeStatusOutcome =
  | 'CONFLICT' | 'CUSTOMER_TERMINATED' | 'NOT_FOUND'
  /** The row already has `to` (changed outside the API, e.g. by SQL, between the caller's read and this write): nothing was written. */
  | 'NOOP'
  | { status: CustomerStatusValue; statusChangedAt: Date; version: number; offboardingId: string | null; cloudAccountIds: string[] };
export type MarkStepOutcome = 'OK' | 'ALREADY_DONE' | 'NOT_FOUND' | 'NOT_ALLOWED';

// ── retention (D-45), export, digest (D-46) ──
export interface LegalHoldState { active: boolean; at: Date | null; byUserId: string | null; reason: string | null }
export interface RetentionView { name: string; status: CustomerStatusValue; statusChangedAt: Date | null; legalHold: LegalHoldState }
/** One incident of the history export. The columns the customer already owns; no people, no contact values. */
export interface ExportIncidentRow {
  number: number; id: string; title: string; severity: Severity; status: 'TRIGGERED' | 'ACKNOWLEDGED' | 'RESOLVED';
  triggeredAt: Date; acknowledgedAt: Date | null; resolvedAt: Date | null; mttaSec: number | null; mttrSec: number | null;
  memberCount: number; eventCount: number; accountIds: string[]; resourceTypes: string[]; pagingSuppressed: string | null;
}

export interface ApiRepository {
  // ── org / scope ──
  orgTree(scope: ScopeFilter): Promise<OrgTree>;
  /** Open (TRIGGERED) incident counts per org position, inside the scope. Unmapped incidents are never included. */
  openIncidentCounts(scope: ScopeFilter): Promise<Array<{ customerId: string; projectId: string | null; serviceId: string | null; open: number }>>;
  /** Customers the session user is a Responder for (direct or via template). Computed from the user id only. */
  responderCustomerIds(userId: string): Promise<string[]>;
  contactIdForUser(userId: string): Promise<string | null>;
  /** Name and kind of session users (INTERNAL staff or a customer's portal user) — the serializers decide what leaves. */
  userDirectory(userIds: string[]): Promise<Map<string, UserInfo>>;
  /** Slack channel for the customer is set and verified (paging health input). */
  slackChannelVerified(customerId: string): Promise<boolean>;
  /** Resource → org position, inside the scope. */
  findResource(scope: ScopeFilter, resourceId: string): Promise<{ id: string; name: string; customerId: string; projectId: string | null; serviceId: string | null } | null>;

  // ── incidents ──
  /** One consistent read (one transaction): page + counts, so `counts.open + outside.open = badge` holds (§8.0). */
  queryIncidents(scope: ScopeFilter, node: NodeFilter | null, filter: IncidentFilter, page: { limit: number; after?: { t: string; id: string } }, now: Date): Promise<IncidentPage>;
  findIncident(scope: ScopeFilter, id: string): Promise<IncidentRow | null>;
  incidentAlerts(scope: ScopeFilter, incidentId: string): Promise<AlertMemberRow[]>;
  incidentEvents(scope: ScopeFilter, incidentId: string, page: { limit: number; after?: { t: string; id: string } }): Promise<{ rows: Array<IncidentEventInput & { id: string }>; hasMore: boolean }>;
  incidentNotifications(scope: ScopeFilter, incidentId: string, page: { limit: number; after?: { t: string; id: string } }): Promise<{ rows: Array<DeliveryLog & { id: string }>; hasMore: boolean; total: number }>;
  commitIncident(c: IncidentCommit): Promise<IncidentRow | 'CONFLICT'>;
  loadPolicy(): Promise<SuppressionPolicy>;
  maintenanceWindows(customerId: string | null, at: Date): Promise<MaintenanceWindow[]>;
  saveUndo(rec: UndoRecord): Promise<void>;
  /** Removes and returns the record (single use). */
  takeUndo(token: string): Promise<UndoRecord | null>;

  // ── paging ──
  /** Configs + responders/rotations/overrides/leaves of one customer. Caller has already checked the customer is in scope. */
  pagingContext(customerId: string): Promise<{ configs: PagingConfig[]; world: PagingWorld }>;
  /**
   * Insert (expectedVersion null) or replace `WHERE version = expected`. Returns the stored row (version bumped).
   * Versions never restart (N-3): a row created again after a delete continues after the deleted row's last
   * version (soft delete or a version sequence per (customer, scope)), so an If-Match from before the delete can never match.
   */
  savePagingConfig(cfg: PagingConfig, expectedVersion: number | null, audit: AuditInput): Promise<PagingConfig | 'CONFLICT'>;
  deletePagingConfig(id: string, expectedVersion: number, audit: AuditInput): Promise<'OK' | 'CONFLICT'>;
  /** Any contact by id — used to tell CROSS_CUSTOMER from "unknown" when validating a step target. Never returned to the client. */
  getContact(contactId: string): Promise<Contact | null>;
  rotationOwner(rotationId: string): Promise<{ scope: 'MSP' | 'CUSTOMER'; customerId: string | null } | null>;
  /** Notify-only customer people for a path (ContactScope NOTIFY, all levels merged — DATA-MODEL ContactScope). */
  notifiedPeople(customerId: string, path: { projectId?: string | null; serviceId?: string | null }): Promise<NotifiedPerson[]>;

  // ── people (GET /me, Responders, rotations, staff) ──
  /** ACTIVE user by id, or null. Never takes anything from the request but the session's user id. */
  sessionPrincipal(userId: string): Promise<Principal | null>;
  /** Caller has already checked the customer is visible (and customer-wide). */
  respondersState(customerId: string): Promise<RespondersState>;
  /**
   * One transaction: the list must still be at `expectedVersion` (row lock on the customer), the change is applied,
   * the version goes up by one and `audit` is written. The audit row is what carries the version (SQL store).
   */
  writeResponders(customerId: string, expectedVersion: number, op: ResponderOp, audit: AuditInput): Promise<ResponderWriteOutcome>;
  /** MSP rotations + rotations of the customers in `scope` (CUSTOMER rotations only inside the scope). */
  rotationsWorld(scope: ScopeFilter): Promise<RotationsWorld>;
  /** Active MSP staff contacts (kind INTERNAL), name order. */
  staffContacts(): Promise<Contact[]>;

  // ── customer status / offboarding (D-43) ──
  /** Caller has already checked the customer is visible. */
  customerStatusState(customerId: string): Promise<CustomerStatusState | null>;
  /**
   * ONE transaction: lock the customer row, re-check version and status, set `status` + `statusChangedAt`, write `audit`
   * (targetType 'CustomerStatus' — it carries the version) and, when `to` is TERMINATED, create the CustomerOffboarding
   * (steps PAGING_STOPPED=DONE, ALARMS_DELETED=PENDING, the other three MANUAL). Returns the customer's CloudAccount ids
   * (one OFFBOARD_ACCOUNT command each) — the publish happens after this commit, never inside it.
   */
  changeCustomerStatus(customerId: string, expectedVersion: number, to: CustomerStatusValue, offboarding: { startedByUserId: string; reason: string } | null, audit: AuditInput): Promise<ChangeStatusOutcome>;
  offboardingState(customerId: string): Promise<OffboardingState | null>;
  /** MANUAL/PENDING → DONE under a row lock; DONE is never overwritten; ALARMS_DELETED only from MANUAL. completedAt when all steps are DONE. */
  markOffboardStepDone(customerId: string, key: OffboardStepKey, userId: string, detail: string | null, at: Date, audit: AuditInput): Promise<MarkStepOutcome>;
  /** CloudAccount ids of the customer (one OFFBOARD_ACCOUNT each). */
  cloudAccountIds(customerId: string): Promise<string[]>;
  /** Command publish failed after commit: ALARMS_DELETED (unless DONE) becomes MANUAL and `COMMAND_PUBLISH_FAILED: <ids>` is APPENDED to its detail (the engine's earlier detail stays). */
  recordOffboardPublishFailure(customerId: string, cloudAccountIds: string[], at: Date): Promise<void>;

  // ── retention (D-45) / export / digest (D-46) ──
  /** Caller has already checked the customer is visible. */
  retentionView(customerId: string): Promise<RetentionView | null>;
  /**
   * ONE transaction: lock the customer row; `hold` set -> legal hold on (reason/who/when), null -> off. Writes `audit` and a
   * RetentionPurgeLog row (LEGAL_HOLD_SET / LEGAL_HOLD_RELEASED, actor = the user). 'NOOP' = already in that state, nothing written.
   */
  setLegalHold(customerId: string, hold: { byUserId: string; reason: string; at: Date } | null, audit: AuditInput): Promise<'OK' | 'NOOP' | 'NOT_FOUND'>;
  purgeLog(customerId: string): Promise<PurgeLogEntry[]>;
  /** Number of incidents the export would contain. */
  countExportIncidents(customerId: string): Promise<number>;
  /** Keyset page ordered by `number`, strictly after `afterNumber`. Always `WHERE customerId = ?`. */
  exportIncidents(customerId: string, afterNumber: number, limit: number): Promise<ExportIncidentRow[]>;
  /** A write that has no store method of its own (the export is audited before it streams). */
  recordAudit(audit: AuditInput): Promise<void>;
  /** Suspended-customer incidents (pagingSuppressed = CUSTOMER_SUSPENDED, triggeredAt in [from, to)) and TERMINATED residual sources (lastAt in [from, to)). Only customers inside `scope` (B-1): residuals need the whole customer in scope, incidents follow the usual scope rule. */
  digestData(scope: ScopeFilter, from: Date, to: Date): Promise<DigestData>;

  // ── idempotency (API-CONTRACT §2 "멱등", 24h) ──
  getIdempotent(key: string, now: Date): Promise<IdempotentEntry | null>;
  /**
   * Store a response for replay. N-19: `owner` (the user id) may hold at most `maxPerOwner` live entries — in the
   * same statement the owner's expired entries are removed and, if still at the cap, the oldest one is dropped.
   */
  putIdempotent(key: string, entry: IdempotentEntry, expiresAt: Date, cap: { owner: string; maxPerOwner: number }): Promise<void>;
}
