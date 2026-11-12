/**
 * Ingest repositories on Postgres (services/ingest ports: SourceRepository + AlertRepository). Same conflict
 * semantics as the in-memory MemoryStore; the shared contract (services/ingest/test/contract) runs against both.
 *
 * - RawEvent: INSERT … ON CONFLICT ("dedupKey") DO NOTHING → 'DUPLICATE' (F-3).
 * - Alert identity (customerId, fingerprint) with the UQ NULLS NOT DISTINCT of the migration (B-4/B-6); a create
 *   that loses the race is 'EXISTS'. Updates are `WHERE id AND version AND customerId IS NOT DISTINCT FROM`.
 * - AlertGroup: one OPEN group per key (partial UQ); a losing create is 'EXISTS'.
 */
import { DEFAULT_SEVERITY_TABLE, type GroupRow, type MaintenanceWindow, type NormalizedEvent, type Severity, type SuppressionPolicy } from '@alarmops/core';
import type { AlertRepository, AlertRow, IngestRejectionInput, IntegrationSourceRow, RawEventDecision, SourceRepository } from '@alarmops/ingest';
import { PG, pgCode, type SqlClient, type SqlRow } from './client.js';
import { GROUP_COLS, d, dReq, iso, js, newId, num, toGroup } from './rows.js';
import { SqlTickStore } from './tickRepo.js';

const ALERT_COLS = `"id", "fingerprint", "fingerprintVersion", "customerId", "sourceId", "source", "awsAccountId", "region", "resourceType", "metricKey", "namespace", "title",
  "status", "severity", "severityRaw", "value", "threshold", "comparison", "lastNotifiedAt", "episodeOpen", "episodeStartedAt", "episodeNotified",
  "recentEpisodes", "quarantinedUntil", "fireCount", "firstSeenAt", "lastEventAt", "version"`;

const toAlert = (r: SqlRow): AlertRow => ({
  id: r.id, fingerprint: r.fingerprint, fingerprintVersion: r.fingerprintVersion, customerId: r.customerId ?? null, sourceId: r.sourceId ?? null, source: r.source,
  awsAccountId: r.awsAccountId ?? null, region: r.region ?? null, resourceType: r.resourceType ?? null, metricKey: r.metricKey ?? null, namespace: r.namespace ?? null,
  title: r.title, status: r.status, severity: r.severity, severityRaw: r.severityRaw ?? null, value: num(r.value), threshold: num(r.threshold), comparison: r.comparison ?? null,
  lastNotifiedAt: d(r.lastNotifiedAt), episodeOpen: r.episodeOpen, episodeStartedAt: d(r.episodeStartedAt), episodeNotified: r.episodeNotified,
  recentEpisodes: ((r.recentEpisodes ?? []) as unknown[]).map(dReq), quarantinedUntil: d(r.quarantinedUntil), fireCount: r.fireCount,
  firstSeenAt: dReq(r.firstSeenAt), lastEventAt: dReq(r.lastEventAt), version: r.version,
});

/** Alert values in ALERT_COLS order ($1…$28). */
const alertParams = (a: AlertRow): unknown[] => [
  a.id, a.fingerprint, a.fingerprintVersion, a.customerId, a.sourceId, a.source, a.awsAccountId, a.region, a.resourceType, a.metricKey, a.namespace, a.title,
  a.status, a.severity, a.severityRaw, a.value, a.threshold, a.comparison, iso(a.lastNotifiedAt), a.episodeOpen, iso(a.episodeStartedAt), a.episodeNotified,
  js(a.recentEpisodes.map((x) => x.toISOString())), iso(a.quarantinedUntil), a.fireCount, iso(a.firstSeenAt), iso(a.lastEventAt), a.version,
];
const ALERT_VALUES = `$1, $2, $3, $4, $5, $6::"SourceKind", $7, $8, $9, $10, $11, $12, $13::"AlertStatus", $14::"Severity", $15, $16, $17, $18, $19::timestamptz, $20,
  $21::timestamptz, $22, ARRAY(SELECT jsonb_array_elements_text($23::jsonb)::timestamptz), $24::timestamptz, $25, $26::timestamptz, $27::timestamptz, $28`;

export class SqlIngestStore implements AlertRepository, SourceRepository {
  private readonly tick: SqlTickStore;
  constructor(private readonly sql: SqlClient) { this.tick = new SqlTickStore(sql); }

