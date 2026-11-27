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

// ── monitoring: resources and managed alarms (API-CONTRACT §8.5, D-16) ──
export type MonitoringStateValue = 'MONITORED' | 'NEEDS_REVIEW' | 'NOT_MONITORED' | 'DELETED';
export type AlarmStateValue = 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
export type ValueSourceValue = 'CODE' | 'MSP' | 'CUSTOMER' | 'CONSOLE' | 'TAG';
export const MONITORING_STATES: readonly MonitoringStateValue[] = ['MONITORED', 'NEEDS_REVIEW', 'NOT_MONITORED', 'DELETED'];
/** A Resource with its place in the org tree (through its CloudAccount's service) and what the monitoring API needs of its account. */
export interface ResourceRecord {
  id: string; customerId: string; projectId: string | null; serviceId: string | null;
  cloudAccountId: string; awsAccountId: string; accountAlias: string | null; alarmWriterEnabled: boolean; tagWriterEnabled: boolean;
  region: string; resourceType: string; resourceKey: string; name: string | null; tags: Record<string, string>;
  monitoringState: MonitoringStateValue; needsReviewSince: Date | null; needsReviewReason: string | null; lastSeenAt: Date;
  alarmCount: number;
  /** Customer ACTIVE, account not disabled, connection not purged (D-43). Monitoring commands are refused otherwise. */
  accountActive: boolean;
}
export interface ManagedAlarmRecord {
  id: string; customerId: string; projectId: string | null; serviceId: string | null;
  resourceId: string; resourceName: string; resourceType: string; region: string; metricKey: string; alarmName: string;
  severity: Severity; threshold: number; thresholdSource: ValueSourceValue; evalM: number; evalN: number; comparison: string; statistic: string; period: number;
  state: AlarmStateValue | null; driftStatus: 'IN_SYNC' | 'DRIFTED' | 'MISSING' | 'EXTERNAL_CHANGE'; lastSyncedAt: Date | null;
}
export interface ResourceFilter { type?: string; monitoringState?: MonitoringStateValue }
export interface ManagedAlarmFilter { resourceId?: string; state?: AlarmStateValue; severity?: Severity }
/** Resources that need review and alarms in ALARM, inside the caller's scope but outside the node filter. */
export interface MonitoringOutside { needsReview: number; inAlarm: number }
export interface MonitoringPage<T> { rows: T[]; hasMore: boolean; outside: MonitoringOutside | null }
/** Cursor of both lists: sort key (C collation) + id. */
export interface MonitoringCursor { k: string; id: string }

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
export interface RespondersState { version: number; templateId: string | null; templateName: string | null; entries: ResponderEntry[]; scopes: PersonScopeRow[] }

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


