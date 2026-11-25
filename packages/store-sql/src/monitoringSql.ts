/**
 * Monitoring reads (API-CONTRACT §8.5): Resource and ManagedAlarm with their org position. The org position of a
 * resource is the service of its CloudAccount; the caller's ScopeFilter is a predicate INSIDE the statement
 * (`scopeSql`), so another tenant's id and an unknown id return the same empty result. Sorting uses COLLATE "C" so
 * the order (and the cursor comparison) is the same on every server and in the memory store.
 */
import type { ManagedAlarmFilter, ManagedAlarmRecord, MonitoringCursor, MonitoringPage, NodeFilter, ResourceFilter, ResourceRecord, ScopeFilter } from '@alarmops/api';
import type { SqlExecutor, SqlRow } from './client.js';
import { Params, d, dReq } from './rows.js';
import { scopeSql } from './apiRepo.js';

/** Visible resources (scope in the WHERE), with the columns every monitoring read needs. `sk` = sort key. */
const visibleResources = (p: Params, scope: ScopeFilter, extraWhere = 'true'): string =>
  `SELECT r."id", r."customerId", s."projectId" AS "projectId", s."id" AS "serviceId", r."cloudAccountId", ca."awsAccountId", ca."alias" AS "accountAlias",
          ca."alarmWriterEnabled", ca."tagWriterEnabled", (cu."status" = 'ACTIVE' AND NOT ca."disabled" AND ca."connectionPurgedAt" IS NULL) AS "accountActive", r."region", r."resourceType", r."resourceKey", r."name", r."tags", r."monitoringState",
          r."needsReviewSince", r."needsReviewReason", r."lastSeenAt", COALESCE(r."name", r."resourceKey") AS "sk"
     FROM "Resource" r
     JOIN "CloudAccount" ca ON ca."id" = r."cloudAccountId" AND ca."customerId" = r."customerId"
     JOIN "Customer" cu ON cu."id" = r."customerId"
     LEFT JOIN "Service" s ON s."id" = ca."serviceId" AND s."customerId" = r."customerId"
    WHERE ${scopeSql(p, scope, 'r', { project: 's."projectId"', service: 's."id"' })} AND ${extraWhere}`;

/** The node filter over a visible-resource alias (customerId / projectId / serviceId). */
function inNodeSql(p: Params, node: NodeFilter | null, v: string): string {
  if (!node) return 'true';
  const ids = p.add([...node.customerIds]);
  return `(${v}."customerId" = ANY(${ids}::text[])${node.projectId ? ` AND ${v}."projectId" IS NOT DISTINCT FROM ${p.add(node.projectId)}` : ''}${node.serviceId ? ` AND ${v}."serviceId" IS NOT DISTINCT FROM ${p.add(node.serviceId)}` : ''})`;
}

const outsideSql = (inNode: string): string =>
  `(SELECT count(*) FROM visible v WHERE NOT ${inNode} AND v."monitoringState" = 'NEEDS_REVIEW')::int AS "needsReview",
   (SELECT count(*) FROM "ManagedAlarm" m JOIN visible v ON v."id" = m."resourceId" AND v."customerId" = m."customerId" WHERE NOT ${inNode} AND m."state" = 'ALARM')::int AS "inAlarm"`;

const after = (p: Params, col: string, c: MonitoringCursor | undefined, idCol: string): string =>
  c ? `(${col} COLLATE "C", ${idCol} COLLATE "C") > (${p.add(c.k)}::text COLLATE "C", ${p.add(c.id)}::text COLLATE "C")` : 'true';

const toResource = (r: SqlRow): ResourceRecord => ({
  id: r.id, customerId: r.customerId, projectId: r.projectId ?? null, serviceId: r.serviceId ?? null,
  cloudAccountId: r.cloudAccountId, awsAccountId: String(r.awsAccountId).trim(), accountAlias: r.accountAlias ?? null, alarmWriterEnabled: !!r.alarmWriterEnabled, tagWriterEnabled: !!r.tagWriterEnabled,
  region: r.region, resourceType: r.resourceType, resourceKey: r.resourceKey, name: r.name ?? null, tags: (typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags) ?? {},
  monitoringState: r.monitoringState, needsReviewSince: d(r.needsReviewSince), needsReviewReason: r.needsReviewReason ?? null, lastSeenAt: dReq(r.lastSeenAt),
  alarmCount: Number(r.alarmCount ?? 0), accountActive: r.accountActive === true,
});

const ALARM_COLS = `m."id", m."customerId", v."projectId", v."serviceId", m."resourceId", COALESCE(v."name", v."resourceKey") AS "resourceName", v."resourceType", m."region", m."metricKey", m."alarmName",
  m."severity", m."threshold", m."thresholdSource", m."evalM", m."evalN", m."comparison", m."statistic", m."period", m."state", m."driftStatus", m."lastSyncedAt"`;