  // ── SourceRepository ──
  async findSourceByTokenHash(tokenHash: string): Promise<IntegrationSourceRow | null> {
    const [r] = await this.sql.query(`SELECT "id", "customerId", "kind", "tokenHash", "enabled", "allowQueryToken" FROM "IntegrationSource" WHERE "tokenHash" = $1`, [tokenHash]);
    return r ? { id: r.id, customerId: r.customerId, kind: r.kind, tokenHash: r.tokenHash ?? null, enabled: r.enabled, allowQueryToken: r.allowQueryToken } : null;
  }
  async touchSource(sourceId: string, at: Date): Promise<void> {
    // never moves backwards, never past the store clock
    await this.sql.query(`UPDATE "IntegrationSource" SET "lastReceivedAt" = GREATEST(COALESCE("lastReceivedAt", '-infinity'::timestamptz), LEAST($2::timestamptz, ${this.sql.now()})) WHERE "id" = $1`, [sourceId, iso(at)]);
  }
  async recordRejection(r: IngestRejectionInput): Promise<void> {
    await this.sql.query(
      `INSERT INTO "IngestRejection"("id", "receivedAt", "customerId", "sourceId", "kind", "reason", "awsAccountId", "title") VALUES ($1, ${this.sql.now()}, $2, $3, $4, $5, $6, $7)`,
      [newId('rej'), r.customerId ?? null, r.sourceId ?? null, r.kind, r.reason, r.awsAccountId ?? null, r.title ?? null]);
  }
  async customerForAccount(awsAccountId: string): Promise<string | null> {
    const [r] = await this.sql.query(`SELECT "customerId" FROM "CloudAccount" WHERE "awsAccountId" = $1 ORDER BY "id" LIMIT 1`, [awsAccountId]);
    return r ? (r.customerId as string) : null;
  }
  async severityTable(): Promise<Record<string, Severity>> {
    const rows = await this.sql.query(`SELECT "matchValue", "severity" FROM "SeverityMapping"`);
    return rows.length ? Object.fromEntries(rows.map((r) => [r.matchValue as string, r.severity as Severity])) : { ...DEFAULT_SEVERITY_TABLE };
  }