// ── Responder templates (API-CONTRACT §8.3) ──
export interface ResponderTemplateView {
  id: string; name: string; version: number; updatedAt: Date; updatedBy: string | null;
  members: Array<{ contactId: string; name: string }>;
  /** Customers that use the template, TERMINATED ones left out. */
  customers: Array<{ id: string; name: string }>;
}
export interface TemplateProposal { name: string; members: string[] }
/** Everything the impact of a change depends on (read in the same transaction as the write). */
export interface TemplateImpactInput {
  templateId: string; version: number; name: string; members: string[];
  /** Display names of every contact id named in `members` (current or proposed). */
  names: Record<string, string>;
  customers: Array<{
    id: string; name: string;
    responders: Array<{ contactId: string; source: ResponderSourceKind; templateId: string | null }>;
    /** PERSON steps of the customer's call orders that name one of the template people; `stepIndex` is 1-based. */
    namedSteps: Array<{ contactId: string; stepIndex: number }>;
    /** What the call-order health and the send limits (D-64) are computed from; the store fills it. */
    paging?: TemplatePaging;
  }>;
}
/** The inputs of `pagingHealth` / `sendCapViolation` for one customer. */
export interface TemplatePaging { configs: PagingConfig[]; world: PagingWorld; slackVerified: boolean }
/** D-64: a change that is refused. UNREACHABLE → 409 WOULD_BE_UNREACHABLE; the other two → 422 (D-38). */
export type TemplateBlockReason = 'UNREACHABLE' | 'RESPONDER_LIMIT_EXCEEDED' | 'SEND_CAP_EXCEEDED';
export interface TemplateBlocking { customerId: string; reason: TemplateBlockReason }
export interface TemplateEffect { kind: 'JOINS' | 'LEAVES' | 'STAYS_DIRECT' | 'ALREADY_DIRECT' | 'STEP_NAMES'; contactId: string; name: string; stepIndex?: number }
export interface TemplatePlan {
  customers: Array<{ id: string; name: string; effects: TemplateEffect[] }>;
  totals: { customers: number; affected: number; joins: number; leaves: number; warnings: number };
  previewHash: string; added: string[]; removed: string[];
}
export interface TemplateCreate { name: string; members: string[]; actorId: string; at: Date }
export interface TemplateUpdate { id: string; expectedVersion: number; proposal: TemplateProposal; previewHash: string; actorId: string; at: Date }
/** 'CONFLICT': version moved. 'STALE': the preview hash no longer matches what would happen now. */
export type TemplateUpdateOutcome = { view: ResponderTemplateView; affected: number } | { blocking: TemplateBlocking[] } | 'NOT_FOUND' | 'CONFLICT' | 'STALE' | 'NAME_EXISTS' | 'BAD_MEMBER' | 'BUSY';

/** Attach / detach / switch the template of ONE customer (D-64). `from`/`to`: null = no template. */
/** `inactive`: the members that are not active staff now (11/27: attaching skips them; they are listed in the preview and response). */
export interface TemplateRef { id: string; name: string; version: number; members: string[]; inactive?: string[] }
export interface TemplateAttachInput {
  customer: {
    id: string; name: string; status: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED'; templateId: string | null; version: number;
    responders: Array<{ contactId: string; source: ResponderSourceKind; templateId: string | null }>;
    namedSteps: Array<{ contactId: string; stepIndex: number }>;
    paging?: TemplatePaging;
  };
  from: TemplateRef | null; to: TemplateRef | null;
  names: Record<string, string>;
}
export interface TemplateAttachPlan {
  effects: TemplateEffect[]; joins: string[]; leaves: string[]; retarget: string[];
  /** New-template members without a row here that are inactive staff: not added (11/27). Name order. */
  skippedInactive: Array<{ contactId: string; name: string }>;
  totals: { joins: number; leaves: number; warnings: number }; previewHash: string;
}
export interface TemplateAttachWrite { customerId: string; toTemplateId: string | null; expectedVersion: number; previewHash: string; actorId: string; at: Date }
export type TemplateAttachOutcome =
  | { version: number; templateId: string | null; joins: number; leaves: number; skippedInactive: Array<{ contactId: string; name: string }> }
  | { blocking: TemplateBlocking[] }
  | 'NOT_FOUND' | 'NO_TEMPLATE' | 'TERMINATED' | 'CONFLICT' | 'STALE' | 'BUSY';

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

// ── contact reveal (D-35) ──
export type RevealChannelValue = 'PHONE' | 'EMAIL' | 'SLACK';
export type RevealModeValue = 'NORMAL' | 'EMERGENCY';
/** Per user, counted from the ContactRevealLog rows themselves (so the limit holds across instances). */
export interface RevealLimits { perMinute: number; emergencyPerHour: number }
export interface RevealWrite {
  actorUserId: string; actorRole: string; contactId: string; contactName: string; customerId: string | null;
  channel: RevealChannelValue; mode: RevealModeValue; reason: string | null; notifiedContactIds: string[]; requestId: string | null;
  limits: RevealLimits;
}
/** `at` is the store's clock (R-14). `retryAfterSec` of a refusal: when the oldest row in the window leaves it (1 when another request of the same user holds the lock — nothing waits). */
export type RevealWriteOutcome = { ok: true; id: string; at: Date } | { ok: false; retryAfterSec: number };
export interface RevealLogFilter {
  /** null = every customer (ADMIN; also rows without a customer). A list = only those customers (may be empty). */
  customerIds: readonly string[] | null;
  mode?: RevealModeValue; actorUserId?: string; contactId?: string; from?: Date; to?: Date;
  after?: { t: string; id: string }; limit: number;
}
/** One ContactRevealLog row with the names the review list shows. Never a contact value. */
export interface RevealLogRow {
  id: string; at: Date; mode: RevealModeValue; actorUserId: string; actorName: string; actorRole: string; contactId: string; contactName: string;
  customer: { id: string; name: string; slug: string } | null; channel: RevealChannelValue; reason: string | null;
  notified: Array<{ contactId: string; name: string }>;
}