const toAlarm = (r: SqlRow): ManagedAlarmRecord => ({
  id: r.id, customerId: r.customerId, projectId: r.projectId ?? null, serviceId: r.serviceId ?? null, resourceId: r.resourceId, resourceName: r.resourceName, resourceType: r.resourceType,
  region: r.region, metricKey: r.metricKey, alarmName: r.alarmName, severity: r.severity, threshold: Number(r.threshold), thresholdSource: r.thresholdSource,
  evalM: Number(r.evalM), evalN: Number(r.evalN), comparison: r.comparison, statistic: r.statistic, period: Number(r.period), state: r.state ?? null, driftStatus: r.driftStatus, lastSyncedAt: d(r.lastSyncedAt),
});

export async function queryResources(sql: SqlExecutor, scope: ScopeFilter, node: NodeFilter | null, f: ResourceFilter, page: { limit: number; after?: MonitoringCursor }): Promise<MonitoringPage<ResourceRecord>> {
  const p = new Params();
  const vis = visibleResources(p, scope);
  const inNode = inNodeSql(p, node, 'v');
  const where = [inNode];
  if (f.type) where.push(`v."resourceType" = ${p.add(f.type)}`);
  if (f.monitoringState) where.push(`v."monitoringState" = ${p.add(f.monitoringState)}::"MonitoringState"`);
  where.push(after(p, 'v."sk"', page.after, 'v."id"'));
  const limit = p.add(page.limit + 1);
  const [r] = await sql.query(
    `WITH visible AS (${vis}),
          pg AS (SELECT v.*, (SELECT count(*) FROM "ManagedAlarm" m WHERE m."resourceId" = v."id" AND m."customerId" = v."customerId")::int AS "alarmCount"
                   FROM visible v WHERE ${where.join(' AND ')} ORDER BY v."sk" COLLATE "C", v."id" COLLATE "C" LIMIT ${limit})
     SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(pg) ORDER BY pg."sk" COLLATE "C", pg."id" COLLATE "C"), '[]'::jsonb) FROM pg) AS "rows"${node ? `, ${outsideSql(inNode)}` : ''}`,
    p.values,
  );
  const all = (r!.rows as SqlRow[]).map(toResource);
  return { rows: all.slice(0, page.limit), hasMore: all.length > page.limit, outside: node ? { needsReview: Number(r!.needsReview), inAlarm: Number(r!.inAlarm) } : null };
}

export async function findResourceDetail(sql: SqlExecutor, scope: ScopeFilter, resourceId: string): Promise<{ resource: ResourceRecord; alarms: ManagedAlarmRecord[] } | null> {
  const p = new Params();
  const [row] = await sql.query(
    `WITH visible AS (${visibleResources(p, scope, `r."id" = ${p.add(resourceId)}`)})
     SELECT v.*, (SELECT count(*) FROM "ManagedAlarm" m WHERE m."resourceId" = v."id" AND m."customerId" = v."customerId")::int AS "alarmCount" FROM visible v`,
    p.values,
  );
  if (!row) return null;
  const resource = toResource(row);
  const pa = new Params();
  const alarms = (await sql.query(
    `WITH visible AS (${visibleResources(pa, scope, `r."id" = ${pa.add(resourceId)}`)})
     SELECT ${ALARM_COLS} FROM "ManagedAlarm" m JOIN visible v ON v."id" = m."resourceId" AND v."customerId" = m."customerId"
      ORDER BY m."alarmName" COLLATE "C", m."id" COLLATE "C"`,
    pa.values,
  )).map(toAlarm);
  return { resource, alarms };
}

export async function queryManagedAlarms(sql: SqlExecutor, scope: ScopeFilter, node: NodeFilter | null, f: ManagedAlarmFilter, page: { limit: number; after?: MonitoringCursor }): Promise<MonitoringPage<ManagedAlarmRecord>> {
  const p = new Params();
  const vis = visibleResources(p, scope);
  const inNode = inNodeSql(p, node, 'v');
  const where = [inNode];
  if (f.resourceId) where.push(`m."resourceId" = ${p.add(f.resourceId)}`);
  if (f.state) where.push(`m."state" = ${p.add(f.state)}::"AlarmState"`);
  if (f.severity) where.push(`m."severity" = ${p.add(f.severity)}::"Severity"`);
  where.push(after(p, 'm."alarmName"', page.after, 'm."id"'));
  const limit = p.add(page.limit + 1);
  const [r] = await sql.query(
    `WITH visible AS (${vis}),
          pg AS (SELECT ${ALARM_COLS} FROM "ManagedAlarm" m JOIN visible v ON v."id" = m."resourceId" AND v."customerId" = m."customerId"
                  WHERE ${where.join(' AND ')} ORDER BY m."alarmName" COLLATE "C", m."id" COLLATE "C" LIMIT ${limit})
     SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(pg) ORDER BY pg."alarmName" COLLATE "C", pg."id" COLLATE "C"), '[]'::jsonb) FROM pg) AS "rows"${node ? `, ${outsideSql(inNode)}` : ''}`,
    p.values,
  );
  const all = (r!.rows as SqlRow[]).map(toAlarm);
  return { rows: all.slice(0, page.limit), hasMore: all.length > page.limit, outside: node ? { needsReview: Number(r!.needsReview), inAlarm: Number(r!.inAlarm) } : null };
}
