import { DEFAULT_POLICY, DEFAULT_SEVERITY_TABLE, type GroupRow, type MaintenanceWindow, type NormalizedEvent, type Severity, type SuppressionPolicy } from '@alarmops/core';
import type { AlertRepository, AlertRow, IngestRejectionInput, IntegrationSourceRow, RawEventDecision, SourceRepository } from './ports.js';

/**
 * In-memory repositories with the same conflict semantics as the Postgres schema:
 * RawEvent.dedupKey UQ, Alert.fingerprint UQ, version-checked updates, one OPEN group per key.
 * For tests and local runs only.
 */
export class MemoryStore implements AlertRepository, SourceRepository {
  rawEvents = new Map<string, NormalizedEvent & { id: string; alertId: string } & Partial<RawEventDecision>>();
  rawByKey = new Map<string, string>();
  alerts = new Map<string, AlertRow>(); // by alertScopeKey(customerId, fingerprint)
  groups = new Map<string, GroupRow>();
  sources: IntegrationSourceRow[] = [];
  accounts = new Map<string, string>();
  rejections: IngestRejectionInput[] = [];
  touched: Array<{ sourceId: string; at: Date }> = [];
  windows: MaintenanceWindow[] = [];
  policy: SuppressionPolicy = { ...DEFAULT_POLICY };
  table: Record<string, Severity> = { ...DEFAULT_SEVERITY_TABLE };
  private seq = 0;
  /** Test hook: make the next N alert updates conflict. */
  forceConflicts = 0;

  async insertRawEvent(ev: NormalizedEvent, alertId: string) {
    if (this.rawByKey.has(ev.dedupKey)) return 'DUPLICATE' as const;
    const id = `raw_${++this.seq}`;
    this.rawByKey.set(ev.dedupKey, id);
    this.rawEvents.set(id, { ...structuredClone(ev), id, alertId });
    return { id };
  }
  async setRawEventDecision(id: string, d: RawEventDecision) {
    const r = this.rawEvents.get(id);
    if (r) Object.assign(r, d);
  }
  async findAlert(customerId: string | null, fp: string) {
    const a = this.alerts.get(alertScopeKey(customerId, fp));
    return a ? structuredClone(a) : null;
  }
  async findAlertInOtherScope(customerId: string | null, fp: string) {
    const others = [...this.alerts.values()].filter((a) => a.fingerprint === fp && a.customerId !== customerId);
    const last = others.sort((x, y) => y.lastEventAt.getTime() - x.lastEventAt.getTime())[0];
    return last ? { id: last.id, customerId: last.customerId } : null;
  }
  async createAlert(row: AlertRow) {
    const k = alertScopeKey(row.customerId, row.fingerprint);
    if (this.alerts.has(k)) return 'EXISTS' as const;
    this.alerts.set(k, structuredClone(row));
    return structuredClone(row);
  }
  async updateAlert(row: AlertRow, expectedVersion: number) {
    const k = alertScopeKey(row.customerId, row.fingerprint);
    const cur = this.alerts.get(k);
    if (this.forceConflicts > 0) { this.forceConflicts--; if (cur) cur.version++; return 'CONFLICT' as const; }
    if (!cur || cur.version !== expectedVersion) return 'CONFLICT' as const;
    const next = { ...structuredClone(row), version: expectedVersion + 1 };
    if (cur.customerId !== row.customerId) return 'CONFLICT' as const;
    this.alerts.set(k, next);
    return structuredClone(next);
  }
  async loadPolicy() { return this.policy; }
  async activeMaintenance(customerId: string | null) {
    return this.windows.filter((w) => w.customerId == null || w.customerId === customerId);
  }
  async findOpenGroup(key: string) {
    const g = [...this.groups.values()].find((x) => x.groupKey === key && x.status === 'OPEN');
    return g ? structuredClone(g) : null;
  }
  async groupIdExists(id: string) { return this.groups.has(id); }
  async createGroup(g: GroupRow, replaceStaleId?: string) {
    if (replaceStaleId) {
      const stale = this.groups.get(replaceStaleId);
      if (stale && stale.status === 'OPEN') { stale.status = 'CLOSED'; stale.version++; }
    }
    if ([...this.groups.values()].some((x) => x.groupKey === g.groupKey && x.status === 'OPEN')) return 'EXISTS' as const;
    if (this.groups.has(g.id)) return 'EXISTS' as const;
    this.groups.set(g.id, structuredClone(g));
    return structuredClone(g);
  }
  async closeGroup(id: string, at: Date) {
    const g = this.groups.get(id);
    if (!g || g.status !== 'OPEN') return false;
    g.status = 'CLOSED';
    g.closedAt = at;
    g.version++;
    return true;
  }

  // SourceRepository
  async findSourceByTokenHash(h: string) { return this.sources.find((s) => s.tokenHash === h) ?? null; }
  async touchSource(sourceId: string, at: Date) { this.touched.push({ sourceId, at }); }
  async recordRejection(r: IngestRejectionInput) { this.rejections.push(r); }
  async customerForAccount(a: string) { return this.accounts.get(a) ?? null; }
  async severityTable() { return this.table; }
}

export const alertScopeKey = (customerId: string | null, fingerprint: string): string => `${customerId ?? '-'}|${fingerprint}`;
