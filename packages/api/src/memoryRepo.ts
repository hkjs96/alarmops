/**
 * In-memory ApiRepository on top of the tick store, so the API and the tick see one world.
 * Scope is applied inside every read, the same way the SQL adapter must do it. Tests and local runs only.
 */
import { MemoryTickStore, incidentMute, parseSnapshot, type AuditInput, type IncidentRow, type PagingConfig } from '@alarmops/core';
import { inScope, nodeVisible, seesCustomer, type ScopeFilter } from './auth.js';
import type { UserInfo } from './audience.js';
import type { AlertMemberRow, ApiRepository, IdempotentEntry, IncidentFilter, IncidentPage, NodeFilter, NotifiedPerson, OpenCounts, StatusCounts, UndoRecord } from './repo.js';

export interface ContactScopeRow { contactId: string; customerId: string; scopeType: 'CUSTOMER' | 'PROJECT' | 'SERVICE'; scopeId: string; role: 'NOTIFY' | 'APPROVER' | 'PORTAL_USER' }

export class MemoryApiStore extends MemoryTickStore implements ApiRepository {
  users = new Map<string, { id: string; name: string; contactId: string | null }>();
  contactScopes: ContactScopeRow[] = [];
  resources = new Map<string, { id: string; name: string; customerId: string; serviceId: string | null }>();
  verifiedSlack = new Set<string>();
  undo = new Map<string, UndoRecord>();
  idempotent = new Map<string, { entry: IdempotentEntry; expiresAt: Date }>();
  /** Last version of deleted paging configs, so a re-created one continues the sequence (N-3). */
  configTombstones = new Map<string, number>();
  /** Counts scoped reads, so tests can assert that out-of-scope ids never reach an unscoped lookup. */
  reads: string[] = [];

  async orgTree(scope: ScopeFilter) {
    const svcProject = (id: string) => this.services.get(id)?.projectId;
    return {
      customers: [...this.customers.values()].filter((c) => seesCustomer(scope, c.id)).map((c) => ({ ...c })),
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
  async takeUndo(token: string) {
    const r = this.undo.get(token) ?? null;
    this.undo.delete(token);
    return r;
  }

  async savePagingConfig(cfg: PagingConfig, expectedVersion: number | null, audit: AuditInput) {
    const i = this.configs.findIndex((c) => c.customerId === cfg.customerId && c.scopeType === cfg.scopeType && c.scopeId === cfg.scopeId);
    if (expectedVersion === null ? i >= 0 : i < 0 || this.configs[i]!.version !== expectedVersion) return 'CONFLICT' as const;
    const key = `${cfg.customerId}|${cfg.scopeType}|${cfg.scopeId}`;
    const stored: PagingConfig = { ...structuredClone(cfg), version: (expectedVersion ?? this.configTombstones.get(key) ?? 0) + 1 };
    if (i >= 0) this.configs[i] = stored; else this.configs.push(stored);
    this.audits.push(audit);
    return structuredClone(stored);
  }
  async deletePagingConfig(id: string, expectedVersion: number, audit: AuditInput) {
    const i = this.configs.findIndex((c) => c.id === id);
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
  async getIdempotent(key: string, now: Date) {
    const hit = this.idempotent.get(key);
    return hit && hit.expiresAt.getTime() > now.getTime() ? structuredClone(hit.entry) : null;
  }
  async putIdempotent(key: string, entry: IdempotentEntry, expiresAt: Date) { this.idempotent.set(key, { entry: structuredClone(entry), expiresAt }); }
}