// ── onboarding: customers, accounts, contacts, verification (API-CONTRACT §8.4, D-07, D-37) ──
export type RoleStatusValue = 'UNKNOWN' | 'OK' | 'DENIED' | 'MISSING';
export type EnvironmentValue = 'PRD' | 'STG' | 'DEV';
export interface CloudAccountRecord {
  id: string; customerId: string; serviceId: string | null; awsAccountId: string; alias: string | null; environment: EnvironmentValue | null; regions: string[];
  /** Server-generated at creation, never accepted from a client. ADMIN responses only; never in an audit row or a log. */
  externalId: string;
  readerRoleArn: string; eventForwarderRoleArn: string; alarmWriterRoleArn: string | null; tagWriterRoleArn: string | null; remediatorRoleArn: string | null;
  alarmWriterEnabled: boolean; tagWriterEnabled: boolean; remediatorEnabled: boolean;
  readerStatus: RoleStatusValue; eventForwarderStatus: RoleStatusValue; alarmWriterStatus: RoleStatusValue; tagWriterStatus: RoleStatusValue; remediatorStatus: RoleStatusValue;
  lastCheckedAt: Date | null;
  /** First / last event received for this account: the stored columns, else the RawEvent rows of this customer + account. */
  firstEventAt: Date | null; lastEventAt: Date | null;
  stackVersion: string | null; disabled: boolean; connectionPurged: boolean; createdAt: Date;
}
export interface NewAccount {
  awsAccountId: string; alias: string | null; environment: EnvironmentValue | null; regions: string[]; serviceId: string | null; externalId: string;
  readerRoleArn: string; eventForwarderRoleArn: string; alarmWriterRoleArn: string | null; tagWriterRoleArn: string | null; remediatorRoleArn: string | null;
  alarmWriterEnabled: boolean; tagWriterEnabled: boolean; remediatorEnabled: boolean;
}
/** `undefined` = unchanged. */
export interface AccountPatch {
  alias?: string | null; environment?: EnvironmentValue | null; regions?: string[]; serviceId?: string | null;
  alarmWriterEnabled?: boolean; tagWriterEnabled?: boolean; remediatorEnabled?: boolean;
  alarmWriterRoleArn?: string | null; tagWriterRoleArn?: string | null; remediatorRoleArn?: string | null;
}
export type AccountWriteOutcome = CloudAccountRecord | 'NOT_FOUND' | 'NO_SUCH_SERVICE' | 'CUSTOMER_TERMINATED' | 'EXISTS';
export type AuditTemplate = Omit<AuditInput, 'customerId' | 'targetId'>;

