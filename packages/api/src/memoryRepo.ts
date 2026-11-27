/**
 * In-memory ApiRepository on top of the tick store, so the API and the tick see one world.
 * Scope is applied inside every read, the same way the SQL adapter must do it. Tests and local runs only.
 */
import { MemoryTickStore, incidentMute, type DigestData, type PurgeLogEntry, type RetentionStage, parseSnapshot, type AuditInput, type Contact, type IncidentRow, type PagingConfig, type Severity } from '@alarmops/core';
import { inScope, nodeVisible, seesCustomer, type Role, type ScopeFilter } from './auth.js';
import { emailDomain, normalizeEmail } from './usersApi.js';
import { isFreeMail } from './onboardingApi.js';
import { attachBlocking, planTemplateAttach, planTemplateChange, templateBlocking } from './templatesApi.js';
import type { ResponderTemplateView, TemplateAttachInput, TemplateAttachOutcome, TemplateAttachWrite, TemplateCreate, TemplateImpactInput, TemplatePaging, TemplateRef, TemplateUpdate, TemplateUpdateOutcome } from './repo.js';
import type { UserInfo } from './audience.js';
import type { AlarmStateValue, ManagedAlarmFilter, ManagedAlarmRecord, MonitoringCursor, MonitoringOutside, MonitoringPage, MonitoringStateValue, ResourceFilter, ResourceRecord, ValueSourceValue } from './repo.js';
import type { CustomerProfile, CustomerProfilePatch, CustomerUpdateOutcome, OrgWriteOutcome, ProjectRecord, ServiceRecord, BindGoogleOutcome, EnrolOutcome, NewUser, UserFilter, UserPatch, UserRecord, UserWriteOutcome } from './repo.js';
import type { AccountPatch, AccountWriteOutcome, AuditTemplate, CloudAccountRecord, ContactPatch, ContactScopeInfo, ContactWriteOutcome, ContactsWorld, NewAccount, NewContact, VerificationIssue, VerificationLimits, IssueOutcome, VerificationLink, VerificationTaken, VerifyChannelValue, ExportIncidentRow, RetentionView, RevealLogFilter, RevealLogRow, RevealWrite, RevealWriteOutcome } from './repo.js';
import { OFFBOARD_STEP_KEYS, type ChangeStatusOutcome, type CustomerStatusState, type CustomerStatusValue, type MarkStepOutcome, type OffboardStepKey, type OffboardingState, type Principal, ResponderOp, ResponderWriteOutcome, RespondersState, RotationsWorld, AlertMemberRow, ApiRepository, IdempotentEntry, IncidentFilter, IncidentPage, NodeFilter, NotifiedPerson, OpenCounts, StatusCounts, UndoRecord } from './repo.js';

/** Seed rows of the Monitoring API (memory store). The account is the tick store's account (`awsAccountId`); org position and capability flags are derived from it. */
export interface MemoryResourceSeed {
  id: string; customerId: string; awsAccountId: string; region: string; resourceType: string; resourceKey: string; name: string | null; tags: Record<string, string>;
  monitoringState: MonitoringStateValue; needsReviewSince: Date | null; needsReviewReason: string | null; lastSeenAt: Date;
}
export interface MemoryAlarmSeed {
  id: string; resourceId: string; metricKey: string; alarmName: string; severity: Severity; threshold: number; thresholdSource: ValueSourceValue; evalM: number; evalN: number;
  comparison: string; statistic: string; period: number; state: AlarmStateValue | null; driftStatus: ManagedAlarmRecord['driftStatus']; lastSyncedAt?: Date | null;
}

export interface ContactScopeRow { contactId: string; customerId: string; scopeType: 'CUSTOMER' | 'PROJECT' | 'SERVICE'; scopeId: string; role: 'NOTIFY' | 'APPROVER' | 'PORTAL_USER' }

/** A ContactRevealLog row as the memory store keeps it (never a contact value). */
export interface RevealLogEntry extends RevealWrite { id: string; at: Date }

/** Everything of a CloudAccount the tick store's OrgAccount does not carry. Keyed by AWS account id (the memory store's account id). */
export interface MemoryAccountMeta extends Omit<NewAccount, 'awsAccountId' | 'serviceId'> {
  readerStatus: CloudAccountRecord['readerStatus']; eventForwarderStatus: CloudAccountRecord['eventForwarderStatus']; alarmWriterStatus: CloudAccountRecord['alarmWriterStatus'];
  tagWriterStatus: CloudAccountRecord['tagWriterStatus']; remediatorStatus: CloudAccountRecord['remediatorStatus'];
  lastCheckedAt: Date | null; firstEventAt: Date | null; lastEventAt: Date | null; stackVersion: string | null; createdAt: Date;
}
/** A ChannelVerification row as the memory store keeps it (only the hash of the token, never the token). */
export interface MemoryVerification { id: string; customerId: string | null; contactId: string; channel: VerifyChannelValue; tokenHash: string; sentAt: Date; expiresAt: Date; usedAt: Date | null; via: string; note: string | null }

const inRange = (ids: readonly string[] | '*', id: string | null): boolean => id !== null && (ids === '*' || ids.includes(id));

export class MemoryApiStore extends MemoryTickStore implements ApiRepository {
  /** Onboarding state (#62). */
  accountMeta = new Map<string, MemoryAccountMeta>();
  verifications = new Map<string, MemoryVerification>();
  loginDomains = new Map<string, string[]>();
  customerCreatedAt = new Map<string, Date>();
  portalGrantsOf = new Map<string, string[]>();
  /** Test hooks: this account has Resource / ManagedAlarm rows (the memory store keeps no such tables). */
  accountsWithResources = new Set<string>();
  users = new Map<string, { id: string; name: string; contactId: string | null; email?: string; role?: Role; customerId?: string | null; status?: 'ACTIVE' | 'PENDING' | 'DISABLED'; googleSub?: string | null; lastLoginAt?: Date | null; createdAt?: Date }>();
  private userSeq = 0;
  /** Responders list versions (never restart) and the source of each responder row (DIRECT unless set). */
  respondersVersion = new Map<string, number>();
  responderSource = new Map<string, { source: 'DIRECT' | 'TEMPLATE'; templateId: string; templateName: string }>();
  customerTemplate = new Map<string, string>();
  /** Responder templates (id → row). Members are staff contact ids. */
  templates = new Map<string, { id: string; name: string; version: number; updatedBy: string | null; updatedAt: Date; members: string[] }>();
  bulkChanges: Array<{ kind: 'TEMPLATE_UPDATE'; actorId: string; params: unknown; preview: unknown; previewHash: string; at: Date }> = [];
  private templateSeq = 0;
  private newContactSeq = 0;
  /** ContactRevealLog (D-35), append only. */
  revealLogs: RevealLogEntry[] = [];
  /** Test switch: the next reveal-log writes fail (nothing is written, the call throws). */
  failRevealWrites = false;
  private revealSeq = 0;
  contactScopes: ContactScopeRow[] = [];
  resources = new Map<string, { id: string; name: string; customerId: string; serviceId: string | null }>();
  verifiedSlack = new Set<string>();
  undo = new Map<string, UndoRecord>();
  idempotent = new Map<string, { entry: IdempotentEntry; expiresAt: Date; owner: string }>();
  /** Last version of deleted paging configs, so a re-created one continues the sequence (N-3). */
  configTombstones = new Map<string, number>();
  /** D-43: CustomerOffboarding per customer, and the events that arrived after TERMINATED (tests fill `residuals`). */
  offboardings = new Map<string, Omit<OffboardingState, 'residual'>>();
  residuals = new Map<string, Array<{ sourceKey: string; lastAt: Date; count: number }>>();
  /** Counts scoped reads, so tests can assert that out-of-scope ids never reach an unscoped lookup. */
  reads: string[] = [];

  async orgTree(scope: ScopeFilter) {
    const svcProject = (id: string) => this.services.get(id)?.projectId;
    return {
      customers: [...this.customers.values()].filter((c) => seesCustomer(scope, c.id)).map((c) => ({ id: c.id, name: c.name, slug: c.slug, status: c.status ?? 'ACTIVE' })),
      projects: [...this.projects.values()].filter((p) => nodeVisible(scope, { customerId: p.customerId, projectId: p.id }, svcProject)).map((p) => ({ ...p })),
      services: [...this.services.values()].filter((s) => nodeVisible(scope, { customerId: s.customerId, projectId: s.projectId, serviceId: s.id }, svcProject)).map((s) => ({ ...s })),
    };
  }
  async openIncidentCounts(scope: ScopeFilter) {
    const m = new Map<string, { customerId: string; projectId: string | null; serviceId: string | null; open: number }>();
    for (const i of this.incidents.values()) {
      if (i.status !== 'TRIGGERED' || i.customerId == null || !inScope(scope, i)) continue;
      const k = `${i.customerId}|${i.projectId}|${i.serviceId}`;
      const row = m.get(k) ?? { customerId: i.customerId, projectId: i.projectId, serviceId: i.serviceId, open: 0 };
      row.open++;
      m.set(k, row);
    }
    return [...m.values()];
  }
  async responderCustomerIds(userId: string) {
    const contactId = this.users.get(userId)?.contactId;
    return contactId ? [...new Set(this.responders.filter((r) => r.contactId === contactId).map((r) => r.customerId))] : [];
  }
  async contactIdForUser(userId: string) { return this.users.get(userId)?.contactId ?? null; }
  async userDirectory(ids: string[]) {
    const out = new Map<string, UserInfo>();
    for (const id of ids) {
      const u = this.users.get(id);
      if (!u) continue;
      const c = u.contactId ? this.contacts.get(u.contactId) : undefined;
      out.set(id, { name: u.name, kind: c?.kind === 'CUSTOMER' ? 'CUSTOMER' : 'INTERNAL', customerId: c?.kind === 'CUSTOMER' ? c.customerId : null });
    }
    return out;
  }
  async staffNames(ids: string[]) {
    const out = new Map<string, string>();
    for (const id of ids) { const u = this.users.get(id); if (u && !u.customerId && u.name) out.set(id, u.name); }
    return out;
  }
  async slackChannelVerified(customerId: string) { return this.verifiedSlack.has(customerId); }
  async findResource(scope: ScopeFilter, id: string) {
    const r = this.resources.get(id);
    if (!r) return null;
    const projectId = r.serviceId ? this.services.get(r.serviceId)?.projectId ?? null : null;
    return inScope(scope, { customerId: r.customerId, projectId, serviceId: r.serviceId }) ? { ...r, projectId } : null;
  }