  // ── AlertRepository ──
  async insertRawEvent(ev: NormalizedEvent, alertId: string): Promise<{ id: string } | 'DUPLICATE'> {
    const id = newId('raw');
    const rows = await this.sql.query(
      `INSERT INTO "RawEvent"("id", "dedupKey", "customerId", "sourceId", "source", "awsAccountId", "region", "fingerprint", "fingerprintVersion", "state", "previousState",
         "severity", "severityRaw", "occurredAt", "receivedAt", "alertId", "raw", "parseError")
       SELECT $1, $2, $3, (SELECT s."id" FROM "IntegrationSource" s WHERE s."id" = $4), $5::"SourceKind", $6, $7, $8, $9, $10::"EventState", $11, $12::"Severity", $13,
              $14::timestamptz, $15::timestamptz, $16, $17::jsonb, $18
       ON CONFLICT ("dedupKey") DO NOTHING RETURNING "id"`,
      [id, ev.dedupKey, ev.customerId, ev.sourceId, ev.source, ev.awsAccountId, ev.region, ev.fingerprint, ev.fingerprintVersion, ev.state, ev.previousState,
        ev.severity, ev.severityRaw, ev.occurredAt, ev.receivedAt, alertId, js(ev.raw ?? {}) ?? '{}', ev.parseError]);
    return rows.length ? { id } : 'DUPLICATE';
  }
  async setRawEventDecision(rawEventId: string, x: RawEventDecision): Promise<void> {
    await this.sql.query(`UPDATE "RawEvent" SET "decision" = $2::"Decision", "decisionReason" = $3, "groupId" = $4 WHERE "id" = $1`, [rawEventId, x.decision, x.decisionReason, x.groupId ?? null]);
  }
  async findAlert(customerId: string | null, fingerprint: string): Promise<AlertRow | null> {
    const [r] = await this.sql.query(`SELECT ${ALERT_COLS} FROM "Alert" WHERE "customerId" IS NOT DISTINCT FROM $1 AND "fingerprint" = $2`, [customerId, fingerprint]);
    return r ? toAlert(r) : null;
  }
  async findAlertInOtherScope(customerId: string | null, fingerprint: string): Promise<{ id: string; customerId: string | null } | null> {
    const [r] = await this.sql.query(`SELECT "id", "customerId" FROM "Alert" WHERE "customerId" IS DISTINCT FROM $1 AND "fingerprint" = $2 ORDER BY "lastEventAt" DESC, "id" LIMIT 1`, [customerId, fingerprint]);
    return r ? { id: r.id, customerId: r.customerId ?? null } : null;
  }
  async createAlert(row: AlertRow): Promise<AlertRow | 'EXISTS'> {
    try {
      const [r] = await this.sql.query(`INSERT INTO "Alert"(${ALERT_COLS}) VALUES (${ALERT_VALUES}) RETURNING ${ALERT_COLS}`, alertParams(row));
      return toAlert(r!);
    } catch (e) {
      if (pgCode(e) === PG.UNIQUE) return 'EXISTS';
      throw e;
    }
  }
  async updateAlert(row: AlertRow, expectedVersion: number): Promise<AlertRow | 'CONFLICT'> {
    const p = alertParams({ ...row, version: expectedVersion + 1 });
    const rows = await this.sql.query(
      `UPDATE "Alert" SET ("fingerprintVersion", "sourceId", "awsAccountId", "region", "resourceType", "metricKey", "namespace", "title", "status", "severity", "severityRaw",
          "value", "threshold", "comparison", "lastNotifiedAt", "episodeOpen", "episodeStartedAt", "episodeNotified", "recentEpisodes", "quarantinedUntil", "fireCount", "lastEventAt", "version")
        = ($3, $5, $7, $8, $9, $10, $11, $12, $13::"AlertStatus", $14::"Severity", $15, $16, $17, $18, $19::timestamptz, $20, $21::timestamptz, $22,
           ARRAY(SELECT jsonb_array_elements_text($23::jsonb)::timestamptz), $24::timestamptz, $25, $27::timestamptz, $28)
        WHERE "id" = $1 AND "fingerprint" = $2 AND "customerId" IS NOT DISTINCT FROM $4 AND "version" = $29 AND $6::"SourceKind" IS NOT NULL AND $26::timestamptz IS NOT NULL
        RETURNING ${ALERT_COLS}`,
      [...p, expectedVersion]);
    return rows[0] ? toAlert(rows[0]) : 'CONFLICT';
  }
  loadPolicy(): Promise<SuppressionPolicy> { return this.tick.loadPolicy(); }
  activeMaintenance(customerId: string | null, at: Date): Promise<MaintenanceWindow[]> { return this.tick.maintenanceWindows(customerId, at); }
  async findOpenGroup(groupKey: string): Promise<GroupRow | null> {
    const [r] = await this.sql.query(`SELECT ${GROUP_COLS} FROM "AlertGroup" WHERE "groupKey" = $1 AND "status" = 'OPEN'`, [groupKey]);
    return r ? toGroup(r) : null;
  }
  async groupIdExists(id: string): Promise<boolean> {
    return (await this.sql.query(`SELECT 1 FROM "AlertGroup" WHERE "id" = $1`, [id])).length > 0;
  }
  async createGroup(g: GroupRow, replaceStaleId?: string): Promise<GroupRow | 'EXISTS'> {
    try {
      return await this.sql.transaction(async (tx) => {
        if (replaceStaleId) await tx.query(`UPDATE "AlertGroup" SET "status" = 'CLOSED', "closedAt" = COALESCE("closedAt", ${this.sql.now()}), "sweptReason" = 'stale', "version" = "version" + 1 WHERE "id" = $1 AND "status" = 'OPEN'`, [replaceStaleId]);
        const [r] = await tx.query(
          `INSERT INTO "AlertGroup"(${GROUP_COLS}) VALUES ($1, $2, $3, $4::"Severity", $5::"GroupStatus", $6::timestamptz, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::timestamptz, $13)
           RETURNING ${GROUP_COLS}`,
          [g.id, g.groupKey, g.customerId, g.severity, g.status, iso(g.openedAt), g.groupWaitSec, iso(g.closeAt), iso(g.closedAt ?? null), iso(g.pauseUntil), iso(g.staleAfter), iso(g.deliveredAt), g.version]);
        return toGroup(r!);
      });
    } catch (e) {
      if (pgCode(e) === PG.UNIQUE) return 'EXISTS';
      throw e;
    }
  }
  closeGroup(groupId: string, at: Date): Promise<boolean> { return this.tick.closeGroup(groupId, at); }
}