export type VerifyChannelValue = 'EMAIL' | 'SMS' | 'SLACK';
/** A contact as the onboarding API reads it: the paging contact plus how/when each channel was verified. */
export type ContactRow = Contact;
export interface ContactScopeInfo { contactId: string; scopeType: 'CUSTOMER' | 'PROJECT' | 'SERVICE'; scopeId: string; role: 'NOTIFY' | 'APPROVER' | 'PORTAL_USER' }
/** Latest link per (contact, channel): used = it verified the channel. */
export interface VerificationLink { contactId: string; channel: VerifyChannelValue; sentAt: Date; expiresAt: Date; usedAt: Date | null }
export interface ContactsWorld {
  contacts: ContactRow[];
  scopes: ContactScopeInfo[];
  responders: Array<{ customerId: string; contactId: string; role: 'PAGEABLE' | 'NOTIFY_ONLY' }>;
  links: VerificationLink[];
}
export interface NewContact { kind: 'INTERNAL' | 'CUSTOMER'; customerId: string | null; name: string; email: string | null; phone: string | null; slackUserId: string | null }
/** `undefined` = unchanged. Changing a value clears that channel's verification (the store does it, in the same statement). */
export interface ContactPatch { name?: string; email?: string | null; phone?: string | null; slackUserId?: string | null; active?: boolean }
export type ContactWriteOutcome = ContactRow | 'NOT_FOUND' | 'SLACK_EXISTS';
/** `destinationHash`: SHA-256 of channel + lower-case address — kept in `ChannelVerification.note` of a link row so sends per address can be counted without storing the address (follow-up: a real column). */
export interface VerificationIssue { customerId: string | null; contactId: string; channel: VerifyChannelValue; tokenHash: string; sentAt: Date; expiresAt: Date; destinationHash: string }
/** Send limits per hour, counted from stored rows (so they hold across instances). `cooldownSec`: same contact + channel. */
export interface VerificationLimits { cooldownSec: number; perCustomerHour: number; perDestinationHour: number }
export type IssueOutcome = 'OK' | { cooling: number } | { capped: 'CUSTOMER' | 'DESTINATION'; retryAfterSec: number };
export interface VerificationTaken { contactId: string; customerId: string | null; channel: VerifyChannelValue; tokenHash: string }

// ── users (API-CONTRACT §8.4 /users, D-55) ──
export type UserStatusValue = 'PENDING' | 'ACTIVE' | 'DISABLED';
/** A console user as the users API reads it. `kind` follows from `customerId` (null = MSP staff, all customers; set = portal user of that customer). The Google `sub` itself never leaves the store: only whether one is bound. */
export interface UserRecord {
  id: string; email: string; name: string; kind: 'INTERNAL' | 'CUSTOMER'; customerId: string | null; role: Role; status: UserStatusValue;
  googleBound: boolean; lastLoginAt: Date | null; createdAt: Date;
}
export interface UserFilter { kind?: 'INTERNAL' | 'CUSTOMER'; customerId?: string; status?: UserStatusValue; role?: Role; q?: string }
/** `email` is already trimmed and lower-case. A CUSTOMER user is always VIEWER. */
export interface NewUser { email: string; name: string; customerId: string | null; role: Role; status: UserStatusValue }
/** `undefined` = unchanged. `customerId` (CUSTOMER users only) moves a portal user to another customer. `clearGoogleSub`: the next sign-in binds again. */
export interface UserPatch { role?: Role; status?: UserStatusValue; customerId?: string; clearGoogleSub?: boolean }
/**
 * 'LAST_ADMIN': the change would leave no ACTIVE ADMIN with the all-customer range. 'NO_SUCH_CUSTOMER': unknown or TERMINATED customer.
 * 'CONTACT_LINKED': a portal user with a linked Contact cannot move to another customer. 'EMAIL_EXISTS': e-mail already used by another user.
 */
export type UserWriteOutcome = UserRecord | 'NOT_FOUND' | 'LAST_ADMIN' | 'NO_SUCH_CUSTOMER' | 'CONTACT_LINKED' | 'EMAIL_EXISTS';
export type EnrolOutcome =
  | { user: UserRecord; created: boolean }
  /** Nothing created: DOMAIN_UNKNOWN (no customer has the domain), AMBIGUOUS (more than one), CUSTOMER_INACTIVE, FREE_MAIL, STAFF_EMAIL (an INTERNAL user has the address), OTHER_CUSTOMER (a portal user of another customer has it), USER_INACTIVE (a DISABLED or PENDING user of that customer has it: nothing is created or changed), INVALID_EMAIL. */
  | { refused: 'DOMAIN_UNKNOWN' | 'AMBIGUOUS' | 'CUSTOMER_INACTIVE' | 'FREE_MAIL' | 'STAFF_EMAIL' | 'OTHER_CUSTOMER' | 'USER_INACTIVE' | 'INVALID_EMAIL' };
