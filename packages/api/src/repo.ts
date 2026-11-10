/**
 * Persistence port of the console API. Every read takes the caller's ScopeFilter and must apply it inside the query
 * (`WHERE customerId IN (…)`), so "does not exist" and "not yours" cost the same and look the same (API-CONTRACT §2).
 * Production: Prisma. Tests/local: MemoryApiStore.
 */
import type {
  AuditInput, Contact, DeliveryLog, IncidentCommit, IncidentEventInput, IncidentRow, MaintenanceWindow, PagingConfig, PagingWorld, Severity, Source, SuppressionPolicy,
} from '@alarmops/core';
import type { ScopeFilter } from './auth.js';

export interface OrgNode { id: string; name: string; slug: string }
export interface ProjectNode extends OrgNode { customerId: string }
export interface ServiceNode extends OrgNode { customerId: string; projectId: string }
/** Customers, projects and services inside the scope — nothing else (out-of-scope nodes are absent, not zeroed). */
export interface OrgTree { customers: OrgNode[]; projects: ProjectNode[]; services: ServiceNode[] }

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

export interface ApiRepository {
  // ── org / scope ──
  orgTree(scope: ScopeFilter): Promise<OrgTree>;
  /** Open (TRIGGERED) incident counts per org position, inside the scope. Unmapped incidents are never included. */
  openIncidentCounts(scope: ScopeFilter): Promise<Array<{ customerId: string; projectId: string | null; serviceId: string | null; open: number }>>;
  /** Customers the session user is a Responder for (direct or via template). Computed from the user id only. */
  responderCustomerIds(userId: string): Promise<string[]>;
  contactIdForUser(userId: string): Promise<string | null>;
  userNames(userIds: string[]): Promise<Map<string, string>>;
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
  /** Insert (expectedVersion null) or replace `WHERE version = expected`. Returns the stored row (version bumped). */
  savePagingConfig(cfg: PagingConfig, expectedVersion: number | null, audit: AuditInput): Promise<PagingConfig | 'CONFLICT'>;
  deletePagingConfig(id: string, expectedVersion: number, audit: AuditInput): Promise<'OK' | 'CONFLICT'>;
  /** Any contact by id — used to tell CROSS_CUSTOMER from "unknown" when validating a step target. Never returned to the client. */
  getContact(contactId: string): Promise<Contact | null>;
  rotationOwner(rotationId: string): Promise<{ scope: 'MSP' | 'CUSTOMER'; customerId: string | null } | null>;
  /** Notify-only customer people for a path (ContactScope NOTIFY, all levels merged — DATA-MODEL ContactScope). */
  notifiedPeople(customerId: string, path: { projectId?: string | null; serviceId?: string | null }): Promise<NotifiedPerson[]>;

  // ── idempotency (API-CONTRACT §2 "멱등", 24h) ──
  getIdempotent(key: string, now: Date): Promise<StoredResponse | null>;
  putIdempotent(key: string, res: StoredResponse, expiresAt: Date): Promise<void>;
}
