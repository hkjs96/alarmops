/**
 * In-memory ApiRepository on top of the tick store, so the API and the tick see one world.
 * Scope is applied inside every read, the same way the SQL adapter must do it. Tests and local runs only.
 */
import { MemoryTickStore, incidentMute, type DigestData, type PurgeLogEntry, type RetentionStage, parseSnapshot, type AuditInput, type Contact, type IncidentRow, type PagingConfig } from '@alarmops/core';
import { inScope, nodeVisible, seesCustomer, type Role, type ScopeFilter } from './auth.js';
import type { UserInfo } from './audience.js';
import type { ExportIncidentRow, RetentionView } from './repo.js';
import { OFFBOARD_STEP_KEYS, type ChangeStatusOutcome, type CustomerStatusState, type CustomerStatusValue, type MarkStepOutcome, type OffboardStepKey, type OffboardingState, type Principal, ResponderOp, ResponderWriteOutcome, RespondersState, RotationsWorld, AlertMemberRow, ApiRepository, IdempotentEntry, IncidentFilter, IncidentPage, NodeFilter, NotifiedPerson, OpenCounts, StatusCounts, UndoRecord } from './repo.js';

export interface ContactScopeRow { contactId: string; customerId: string; scopeType: 'CUSTOMER' | 'PROJECT' | 'SERVICE'; scopeId: string; role: 'NOTIFY' | 'APPROVER' | 'PORTAL_USER' }

export class MemoryApiStore extends MemoryTickStore implements ApiRepository {
  users = new Map<string, { id: string; name: string; contactId: string | null; email?: string; role?: Role; customerId?: string | null; status?: 'ACTIVE' | 'PENDING' | 'DISABLED' }>();
  /** Responders list versions (never restart) and the source of each responder row (DIRECT unless set). */
  respondersVersion = new Map<string, number>();
  responderSource = new Map<string, { source: 'DIRECT' | 'TEMPLATE'; templateId: string; templateName: string }>();
  customerTemplate = new Map<string, string>();
  private newContactSeq = 0;
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
      customers: [...this.customers.values()].filter((c) => seesCustomer(scope, c.id)).map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
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
  async slackChannelVerified(customerId: string) { return this.verifiedSlack.has(customerId); }
  async findResource(scope: ScopeFilter, id: string) {
    const r = this.resources.get(id);
    if (!r) return null;
    const projectId = r.serviceId ? this.services.get(r.serviceId)?.projectId ?? null : null;
    return inScope(scope, { customerId: r.customerId, projectId, serviceId: r.serviceId }) ? { ...r, projectId } : null;
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
  async digestData(from: Date, to: Date): Promise<DigestData> {
    const inWin = (t: Date): boolean => t.getTime() >= from.getTime() && t.getTime() < to.getTime();
    const by = new Map<string, { customerId: string; customerName: string; incidents: number; firstAt: Date; lastAt: Date }>();
    for (const i of this.incidents.values()) {
      if (i.pagingSuppressed !== 'CUSTOMER_SUSPENDED' || !i.customerId || !inWin(i.triggeredAt)) continue;
      const cur = by.get(i.customerId);
      if (cur) { cur.incidents++; if (i.triggeredAt < cur.firstAt) cur.firstAt = i.triggeredAt; if (i.triggeredAt > cur.lastAt) cur.lastAt = i.triggeredAt; }
      else by.set(i.customerId, { customerId: i.customerId, customerName: this.customers.get(i.customerId)?.name ?? i.customerId, incidents: 1, firstAt: i.triggeredAt, lastAt: i.triggeredAt });
    }
    const terminated: DigestData['terminatedResiduals'] = [];
    for (const [cid, rs] of this.residuals) {
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
}