/** 'bound': the user had no Google account, now has (audited). 'ok': the same one. 'mismatch': another one is bound; nothing changed, a `user.google_mismatch` audit row (reason code, no e-mail) was written. */
export type BindGoogleOutcome = 'bound' | 'ok' | 'mismatch' | 'NOT_FOUND';

// ── wizard: customer profile, projects, services (API-CONTRACT §8.4, #69) ──
export interface CustomerProfile { id: string; name: string; slug: string; status: CustomerStatusValue; loginDomains: string[]; createdAt: Date }
export interface ProjectRecord { id: string; customerId: string; name: string; slug: string; serviceCount: number }
export interface ServiceRecord { id: string; customerId: string; projectId: string; name: string; slug: string }
/** `undefined` = unchanged. The slug never changes (D-33). */
export interface CustomerProfilePatch { name?: string; loginDomains?: string[] }
export type OrgWriteOutcome<T> = T | 'NOT_FOUND' | 'NAME_EXISTS' | 'SLUG_EXISTS' | 'CUSTOMER_TERMINATED';
export type CustomerUpdateOutcome = CustomerProfile | 'NOT_FOUND' | 'NAME_EXISTS' | 'DOMAIN_EXISTS' | 'CUSTOMER_TERMINATED';

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
  /**
   * Display names of MSP staff (User.customerId IS NULL) only, for 'who did it' fields (legal hold, purge log, offboarding).
   * Never email or phone. Absent from the map: unknown, a portal user, or scrubbed by D-45 retention (callers answer null).
   * Contract (security review, record-user-names): pass ONLY ids read from rows the caller has already authorised and
   * scoped (e.g. legalHold.byUserId, purge-log actor, offboarding step byUserId). Never ids from a request body or query:
   * this method does no scope check itself and would become a staff-name enumeration oracle.
   */
  staffNames(userIds: string[]): Promise<Map<string, string>>;
  /** Slack channel for the customer is set and verified (paging health input). */
  slackChannelVerified(customerId: string): Promise<boolean>;
  /** Resource → org position, inside the scope. */
  findResource(scope: ScopeFilter, resourceId: string): Promise<{ id: string; name: string; customerId: string; projectId: string | null; serviceId: string | null } | null>;

  // ── monitoring (API-CONTRACT §8.5) ──
  /** Resources inside the scope (+ node filter), sorted by name then id. `outside` is null without a node filter. */
  queryResources(scope: ScopeFilter, node: NodeFilter | null, f: ResourceFilter, page: { limit: number; after?: MonitoringCursor }): Promise<MonitoringPage<ResourceRecord>>;
  /** One resource and its managed alarms; the scope is in the query, so "unknown" and "not yours" are the same null. */
  findResourceDetail(scope: ScopeFilter, resourceId: string): Promise<{ resource: ResourceRecord; alarms: ManagedAlarmRecord[] } | null>;
  queryManagedAlarms(scope: ScopeFilter, node: NodeFilter | null, f: ManagedAlarmFilter, page: { limit: number; after?: MonitoringCursor }): Promise<MonitoringPage<ManagedAlarmRecord>>;

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
  /** Responder templates, name order. MSP-level (no scope): the API only calls these for staff who see every customer. */
  listResponderTemplates(): Promise<ResponderTemplateView[]>;
  getResponderTemplate(id: string): Promise<ResponderTemplateView | null>;
  /** The inputs of `planTemplateChange` for a template and a proposed member list; null when the template does not exist. */
  responderTemplateImpactInput(id: string, proposedMembers: string[]): Promise<TemplateImpactInput | null>;
  /** One transaction: template + members + `audit` (MSP-level row). 'BAD_MEMBER': not an active staff contact. */
  createResponderTemplate(t: TemplateCreate, audit: AuditInput): Promise<ResponderTemplateView | 'NAME_EXISTS' | 'BAD_MEMBER'>;
  /**
   * One transaction: lock the template, check the version, re-read the impact INSIDE the transaction, compare its hash with
   * `previewHash`, then replace members, add/remove the customers' template rows, bump the version, write BulkChange
   * (TEMPLATE_UPDATE) and the audit rows (`audit` template for the MSP-level row, one `responder_template.apply` row per changed customer).
   * Customer Responders versions do not move (their audit rows have another targetType).
   */
  updateResponderTemplate(u: TemplateUpdate, audit: AuditInput): Promise<TemplateUpdateOutcome>;
  /**
   * D-64. Inputs of `planTemplateAttach` for a customer and the template it should use (null = none). null: no such customer.
   * 'NO_TEMPLATE': `toTemplateId` names no template.
   */
  customerTemplateAttachInput(customerId: string, toTemplateId: string | null): Promise<TemplateAttachInput | 'NO_TEMPLATE' | null>;
  /**
   * D-64, one transaction: lock the template row(s) (id order) THEN the customer row (the lock order of updateResponderTemplate), refuse a
   * TERMINATED customer, check the Responders version, re-read the inputs, compare the hash, refuse a blocking change, then set
   * `responderTemplateId`, add/remove/retarget the template rows and write ONE customer audit row (targetType 'Responders': the version moves).
   * `audit.customerId` must be `customerId`; `action`/`before`/`after` are filled by the store from the plan.
   * 'BUSY': a deadlock, serialization failure, lock/statement timeout or a foreign-key race — nothing was written.
   */
  setCustomerTemplate(w: TemplateAttachWrite, audit: AuditInput): Promise<TemplateAttachOutcome>;
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

  // ── contact reveal (D-35) ──
  /** Customers this CONTACT is a Responder of (direct or via template). */
  responderCustomerIdsOfContact(contactId: string): Promise<string[]>;
  /** Active ADMIN staff (MSP users with a contact) — the emergency-reveal notice goes to them when no primary Responder can be named (Q-API-14). */
  adminStaff(): Promise<Array<{ contactId: string; name: string }>>;
  /**
   * ONE transaction: take the actor's lock, count the actor's rows in the window (minute; for EMERGENCY also the hour),
   * refuse when at the limit, else INSERT the ContactRevealLog row and the AuditLog row (`contact.reveal`). Anything
   * that fails throws and nothing is written: the caller must not hand out the value then.
   */
  recordReveal(w: RevealWrite): Promise<RevealWriteOutcome>;
  /** Newest first (at, id), one more than `limit` is NOT fetched: `hasMore` says whether there is another page. */
  revealLog(f: RevealLogFilter): Promise<{ rows: RevealLogRow[]; hasMore: boolean }>;


  // ── onboarding: customers and accounts (D-07) ──
  /**
   * Customer + AuditLog (`audit` without customerId/targetId: the store fills in the new id) in one transaction.
   * 'NAME_EXISTS' / 'SLUG_EXISTS' / 'DOMAIN_EXISTS' (a login domain already belongs to another customer): nothing written.
   */
  createCustomer(c: { name: string; slug: string; loginDomains: string[] }, audit: AuditTemplate): Promise<{ id: string; createdAt: Date } | 'NAME_EXISTS' | 'SLUG_EXISTS' | 'DOMAIN_EXISTS'>;
  /** Accounts of one customer (caller has checked the customer is visible and customer-wide). */
  listAccounts(customerId: string): Promise<CloudAccountRecord[]>;
  /** One account if its customer is inside `scope` — the scope is in the query, so "unknown" and "not yours" are the same null. */
  findAccount(scope: ScopeFilter, accountId: string): Promise<CloudAccountRecord | null>;
  /** ONE transaction: row + audit. 'EXISTS' = the AWS account id is registered (any customer); 'NO_SUCH_SERVICE' = serviceId is not a service of THIS customer; 'CUSTOMER_TERMINATED'. */
  createAccount(customerId: string, a: NewAccount, audit: AuditTemplate): Promise<AccountWriteOutcome>;
  /** `WHERE id = ? AND customerId = ?`. Refused for a TERMINATED customer and for a purged account. */
  updateAccount(customerId: string, accountId: string, patch: AccountPatch, audit: AuditTemplate): Promise<AccountWriteOutcome>;
  /**
   * ATOMIC check-then-record of the CHECK_CONNECTION cooldown: one transaction (lock per account) looks for an `account.check`
   * audit row newer than `cooldownSec` and, if none, writes `audit` as that row. 'OK' = reserved (publish now); else seconds to wait.
   */
  reserveAccountCheck(customerId: string, accountId: string, now: Date, cooldownSec: number, audit: AuditTemplate): Promise<'OK' | { retryAfterSec: number }>;
  /** Deletes only an account that has no Resource and no ManagedAlarm rows (nothing of ours in the customer's AWS); else 'IN_USE'. */
  deleteAccount(customerId: string, accountId: string, audit: AuditTemplate): Promise<'OK' | 'NOT_FOUND' | 'IN_USE' | 'CUSTOMER_TERMINATED'>;

  // ── onboarding: contacts and verification (D-29, D-37) ──
  /** `Customer.portalGrants` (`contacts`, `silences`, `channels`): what a portal user of this customer may write. */
  portalGrants(customerId: string): Promise<string[]>;
  /** Contacts the caller may list: CUSTOMER contacts of `customerIds` ('*' = every customer) and, when `staff`, INTERNAL ones (all of them for '*', else only those who are Responders of `customerIds`) — plus their scopes, responder rows and latest verification links. */
  contactsWorld(customerIds: readonly string[] | '*', staff: boolean): Promise<ContactsWorld>;
  /**
   * One contact inside the caller's range; the range is in the query. A CUSTOMER contact: its customer is in `customerIds`.
   * An INTERNAL (staff) contact: `staff` and either `customerIds` is '*' or the contact is a Responder of one of `customerIds`
   * (read-only: `forWrite` makes an INTERNAL contact visible only when `customerIds` is '*').
   */
  findContact(customerIds: readonly string[] | '*', staff: boolean, contactId: string, forWrite?: boolean): Promise<{ contact: ContactRow; links: VerificationLink[]; responderCustomerIds: string[] } | null>;
  createContact(c: NewContact, audit: AuditTemplate): Promise<ContactWriteOutcome>;
  /** `WHERE id = ? AND customerId IS NOT DISTINCT FROM ?` (the customer of the contact as the caller saw it). */
  updateContact(contactId: string, customerId: string | null, patch: ContactPatch, audit: AuditTemplate): Promise<ContactWriteOutcome>;
  /** 'IN_USE': the contact is a Responder, a rotation member, named in a step, or a login user. */
  deleteContact(contactId: string, customerId: string | null, audit: AuditTemplate): Promise<'OK' | 'NOT_FOUND' | 'IN_USE'>;
  /** Stores only the token HASH. 'COOLING' (with seconds) when this contact + channel got a link less than `cooldownSec` ago: nothing written. */
  issueVerification(v: VerificationIssue, limits: VerificationLimits): Promise<IssueOutcome>;
  /** AuditLog rows of this actor + action for this customer since `since` (a DB count: the caps hold across instances). */
  countAudits(customerId: string, actorId: string, action: string, since: Date): Promise<number>;
  /** The sender failed: take the unused link back so no valid token exists for a message that was never sent. */
  discardVerification(tokenHash: string): Promise<void>;
  /** A person (ADMIN) states the channel is verified: sets the channel's verified time + via `admin:<name>`, writes a ChannelVerification history row (already used) and `audit`. */
  markVerifiedManually(contactId: string, customerId: string | null, channel: VerifyChannelValue, via: string, note: string | null, now: Date, audit: AuditTemplate): Promise<'OK' | 'NOT_FOUND'>;
  /**
   * ONE transaction: the link with this hash, unused and not expired at `now`, is marked used and the contact's channel
   * becomes verified (via `link`); `audit` is written. null = unknown, used or expired (no difference).
   */
  takeVerification(tokenHash: string, now: Date, audit: AuditTemplate): Promise<VerificationTaken | null>;
  /** Read-only: is a link with this hash pending (unused, not expired, contact active)? Changes nothing. */
  peekVerification(tokenHash: string, now: Date): Promise<{ channel: VerifyChannelValue } | null>;

  // ── wizard: customer profile, projects, services (#69). Reads take the scope and apply it inside the query; writes are `WHERE customerId = ?`. ──
  listCustomers(scope: ScopeFilter): Promise<CustomerProfile[]>;
  findCustomer(scope: ScopeFilter, customerId: string): Promise<CustomerProfile | null>;
  /** ONE transaction: row + audit. Name unique case-insensitively; a login domain may belong to one customer only. Refused for a TERMINATED customer. */
  updateCustomer(customerId: string, patch: CustomerProfilePatch, audit: AuditTemplate): Promise<CustomerUpdateOutcome>;
  /** ACTIVE portal users of the customer whose e-mail address is in one of `domains` (exact domain). Counts only; read before a login domain is removed. */
  countPortalUsersInDomains(customerId: string, domains: readonly string[]): Promise<number>;
  /** Caller has checked the customer is visible and customer-wide. */
  listProjects(customerId: string): Promise<ProjectRecord[]>;
  /** The project if its customer is inside `scope` (in the query). */
  findProject(scope: ScopeFilter, projectId: string): Promise<ProjectRecord | null>;
  createProject(customerId: string, p: { name: string; slug: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ProjectRecord>>;
  updateProject(customerId: string, projectId: string, patch: { name: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ProjectRecord>>;
  /** Caller has found the project through `findProject` (scope checked). */
  listServices(customerId: string, projectId: string): Promise<ServiceRecord[]>;
  findService(scope: ScopeFilter, serviceId: string): Promise<ServiceRecord | null>;
  createService(customerId: string, projectId: string, sv: { name: string; slug: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ServiceRecord>>;
  updateService(customerId: string, serviceId: string, patch: { name: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ServiceRecord>>;

  // ── users (D-55) ──
  /** All users matching the filter (ADMIN with the all-customer range only: the caller checked), name order. */
  listUsers(f: UserFilter): Promise<UserRecord[]>;
  findUser(userId: string): Promise<UserRecord | null>;
  /** ONE transaction: row + audit (`audit` without customerId/targetId: the store fills them). 'EMAIL_EXISTS' (unique, case-insensitive), 'NO_SUCH_CUSTOMER'. */
  createUser(n: NewUser, audit: AuditTemplate): Promise<UserRecord | 'EMAIL_EXISTS' | 'NO_SUCH_CUSTOMER'>;
  /** ONE transaction: the ACTIVE all-range ADMIN rows are locked, the last-admin rule is re-checked on the locked rows, the change and `audit` are written. */
  updateUser(userId: string, patch: UserPatch, audit: AuditTemplate): Promise<UserWriteOutcome>;
  /** Sets `lastLoginAt` (no audit row; the console calls it after a successful sign-in). No-op for an unknown id. */
  touchLastLogin(userId: string, at: Date): Promise<void>;
  /** Login-domain enrolment (D-55 b). See EnrolOutcome. Idempotent and safe under parallel calls: one row per e-mail. */
  enrolPortalUserByDomain(email: string, at: Date): Promise<EnrolOutcome>;
  /** Binds the Google account id of a sign-in to the user (atomic: the first binder wins). See BindGoogleOutcome. */
  bindGoogleSub(userId: string, sub: string, at: Date): Promise<BindGoogleOutcome>;

  // ── idempotency (API-CONTRACT §2 "멱등", 24h) ──
  getIdempotent(key: string, now: Date): Promise<IdempotentEntry | null>;
  /**
   * Store a response for replay. N-19: `owner` (the user id) may hold at most `maxPerOwner` live entries — in the
   * same statement the owner's expired entries are removed and, if still at the cap, the oldest one is dropped.
   */
  putIdempotent(key: string, entry: IdempotentEntry, expiresAt: Date, cap: { owner: string; maxPerOwner: number }): Promise<void>;
}