  // ───────────── monitoring: resources and managed alarms (API-CONTRACT §8.5) ─────────────
  /** Test seed of the Monitoring API: Resource and ManagedAlarm rows (the engine writes them in production). */
  resourceSeeds = new Map<string, MemoryResourceSeed>();
  alarmSeeds = new Map<string, MemoryAlarmSeed>();
  private resourceRecord(s: MemoryResourceSeed): ResourceRecord | null {
    const org = this.accounts.get(s.awsAccountId);
    if (!org || org.customerId !== s.customerId) return null;
    const acc = this.accountRecord(org);
    const serviceId = org.serviceId;
    const projectId = serviceId ? this.services.get(serviceId)?.projectId ?? null : null;
    return {
      id: s.id, customerId: s.customerId, projectId, serviceId, cloudAccountId: acc.id, awsAccountId: acc.awsAccountId, accountAlias: acc.alias,
      alarmWriterEnabled: acc.alarmWriterEnabled, tagWriterEnabled: acc.tagWriterEnabled,
      region: s.region, resourceType: s.resourceType, resourceKey: s.resourceKey, name: s.name, tags: { ...s.tags },
      monitoringState: s.monitoringState, needsReviewSince: s.needsReviewSince, needsReviewReason: s.needsReviewReason, lastSeenAt: s.lastSeenAt,
      accountActive: (this.customers.get(s.customerId)?.status ?? 'ACTIVE') === 'ACTIVE' && !acc.disabled && !acc.connectionPurged,
      alarmCount: [...this.alarmSeeds.values()].filter((a) => a.resourceId === s.id).length,
    };
  }
  private alarmRecord(a: MemoryAlarmSeed, r: ResourceRecord): ManagedAlarmRecord {
    const { customerId, projectId, serviceId, resourceType, region } = r;
    return { ...a, customerId, projectId, serviceId, resourceType, region, resourceName: r.name ?? r.resourceKey, lastSyncedAt: a.lastSyncedAt ?? null };
  }
  private visibleResources(scope: ScopeFilter): ResourceRecord[] {
    return [...this.resourceSeeds.values()].map((s) => this.resourceRecord(s)).filter((r): r is ResourceRecord => r !== null && inScope(scope, r));
  }
  private inNodeOf(node: NodeFilter | null) {
    return (r: { customerId: string; projectId: string | null; serviceId: string | null }): boolean =>
      !node || (node.customerIds.includes(r.customerId) && (!node.projectId || r.projectId === node.projectId) && (!node.serviceId || r.serviceId === node.serviceId));
  }
  private outsideOf(scope: ScopeFilter, node: NodeFilter | null): MonitoringOutside | null {
    if (!node) return null;
    const inNode = this.inNodeOf(node);
    const out = this.visibleResources(scope).filter((r) => !inNode(r));
    const ids = new Set(out.map((r) => r.id));
    return {
      needsReview: out.filter((r) => r.monitoringState === 'NEEDS_REVIEW').length,
      inAlarm: [...this.alarmSeeds.values()].filter((a) => ids.has(a.resourceId) && a.state === 'ALARM').length,
    };
  }
  private static page<T>(rows: T[], key: (x: T) => string, id: (x: T) => string, p: { limit: number; after?: MonitoringCursor }): { rows: T[]; hasMore: boolean } {
    const cmp = (x: T, y: T): number => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : id(x) < id(y) ? -1 : id(x) > id(y) ? 1 : 0); // plain code-unit order = the SQL side's COLLATE "C"
    const sorted = [...rows].sort(cmp).filter((x) => !p.after || key(x) > p.after.k || (key(x) === p.after.k && id(x) > p.after.id));
    return { rows: sorted.slice(0, p.limit), hasMore: sorted.length > p.limit };
  }
  async queryResources(scope: ScopeFilter, node: NodeFilter | null, f: ResourceFilter, page: { limit: number; after?: MonitoringCursor }): Promise<MonitoringPage<ResourceRecord>> {
    this.reads.push('queryResources');
    const inNode = this.inNodeOf(node);
    const rows = this.visibleResources(scope).filter((r) => inNode(r) && (!f.type || r.resourceType === f.type) && (!f.monitoringState || r.monitoringState === f.monitoringState));
    return { ...MemoryApiStore.page(rows, (r) => r.name ?? r.resourceKey, (r) => r.id, page), outside: this.outsideOf(scope, node) };
  }
  async findResourceDetail(scope: ScopeFilter, resourceId: string) {
    this.reads.push('findResourceDetail');
    const s = this.resourceSeeds.get(resourceId);
    const resource = s ? this.resourceRecord(s) : null;
    if (!resource || !inScope(scope, resource)) return null;
    const alarms = [...this.alarmSeeds.values()].filter((a) => a.resourceId === resource.id).map((a) => this.alarmRecord(a, resource)).sort((x, y) => (x.alarmName < y.alarmName ? -1 : x.alarmName > y.alarmName ? 1 : 0));
    return { resource, alarms };
  }
  async queryManagedAlarms(scope: ScopeFilter, node: NodeFilter | null, f: ManagedAlarmFilter, page: { limit: number; after?: MonitoringCursor }): Promise<MonitoringPage<ManagedAlarmRecord>> {
    this.reads.push('queryManagedAlarms');
    const inNode = this.inNodeOf(node);
    const byId = new Map(this.visibleResources(scope).map((r) => [r.id, r]));
    const rows: ManagedAlarmRecord[] = [];
    for (const a of this.alarmSeeds.values()) {
      const r = byId.get(a.resourceId);
      if (!r || !inNode(r)) continue;
      if ((f.resourceId && a.resourceId !== f.resourceId) || (f.state && a.state !== f.state) || (f.severity && a.severity !== f.severity)) continue;
      rows.push(this.alarmRecord(a, r));
    }
    return { ...MemoryApiStore.page(rows, (a) => a.alarmName, (a) => a.id, page), outside: this.outsideOf(scope, node) };
  }

  private visible(scope: ScopeFilter): IncidentRow[] {
    return [...this.incidents.values()].filter((i) => inScope(scope, i));
  }
  private muted(i: IncidentRow, now: Date): boolean {
    if (i.status === 'RESOLVED') return false;
    const ws = this.windows.filter((w) => w.customerId == null || w.customerId === i.customerId);
    return !!incidentMute({ customerId: i.customerId, projectId: i.projectId, serviceId: i.serviceId, accountIds: i.accountIds, resourceTypes: i.resourceTypes, severity: i.severity }, ws, now);
  }

  async queryIncidents(scope: ScopeFilter, node: NodeFilter | null, f: IncidentFilter, page: { limit: number; after?: { t: string; id: string } }, now: Date): Promise<IncidentPage> {
    this.reads.push('queryIncidents');
    const visible = this.visible(scope);
    const inNode = (i: IncidentRow): boolean => {
      if (!node) return true;
      if (i.customerId == null) return node.includeUnmapped;
      return node.customerIds.includes(i.customerId) && (!node.projectId || i.projectId === node.projectId) && (!node.serviceId || i.serviceId === node.serviceId);
    };
    const needle = f.q?.toLowerCase();
    const attr = (i: IncidentRow): boolean =>
      (!f.severity || i.severity === f.severity) && (!f.source || i.source === f.source) && (!needle || i.title.toLowerCase().includes(needle))
      && (!f.unmappedOnly || i.customerId == null)
      && (!f.assigneeContactId || !!parseSnapshot(i.assignmentSnapshot)?.steps.some((s) => s.resolved.some((r) => r.contactId === f.assigneeContactId)));
    const open = (xs: IncidentRow[]): OpenCounts => ({
      open: xs.filter((i) => i.status === 'TRIGGERED').length,
      unmappedOpen: xs.filter((i) => i.status === 'TRIGGERED' && i.customerId == null).length,
      acknowledged: xs.filter((i) => i.status === 'ACKNOWLEDGED').length,
    });
    const basis = visible.filter((i) => inNode(i) && attr(i));
    const escalated = (i: IncidentRow) => i.escalationStep > 1 || i.escalationRepeat > 0;
    const counts: StatusCounts = {
      triggered: basis.filter((i) => i.status === 'TRIGGERED' && !escalated(i)).length,
      escalated: basis.filter((i) => i.status === 'TRIGGERED' && escalated(i)).length,
      acknowledged: basis.filter((i) => i.status === 'ACKNOWLEDGED').length,
      resolved24h: basis.filter((i) => i.status === 'RESOLVED' && i.resolvedAt != null && now.getTime() - i.resolvedAt.getTime() <= 86400_000).length,
      muted: basis.filter((i) => this.muted(i, now)).length,
      open: basis.filter((i) => i.status === 'TRIGGERED').length,
    };
    const byStatus = basis.filter((i) => !f.status || (f.status === 'active' ? i.status !== 'RESOLVED' : i.status === f.status));
    // Sort on the server, then cut (known-bugs 9-1, 9-2): newest first, id as the tie-break so cursors are stable.
    const sorted = byStatus.sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime() || (a.id < b.id ? 1 : -1));
    const after = page.after;
    const rest = after ? sorted.filter((i) => { const t = i.triggeredAt.toISOString(); return t < after.t || (t === after.t && i.id < after.id); }) : sorted;
    const accounts = new Map<string, number>();
    if (scope.unmapped) for (const i of visible) if (i.customerId == null && i.status !== 'RESOLVED') accounts.set(i.accountIds[0] ?? 'unknown', (accounts.get(i.accountIds[0] ?? 'unknown') ?? 0) + i.memberCount);
    return {
      rows: structuredClone(rest.slice(0, page.limit)), hasMore: rest.length > page.limit, counts,
      inside: open(visible.filter(inNode)), all: open(visible),
      unmapped: [...accounts].map(([awsAccountId, alertCount]) => ({ awsAccountId, alertCount })),
    };
  }
  async findIncident(scope: ScopeFilter, id: string) {
    this.reads.push('findIncident');
    const i = this.incidents.get(id);
    return i && inScope(scope, i) ? structuredClone(i) : null;
  }
  async incidentAlerts(scope: ScopeFilter, incidentId: string): Promise<AlertMemberRow[]> {
    const inc = await this.findIncident(scope, incidentId);
    if (!inc) return [];
    const info = new Map([...this.members.values()].flat().map((m) => [m.alertId, m]));
    return [...(this.incidentMembers.get(incidentId)?.entries() ?? [])].map(([fingerprint, m]) => ({
      id: m.alertId, fingerprint, title: info.get(m.alertId)?.title ?? fingerprint,
      status: !(this.episodes.get(m.alertId) ?? true) ? 'RESOLVED' : this.alertAcked.get(m.alertId) ? 'ACKNOWLEDGED' : 'FIRING',
      severity: info.get(m.alertId)?.severity ?? inc.severity, metricKey: null, resourceId: null, value: null, threshold: null, eventCount: m.eventCount, lastEventAt: inc.lastMergedAt ?? inc.triggeredAt,
    }));
  }
  async incidentEvents(scope: ScopeFilter, incidentId: string, page: { limit: number; after?: { t: string; id: string } }) {
    if (!(await this.findIncident(scope, incidentId))) return { rows: [], hasMore: false };
    const all = this.events.filter((e) => e.incidentId === incidentId).map((e, i) => ({ e, i })).sort((a, b) => a.e.at.getTime() - b.e.at.getTime() || a.i - b.i).map((x) => x.e);
    const start = page.after ? all.findIndex((e) => e.id === page.after!.id) + 1 : 0;
    return { rows: all.slice(start, start + page.limit), hasMore: all.length > start + page.limit };
  }
  async incidentNotifications(scope: ScopeFilter, incidentId: string, page: { limit: number; after?: { t: string; id: string } }) {
    if (!(await this.findIncident(scope, incidentId))) return { rows: [], hasMore: false, total: 0 };
    const all = this.logs.filter((l) => l.incidentId === incidentId);
    const start = page.after ? all.findIndex((l) => l.id === page.after!.id) + 1 : 0;
    return { rows: all.slice(start, start + page.limit), hasMore: all.length > start + page.limit, total: all.length };
  }
  async saveUndo(rec: UndoRecord) { this.undo.set(rec.token, structuredClone(rec)); }
  /** Tick housekeeping (R-7): expired Idempotency-Key entries and undo records of every user, on the store clock. */
  override async purgeExpired(): Promise<number> {
    let n = await super.purgeExpired();
    const now = this.clock().getTime();
    for (const [k, v] of this.idempotent) if (v.expiresAt.getTime() <= now) { this.idempotent.delete(k); n++; }
    for (const [k, v] of this.undo) if (v.expiresAt.getTime() < now - 86_400_000) { this.undo.delete(k); n++; }
    return n;
  }
  async takeUndo(token: string) {
    const r = this.undo.get(token) ?? null;
    this.undo.delete(token);
    return r;
  }

  async savePagingConfig(cfg: PagingConfig, expectedVersion: number | null, audit: AuditInput) {
    if (typeof cfg.customerId !== 'string' || !cfg.customerId || audit.customerId !== cfg.customerId) throw new Error('savePagingConfig: customerId is required and must be the audited customer');
    const i = this.configs.findIndex((c) => c.customerId === cfg.customerId && c.scopeType === cfg.scopeType && c.scopeId === cfg.scopeId);
    if (expectedVersion === null ? i >= 0 : i < 0 || this.configs[i]!.version !== expectedVersion) return 'CONFLICT' as const;
    const key = `${cfg.customerId}|${cfg.scopeType}|${cfg.scopeId}`;
    const stored: PagingConfig = { ...structuredClone(cfg), version: (expectedVersion ?? this.configTombstones.get(key) ?? 0) + 1 };
    if (i >= 0) this.configs[i] = stored; else this.configs.push(stored);
    this.audits.push(audit);
    return structuredClone(stored);
  }
  async deletePagingConfig(id: string, expectedVersion: number, audit: AuditInput) {
    // R-6: the audited customer is required and must own the row (the SQL store has it in the WHERE).
    const i = this.configs.findIndex((c) => c.id === id && audit.customerId != null && c.customerId === audit.customerId);
    if (i < 0 || this.configs[i]!.version !== expectedVersion) return 'CONFLICT' as const;
    const [gone] = this.configs.splice(i, 1);
    this.configTombstones.set(`${gone!.customerId}|${gone!.scopeType}|${gone!.scopeId}`, gone!.version);
    this.audits.push(audit);
    return 'OK' as const;
  }
  async rotationOwner(rotationId: string) {
    const r = this.rotations.get(rotationId);
    return r ? { scope: r.scope, customerId: r.customerId } : null;
  }
  async notifiedPeople(customerId: string, path: { projectId?: string | null; serviceId?: string | null }): Promise<NotifiedPerson[]> {
    const out: NotifiedPerson[] = [];
    const name = (t: string, id: string) => (t === 'CUSTOMER' ? this.customers.get(id)?.name : t === 'PROJECT' ? this.projects.get(id)?.name : this.services.get(id)?.name) ?? id;
    for (const s of this.contactScopes) {
      if (s.customerId !== customerId || s.role !== 'NOTIFY') continue;
      const hit = s.scopeType === 'CUSTOMER' ? s.scopeId === customerId : s.scopeType === 'PROJECT' ? s.scopeId === path.projectId : s.scopeId === path.serviceId;
      const c = this.contacts.get(s.contactId);
      if (hit && c?.active && c.customerId === customerId) out.push({ contactId: c.id, name: c.name, scope: { level: s.scopeType, id: s.scopeId, name: name(s.scopeType, s.scopeId) } });
    }
    return out;
  }
  // ───────────── retention (D-45), export, digest (D-46) ─────────────
  protected override offboardingCompletedAt(customerId: string): Date | null { return this.offboardings.get(customerId)?.completedAt ?? null; }
  /** Portal users, resources and contact scopes of the customer (the tick store does not know them). */
  protected override retentionExtra(stage: RetentionStage, customerId: string): Record<string, number> {
    const out: Record<string, number> = {};
    if (stage === 'CONNECTIONS') {
      let n = 0;
      for (const [id, r] of this.resources) if (r.customerId === customerId) { this.resources.delete(id); n++; }
      if (n) out.Resource = n;
    } else if (stage === 'RETURN_PERIOD') {
      const gone = [...this.users.values()].filter((u) => u.customerId === customerId);
      for (const u of gone) this.users.delete(u.id);
      if (gone.length) out.User = gone.length;
      const sc = this.contactScopes.length;
      this.contactScopes = this.contactScopes.filter((x) => x.customerId !== customerId);
      if (sc !== this.contactScopes.length) out.ContactScope = sc - this.contactScopes.length;
    }
    return out;
  }
  async retentionView(customerId: string): Promise<RetentionView | null> {
    const c = this.customers.get(customerId);
    if (!c) return null;
    const h = c.legalHold;
    return { name: c.name, status: c.status ?? 'ACTIVE', statusChangedAt: c.statusChangedAt ?? null, legalHold: { active: !!h, at: h?.at ?? null, byUserId: h?.byUserId ?? null, reason: h?.reason ?? null } };
  }
  async setLegalHold(customerId: string, hold: { byUserId: string; reason: string; at: Date } | null, audit: AuditInput): Promise<'OK' | 'NOOP' | 'NOT_FOUND'> {
    const c = this.customers.get(customerId);
    if (!c || audit.customerId !== customerId) return 'NOT_FOUND';
    if (!!c.legalHold === !!hold) return 'NOOP';
    c.legalHold = hold ? { ...hold } : null;
    this.purgeLogs.push({ id: this.nextId('purge'), customerId, stage: hold ? 'LEGAL_HOLD_SET' : 'LEGAL_HOLD_RELEASED', counts: {}, actor: hold ? hold.byUserId : (audit.actorId ?? 'unknown'), at: audit.at });
    this.audits.push(audit);
    return 'OK';
  }
  async purgeLog(customerId: string): Promise<PurgeLogEntry[]> {
    return structuredClone(this.purgeLogs.filter((e) => e.customerId === customerId)).sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  }
  private exportable(customerId: string): IncidentRow[] {
    return [...this.incidents.values()].filter((i) => i.customerId === customerId).sort((a, b) => a.number - b.number);
  }
  async countExportIncidents(customerId: string): Promise<number> { return this.exportable(customerId).length; }
  async exportIncidents(customerId: string, afterNumber: number, limit: number): Promise<ExportIncidentRow[]> {
    return this.exportable(customerId).filter((i) => i.number > afterNumber).slice(0, limit).map((i) => ({
      number: i.number, id: i.id, title: i.title, severity: i.severity, status: i.status, triggeredAt: i.triggeredAt, acknowledgedAt: i.acknowledgedAt, resolvedAt: i.resolvedAt,
      mttaSec: i.mttaSec, mttrSec: i.mttrSec, memberCount: i.memberCount, eventCount: i.eventCount, accountIds: [...i.accountIds], resourceTypes: [...i.resourceTypes], pagingSuppressed: i.pagingSuppressed ?? null,
    }));
  }
  async recordAudit(audit: AuditInput): Promise<void> { this.audits.push(audit); }
  async digestData(scope: ScopeFilter, from: Date, to: Date): Promise<DigestData> {
    const inWin = (t: Date): boolean => t.getTime() >= from.getTime() && t.getTime() < to.getTime();
    const by = new Map<string, { customerId: string; customerName: string; incidents: number; firstAt: Date; lastAt: Date }>();
    for (const i of this.incidents.values()) {
      if (i.pagingSuppressed !== 'CUSTOMER_SUSPENDED' || !i.customerId || !inWin(i.triggeredAt) || !inScope(scope, i)) continue;
      const cur = by.get(i.customerId);
      if (cur) { cur.incidents++; if (i.triggeredAt < cur.firstAt) cur.firstAt = i.triggeredAt; if (i.triggeredAt > cur.lastAt) cur.lastAt = i.triggeredAt; }
      else by.set(i.customerId, { customerId: i.customerId, customerName: this.customers.get(i.customerId)?.name ?? i.customerId, incidents: 1, firstAt: i.triggeredAt, lastAt: i.triggeredAt });
    }
    const terminated: DigestData['terminatedResiduals'] = [];
    for (const [cid, rs] of this.residuals) {
      if (!inScope(scope, { customerId: cid, projectId: null, serviceId: null })) continue; // whole customer only
      const hit = rs.filter((r) => inWin(r.lastAt));
      if (!hit.length) continue;
      terminated.push({ customerId: cid, customerName: this.customers.get(cid)?.name ?? cid, sources: hit.length, lastEventAt: new Date(Math.max(...hit.map((r) => r.lastAt.getTime()))), totalEvents: rs.reduce((n, r) => n + r.count, 0) });
    }
    return { suspended: [...by.values()], terminatedResiduals: terminated };
  }
  // ───────────── customer status / offboarding (D-43) ─────────────
  private statusVersionOf(customerId: string): number {
    return this.audits.filter((a) => a.customerId === customerId && a.targetType === 'CustomerStatus').length;
  }
  async customerStatusState(customerId: string): Promise<CustomerStatusState | null> {
    const c = this.customers.get(customerId);
    return c ? { name: c.name, status: c.status ?? 'ACTIVE', statusChangedAt: c.statusChangedAt ?? null, version: this.statusVersionOf(customerId) } : null;
  }
  async changeCustomerStatus(customerId: string, expectedVersion: number, to: CustomerStatusValue, offboarding: { startedByUserId: string; reason: string } | null, audit: AuditInput): Promise<ChangeStatusOutcome> {
    if (audit.customerId !== customerId || audit.targetType !== 'CustomerStatus') throw new Error('changeCustomerStatus: audit must be a CustomerStatus audit of the same customer');
    const c = this.customers.get(customerId);
    if (!c) return 'NOT_FOUND';
    if (this.statusVersionOf(customerId) !== expectedVersion) return 'CONFLICT';
    const from = c.status ?? 'ACTIVE';
    if (from === 'TERMINATED' && to !== 'TERMINATED') return 'CUSTOMER_TERMINATED';
    if (from === to) return 'NOOP';
    if (to === 'TERMINATED' && !offboarding) throw new Error('changeCustomerStatus: TERMINATED needs an offboarding');
    const at = audit.at;
    c.status = to; c.statusChangedAt = at;
    let offboardingId: string | null = null;
    if (to === 'TERMINATED' && offboarding) {
      offboardingId = this.nextId('off');
      const at_ = at.toISOString();
      this.offboardings.set(customerId, {
        id: offboardingId, customerId, startedByUserId: offboarding.startedByUserId, reason: offboarding.reason, startedAt: at, completedAt: null,
        steps: {
          PAGING_STOPPED: { state: 'DONE', at: at_, byUserId: offboarding.startedByUserId }, ALARMS_DELETED: { state: 'PENDING' },
          CUSTOMER_STACK_REMOVED: { state: 'MANUAL' }, ACCOUNTS_DISABLED: { state: 'MANUAL' }, BUS_ALLOWLIST_REMOVED: { state: 'MANUAL' },
        },
      });
    }
    this.audits.push(audit);
    // In memory a CloudAccount is identified by its AWS account id.
    return { status: to, statusChangedAt: at, version: expectedVersion + 1, offboardingId, cloudAccountIds: to === 'TERMINATED' ? [...this.accounts.values()].filter((a) => a.customerId === customerId).map((a) => a.awsAccountId) : [] };
  }
  async offboardingState(customerId: string): Promise<OffboardingState | null> {
    const o = this.offboardings.get(customerId);
    if (!o) return null;
    const rs = this.residuals.get(customerId) ?? [];
    const last = rs.reduce<Date | null>((m, r) => (m === null || r.lastAt > m ? r.lastAt : m), null);
    return { ...structuredClone(o), residual: { lastEventAt: last, count: rs.reduce((n, r) => n + r.count, 0) } };
  }
  async markOffboardStepDone(customerId: string, key: OffboardStepKey, userId: string, detail: string | null, at: Date, audit: AuditInput): Promise<MarkStepOutcome> {
    const o = this.offboardings.get(customerId);
    if (!o || audit.customerId !== customerId) return 'NOT_FOUND';
    const st = o.steps[key];
    if (st.state === 'DONE') return 'ALREADY_DONE';
    if (key === 'ALARMS_DELETED' && st.state !== 'MANUAL') return 'NOT_ALLOWED';
    o.steps[key] = { ...st, state: 'DONE', at: at.toISOString(), byUserId: userId, ...(detail ? { detail } : {}) };
    if (OFFBOARD_STEP_KEYS.every((k) => o.steps[k].state === 'DONE') && !o.completedAt) o.completedAt = at;
    this.audits.push(audit);
    return 'OK';
  }
  async cloudAccountIds(customerId: string): Promise<string[]> {
    return [...this.accounts.values()].filter((a) => a.customerId === customerId).map((a) => a.awsAccountId);
  }
  async recordOffboardPublishFailure(customerId: string, cloudAccountIds: string[], at: Date): Promise<void> {
    const o = this.offboardings.get(customerId);
    if (!o || o.steps.ALARMS_DELETED.state === 'DONE') return;
    const prev = o.steps.ALARMS_DELETED.detail;
    const mark = `COMMAND_PUBLISH_FAILED: ${cloudAccountIds.join(',')}`;
    o.steps.ALARMS_DELETED = { ...o.steps.ALARMS_DELETED, state: 'MANUAL', detail: prev ? (prev.includes(mark) ? prev : `${prev}; ${mark}`) : mark };
    void at;
  }

  // ───────────── onboarding: customers, accounts, contacts, verification (#62) ─────────────
  async createCustomer(c: { name: string; slug: string; loginDomains: string[] }, audit: AuditTemplate) {
    const all = [...this.customers.values()];
    if (all.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) return 'NAME_EXISTS' as const;
    if (all.some((x) => x.slug === c.slug)) return 'SLUG_EXISTS' as const;
    if (c.loginDomains.some((d) => [...this.loginDomains.values()].some((l) => l.includes(d)))) return 'DOMAIN_EXISTS' as const;
    const id = this.nextId('cus');
    this.customers.set(id, { id, name: c.name, slug: c.slug, status: 'ACTIVE' });
    this.loginDomains.set(id, [...c.loginDomains]);
    this.customerCreatedAt.set(id, audit.at);
    this.audits.push({ ...audit, customerId: id, targetId: id });
    return { id, createdAt: audit.at };
  }
  private accountRecord(a: { awsAccountId: string; customerId: string; serviceId: string | null }): CloudAccountRecord {
    const m = this.accountMeta.get(a.awsAccountId);
    const base: MemoryAccountMeta = m ?? {
      alias: null, environment: null, regions: ['ap-northeast-2'], externalId: `ext-${a.awsAccountId}`, readerRoleArn: `arn:aws:iam::${a.awsAccountId}:role/AlarmOps-Reader`,
      eventForwarderRoleArn: `arn:aws:iam::${a.awsAccountId}:role/AlarmOps-EventForwarder`, alarmWriterRoleArn: null, tagWriterRoleArn: null, remediatorRoleArn: null,
      alarmWriterEnabled: false, tagWriterEnabled: false, remediatorEnabled: false, readerStatus: 'UNKNOWN', eventForwarderStatus: 'UNKNOWN', alarmWriterStatus: 'UNKNOWN',
      tagWriterStatus: 'UNKNOWN', remediatorStatus: 'UNKNOWN', lastCheckedAt: null, firstEventAt: null, lastEventAt: null, stackVersion: null, createdAt: new Date(0),
    };
    const org = this.accounts.get(a.awsAccountId);
    return { id: a.awsAccountId, customerId: a.customerId, serviceId: a.serviceId, awsAccountId: a.awsAccountId, ...structuredClone(base), disabled: !!org?.disabled, connectionPurged: !!org?.purgedAt };
  }
  async listAccounts(customerId: string): Promise<CloudAccountRecord[]> {
    return [...this.accounts.values()].filter((a) => a.customerId === customerId).sort((x, y) => (x.awsAccountId < y.awsAccountId ? -1 : 1)).map((a) => this.accountRecord(a));
  }
  async findAccount(scope: ScopeFilter, accountId: string): Promise<CloudAccountRecord | null> {
    const a = this.accounts.get(accountId);
    return a && seesCustomer(scope, a.customerId) ? this.accountRecord(a) : null;
  }
  async createAccount(customerId: string, a: NewAccount, audit: AuditTemplate): Promise<AccountWriteOutcome> {
    const cus = this.customers.get(customerId);
    if (!cus) return 'NOT_FOUND';
    if ((cus.status ?? 'ACTIVE') === 'TERMINATED') return 'CUSTOMER_TERMINATED';
    if (this.accounts.has(a.awsAccountId)) return 'EXISTS';
    if (a.serviceId !== null && this.services.get(a.serviceId)?.customerId !== customerId) return 'NO_SUCH_SERVICE';
    const { awsAccountId, serviceId, ...rest } = a;
    this.accounts.set(awsAccountId, { awsAccountId, customerId, serviceId, externalId: rest.externalId, roleArns: [rest.readerRoleArn, rest.eventForwarderRoleArn] });
    this.accountMeta.set(awsAccountId, { ...structuredClone(rest), readerStatus: 'UNKNOWN', eventForwarderStatus: 'UNKNOWN', alarmWriterStatus: 'UNKNOWN', tagWriterStatus: 'UNKNOWN', remediatorStatus: 'UNKNOWN', lastCheckedAt: null, firstEventAt: null, lastEventAt: null, stackVersion: null, createdAt: audit.at });
    this.audits.push({ ...audit, customerId, targetId: awsAccountId });
    return this.accountRecord(this.accounts.get(awsAccountId)!);
  }
  async updateAccount(customerId: string, accountId: string, patch: AccountPatch, audit: AuditTemplate): Promise<AccountWriteOutcome> {
    const org = this.accounts.get(accountId);
    if (!org || org.customerId !== customerId) return 'NOT_FOUND';
    if ((this.customers.get(customerId)?.status ?? 'ACTIVE') === 'TERMINATED' || org.purgedAt) return 'CUSTOMER_TERMINATED';
    if (patch.serviceId !== undefined && patch.serviceId !== null && this.services.get(patch.serviceId)?.customerId !== customerId) return 'NO_SUCH_SERVICE';
    const meta = this.accountMeta.get(accountId) ?? (() => { const { id: _i, customerId: _c, serviceId: _s, awsAccountId: _a, disabled: _d, connectionPurged: _p, ...m } = this.accountRecord(org); return m as MemoryAccountMeta; })();
    const { serviceId, ...rest } = patch;
    if (serviceId !== undefined) org.serviceId = serviceId;
    this.accountMeta.set(accountId, { ...meta, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) } as MemoryAccountMeta);
    this.audits.push({ ...audit, customerId, targetId: accountId });
    return this.accountRecord(org);
  }
  async reserveAccountCheck(customerId: string, accountId: string, now: Date, cooldownSec: number, audit: AuditTemplate): Promise<'OK' | { retryAfterSec: number }> {
    const t = this.audits.filter((a) => a.action === 'account.check' && a.customerId === customerId && a.targetId === accountId).map((a) => a.at.getTime());
    const last = t.length ? Math.max(...t) : null;
    if (last !== null && now.getTime() - last < cooldownSec * 1000) return { retryAfterSec: Math.max(1, Math.ceil((last + cooldownSec * 1000 - now.getTime()) / 1000)) };
    this.audits.push({ ...audit, customerId, targetId: accountId });
    return 'OK';
  }
  async deleteAccount(customerId: string, accountId: string, audit: AuditTemplate) {
    const org = this.accounts.get(accountId);
    if (!org || org.customerId !== customerId) return 'NOT_FOUND' as const;
    if ((this.customers.get(customerId)?.status ?? 'ACTIVE') === 'TERMINATED') return 'CUSTOMER_TERMINATED' as const;
    if (this.accountsWithResources.has(accountId)) return 'IN_USE' as const;
    this.accounts.delete(accountId);
    this.accountMeta.delete(accountId);
    this.audits.push({ ...audit, customerId, targetId: accountId });
    return 'OK' as const;
  }

  async portalGrants(customerId: string): Promise<string[]> { return [...(this.portalGrantsOf.get(customerId) ?? [])]; }
  private linksFor(contactIds: Set<string>): VerificationLink[] {
    const latest = new Map<string, MemoryVerification>();
    for (const v of this.verifications.values()) {
      if (!contactIds.has(v.contactId) || v.via !== 'link') continue;
      const k = `${v.contactId}|${v.channel}`;
      const cur = latest.get(k);
      if (!cur || v.sentAt > cur.sentAt) latest.set(k, v);
    }
    return [...latest.values()].map((v) => ({ contactId: v.contactId, channel: v.channel, sentAt: v.sentAt, expiresAt: v.expiresAt, usedAt: v.usedAt }));
  }
  async contactsWorld(customerIds: readonly string[] | '*', staff: boolean): Promise<ContactsWorld> {
    const linked = (id: string): boolean => customerIds === '*' || this.responders.some((r) => r.contactId === id && customerIds.includes(r.customerId));
    const contacts = [...this.contacts.values()].filter((c) => (c.kind === 'CUSTOMER' ? inRange(customerIds, c.customerId) : staff && linked(c.id))).map((c) => structuredClone(c));
    const ids = new Set(contacts.map((c) => c.id));
    const scopes: ContactScopeInfo[] = this.contactScopes.filter((s) => ids.has(s.contactId) && inRange(customerIds, s.customerId)).map(({ contactId, scopeType, scopeId, role }) => ({ contactId, scopeType, scopeId, role }));
    const responders = this.responders.filter((r) => ids.has(r.contactId) && inRange(customerIds, r.customerId)).map((r) => ({ customerId: r.customerId, contactId: r.contactId, role: r.role }));
    return { contacts, scopes, responders, links: this.linksFor(ids) };
  }
  async findContact(customerIds: readonly string[] | '*', staff: boolean, contactId: string, forWrite = false) {
    const c = this.contacts.get(contactId);
    const staffOk = (): boolean => staff && (customerIds === '*' || (!forWrite && this.responders.some((r) => r.contactId === contactId && customerIds.includes(r.customerId))));
    if (!c || !(c.kind === 'CUSTOMER' ? inRange(customerIds, c.customerId) : staffOk())) return null;
    return { contact: structuredClone(c), links: this.linksFor(new Set([c.id])), responderCustomerIds: [...new Set(this.responders.filter((r) => r.contactId === c.id && inRange(customerIds, r.customerId)).map((r) => r.customerId))] };
  }
  async createContact(n: NewContact, audit: AuditTemplate): Promise<ContactWriteOutcome> {
    if (n.kind === 'CUSTOMER' && (!n.customerId || !this.customers.has(n.customerId))) return 'NOT_FOUND';
    if (n.slackUserId && [...this.contacts.values()].some((c) => c.slackUserId === n.slackUserId)) return 'SLACK_EXISTS';
    const id = this.nextId('ct');
    const c: Contact = { id, kind: n.kind, customerId: n.customerId, name: n.name, active: true, email: n.email, phone: n.phone, slackUserId: n.slackUserId };
    this.contacts.set(id, c);
    this.audits.push({ ...audit, customerId: n.customerId, targetId: id });
    return structuredClone(c);
  }
  async updateContact(contactId: string, customerId: string | null, patch: ContactPatch, audit: AuditTemplate): Promise<ContactWriteOutcome> {
    const c = this.contacts.get(contactId);
    if (!c || (c.customerId ?? null) !== customerId) return 'NOT_FOUND';
    if (patch.slackUserId && [...this.contacts.values()].some((o) => o.id !== c.id && o.slackUserId === patch.slackUserId)) return 'SLACK_EXISTS';
    const reset = (ch: VerifyChannelValue, key: 'email' | 'phone' | 'slackUserId', value: string | null | undefined): void => {
      if (value === undefined || (c[key] ?? null) === value) return;
      c[key] = value;
      if (ch === 'EMAIL') { c.emailVerifiedAt = null; c.emailVerifiedVia = null; } else if (ch === 'SMS') { c.phoneVerifiedAt = null; c.phoneVerifiedVia = null; } else { c.slackVerifiedAt = null; c.slackVerifiedVia = null; }
      // an unused link was meant for the OLD value: it must not verify the new one
      for (const v of this.verifications.values()) if (v.contactId === c.id && v.channel === ch && !v.usedAt && v.expiresAt > audit.at) v.expiresAt = audit.at;
    };
    reset('EMAIL', 'email', patch.email); reset('SMS', 'phone', patch.phone); reset('SLACK', 'slackUserId', patch.slackUserId);
    if (patch.name !== undefined) c.name = patch.name;
    if (patch.active !== undefined) c.active = patch.active;
    this.audits.push({ ...audit, customerId, targetId: c.id });
    return structuredClone(c);
  }
  async deleteContact(contactId: string, customerId: string | null, audit: AuditTemplate) {
    const c = this.contacts.get(contactId);
    if (!c || (c.customerId ?? null) !== customerId) return 'NOT_FOUND' as const;
    const named = this.configs.some((cfg) => cfg.steps.some((st) => st.targetType === 'PERSON' && st.targetId === c.id));
    const used = this.responders.some((r) => r.contactId === c.id) || [...this.rotations.values()].some((r) => r.members.some((m) => m.contactId === c.id))
      || this.leaves.some((l) => l.contactId === c.id || l.replacementId === c.id) || this.overrides.some((o) => o.contactId === c.id) || [...this.users.values()].some((u) => u.contactId === c.id) || named;
    if (used) return 'IN_USE' as const;
    this.contacts.delete(c.id);
    this.contactScopes = this.contactScopes.filter((s) => s.contactId !== c.id);
    for (const [h, v] of this.verifications) if (v.contactId === c.id) this.verifications.delete(h);
    this.audits.push({ ...audit, customerId, targetId: c.id });
    return 'OK' as const;
  }
  async countAudits(customerId: string, actorId: string, action: string, since: Date): Promise<number> {
    return this.audits.filter((a) => a.customerId === customerId && a.actorId === actorId && a.action === action && a.at.getTime() > since.getTime()).length;
  }
  async issueVerification(v: VerificationIssue, limits: VerificationLimits): Promise<IssueOutcome> {
    const cooldownSec = limits.cooldownSec;
    const hourAgo = v.sentAt.getTime() - 3600_000;
    const hour = [...this.verifications.values()].filter((x) => x.via === 'link' && x.sentAt.getTime() > hourAgo);
    const retry = (rows: MemoryVerification[], cap: number): number => { const o = rows.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())[rows.length - cap]; return Math.max(1, Math.ceil((o!.sentAt.getTime() + 3600_000 - v.sentAt.getTime()) / 1000)); };
    const byCustomer = hour.filter((x) => (x.customerId ?? null) === (v.customerId ?? null));
    if (byCustomer.length >= limits.perCustomerHour) return { capped: 'CUSTOMER', retryAfterSec: retry(byCustomer, limits.perCustomerHour) };
    const byDest = byCustomer.filter((x) => x.note === v.destinationHash);
    if (byDest.length >= limits.perDestinationHour) return { capped: 'DESTINATION', retryAfterSec: retry(byDest, limits.perDestinationHour) };
    const recent = [...this.verifications.values()].filter((x) => x.contactId === v.contactId && x.channel === v.channel && x.via === 'link' && x.sentAt.getTime() > v.sentAt.getTime() - cooldownSec * 1000)
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
    if (recent) return { cooling: Math.max(1, Math.ceil((recent.sentAt.getTime() + cooldownSec * 1000 - v.sentAt.getTime()) / 1000)) };
    this.verifications.set(v.tokenHash, { id: this.nextId('cv'), customerId: v.customerId, contactId: v.contactId, channel: v.channel, tokenHash: v.tokenHash, sentAt: v.sentAt, expiresAt: v.expiresAt, usedAt: null, via: 'link', note: v.destinationHash });
    return 'OK' as const;
  }
  async discardVerification(tokenHash: string) { this.verifications.delete(tokenHash); }
  private setVerified(c: Contact, ch: VerifyChannelValue, at: Date, via: string): void {
    if (ch === 'EMAIL') { c.emailVerifiedAt = at; c.emailVerifiedVia = via; } else if (ch === 'SMS') { c.phoneVerifiedAt = at; c.phoneVerifiedVia = via; } else { c.slackVerifiedAt = at; c.slackVerifiedVia = via; }
  }
  async markVerifiedManually(contactId: string, customerId: string | null, channel: VerifyChannelValue, via: string, note: string | null, now: Date, audit: AuditTemplate) {
    const c = this.contacts.get(contactId);
    if (!c || (c.customerId ?? null) !== customerId) return 'NOT_FOUND' as const;
    this.setVerified(c, channel, now, via);
    const h = `manual:${this.nextId('cv')}`;
    this.verifications.set(h, { id: h, customerId, contactId, channel, tokenHash: h, sentAt: now, expiresAt: now, usedAt: now, via, note });
    this.audits.push({ ...audit, customerId, targetId: contactId });
    return 'OK' as const;
  }
  async peekVerification(tokenHash: string, now: Date) {
    const v = this.verifications.get(tokenHash);
    if (!v || v.via !== 'link' || v.usedAt || v.expiresAt.getTime() <= now.getTime() || !this.contacts.get(v.contactId)?.active) return null;
    return { channel: v.channel };
  }
  async takeVerification(tokenHash: string, now: Date, audit: AuditTemplate): Promise<VerificationTaken | null> {
    const v = this.verifications.get(tokenHash);
    if (!v || v.via !== 'link' || v.usedAt || v.expiresAt.getTime() <= now.getTime()) return null;
    const c = this.contacts.get(v.contactId);
    if (!c || !c.active) return null;
    v.usedAt = now;
    this.setVerified(c, v.channel, now, 'link');
    this.audits.push({ ...audit, actorId: c.id, customerId: v.customerId, targetId: c.id });
    return { contactId: c.id, customerId: v.customerId, channel: v.channel, tokenHash: v.tokenHash };
  }

  async getIdempotent(key: string, now: Date) {
    const hit = this.idempotent.get(key);
    return hit && hit.expiresAt.getTime() > now.getTime() ? structuredClone(hit.entry) : null;
  }
  async putIdempotent(key: string, entry: IdempotentEntry, expiresAt: Date, cap: { owner: string; maxPerOwner: number }) {
    const now = this.clock();
    // Map keeps insertion order: the first key of an owner is that owner's oldest entry.
    const mine = [...this.idempotent].filter(([, v]) => v.owner === cap.owner);
    for (const [k, v] of mine) if (v.expiresAt.getTime() <= now.getTime()) this.idempotent.delete(k);
    const live = [...this.idempotent].filter(([k, v]) => v.owner === cap.owner && k !== key);
    for (const [k] of live.slice(0, Math.max(0, live.length - (cap.maxPerOwner - 1)))) this.idempotent.delete(k);
    this.idempotent.delete(key);
    this.idempotent.set(key, { entry: structuredClone(entry), expiresAt, owner: cap.owner });
  }

  // ───────────── wizard: customer profile, projects, services (#69) ─────────────
  private profile(id: string): CustomerProfile {
    const c = this.customers.get(id)!;
    return { id, name: c.name, slug: c.slug, status: c.status ?? 'ACTIVE', loginDomains: [...(this.loginDomains.get(id) ?? [])], createdAt: this.customerCreatedAt.get(id) ?? new Date(0) };
  }
  async listCustomers(scope: ScopeFilter): Promise<CustomerProfile[]> {
    return [...this.customers.keys()].filter((id) => seesCustomer(scope, id)).map((id) => this.profile(id));
  }
  async findCustomer(scope: ScopeFilter, customerId: string): Promise<CustomerProfile | null> {
    return this.customers.has(customerId) && seesCustomer(scope, customerId) ? this.profile(customerId) : null;
  }
  async updateCustomer(customerId: string, patch: CustomerProfilePatch, audit: AuditTemplate): Promise<CustomerUpdateOutcome> {
    const c = this.customers.get(customerId);
    if (!c) return 'NOT_FOUND';
    if ((c.status ?? 'ACTIVE') === 'TERMINATED') return 'CUSTOMER_TERMINATED';
    if (patch.name !== undefined && [...this.customers.values()].some((x) => x.id !== customerId && x.name.toLowerCase() === patch.name!.toLowerCase())) return 'NAME_EXISTS';
    if (patch.loginDomains?.some((d) => [...this.loginDomains].some(([id, l]) => id !== customerId && l.includes(d)))) return 'DOMAIN_EXISTS';
    if (patch.name !== undefined) c.name = patch.name;
    if (patch.loginDomains !== undefined) this.loginDomains.set(customerId, [...patch.loginDomains]);
    this.audits.push({ ...audit, customerId, targetId: customerId });
    return this.profile(customerId);
  }
  async countPortalUsersInDomains(customerId: string, domains: readonly string[]): Promise<number> {
    return [...this.users.values()].map((u) => this.userRecord(u)).filter((u) => u.customerId === customerId && u.status === 'ACTIVE' && domains.includes(emailDomain(u.email))).length;
  }
  private projectRecord(p: { id: string; customerId: string; name: string; slug: string }): ProjectRecord {
    return { id: p.id, customerId: p.customerId, name: p.name, slug: p.slug, serviceCount: [...this.services.values()].filter((s) => s.projectId === p.id).length };
  }
  async listProjects(customerId: string): Promise<ProjectRecord[]> {
    return [...this.projects.values()].filter((p) => p.customerId === customerId).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1)).map((p) => this.projectRecord(p));
  }
  async findProject(scope: ScopeFilter, projectId: string): Promise<ProjectRecord | null> {
    const p = this.projects.get(projectId);
    return p && seesCustomer(scope, p.customerId) ? this.projectRecord(p) : null;
  }
  async createProject(customerId: string, n: { name: string; slug: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ProjectRecord>> {
    const c = this.customers.get(customerId);
    if (!c) return 'NOT_FOUND';
    if ((c.status ?? 'ACTIVE') === 'TERMINATED') return 'CUSTOMER_TERMINATED';
    const mine = [...this.projects.values()].filter((p) => p.customerId === customerId);
    if (mine.some((p) => p.name.toLowerCase() === n.name.toLowerCase())) return 'NAME_EXISTS';
    if (mine.some((p) => p.slug === n.slug)) return 'SLUG_EXISTS';
    const id = this.nextId('prj');
    this.projects.set(id, { id, customerId, name: n.name, slug: n.slug });
    this.audits.push({ ...audit, customerId, targetId: id });
    return this.projectRecord(this.projects.get(id)!);
  }
  async updateProject(customerId: string, projectId: string, patch: { name: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ProjectRecord>> {
    const p = this.projects.get(projectId);
    if (!p || p.customerId !== customerId) return 'NOT_FOUND';
    if ((this.customers.get(customerId)?.status ?? 'ACTIVE') === 'TERMINATED') return 'CUSTOMER_TERMINATED';
    if ([...this.projects.values()].some((x) => x.customerId === customerId && x.id !== projectId && x.name.toLowerCase() === patch.name.toLowerCase())) return 'NAME_EXISTS';
    p.name = patch.name;
    this.audits.push({ ...audit, customerId, targetId: projectId });
    return this.projectRecord(p);
  }
  async listServices(customerId: string, projectId: string): Promise<ServiceRecord[]> {
    return [...this.services.values()].filter((s) => s.customerId === customerId && s.projectId === projectId).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1)).map((s) => ({ ...s }));
  }
  async findService(scope: ScopeFilter, serviceId: string): Promise<ServiceRecord | null> {
    const s = this.services.get(serviceId);
    return s && seesCustomer(scope, s.customerId) ? { ...s } : null;
  }
  async createService(customerId: string, projectId: string, n: { name: string; slug: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ServiceRecord>> {
    const p = this.projects.get(projectId);
    if (!p || p.customerId !== customerId) return 'NOT_FOUND';
    if ((this.customers.get(customerId)?.status ?? 'ACTIVE') === 'TERMINATED') return 'CUSTOMER_TERMINATED';
    const mine = [...this.services.values()].filter((s) => s.projectId === projectId);
    if (mine.some((s) => s.name.toLowerCase() === n.name.toLowerCase())) return 'NAME_EXISTS';
    if (mine.some((s) => s.slug === n.slug)) return 'SLUG_EXISTS';
    const id = this.nextId('svc');
    this.services.set(id, { id, customerId, projectId, name: n.name, slug: n.slug });
    this.audits.push({ ...audit, customerId, targetId: id });
    return { ...this.services.get(id)! };
  }
  async updateService(customerId: string, serviceId: string, patch: { name: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ServiceRecord>> {
    const s = this.services.get(serviceId);
    if (!s || s.customerId !== customerId) return 'NOT_FOUND';
    if ((this.customers.get(customerId)?.status ?? 'ACTIVE') === 'TERMINATED') return 'CUSTOMER_TERMINATED';
    if ([...this.services.values()].some((x) => x.projectId === s.projectId && x.id !== serviceId && x.name.toLowerCase() === patch.name.toLowerCase())) return 'NAME_EXISTS';
    s.name = patch.name;
    this.audits.push({ ...audit, customerId, targetId: serviceId });
    return { ...s };
  }

  // ───────────── users (#69, D-55) ─────────────
  private userRecord(u: MemoryApiStore['users'] extends Map<string, infer V> ? V : never): UserRecord {
    const customerId = u.customerId ?? null;
    return {
      id: u.id, email: (u.email ?? `${u.id}@example.test`).toLowerCase(), name: u.name, kind: customerId ? 'CUSTOMER' : 'INTERNAL', customerId,
      role: u.role ?? (customerId ? 'VIEWER' : 'OPERATOR'), status: u.status ?? 'ACTIVE', googleBound: !!u.googleSub, lastLoginAt: u.lastLoginAt ?? null, createdAt: u.createdAt ?? new Date(0),
    };
  }
  private emailTaken(email: string, exceptId?: string): boolean {
    return [...this.users.values()].some((u) => u.id !== exceptId && this.userRecord(u).email === email);
  }
  async listUsers(f: UserFilter): Promise<UserRecord[]> {
    const needle = f.q?.toLowerCase();
    return [...this.users.values()].map((u) => this.userRecord(u))
      .filter((u) => (!f.kind || u.kind === f.kind) && (!f.customerId || u.customerId === f.customerId) && (!f.status || u.status === f.status) && (!f.role || u.role === f.role)
        && (!needle || u.name.toLowerCase().includes(needle) || u.email.includes(needle)))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  }
  async findUser(userId: string): Promise<UserRecord | null> {
    const u = this.users.get(userId);
    return u ? this.userRecord(u) : null;
  }
  async createUser(n: NewUser, audit: AuditTemplate): Promise<UserRecord | 'EMAIL_EXISTS' | 'NO_SUCH_CUSTOMER'> {
    if (n.customerId !== null && (!this.customers.has(n.customerId) || this.customers.get(n.customerId)!.status === 'TERMINATED')) return 'NO_SUCH_CUSTOMER';
    if (this.emailTaken(n.email)) return 'EMAIL_EXISTS';
    const id = `usr_${++this.userSeq}_${this.nextId('u')}`;
    const u = { id, name: n.name, contactId: null, email: n.email, role: n.role, customerId: n.customerId, status: n.status, googleSub: null, lastLoginAt: null, createdAt: audit.at };
    this.users.set(id, u);
    this.audits.push({ ...audit, customerId: n.customerId, targetId: id });
    return this.userRecord(u);
  }
  async updateUser(userId: string, patch: UserPatch, audit: AuditTemplate): Promise<UserWriteOutcome> {
    const u = this.users.get(userId);
    if (!u) return 'NOT_FOUND';
    const cur = this.userRecord(u);
    const role = patch.role ?? cur.role; const status = patch.status ?? cur.status;
    if (cur.kind === 'INTERNAL' && cur.role === 'ADMIN' && cur.status === 'ACTIVE' && !(role === 'ADMIN' && status === 'ACTIVE')) {
      const others = [...this.users.values()].map((x) => this.userRecord(x)).filter((x) => x.id !== userId && x.kind === 'INTERNAL' && x.role === 'ADMIN' && x.status === 'ACTIVE');
      if (!others.length) return 'LAST_ADMIN';
    }
    if (patch.customerId !== undefined) {
      const c = this.customers.get(patch.customerId);
      if (!c || (c.status ?? 'ACTIVE') === 'TERMINATED') return 'NO_SUCH_CUSTOMER';
      if (u.contactId) return 'CONTACT_LINKED';
      u.customerId = patch.customerId;
    }
    u.role = role; u.status = status;
    if (patch.clearGoogleSub) u.googleSub = null;
    this.audits.push({ ...audit, customerId: u.customerId ?? null, targetId: userId });
    return this.userRecord(u);
  }
  async touchLastLogin(userId: string, at: Date): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.lastLoginAt = at;
  }
  async enrolPortalUserByDomain(rawEmail: string, at: Date): Promise<EnrolOutcome> {
    const email = normalizeEmail(rawEmail);
    if (!email) return { refused: 'INVALID_EMAIL' };
    const domain = emailDomain(email);
    if (isFreeMail(domain)) return { refused: 'FREE_MAIL' };
    const owners = [...this.loginDomains].filter(([, ds]) => ds.includes(domain)).map(([id]) => id).filter((id) => this.customers.has(id));
    if (owners.length === 0) return { refused: 'DOMAIN_UNKNOWN' };
    if (owners.length > 1) return { refused: 'AMBIGUOUS' };
    const customerId = owners[0]!;
    if ((this.customers.get(customerId)!.status ?? 'ACTIVE') !== 'ACTIVE') return { refused: 'CUSTOMER_INACTIVE' };
    const existing = [...this.users.values()].find((u) => this.userRecord(u).email === email);
    if (existing) {
      const r = this.userRecord(existing);
      if (r.kind === 'INTERNAL') return { refused: 'STAFF_EMAIL' };
      if (r.customerId !== customerId) return { refused: 'OTHER_CUSTOMER' };
      return r.status === 'ACTIVE' ? { user: r, created: false } : { refused: 'USER_INACTIVE' };
    }
    const id = `usr_${++this.userSeq}_${this.nextId('u')}`;
    const u = { id, name: email.slice(0, email.indexOf('@')).slice(0, 80), contactId: null, email, role: 'VIEWER' as const, customerId, status: 'ACTIVE' as const, googleSub: null, lastLoginAt: null, createdAt: at };
    this.users.set(id, u);
    this.audits.push({ at, customerId, actorType: 'SYSTEM', actorId: null, action: 'user.enrol_domain', targetType: 'User', targetId: id, before: null, after: { kind: 'CUSTOMER', role: 'VIEWER', status: 'ACTIVE', reason: 'LOGIN_DOMAIN' } });
    return { user: this.userRecord(u), created: true };
  }
  async bindGoogleSub(userId: string, sub: string, at: Date): Promise<BindGoogleOutcome> {
    if (typeof sub !== 'string' || !sub || sub.length > 255 || /[\u0000-\u001f\u007f]/.test(sub)) throw new Error('bindGoogleSub: invalid sub');
    const u = this.users.get(userId);
    if (!u) return 'NOT_FOUND';
    const audit = (action: string, reason: string) => this.audits.push({ at, customerId: u.customerId ?? null, actorType: 'SYSTEM', actorId: null, action, targetType: 'User', targetId: userId, before: null, after: { reason } });
    if (u.googleSub === sub) return 'ok';
    if (u.googleSub) { audit('user.google_mismatch', 'GOOGLE_SUB_MISMATCH'); return 'mismatch'; }
    if ([...this.users.values()].some((x) => x.id !== userId && x.googleSub === sub)) { audit('user.google_mismatch', 'GOOGLE_SUB_IN_USE'); return 'mismatch'; }
    u.googleSub = sub;
    audit('user.google_bind', 'FIRST_SIGN_IN');
    return 'bound';
  }

  // ───────────── people ─────────────
  async sessionPrincipal(userId: string): Promise<Principal | null> {
    const u = this.users.get(userId);
    if (!u || (u.status ?? 'ACTIVE') !== 'ACTIVE') return null;
    // Mirror the SQL store (LEFT JOIN "Contact" c ON c."userId" = u."id"): the contact is the one linked to THIS user
    // and must exist — a dangling User.contactId is no contact (contactId null, no sub-scopes), not a half link.
    // (Memory contacts carry no userId: User.contactId is the link here, the same one-to-one link.)
    const contact = u.contactId ? this.contacts.get(u.contactId) : undefined;
    const contactId = contact?.id ?? null;
    const customerId = u.customerId ?? null;
    // Fail closed (same as the SQL store): a CUSTOMER contact's user must be bound to that very customer. The
    // customer is never filled in from the contact — a missing or different User.customerId is no session at all.
    if (contact?.kind === 'CUSTOMER' && contact.customerId !== customerId) return null;
    // D-42: a portal user of a customer that is not ACTIVE (or that does not exist) has no session. Staff are unaffected.
    if (customerId) {
      const cust = this.customers.get(customerId);
      if (!cust || (cust.status ?? 'ACTIVE') !== 'ACTIVE') return null;
    }
    const subScopes = customerId && contactId ? this.contactScopes.filter((s) => s.contactId === contactId && s.role === 'PORTAL_USER' && s.scopeType !== 'CUSTOMER')
      .map((s) => (s.scopeType === 'PROJECT' ? { customerId, projectId: s.scopeId } : { customerId, projectId: this.services.get(s.scopeId)?.projectId, serviceId: s.scopeId }))
      .map((x) => (x.projectId === undefined ? { customerId: x.customerId, serviceId: (x as { serviceId: string }).serviceId } : x)) : [];
    return { userId: u.id, email: u.email ?? `${u.id}@example.test`, name: u.name, customerId: customerId ?? null, role: u.role ?? (customerId ? 'VIEWER' : 'OPERATOR'), contactId, subScopes };
  }
  async respondersState(customerId: string): Promise<RespondersState> {
    const name = (t: string, id: string) => (t === 'CUSTOMER' ? this.customers.get(id)?.name : t === 'PROJECT' ? this.projects.get(id)?.name : this.services.get(id)?.name) ?? id;
    const entries = this.responders.filter((r) => r.customerId === customerId)
      .map((r, i) => ({ r, i, src: this.responderSource.get(`${customerId}|${r.contactId}`) }))
      .sort((a, b) => (a.r.order ?? 0) - (b.r.order ?? 0) || (a.r.contactId < b.r.contactId ? -1 : 1))
      .map(({ r, src }) => ({ contactId: r.contactId, role: r.role, source: src?.source ?? 'DIRECT' as const, templateId: src?.templateId ?? null, templateName: src?.templateName ?? null, order: r.order ?? 0 }));
    const scopes = this.contactScopes.filter((s) => s.customerId === customerId).map((s) => ({ contactId: s.contactId, scopeType: s.scopeType, scopeId: s.scopeId, scopeName: name(s.scopeType, s.scopeId), role: s.role }));
    return { version: this.respondersVersion.get(customerId) ?? 0, templateId: this.customerTemplate.get(customerId) ?? null, entries, scopes };
  }
  async writeResponders(customerId: string, expectedVersion: number, op: ResponderOp, audit: AuditInput): Promise<ResponderWriteOutcome> {
    if (audit.customerId !== customerId) throw new Error('writeResponders: audit must be for the same customer');
    if ((this.respondersVersion.get(customerId) ?? 0) !== expectedVersion) return 'CONFLICT';
    const has = (id: string) => this.responders.some((r) => r.customerId === customerId && r.contactId === id);
    const nextOrder = () => Math.max(-1, ...this.responders.filter((r) => r.customerId === customerId).map((r) => r.order ?? 0)) + 1;
    let contactId: string;
    if (op.kind === 'add') {
      if (has(op.contactId)) return 'EXISTS';
      this.responders.push({ customerId, contactId: op.contactId, role: op.role, order: nextOrder() });
      contactId = op.contactId;
    } else if (op.kind === 'create') {
      contactId = `ct_new_${++this.newContactSeq}`;
      const c: Contact = { id: contactId, kind: 'CUSTOMER', customerId, name: op.name, active: true, email: op.email, phone: op.phone };
      this.contacts.set(contactId, c);
      this.responders.push({ customerId, contactId, role: op.role, order: nextOrder() });
      for (const role of op.extras) this.contactScopes.push({ contactId, customerId, scopeType: 'CUSTOMER', scopeId: customerId, role });
    } else if (op.kind === 'role') {
      const r = this.responders.find((x) => x.customerId === customerId && x.contactId === op.contactId);
      if (!r) return 'GONE';
      r.role = op.role;
      contactId = op.contactId;
    } else {
      if (!has(op.contactId)) return 'GONE';
      this.responders = this.responders.filter((x) => !(x.customerId === customerId && x.contactId === op.contactId));
      contactId = op.contactId;
    }
    const version = expectedVersion + 1;
    this.respondersVersion.set(customerId, version);
    this.audits.push({ ...audit, targetId: contactId });
    return { contactId, version };
  }
  // ── Responder templates ──
  private templateView(t: { id: string; name: string; version: number; updatedBy: string | null; updatedAt: Date; members: string[] }): ResponderTemplateView {
    const nameOf = (id: string) => this.contacts.get(id)?.name ?? id;
    return {
      id: t.id, name: t.name, version: t.version, updatedAt: t.updatedAt, updatedBy: t.updatedBy,
      members: [...t.members].map((contactId) => ({ contactId, name: nameOf(contactId) })).sort((a, b) => a.name.localeCompare(b.name) || (a.contactId < b.contactId ? -1 : 1)),
      customers: [...this.customerTemplate].filter(([cid, tid]) => tid === t.id && (this.customers.get(cid)?.status ?? 'ACTIVE') !== 'TERMINATED')
        .map(([cid]) => ({ id: cid, name: this.customers.get(cid)?.name ?? cid })).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)),
    };
  }
  async listResponderTemplates(): Promise<ResponderTemplateView[]> {
    return [...this.templates.values()].map((t) => this.templateView(t)).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  }
  async getResponderTemplate(id: string): Promise<ResponderTemplateView | null> {
    const t = this.templates.get(id);
    return t ? this.templateView(t) : null;
  }
  private templatePaging(cid: string): TemplatePaging { return { configs: this.configsOf(cid), world: this.worldOf(cid), slackVerified: this.verifiedSlack.has(cid) }; }
  private impactInput(t: { id: string; name: string; version: number; members: string[] }, proposed: string[]): TemplateImpactInput {
    const ids = [...new Set([...t.members, ...proposed])];
    const names: Record<string, string> = {};
    for (const id of ids) names[id] = this.contacts.get(id)?.name ?? id;
    const customers = [...this.customerTemplate].filter(([cid, tid]) => tid === t.id && (this.customers.get(cid)?.status ?? 'ACTIVE') !== 'TERMINATED').map(([cid]) => ({
      id: cid, name: this.customers.get(cid)?.name ?? cid,
      responders: this.responders.filter((r) => r.customerId === cid).map((r) => {
        const src = this.responderSource.get(`${cid}|${r.contactId}`);
        return { contactId: r.contactId, source: src?.source ?? ('DIRECT' as const), templateId: src?.templateId ?? null };
      }),
      paging: this.templatePaging(cid),
      namedSteps: this.configs.filter((c) => c.customerId === cid).flatMap((c) => c.steps.filter((s) => s.targetType === 'PERSON' && s.targetId && ids.includes(s.targetId)).map((s) => ({ contactId: s.targetId!, stepIndex: s.index + 1 }))),
    }));
    return { templateId: t.id, version: t.version, name: t.name, members: [...t.members], names, customers };
  }
  async responderTemplateImpactInput(id: string, proposedMembers: string[]): Promise<TemplateImpactInput | null> {
    const t = this.templates.get(id);
    return t ? this.impactInput(t, proposedMembers) : null;
  }
  private staffOk = (ids: string[]) => ids.every((id) => { const c = this.contacts.get(id); return !!c && c.kind === 'INTERNAL' && c.active; });
  async createResponderTemplate(t: TemplateCreate, audit: AuditInput): Promise<ResponderTemplateView | 'NAME_EXISTS' | 'BAD_MEMBER'> {
    if ([...this.templates.values()].some((x) => x.name === t.name)) return 'NAME_EXISTS';
    if (!this.staffOk(t.members)) return 'BAD_MEMBER';
    const row = { id: `rt_${++this.templateSeq}`, name: t.name, version: 0, updatedBy: t.actorId, updatedAt: t.at, members: [...t.members] };
    this.templates.set(row.id, row);
    this.audits.push({ ...audit, targetId: row.id });
    return this.templateView(row);
  }
  async updateResponderTemplate(u: TemplateUpdate, audit: AuditInput): Promise<TemplateUpdateOutcome> {
    const t = this.templates.get(u.id);
    if (!t) return 'NOT_FOUND';
    if (t.version !== u.expectedVersion) return 'CONFLICT';
    if ([...this.templates.values()].some((x) => x.id !== t.id && x.name === u.proposal.name)) return 'NAME_EXISTS';
    if (!this.staffOk(u.proposal.members)) return 'BAD_MEMBER';
    const plan = planTemplateChange(this.impactInput(t, u.proposal.members), u.proposal);
    if (plan.previewHash !== u.previewHash) return 'STALE';
    const blocking = templateBlocking(this.impactInput(t, u.proposal.members), plan, u.at);
    if (blocking.length) return { blocking };
    let affected = 0;
    for (const c of plan.customers) {
      const joins = c.effects.filter((e) => e.kind === 'JOINS').map((e) => e.contactId);
      const leaves = c.effects.filter((e) => e.kind === 'LEAVES').map((e) => e.contactId);
      for (const id of joins) {
        const order = Math.max(-1, ...this.responders.filter((r) => r.customerId === c.id).map((r) => r.order ?? 0)) + 1;
        this.responders.push({ customerId: c.id, contactId: id, role: 'PAGEABLE', order });
        this.responderSource.set(`${c.id}|${id}`, { source: 'TEMPLATE', templateId: t.id, templateName: u.proposal.name });
      }
      for (const id of leaves) {
        this.responders = this.responders.filter((r) => !(r.customerId === c.id && r.contactId === id));
        this.responderSource.delete(`${c.id}|${id}`);
      }
      if (joins.length || leaves.length) {
        affected += 1;
        this.audits.push({ ...audit, customerId: c.id, action: 'responder_template.apply', targetId: t.id, before: null, after: { added: joins, removed: leaves } });
      }
      // a renamed template: the rows of its customers show the new name
      for (const [k, v] of this.responderSource) if (v.templateId === t.id) this.responderSource.set(k, { ...v, templateName: u.proposal.name });
    }
    const before = { name: t.name, members: [...t.members].sort(), version: t.version };
    t.name = u.proposal.name; t.members = [...u.proposal.members]; t.version += 1; t.updatedBy = u.actorId; t.updatedAt = u.at;
    this.audits.push({ ...audit, targetId: t.id, before, after: { name: t.name, members: [...t.members].sort(), version: t.version, added: plan.added, removed: plan.removed } });
    this.bulkChanges.push({ kind: 'TEMPLATE_UPDATE', actorId: u.actorId, params: { templateId: t.id, added: plan.added, removed: plan.removed }, preview: { customers: plan.customers.map((c) => ({ id: c.id, effects: c.effects })), totals: plan.totals }, previewHash: plan.previewHash, at: u.at });
    return { view: this.templateView(t), affected };
  }
  // ── one customer's template (D-64) ──
  private templateRef(id: string | null): TemplateRef | null {
    const t = id ? this.templates.get(id) : undefined;
    return t ? { id: t.id, name: t.name, version: t.version, members: [...t.members] } : null;
  }
  private attachInput(customerId: string, from: TemplateRef | null, to: TemplateRef | null): TemplateAttachInput {
    const ids = [...new Set([...(from?.members ?? []), ...(to?.members ?? [])])];
    const names: Record<string, string> = {};
    for (const id of ids) names[id] = this.contacts.get(id)?.name ?? id;
    const c = this.customers.get(customerId)!;
    return {
      customer: {
        id: customerId, name: c.name, status: (c.status ?? 'ACTIVE') as 'ACTIVE' | 'SUSPENDED' | 'TERMINATED', templateId: this.customerTemplate.get(customerId) ?? null,
        version: this.respondersVersion.get(customerId) ?? 0,
        responders: this.responders.filter((r) => r.customerId === customerId).map((r) => {
          const src = this.responderSource.get(`${customerId}|${r.contactId}`);
          return { contactId: r.contactId, source: src?.source ?? ('DIRECT' as const), templateId: src?.templateId ?? null };
        }),
        namedSteps: this.configs.filter((x) => x.customerId === customerId).flatMap((x) => x.steps.filter((s) => s.targetType === 'PERSON' && s.targetId && ids.includes(s.targetId)).map((s) => ({ contactId: s.targetId!, stepIndex: s.index + 1 }))),
        paging: this.templatePaging(customerId),
      },
      from, to, names,
    };
  }
  async customerTemplateAttachInput(customerId: string, toTemplateId: string | null): Promise<TemplateAttachInput | 'NO_TEMPLATE' | null> {
    if (!this.customers.has(customerId)) return null;
    if (toTemplateId !== null && !this.templates.has(toTemplateId)) return 'NO_TEMPLATE';
    return this.attachInput(customerId, this.templateRef(this.customerTemplate.get(customerId) ?? null), this.templateRef(toTemplateId));
  }
  async setCustomerTemplate(w: TemplateAttachWrite, audit: AuditInput): Promise<TemplateAttachOutcome> {
    if (audit.customerId !== w.customerId) throw new Error('setCustomerTemplate: audit must be for the same customer');
    const cus = this.customers.get(w.customerId);
    if (!cus) return 'NOT_FOUND';
    if (w.toTemplateId !== null && !this.templates.has(w.toTemplateId)) return 'NO_TEMPLATE';
    if ((cus.status ?? 'ACTIVE') === 'TERMINATED') return 'TERMINATED';
    if ((this.respondersVersion.get(w.customerId) ?? 0) !== w.expectedVersion) return 'CONFLICT';
    const from = this.templateRef(this.customerTemplate.get(w.customerId) ?? null);
    const to = this.templateRef(w.toTemplateId);
    const input = this.attachInput(w.customerId, from, to);
    const plan = planTemplateAttach(input);
    if (plan.previewHash !== w.previewHash) return 'STALE';
    const blocking = attachBlocking(input, plan, w.at);
    if (blocking.length) return { blocking };
    for (const id of plan.leaves) {
      this.responders = this.responders.filter((r) => !(r.customerId === w.customerId && r.contactId === id));
      this.responderSource.delete(`${w.customerId}|${id}`);
    }
    for (const id of plan.retarget) this.responderSource.set(`${w.customerId}|${id}`, { source: 'TEMPLATE', templateId: to!.id, templateName: to!.name });
    for (const id of plan.joins) {
      const order = Math.max(-1, ...this.responders.filter((r) => r.customerId === w.customerId).map((r) => r.order ?? 0)) + 1;
      this.responders.push({ customerId: w.customerId, contactId: id, role: 'PAGEABLE', order });
      this.responderSource.set(`${w.customerId}|${id}`, { source: 'TEMPLATE', templateId: to!.id, templateName: to!.name });
    }
    if (w.toTemplateId === null) this.customerTemplate.delete(w.customerId); else this.customerTemplate.set(w.customerId, w.toTemplateId);
    const version = w.expectedVersion + 1;
    this.respondersVersion.set(w.customerId, version);
    this.audits.push({ ...audit, before: { templateId: from?.id ?? null }, after: { templateId: to?.id ?? null, added: plan.joins, removed: plan.leaves } });
    return { version, templateId: w.toTemplateId, joins: plan.joins.length, leaves: plan.leaves.length };
  }
  async rotationsWorld(scope: ScopeFilter): Promise<RotationsWorld> {
    const rotations = [...this.rotations.values()].filter((r) => r.scope === 'MSP' || (r.customerId != null && seesCustomer(scope, r.customerId))).map((r) => structuredClone(r));
    const ids = new Set(rotations.flatMap((r) => r.members.map((m) => m.contactId)));
    const ovs = this.overrides.filter((o) => rotations.some((r) => r.id === o.rotationId));
    for (const o of ovs) ids.add(o.contactId);
    const leaves = this.leaves.filter((l) => ids.has(l.contactId));
    for (const l of leaves) ids.add(l.replacementId);
    const contacts = new Map([...ids].map((id) => this.contacts.get(id)).filter((c): c is Contact => !!c).map((c) => [c.id, structuredClone(c)]));
    return { rotations, overrides: structuredClone(ovs), leaves: structuredClone(leaves), contacts };
  }
  async staffContacts(): Promise<Contact[]> {
    return [...this.contacts.values()].filter((c) => c.kind === 'INTERNAL' && c.active).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)).map((c) => structuredClone(c));
  }

  // ── contact reveal (D-35) ──
  async responderCustomerIdsOfContact(contactId: string) { return [...new Set(this.responders.filter((r) => r.contactId === contactId).map((r) => r.customerId))].sort(); }
  async adminStaff() {
    return [...this.users.values()]
      .filter((u) => u.role === 'ADMIN' && (u.status ?? 'ACTIVE') === 'ACTIVE' && !u.customerId && u.contactId)
      .map((u) => this.contacts.get(u.contactId!)).filter((c): c is Contact => !!c && c.kind === 'INTERNAL' && c.active)
      .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)).map((c) => ({ contactId: c.id, name: c.name }));
  }
  async recordReveal(w: RevealWrite): Promise<RevealWriteOutcome> {
    if (this.failRevealWrites) throw new Error('reveal log write failed');
    const at = this.clock();
    const mine = this.revealLogs.filter((r) => r.actorUserId === w.actorUserId);
    // The row that, once it leaves the window, frees a slot: the `limit`-th newest inside the window.
    const wait = (windowMs: number, limit: number, rows: RevealLogEntry[]): number => {
      const inWin = rows.filter((r) => r.at.getTime() > at.getTime() - windowMs).sort((a, b) => b.at.getTime() - a.at.getTime());
      const edge = inWin[limit - 1];
      return edge ? Math.max(1, Math.ceil((edge.at.getTime() + windowMs - at.getTime()) / 1000)) : 0;
    };
    const minute = wait(60_000, w.limits.perMinute, mine);
    const hour = w.mode === 'EMERGENCY' ? wait(3_600_000, w.limits.emergencyPerHour, mine.filter((r) => r.mode === 'EMERGENCY')) : 0;
    if (minute || hour) return { ok: false, retryAfterSec: Math.max(minute, hour) };
    const id = `crl_${++this.revealSeq}`;
    this.revealLogs.push({ ...structuredClone(w), id, at });
    this.audits.push({ at, customerId: w.customerId, actorType: 'USER', actorId: w.actorUserId, action: 'contact.reveal', targetType: 'Contact', targetId: w.contactId, after: { revealLogId: id, mode: w.mode }, requestId: w.requestId });
    return { ok: true, id, at };
  }
  async revealLog(f: RevealLogFilter): Promise<{ rows: RevealLogRow[]; hasMore: boolean }> {
    const rows = this.revealLogs
      .filter((r) => (f.customerIds === null || (r.customerId !== null && f.customerIds.includes(r.customerId)))
        && (!f.mode || r.mode === f.mode) && (!f.actorUserId || r.actorUserId === f.actorUserId) && (!f.contactId || r.contactId === f.contactId)
        && (!f.from || r.at >= f.from) && (!f.to || r.at <= f.to))
      .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
      .filter((r) => !f.after || r.at.toISOString() < f.after.t || (r.at.toISOString() === f.after.t && r.id < f.after.id));
    const page = rows.slice(0, f.limit).map((r): RevealLogRow => {
      const c = r.customerId ? this.customers.get(r.customerId) : undefined;
      return {
        id: r.id, at: r.at, mode: r.mode, actorUserId: r.actorUserId, actorName: this.users.get(r.actorUserId)?.name ?? r.actorUserId, actorRole: r.actorRole, contactId: r.contactId, contactName: r.contactName,
        customer: c ? { id: c.id, name: c.name, slug: c.slug } : null, channel: r.channel, reason: r.reason,
        notified: r.notifiedContactIds.map((id) => ({ contactId: id, name: this.contacts.get(id)?.name ?? id })),
      };
    });
    return { rows: page, hasMore: rows.length > f.limit };
  }
}
