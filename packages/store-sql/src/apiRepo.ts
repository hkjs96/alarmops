/**
 * ApiRepository on Postgres. The caller's ScopeFilter is turned into SQL and sits INSIDE every read (API-CONTRACT §2):
 * a row of another tenant is never fetched and then compared, so "does not exist" and "not yours" are the same query
 * with the same result.
 */
import { createHash } from 'node:crypto';
import { handoverOf, incidentMute, type DigestData, type PurgeLogEntry, type Contact, type Leave, type Override, type Rotation, type AuditInput, type DeliveryLog, type IncidentEventInput, type IncidentRow, type MaintenanceWindow, type PagingConfig } from '@alarmops/core';
import { nodeVisible, type ApiRepository, type ManagedAlarmFilter, type ManagedAlarmRecord, type MonitoringCursor, type MonitoringPage, type ResourceFilter, type ResourceRecord, type AlertMemberRow, type IdempotentEntry, type IncidentFilter, type IncidentPage, type NodeFilter, type NotifiedPerson, type OpenCounts, type OrgTree, type ScopeFilter, type StatusCounts, type UndoRecord, type UserInfo, type Principal, type ResponderOp, type ResponderWriteOutcome, type RespondersState, type RotationsWorld, type ChangeStatusOutcome, type CustomerStatusState, type CustomerStatusValue, type ExportIncidentRow, type RetentionView, type MarkStepOutcome, type OffboardStep, type OffboardStepKey, type OffboardingState, type RevealLogFilter, type RevealLogRow, type RevealWrite, type RevealWriteOutcome, type AccountPatch, type AccountWriteOutcome, type AuditTemplate, type CloudAccountRecord, type ContactPatch, type ContactScopeInfo, type ContactWriteOutcome, type ContactsWorld, type NewAccount, type NewContact, type VerificationIssue, type VerificationLimits, type IssueOutcome, type VerificationLink, type VerificationTaken, type VerifyChannelValue, type CustomerProfile, type CustomerProfilePatch, type CustomerUpdateOutcome, type OrgWriteOutcome, type ProjectRecord, type ServiceRecord, type BindGoogleOutcome, type EnrolOutcome, type NewUser, type UserFilter, type UserPatch, type UserRecord, type UserWriteOutcome, OFFBOARD_STEP_KEYS, normalizeEmail, emailDomain, isFreeMail, planTemplateChange, planTemplateAttach, templateBlocking, attachBlocking, type ResponderTemplateView, type TemplateCreate, type TemplateImpactInput, type TemplateUpdate, type TemplateUpdateOutcome, type TemplateAttachInput, type TemplateAttachOutcome, type TemplateAttachWrite, type TemplateRef, type TemplatePaging, evaluateRotationChange, seesCustomer, type RotationState, type RotationUsageRow, type NewRotation, type RotationCreateOutcome, type RotationUpdate, type RotationUpdateOutcome, type RotationDeleteOutcome } from '@alarmops/api';
import { PG, ROTATION_NAME_KEY, ROTATION_RACE_FKS, isBusyError, isUniqueOn, pgCode, type SqlExecutor } from './client.js';
import { purgeLogOf } from './retentionSql.js';
import { CONTACT_COLS, toContact, Params, d, dReq, incidentCols, iso, js, newId, num, toEvent, toIncident, toLog } from './rows.js';
import { SqlTickStore, insertAudit, loadPins, toWindow } from './tickRepo.js';
import * as monitoring from './monitoringSql.js';

class Abort<T> { constructor(readonly value: T) {} }

/**
 * `inScope()` of @alarmops/api as a SQL predicate over `<alias>."customerId" / "projectId" / "serviceId"`.
 * - unmapped rows (customer null) only for a scope with `unmapped`;
 * - the customer must be in the list (or the list is '*');
 * - when the scope has sub-scopes for that customer, one of them must match (a service entry with a project means
 *   that service IN that project).
 */
export function scopeSql(p: Params, s: ScopeFilter, alias: string, cols: { project?: string; service?: string } = {}): string {
  const c = `${alias}."customerId"`;
  const prj = cols.project ?? `${alias}."projectId"`;
  const svc = cols.service ?? `${alias}."serviceId"`;
  const all = s.customerIds === '*';
  const ids = p.add(all ? [] : [...s.customerIds]);
  const subs = p.add(JSON.stringify(s.subScopes.map((x) => ({ customerId: x.customerId, projectId: x.projectId || null, serviceId: x.serviceId || null }))));
  const sub = `jsonb_array_elements(${subs}::jsonb) AS sc_(x)`;
  return `((${c} IS NULL AND ${s.unmapped ? 'true' : 'false'}) OR (${c} IS NOT NULL AND (${all ? 'true' : 'false'} OR ${c} = ANY(${ids}::text[]))
    AND (NOT EXISTS (SELECT 1 FROM ${sub} WHERE sc_.x->>'customerId' = ${c})
      OR EXISTS (SELECT 1 FROM ${sub} WHERE sc_.x->>'customerId' = ${c} AND (CASE
           WHEN sc_.x->>'serviceId' IS NOT NULL THEN sc_.x->>'serviceId' = ${svc} AND (sc_.x->>'projectId' IS NULL OR sc_.x->>'projectId' = ${prj})
           WHEN sc_.x->>'projectId' IS NOT NULL THEN sc_.x->>'projectId' = ${prj}
           ELSE true END)))))`;
}

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
const OPEN_SQL = (from: string): string =>
  `(SELECT jsonb_build_object('open', count(*) FILTER (WHERE "status" = 'TRIGGERED'), 'unmappedOpen', count(*) FILTER (WHERE "status" = 'TRIGGERED' AND "customerId" IS NULL),
     'acknowledged', count(*) FILTER (WHERE "status" = 'ACKNOWLEDGED')) FROM ${from})`;

export class SqlApiStore extends SqlTickStore implements ApiRepository {
  // ───────────────────────────── org / scope ─────────────────────────────

  async orgTree(scope: ScopeFilter): Promise<OrgTree> {
    // The customer filter is in the query; the narrowing to sub-trees of an already visible customer uses the same
    // `nodeVisible` as the in-memory store.
    const all = scope.customerIds === '*';
    const ids = all ? [] : [...scope.customerIds];
    const [customers, projects, services] = await Promise.all([
      this.sql.query(`SELECT "id", "name", "slug", "status" FROM "Customer" WHERE $1::boolean OR "id" = ANY($2::text[]) ORDER BY "createdAt", "id"`, [all, ids]),
      this.sql.query(`SELECT "id", "name", "slug", "customerId" FROM "Project" WHERE $1::boolean OR "customerId" = ANY($2::text[]) ORDER BY "name", "id"`, [all, ids]),
      this.sql.query(`SELECT "id", "name", "slug", "customerId", "projectId" FROM "Service" WHERE $1::boolean OR "customerId" = ANY($2::text[]) ORDER BY "name", "id"`, [all, ids]),
    ]);
    const projectOf = new Map(services.map((s) => [s.id as string, s.projectId as string]));
    const svcProject = (id: string): string | undefined => projectOf.get(id);
    return {
      customers: customers.map((c) => ({ id: c.id, name: c.name, slug: c.slug, status: c.status as CustomerStatusValue })),
      projects: projects.filter((p) => nodeVisible(scope, { customerId: p.customerId, projectId: p.id }, svcProject)).map((p) => ({ id: p.id, name: p.name, slug: p.slug, customerId: p.customerId })),
      services: services.filter((s) => nodeVisible(scope, { customerId: s.customerId, projectId: s.projectId, serviceId: s.id }, svcProject))
        .map((s) => ({ id: s.id, name: s.name, slug: s.slug, customerId: s.customerId, projectId: s.projectId })),
    };
  }

  async openIncidentCounts(scope: ScopeFilter) {
    const p = new Params();
    const rows = await this.sql.query(
      `SELECT i."customerId", i."projectId", i."serviceId", count(*)::int AS "open" FROM "Incident" i
        WHERE i."status" = 'TRIGGERED' AND i."customerId" IS NOT NULL AND ${scopeSql(p, scope, 'i')}
        GROUP BY i."customerId", i."projectId", i."serviceId"`,
      p.values,
    );
    return rows.map((r) => ({ customerId: r.customerId as string, projectId: (r.projectId ?? null) as string | null, serviceId: (r.serviceId ?? null) as string | null, open: r.open as number }));
  }

  async responderCustomerIds(userId: string): Promise<string[]> {
    return (await this.sql.query(`SELECT DISTINCT r."customerId" FROM "Contact" c JOIN "Responder" r ON r."contactId" = c."id" WHERE c."userId" = $1 ORDER BY 1`, [userId])).map((r) => r.customerId as string);
  }
  async contactIdForUser(userId: string): Promise<string | null> {
    const [r] = await this.sql.query(`SELECT "id" FROM "Contact" WHERE "userId" = $1`, [userId]);
    return r ? (r.id as string) : null;
  }
  async userDirectory(userIds: string[]): Promise<Map<string, UserInfo>> {
    const out = new Map<string, UserInfo>();
    if (!userIds.length) return out;
    const rows = await this.sql.query(
      `SELECT u."id", u."name", c."kind", c."customerId" FROM "User" u LEFT JOIN "Contact" c ON c."userId" = u."id" WHERE u."id" = ANY($1::text[])`, [userIds]);
    for (const r of rows) out.set(r.id, { name: r.name, kind: r.kind === 'CUSTOMER' ? 'CUSTOMER' : 'INTERNAL', customerId: r.kind === 'CUSTOMER' ? r.customerId : null });
    return out;
  }
  async staffNames(userIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!userIds.length) return out;
    const rows = await this.sql.query(
      `SELECT "id", "name" FROM "User" WHERE "id" = ANY($1::text[]) AND "customerId" IS NULL AND "email"::text NOT LIKE 'purged-%@invalid.invalid'`, [userIds]);
    for (const r of rows) out.set(r.id, r.name);
    return out;
  }
  async slackChannelVerified(customerId: string): Promise<boolean> { return this.slackVerifiedVia(this.sql, customerId); }
  private async slackVerifiedVia(q: SqlExecutor, customerId: string): Promise<boolean> {
    return (await q.query(
      `SELECT 1 FROM "NotificationChannel" WHERE "customerId" = $1 AND "scopeType" = 'CUSTOMER' AND "scopeId" = $1 AND "kind" IN ('SLACK_BOT', 'SLACK_WEBHOOK') AND "enabled" AND "verifiedAt" IS NOT NULL LIMIT 1`,
      [customerId],
    )).length > 0;
  }
  private async slackVerifiedMany(q: SqlExecutor, customerIds: string[]): Promise<Set<string>> {
    if (!customerIds.length) return new Set();
    const rows = await q.query(
      `SELECT DISTINCT "customerId" FROM "NotificationChannel" WHERE "customerId" = ANY($1::text[]) AND "scopeType" = 'CUSTOMER' AND "scopeId" = "customerId" AND "kind" IN ('SLACK_BOT', 'SLACK_WEBHOOK') AND "enabled" AND "verifiedAt" IS NOT NULL`,
      [customerIds]);
    return new Set(rows.map((r) => r.customerId as string));
  }
  async findResource(scope: ScopeFilter, resourceId: string) {
    const p = new Params();
    const id = p.add(resourceId);
    const [r] = await this.sql.query(
      `SELECT r."id", COALESCE(r."name", r."resourceKey") AS "name", r."customerId", s."projectId", s."id" AS "serviceId"
         FROM "Resource" r
         JOIN "CloudAccount" ca ON ca."id" = r."cloudAccountId" AND ca."customerId" = r."customerId"
         LEFT JOIN "Service" s ON s."id" = ca."serviceId" AND s."customerId" = r."customerId"
        WHERE r."id" = ${id} AND ${scopeSql(p, scope, 'r', { project: 's."projectId"', service: 's."id"' })}`,
      p.values,
    );
    return r ? { id: r.id as string, name: r.name as string, customerId: r.customerId as string, projectId: (r.projectId ?? null) as string | null, serviceId: (r.serviceId ?? null) as string | null } : null;
  }

  // ───────────────────────────── monitoring (API-CONTRACT §8.5) ─────────────────────────────

  queryResources(scope: ScopeFilter, node: NodeFilter | null, f: ResourceFilter, page: { limit: number; after?: MonitoringCursor }): Promise<MonitoringPage<ResourceRecord>> { return monitoring.queryResources(this.sql, scope, node, f, page); }
  findResourceDetail(scope: ScopeFilter, resourceId: string) { return monitoring.findResourceDetail(this.sql, scope, resourceId); }
  queryManagedAlarms(scope: ScopeFilter, node: NodeFilter | null, f: ManagedAlarmFilter, page: { limit: number; after?: MonitoringCursor }): Promise<MonitoringPage<ManagedAlarmRecord>> { return monitoring.queryManagedAlarms(this.sql, scope, node, f, page); }

  // ───────────────────────────── incidents ─────────────────────────────

  /** ONE statement, so the page and every count come from the same snapshot (`counts.open + outside.open = badge`, §8.0). */
  async queryIncidents(scope: ScopeFilter, node: NodeFilter | null, f: IncidentFilter, page: { limit: number; after?: { t: string; id: string } }, now: Date): Promise<IncidentPage> {
    const p = new Params();
    const visible = scopeSql(p, scope, 'i');
    let inNode = 'true';
    if (node) {
      const ids = p.add([...node.customerIds]);
      inNode = `(CASE WHEN i."customerId" IS NULL THEN ${node.includeUnmapped ? 'true' : 'false'} ELSE i."customerId" = ANY(${ids}::text[])`
        + `${node.projectId ? ` AND i."projectId" IS NOT DISTINCT FROM ${p.add(node.projectId)}` : ''}${node.serviceId ? ` AND i."serviceId" IS NOT DISTINCT FROM ${p.add(node.serviceId)}` : ''} END)`;
    }
    const attr: string[] = ['true'];
    if (f.severity) attr.push(`i."severity" = ${p.add(f.severity)}::"Severity"`);
    if (f.source) attr.push(`i."source" = ${p.add(f.source)}::"SourceKind"`);
    if (f.q) attr.push(`position(lower(${p.add(f.q)}) in lower(i."title")) > 0`);
    if (f.unmappedOnly) attr.push(`i."customerId" IS NULL`);
    if (f.assigneeContactId) attr.push(`jsonb_path_exists(i."assignmentSnapshot", '$.steps[*].resolved[*] ? (@.contactId == $cid)', jsonb_build_object('cid', ${p.add(f.assigneeContactId)}::text))`);
    const status = !f.status ? 'true' : f.status === 'active' ? `i."status" <> 'RESOLVED'` : `i."status" = ${p.add(f.status)}::"IncidentStatus"`;
    const after = page.after ? `(i."triggeredAt", i."id") < (${p.add(page.after.t)}::timestamptz, ${p.add(page.after.id)})` : 'true';
    const nowP = p.add(iso(now));
    const limit = p.add(page.limit + 1);
    const [r] = await this.sql.query(
      `WITH visible AS (SELECT i.* FROM "Incident" i WHERE ${visible}),
            innode AS (SELECT i.* FROM visible i WHERE ${inNode}),
            basis AS (SELECT i.* FROM innode i WHERE ${attr.join(' AND ')}),
            page AS (SELECT ${incidentCols('i')} FROM basis i WHERE ${status} AND ${after} ORDER BY i."triggeredAt" DESC, i."id" DESC LIMIT ${limit}),
            win AS (SELECT w."id", w."customerId", w."scopeType", w."scopeId", w."resourceType", w."startsAt", w."endsAt", w."revokedAt" FROM "MaintenanceWindow" w
                     WHERE (w."revokedAt" IS NULL OR w."revokedAt" > ${nowP}::timestamptz) AND w."startsAt" <= ${nowP}::timestamptz AND ${nowP}::timestamptz < w."endsAt")
       SELECT
         (SELECT COALESCE(jsonb_agg(to_jsonb(pg) ORDER BY pg."triggeredAt" DESC, pg."id" DESC), '[]'::jsonb) FROM page pg) AS "rows",
         (SELECT jsonb_build_object(
            'triggered', count(*) FILTER (WHERE "status" = 'TRIGGERED' AND NOT ("escalationStep" > 1 OR "escalationRepeat" > 0)),
            'escalated', count(*) FILTER (WHERE "status" = 'TRIGGERED' AND ("escalationStep" > 1 OR "escalationRepeat" > 0)),
            'acknowledged', count(*) FILTER (WHERE "status" = 'ACKNOWLEDGED'),
            'resolved24h', count(*) FILTER (WHERE "status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND ${nowP}::timestamptz - "resolvedAt" <= interval '24 hours'),
            'open', count(*) FILTER (WHERE "status" = 'TRIGGERED')) FROM basis) AS "counts",
         ${OPEN_SQL('innode')} AS "inside",
         ${OPEN_SQL('visible')} AS "all",
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('awsAccountId', u.k, 'alertCount', u.n) ORDER BY u.k), '[]'::jsonb)
            FROM (SELECT COALESCE("accountIds"[1], 'unknown') AS k, sum("memberCount")::int AS n FROM visible WHERE "customerId" IS NULL AND "status" <> 'RESOLVED' GROUP BY 1) u) AS "unmapped",
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('customerId', b."customerId", 'projectId', b."projectId", 'serviceId', b."serviceId", 'accountIds', to_jsonb(b."accountIds"),
                   'resourceTypes', to_jsonb(b."resourceTypes"), 'severity', b."severity")), '[]'::jsonb)
            FROM basis b WHERE b."status" <> 'RESOLVED' AND b."severity" <> 'SEV_1'
             AND EXISTS (SELECT 1 FROM win w WHERE w."customerId" IS NULL OR w."customerId" = b."customerId")) AS "mutable",
         (SELECT COALESCE(jsonb_agg(to_jsonb(w)), '[]'::jsonb) FROM win w) AS "windows"`,
      p.values,
    );
    const rows = (r!.rows as Array<Record<string, unknown>>).map(toIncident);
    const windows: MaintenanceWindow[] = (r!.windows as Array<Record<string, unknown>>).map(toWindow);
    const muted = (r!.mutable as Array<Pick<IncidentRow, 'customerId' | 'projectId' | 'serviceId' | 'accountIds' | 'resourceTypes' | 'severity'>>)
      .filter((i) => !!incidentMute(i, windows.filter((w) => w.customerId == null || w.customerId === i.customerId), now)).length;
    const n = (o: Record<string, unknown>): Record<string, number> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
    return {
      rows: rows.slice(0, page.limit), hasMore: rows.length > page.limit,
      counts: { ...(n(r!.counts) as unknown as StatusCounts), muted },
      inside: n(r!.inside) as unknown as OpenCounts, all: n(r!.all) as unknown as OpenCounts,
      unmapped: scope.unmapped ? (r!.unmapped as Array<{ awsAccountId: string; alertCount: number }>) : [],
    };
  }

  async findIncident(scope: ScopeFilter, id: string): Promise<IncidentRow | null> {
    const p = new Params();
    const idP = p.add(id);
    const [r] = await this.sql.query(`SELECT ${incidentCols('i')} FROM "Incident" i WHERE i."id" = ${idP} AND ${scopeSql(p, scope, 'i')}`, p.values);
    return r ? toIncident(r) : null;
  }

  async incidentAlerts(scope: ScopeFilter, incidentId: string): Promise<AlertMemberRow[]> {
    const p = new Params();
    const idP = p.add(incidentId);
    const rows = await this.sql.query(
      `SELECT a."id", a."fingerprint", a."title", a."status", a."severity", a."metricKey", a."resourceId", a."value", a."threshold", ia."eventCount", a."lastEventAt"
         FROM "Incident" i
         JOIN "IncidentAlert" ia ON ia."incidentId" = i."id"
         JOIN "Alert" a ON a."id" = ia."alertId" AND a."customerId" IS NOT DISTINCT FROM i."customerId"
        WHERE i."id" = ${idP} AND ${scopeSql(p, scope, 'i')}
        ORDER BY ia."joinedAt", a."id"`,
      p.values,
    );
    return rows.map((r) => ({
      id: r.id, fingerprint: r.fingerprint, title: r.title, status: r.status, severity: r.severity, metricKey: r.metricKey ?? null, resourceId: r.resourceId ?? null,
      value: num(r.value), threshold: num(r.threshold), eventCount: r.eventCount, lastEventAt: dReq(r.lastEventAt),
    }));
  }

  /** Timeline order: `at`, then insertion (`seq`). The cursor names the last row seen; an unknown cursor starts from the top (as the memory store does). */
  async incidentEvents(scope: ScopeFilter, incidentId: string, page: { limit: number; after?: { t: string; id: string } }): Promise<{ rows: Array<IncidentEventInput & { id: string }>; hasMore: boolean }> {
    const p = new Params();
    const idP = p.add(incidentId);
    const sc = scopeSql(p, scope, 'i');
    const cur = p.add(page.after?.id ?? null);
    const rows = await this.sql.query(
      `SELECT e."id", e."incidentId", e."customerId", e."at", e."kind", e."actorType", e."actorId", e."message", e."data"
         FROM "Incident" i JOIN "IncidentEvent" e ON e."incidentId" = i."id"
         LEFT JOIN "IncidentEvent" c ON c."id" = ${cur} AND c."incidentId" = i."id"
        WHERE i."id" = ${idP} AND ${sc} AND (c."id" IS NULL OR (e."at", e."seq") > (c."at", c."seq"))
        ORDER BY e."at", e."seq" LIMIT ${p.add(page.limit + 1)}`,
      p.values,
    );
    return { rows: rows.slice(0, page.limit).map(toEvent), hasMore: rows.length > page.limit };
  }

  async incidentNotifications(scope: ScopeFilter, incidentId: string, page: { limit: number; after?: { t: string; id: string } }): Promise<{ rows: Array<DeliveryLog & { id: string }>; hasMore: boolean; total: number }> {
    const p = new Params();
    const idP = p.add(incidentId);
    const sc = scopeSql(p, scope, 'i');
    const cur = p.add(page.after?.id ?? null);
    const rows = await this.sql.query(
      `SELECT l.*, (SELECT count(*)::int FROM "NotificationLog" t WHERE t."incidentId" = i."id") AS "total"
         FROM "Incident" i JOIN "NotificationLog" l ON l."incidentId" = i."id"
         LEFT JOIN "NotificationLog" c ON c."id" = ${cur} AND c."incidentId" = i."id"
        WHERE i."id" = ${idP} AND ${sc} AND (c."id" IS NULL OR l."seq" > c."seq")
        ORDER BY l."seq" LIMIT ${p.add(page.limit + 1)}`,
      p.values,
    );
    let total = rows[0]?.total as number | undefined;
    if (total === undefined) {
      // nothing after the cursor (or no rows at all): the total still has to be right
      const q = new Params();
      const qi = q.add(incidentId);
      const [t] = await this.sql.query(`SELECT count(l."id")::int AS "total" FROM "Incident" i LEFT JOIN "NotificationLog" l ON l."incidentId" = i."id" WHERE i."id" = ${qi} AND ${scopeSql(q, scope, 'i')}`, q.values);
      total = (t?.total as number | undefined) ?? 0;
    }
    return { rows: rows.slice(0, page.limit).map(toLog), hasMore: rows.length > page.limit, total };
  }

  async saveUndo(rec: UndoRecord): Promise<void> {
    // The token itself is not stored: the row is found by its SHA-256.
    await this.sql.query(
      `INSERT INTO "UndoRecord"("token", "userId", "action", "expiresAt", "items", "createdAt") VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb, ${this.sql.now()})
       ON CONFLICT ("token") DO UPDATE SET "userId" = EXCLUDED."userId", "action" = EXCLUDED."action", "expiresAt" = EXCLUDED."expiresAt", "items" = EXCLUDED."items"`,
      [tokenHash(rec.token), rec.userId, rec.action, iso(rec.expiresAt), js(rec.items)],
    );
    // Expired records of every user are removed by the tick (`purgeExpired`).
  }
  /** Single use: DELETE … RETURNING — two callers cannot both get the record. */
  async takeUndo(token: string): Promise<UndoRecord | null> {
    const [r] = await this.sql.query(`DELETE FROM "UndoRecord" WHERE "token" = $1 RETURNING "userId", "action", "expiresAt", "items"`, [tokenHash(String(token))]);
    if (!r) return null;
    const items = (r.items as UndoRecord['items']).map((it) => ({ ...it, prev: { ...it.prev, acknowledgedAt: d(it.prev.acknowledgedAt) } }));
    return { token, userId: r.userId, action: r.action, expiresAt: dReq(r.expiresAt), items };
  }

  // ───────────────────────────── paging ─────────────────────────────

  async savePagingConfig(cfg: PagingConfig, expectedVersion: number | null, audit: AuditInput): Promise<PagingConfig | 'CONFLICT' | { unknownRotation: number }> {
    // R-6: a write without a customer is refused before any SQL runs (a call order always belongs to one customer).
    if (typeof cfg.customerId !== 'string' || !cfg.customerId || audit.customerId !== cfg.customerId) throw new Error('savePagingConfig: customerId is required and must be the audited customer');
    try {
      return await this.sql.transaction(async (tx) => {
        const [cur] = await tx.query(`SELECT "id", "version", "customerId" FROM "PagingConfig" WHERE "scopeType" = $1::"ScopeType" AND "scopeId" = $2 FOR UPDATE`, [cfg.scopeType, cfg.scopeId]);
        // A row of the same scope under another customer is "not there" for this caller and blocks the insert.
        const mine = cur && cur.customerId === cfg.customerId ? cur : null;
        if (expectedVersion === null ? !!cur : !mine || mine.version !== expectedVersion) return 'CONFLICT' as const;
        // D-28: a rotation the steps name must still exist. FOR SHARE in id order: a DELETE /rotations/{id} (FOR UPDATE) either ran first (the rotation is gone: refused
        // here) or waits for this save to commit (and then finds the step: IN_USE). So no step is left pointing at a missing rotation.
        const rids = [...new Set(cfg.steps.filter((st) => st.targetType === 'ROTATION' && st.targetId).map((st) => st.targetId as string))].sort();
        if (rids.length) {
          // scope and customerId are read under the same lock: another customer's CUSTOMER rotation is "unknown" for this save (as the API's CROSS_CUSTOMER gate would say)
          const found = new Set((await tx.query(`SELECT "id", "scope", "customerId" FROM "Rotation" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR SHARE`, [rids]))
            .filter((r) => r.scope !== 'CUSTOMER' || r.customerId === cfg.customerId).map((r) => r.id as string));
          const gone = cfg.steps.findIndex((st) => st.targetType === 'ROTATION' && (!st.targetId || !found.has(st.targetId)));
          if (gone >= 0) throw new Abort({ unknownRotation: gone });
        }
        let id = cfg.id;
        let version: number;
        if (mine) {
          id = mine.id as string;
          version = expectedVersion! + 1;
          await tx.query(
            `UPDATE "PagingConfig" SET "style" = $2::"PagingStyle", "plan" = $3::"PagingPlan", "edited" = $4, "repeatCount" = $5, "renotifyAfterAckSec" = $6, "version" = $7, "updatedBy" = $8, "updatedAt" = ${this.sql.now()}
              WHERE "id" = $1 AND "customerId" = $9`,
            [id, cfg.style, cfg.plan, cfg.edited, cfg.repeatCount, cfg.renotifyAfterAckSec ?? null, version, audit.actorId, cfg.customerId]);
          await tx.query(`DELETE FROM "EscalationStep" WHERE "pagingConfigId" = $1`, [id]);
        } else {
          // N-3: versions never restart — continue after the last version of a deleted row of this scope.
          const [tomb] = await tx.query(`SELECT "lastVersion" FROM "PagingConfigTombstone" WHERE "scopeType" = $1::"ScopeType" AND "scopeId" = $2 AND "customerId" = $3`, [cfg.scopeType, cfg.scopeId, cfg.customerId]);
          version = ((tomb?.lastVersion as number | undefined) ?? 0) + 1;
          await tx.query(
            `INSERT INTO "PagingConfig"("id", "customerId", "scopeType", "scopeId", "style", "plan", "edited", "repeatCount", "renotifyAfterAckSec", "version", "updatedBy", "updatedAt")
             VALUES ($1, $2, $3::"ScopeType", $4, $5::"PagingStyle", $6::"PagingPlan", $7, $8, $9, $10, $11, ${this.sql.now()})`,
            [id, cfg.customerId, cfg.scopeType, cfg.scopeId, cfg.style, cfg.plan, cfg.edited, cfg.repeatCount, cfg.renotifyAfterAckSec ?? null, version, audit.actorId]);
        }
        await insertSteps(tx, id, cfg.steps);
        await insertAudit(tx, audit);
        return { ...structuredClone(cfg), id, version };
      });
    } catch (err) {
      if (err instanceof Abort) return err.value as 'CONFLICT' | { unknownRotation: number };
      if (pgCode(err) === PG.UNIQUE) return 'CONFLICT'; // two creates of the same scope at once
      throw err;
    }
  }

  async deletePagingConfig(id: string, expectedVersion: number, audit: AuditInput): Promise<'OK' | 'CONFLICT'> {
    // R-6: the customer of the audit record (the customer the caller was authorised for) is part of the WHERE, and
    // it is REQUIRED. Without it nothing is deleted (it used to mean "any customer").
    if (typeof audit.customerId !== 'string' || !audit.customerId) return 'CONFLICT';
    return this.sql.transaction(async (tx) => {
      const [gone] = await tx.query(
        `DELETE FROM "PagingConfig" WHERE "id" = $1 AND "version" = $2 AND "customerId" = $3 RETURNING "customerId", "scopeType", "scopeId", "version"`,
        [id, expectedVersion, audit.customerId]);
      if (!gone) return 'CONFLICT' as const;
      await tx.query(
        `INSERT INTO "PagingConfigTombstone"("scopeType", "scopeId", "customerId", "lastVersion", "deletedAt") VALUES ($1::"ScopeType", $2, $3, $4, ${this.sql.now()})
         ON CONFLICT ("scopeType", "scopeId") DO UPDATE SET "customerId" = EXCLUDED."customerId", "lastVersion" = EXCLUDED."lastVersion", "deletedAt" = EXCLUDED."deletedAt"`,
        [gone.scopeType, gone.scopeId, gone.customerId, gone.version]);
      await insertAudit(tx, audit);
      return 'OK' as const;
    });
  }

  async rotationOwner(rotationId: string): Promise<{ scope: 'MSP' | 'CUSTOMER'; customerId: string | null } | null> {
    const [r] = await this.sql.query(`SELECT "scope", "customerId" FROM "Rotation" WHERE "id" = $1`, [rotationId]);
    return r ? { scope: r.scope, customerId: r.customerId ?? null } : null;
  }

  async notifiedPeople(customerId: string, path: { projectId?: string | null; serviceId?: string | null }): Promise<NotifiedPerson[]> {
    const rows = await this.sql.query(
      `SELECT c."id" AS "contactId", c."name", cs."scopeType", cs."scopeId",
              COALESCE(CASE cs."scopeType" WHEN 'CUSTOMER' THEN (SELECT x."name" FROM "Customer" x WHERE x."id" = cs."scopeId")
                                            WHEN 'PROJECT' THEN (SELECT x."name" FROM "Project" x WHERE x."id" = cs."scopeId" AND x."customerId" = $1)
                                            ELSE (SELECT x."name" FROM "Service" x WHERE x."id" = cs."scopeId" AND x."customerId" = $1) END, cs."scopeId") AS "scopeName"
         FROM "ContactScope" cs JOIN "Contact" c ON c."id" = cs."contactId" AND c."customerId" = $1 AND c."active"
        WHERE cs."customerId" = $1 AND cs."role" = 'NOTIFY'
          AND ((cs."scopeType" = 'CUSTOMER' AND cs."scopeId" = $1) OR (cs."scopeType" = 'PROJECT' AND cs."scopeId" = $2) OR (cs."scopeType" = 'SERVICE' AND cs."scopeId" = $3))
        ORDER BY cs."createdAt", cs."id"`,
      [customerId, path.projectId ?? null, path.serviceId ?? null],
    );
    return rows.map((r) => ({ contactId: r.contactId, name: r.name, scope: { level: r.scopeType, id: r.scopeId, name: r.scopeName } }));
  }


  // ───────────────────────────── people ─────────────────────────────

  /**
   * The session gate: User.status must be ACTIVE, and for a portal user (customer-bound) the customer must be ACTIVE
   * too (D-42: SUSPENDED / TERMINATED → null → 401). MSP staff (customerId null) do not depend on any customer.
   * Fail closed on an inconsistent link: a user whose Contact is a CUSTOMER contact must be bound to that same
   * customer (User.customerId = Contact.customerId); NULL or another customer → null (401), never staff access.
   */
  async sessionPrincipal(userId: string): Promise<Principal | null> {
    const [u] = await this.sql.query(
      `SELECT u."id", u."email"::text AS "email", u."name", u."customerId", u."role", c."id" AS "contactId" FROM "User" u LEFT JOIN "Contact" c ON c."userId" = u."id"
        WHERE u."id" = $1 AND u."status" = 'ACTIVE'
          AND (u."customerId" IS NULL OR EXISTS (SELECT 1 FROM "Customer" cu WHERE cu."id" = u."customerId" AND cu."status" = 'ACTIVE'))
          AND (c."id" IS NULL OR c."kind" <> 'CUSTOMER' OR c."customerId" IS NOT DISTINCT FROM u."customerId")`, [userId]);
    if (!u) return null;
    const customerId = (u.customerId ?? null) as string | null;
    let subScopes: Principal['subScopes'] = [];
    if (customerId && u.contactId) {
      const rows = await this.sql.query(
        `SELECT cs."scopeType", cs."scopeId", s."projectId" FROM "ContactScope" cs LEFT JOIN "Service" s ON cs."scopeType" = 'SERVICE' AND s."id" = cs."scopeId" AND s."customerId" = cs."customerId"
          WHERE cs."contactId" = $1 AND cs."customerId" = $2 AND cs."role" = 'PORTAL_USER' AND cs."scopeType" <> 'CUSTOMER' ORDER BY cs."createdAt", cs."id"`, [u.contactId, customerId]);
      subScopes = rows.map((r) => (r.scopeType === 'PROJECT' ? { customerId, projectId: r.scopeId as string }
        : r.projectId ? { customerId, projectId: r.projectId as string, serviceId: r.scopeId as string } : { customerId, serviceId: r.scopeId as string }));
    }
    return { userId: u.id, email: u.email, name: u.name, customerId, role: u.role, contactId: (u.contactId ?? null) as string | null, subScopes };
  }

  // ───────────────────────────── wizard: customer profile, projects, services (#69) ─────────────────────────────

  /**
   * A login domain belongs to one customer, and there is no unique index over the array column: two requests claiming the same domain
   * would both pass the `&&` check. A transaction-level advisory lock per domain (sorted order, so no deadlock) makes the second wait
   * for the first to commit, then see its row. Taken by customer create and by PATCH /customers/{id}.
   */
  private static async lockLoginDomains(tx: SqlExecutor, domains: readonly string[]): Promise<void> {
    for (const dom of [...new Set(domains)].sort()) await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`alarmops:loginDomain:${dom}`]);
  }
  private static toProfile(r: Record<string, any>): CustomerProfile { // eslint-disable-line @typescript-eslint/no-explicit-any
    return { id: r.id, name: r.name, slug: r.slug, status: r.status, loginDomains: r.loginDomains ?? [], createdAt: dReq(r.createdAt) };
  }
  private static readonly PROFILE_SELECT = `SELECT "id", "name", "slug", "status", "loginDomains", "createdAt" FROM "Customer"`;
  async listCustomers(scope: ScopeFilter): Promise<CustomerProfile[]> {
    const all = scope.customerIds === '*';
    return (await this.sql.query(`${SqlApiStore.PROFILE_SELECT} WHERE $1::boolean OR "id" = ANY($2::text[]) ORDER BY "createdAt", "id"`, [all, all ? [] : [...scope.customerIds]])).map(SqlApiStore.toProfile);
  }
  async findCustomer(scope: ScopeFilter, customerId: string): Promise<CustomerProfile | null> {
    const all = scope.customerIds === '*';
    const [r] = await this.sql.query(`${SqlApiStore.PROFILE_SELECT} WHERE "id" = $1 AND ($2::boolean OR "id" = ANY($3::text[]))`, [customerId, all, all ? [] : [...scope.customerIds]]);
    return r ? SqlApiStore.toProfile(r) : null;
  }
  async updateCustomer(customerId: string, patch: CustomerProfilePatch, audit: AuditTemplate): Promise<CustomerUpdateOutcome> {
    try {
      return await this.sql.transaction(async (tx) => {
        await SqlApiStore.lockLoginDomains(tx, patch.loginDomains ?? []);
        // the same row lock a status change takes: no edit slips in behind a termination
        const [cur] = await tx.query(`SELECT "status" FROM "Customer" WHERE "id" = $1 FOR UPDATE`, [customerId]);
        if (!cur) return 'NOT_FOUND' as const;
        if (cur.status === 'TERMINATED') return 'CUSTOMER_TERMINATED' as const;
        if (patch.name !== undefined && (await tx.query(`SELECT 1 FROM "Customer" WHERE lower("name") = lower($1) AND "id" <> $2`, [patch.name, customerId])).length) return 'NAME_EXISTS' as const;
        if (patch.loginDomains?.length && (await tx.query(`SELECT 1 FROM "Customer" WHERE "loginDomains" && $1::text[] AND "id" <> $2`, [patch.loginDomains, customerId])).length) return 'DOMAIN_EXISTS' as const;
        await tx.query(`UPDATE "Customer" SET "name" = COALESCE($2, "name"), "loginDomains" = COALESCE($3::text[], "loginDomains"), "updatedAt" = ${this.sql.now()} WHERE "id" = $1`, [customerId, patch.name ?? null, patch.loginDomains ?? null]);
        await insertAudit(tx, { ...audit, customerId, targetId: customerId });
        const [r] = await tx.query(`${SqlApiStore.PROFILE_SELECT} WHERE "id" = $1`, [customerId]);
        return SqlApiStore.toProfile(r!);
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return 'NAME_EXISTS';
      throw err;
    }
  }
  async countPortalUsersInDomains(customerId: string, domains: readonly string[]): Promise<number> {
    if (!domains.length) return 0;
    const [r] = await this.sql.query(`SELECT count(*)::int AS "n" FROM "User" WHERE "customerId" = $1 AND "status" = 'ACTIVE' AND lower(substring("email"::text from '@([^@]*)$')) = ANY($2::text[])`, [customerId, [...domains]]);
    return (r?.n as number) ?? 0;
  }
  private static readonly PROJECT_SELECT = `SELECT p."id", p."customerId", p."name", p."slug", (SELECT count(*)::int FROM "Service" s WHERE s."projectId" = p."id") AS "serviceCount" FROM "Project" p`;
  private static toProject(r: Record<string, any>): ProjectRecord { // eslint-disable-line @typescript-eslint/no-explicit-any
    return { id: r.id, customerId: r.customerId, name: r.name, slug: r.slug, serviceCount: r.serviceCount };
  }
  private static toService(r: Record<string, any>): ServiceRecord { // eslint-disable-line @typescript-eslint/no-explicit-any
    return { id: r.id, customerId: r.customerId, projectId: r.projectId, name: r.name, slug: r.slug };
  }
  async listProjects(customerId: string): Promise<ProjectRecord[]> {
    return (await this.sql.query(`${SqlApiStore.PROJECT_SELECT} WHERE p."customerId" = $1 ORDER BY p."name" COLLATE "C", p."id"`, [customerId])).map(SqlApiStore.toProject);
  }
  async findProject(scope: ScopeFilter, projectId: string): Promise<ProjectRecord | null> {
    const all = scope.customerIds === '*';
    const [r] = await this.sql.query(`${SqlApiStore.PROJECT_SELECT} WHERE p."id" = $1 AND ($2::boolean OR p."customerId" = ANY($3::text[]))`, [projectId, all, all ? [] : [...scope.customerIds]]);
    return r ? SqlApiStore.toProject(r) : null;
  }
  /** FOR SHARE on the customer conflicts with the FOR UPDATE of a status change. */
  private async liveCustomer(tx: SqlExecutor, customerId: string): Promise<'OK' | 'NOT_FOUND' | 'CUSTOMER_TERMINATED'> {
    const [c] = await tx.query(`SELECT "status" FROM "Customer" WHERE "id" = $1 FOR SHARE`, [customerId]);
    return !c ? 'NOT_FOUND' : c.status === 'TERMINATED' ? 'CUSTOMER_TERMINATED' : 'OK';
  }
  private static uniqueOutcome(err: unknown): 'NAME_EXISTS' | 'SLUG_EXISTS' {
    return /slug/i.test(String((err as { constraint?: unknown }).constraint ?? '')) ? 'SLUG_EXISTS' : 'NAME_EXISTS';
  }
  async createProject(customerId: string, n: { name: string; slug: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ProjectRecord>> {
    try {
      return await this.sql.transaction(async (tx) => {
        const live = await this.liveCustomer(tx, customerId);
        if (live !== 'OK') return live;
        if ((await tx.query(`SELECT 1 FROM "Project" WHERE "customerId" = $1 AND lower("name") = lower($2)`, [customerId, n.name])).length) return 'NAME_EXISTS' as const;
        const id = newId('prj');
        await tx.query(`INSERT INTO "Project"("id", "customerId", "name", "slug") VALUES ($1, $2, $3, $4)`, [id, customerId, n.name, n.slug]);
        await insertAudit(tx, { ...audit, customerId, targetId: id });
        const [r] = await tx.query(`${SqlApiStore.PROJECT_SELECT} WHERE p."id" = $1`, [id]);
        return SqlApiStore.toProject(r!);
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return SqlApiStore.uniqueOutcome(err);
      throw err;
    }
  }
  async updateProject(customerId: string, projectId: string, patch: { name: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ProjectRecord>> {
    try {
      return await this.sql.transaction(async (tx) => {
        const live = await this.liveCustomer(tx, customerId);
        if (live !== 'OK') return live;
        if (!(await tx.query(`SELECT 1 FROM "Project" WHERE "id" = $1 AND "customerId" = $2 FOR UPDATE`, [projectId, customerId])).length) return 'NOT_FOUND' as const;
        if ((await tx.query(`SELECT 1 FROM "Project" WHERE "customerId" = $1 AND "id" <> $2 AND lower("name") = lower($3)`, [customerId, projectId, patch.name])).length) return 'NAME_EXISTS' as const;
        await tx.query(`UPDATE "Project" SET "name" = $3 WHERE "id" = $1 AND "customerId" = $2`, [projectId, customerId, patch.name]);
        await insertAudit(tx, { ...audit, customerId, targetId: projectId });
        const [r] = await tx.query(`${SqlApiStore.PROJECT_SELECT} WHERE p."id" = $1`, [projectId]);
        return SqlApiStore.toProject(r!);
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return SqlApiStore.uniqueOutcome(err);
      throw err;
    }
  }
  async listServices(customerId: string, projectId: string): Promise<ServiceRecord[]> {
    return (await this.sql.query(`SELECT "id", "customerId", "projectId", "name", "slug" FROM "Service" WHERE "customerId" = $1 AND "projectId" = $2 ORDER BY "name" COLLATE "C", "id"`, [customerId, projectId])).map(SqlApiStore.toService);
  }
  async findService(scope: ScopeFilter, serviceId: string): Promise<ServiceRecord | null> {
    const all = scope.customerIds === '*';
    const [r] = await this.sql.query(`SELECT "id", "customerId", "projectId", "name", "slug" FROM "Service" WHERE "id" = $1 AND ($2::boolean OR "customerId" = ANY($3::text[]))`, [serviceId, all, all ? [] : [...scope.customerIds]]);
    return r ? SqlApiStore.toService(r) : null;
  }
  async createService(customerId: string, projectId: string, n: { name: string; slug: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ServiceRecord>> {
    try {
      return await this.sql.transaction(async (tx) => {
        const live = await this.liveCustomer(tx, customerId);
        if (live !== 'OK') return live;
        if (!(await tx.query(`SELECT 1 FROM "Project" WHERE "id" = $1 AND "customerId" = $2 FOR SHARE`, [projectId, customerId])).length) return 'NOT_FOUND' as const;
        if ((await tx.query(`SELECT 1 FROM "Service" WHERE "projectId" = $1 AND lower("name") = lower($2)`, [projectId, n.name])).length) return 'NAME_EXISTS' as const;
        const id = newId('svc');
        await tx.query(`INSERT INTO "Service"("id", "customerId", "projectId", "name", "slug") VALUES ($1, $2, $3, $4, $5)`, [id, customerId, projectId, n.name, n.slug]);
        await insertAudit(tx, { ...audit, customerId, targetId: id });
        return { id, customerId, projectId, name: n.name, slug: n.slug };
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return SqlApiStore.uniqueOutcome(err);
      throw err;
    }
  }
  async updateService(customerId: string, serviceId: string, patch: { name: string }, audit: AuditTemplate): Promise<OrgWriteOutcome<ServiceRecord>> {
    try {
      return await this.sql.transaction(async (tx) => {
        const live = await this.liveCustomer(tx, customerId);
        if (live !== 'OK') return live;
        const [cur] = await tx.query(`SELECT "projectId" FROM "Service" WHERE "id" = $1 AND "customerId" = $2 FOR UPDATE`, [serviceId, customerId]);
        if (!cur) return 'NOT_FOUND' as const;
        if ((await tx.query(`SELECT 1 FROM "Service" WHERE "projectId" = $1 AND "id" <> $2 AND lower("name") = lower($3)`, [cur.projectId, serviceId, patch.name])).length) return 'NAME_EXISTS' as const;
        await tx.query(`UPDATE "Service" SET "name" = $3 WHERE "id" = $1 AND "customerId" = $2`, [serviceId, customerId, patch.name]);
        await insertAudit(tx, { ...audit, customerId, targetId: serviceId });
        const [r] = await tx.query(`SELECT "id", "customerId", "projectId", "name", "slug" FROM "Service" WHERE "id" = $1`, [serviceId]);
        return SqlApiStore.toService(r!);
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return SqlApiStore.uniqueOutcome(err);
      throw err;
    }
  }

  // ───────────────────────────── users (#69, D-55) ─────────────────────────────

  private static readonly USER_SELECT = `SELECT u."id", u."email"::text AS "email", u."name", u."customerId", u."role", u."status", (u."googleSub" IS NOT NULL) AS "googleBound", u."lastLoginAt", u."createdAt" FROM "User" u`;
  private static toUser(r: Record<string, any>): UserRecord { // eslint-disable-line @typescript-eslint/no-explicit-any
    return { id: r.id, email: String(r.email).toLowerCase(), name: r.name, kind: r.customerId ? 'CUSTOMER' : 'INTERNAL', customerId: r.customerId ?? null, role: r.role, status: r.status, googleBound: !!r.googleBound, lastLoginAt: d(r.lastLoginAt), createdAt: dReq(r.createdAt) };
  }
  async listUsers(f: UserFilter): Promise<UserRecord[]> {
    const p = new Params();
    const w: string[] = [];
    if (f.kind) w.push(f.kind === 'CUSTOMER' ? `u."customerId" IS NOT NULL` : `u."customerId" IS NULL`);
    if (f.customerId) w.push(`u."customerId" = ${p.add(f.customerId)}`);
    if (f.status) w.push(`u."status" = ${p.add(f.status)}::"UserStatus"`);
    if (f.role) w.push(`u."role" = ${p.add(f.role)}::"ConsoleRole"`);
    if (f.q) { const like = p.add(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); w.push(`(u."name" ILIKE ${like} OR u."email"::text ILIKE ${like})`); }
    const rows = await this.sql.query(`${SqlApiStore.USER_SELECT}${w.length ? ` WHERE ${w.join(' AND ')}` : ''} ORDER BY u."name" COLLATE "C", u."id"`, p.values);
    return rows.map(SqlApiStore.toUser);
  }
  async findUser(userId: string): Promise<UserRecord | null> {
    const [r] = await this.sql.query(`${SqlApiStore.USER_SELECT} WHERE u."id" = $1`, [userId]);
    return r ? SqlApiStore.toUser(r) : null;
  }
  async createUser(n: NewUser, audit: AuditTemplate): Promise<UserRecord | 'EMAIL_EXISTS' | 'NO_SUCH_CUSTOMER'> {
    try {
      return await this.sql.transaction(async (tx) => {
        if (n.customerId !== null && !(await tx.query(`SELECT 1 FROM "Customer" WHERE "id" = $1 AND "status" <> 'TERMINATED' FOR SHARE`, [n.customerId])).length) return 'NO_SUCH_CUSTOMER' as const;
        const id = newId('usr');
        const [r] = await tx.query(
          `INSERT INTO "User"("id", "email", "name", "customerId", "role", "status", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5::"ConsoleRole", $6::"UserStatus", ${this.sql.now()}, ${this.sql.now()})
           ON CONFLICT ("email") DO NOTHING RETURNING "id"`, [id, n.email, n.name, n.customerId, n.role, n.status]);
        if (!r) return 'EMAIL_EXISTS' as const;
        await insertAudit(tx, { ...audit, customerId: n.customerId, targetId: id });
        const [u] = await tx.query(`${SqlApiStore.USER_SELECT} WHERE u."id" = $1`, [id]);
        return SqlApiStore.toUser(u!);
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return 'EMAIL_EXISTS';
      throw err;
    }
  }
  async updateUser(userId: string, patch: UserPatch, audit: AuditTemplate): Promise<UserWriteOutcome> {
    return this.sql.transaction(async (tx) => {
      // Lock every ACTIVE all-range ADMIN (id order, so two demotions cannot deadlock) BEFORE reading the target: the last-admin rule is
      // then checked on rows nobody else can change until this transaction ends.
      const admins = (await tx.query(`SELECT "id" FROM "User" WHERE "customerId" IS NULL AND "role" = 'ADMIN' AND "status" = 'ACTIVE' ORDER BY "id" FOR UPDATE`)).map((r) => r.id as string);
      const [cur] = await tx.query(`SELECT "id", "customerId", "role", "status" FROM "User" WHERE "id" = $1 FOR UPDATE`, [userId]);
      if (!cur) return 'NOT_FOUND' as const;
      const role = patch.role ?? cur.role; const status = patch.status ?? cur.status;
      if (!cur.customerId && admins.includes(userId) && !(role === 'ADMIN' && status === 'ACTIVE') && admins.filter((a) => a !== userId).length === 0) return 'LAST_ADMIN' as const;
      let customerId = (cur.customerId ?? null) as string | null;
      if (patch.customerId !== undefined) {
        if (!cur.customerId) return 'NO_SUCH_CUSTOMER' as const;
        if (!(await tx.query(`SELECT 1 FROM "Customer" WHERE "id" = $1 AND "status" <> 'TERMINATED' FOR SHARE`, [patch.customerId])).length) return 'NO_SUCH_CUSTOMER' as const;
        if ((await tx.query(`SELECT 1 FROM "Contact" WHERE "userId" = $1`, [userId])).length) return 'CONTACT_LINKED' as const;
        customerId = patch.customerId;
      }
      await tx.query(
        `UPDATE "User" SET "role" = $2::"ConsoleRole", "status" = $3::"UserStatus", "customerId" = $4, "googleSub" = CASE WHEN $5::boolean THEN NULL ELSE "googleSub" END, "updatedAt" = ${this.sql.now()} WHERE "id" = $1`,
        [userId, role, status, customerId, patch.clearGoogleSub === true]);
      await insertAudit(tx, { ...audit, customerId, targetId: userId });
      const [u] = await tx.query(`${SqlApiStore.USER_SELECT} WHERE u."id" = $1`, [userId]);
      return SqlApiStore.toUser(u!);
    });
  }
  async touchLastLogin(userId: string, at: Date): Promise<void> {
    await this.sql.query(`UPDATE "User" SET "lastLoginAt" = $2::timestamptz WHERE "id" = $1`, [userId, iso(at)]);
  }
  async enrolPortalUserByDomain(rawEmail: string, at: Date): Promise<EnrolOutcome> {
    const email = normalizeEmail(rawEmail);
    if (!email) return { refused: 'INVALID_EMAIL' };
    const domain = emailDomain(email);
    if (isFreeMail(domain)) return { refused: 'FREE_MAIL' };
    return this.sql.transaction(async (tx) => {
      const owners = await tx.query(`SELECT "id", "status" FROM "Customer" WHERE $1 = ANY("loginDomains") ORDER BY "id"`, [domain]);
      if (owners.length === 0) return { refused: 'DOMAIN_UNKNOWN' as const };
      if (owners.length > 1) return { refused: 'AMBIGUOUS' as const };
      const customerId = owners[0]!.id as string;
      if (owners[0]!.status !== 'ACTIVE') return { refused: 'CUSTOMER_INACTIVE' as const };
      // The unique index on e-mail decides a race: the loser inserts nothing and reads the winner's row.
      const [ins] = await tx.query(
        `INSERT INTO "User"("id", "email", "name", "customerId", "role", "status", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, 'VIEWER', 'ACTIVE', $5::timestamptz, $5::timestamptz)
         ON CONFLICT ("email") DO NOTHING RETURNING "id"`, [newId('usr'), email, email.slice(0, email.indexOf('@')).slice(0, 80), customerId, iso(at)]);
      const [u] = await tx.query(`${SqlApiStore.USER_SELECT} WHERE u."email" = $1`, [email]);
      if (!u) return { refused: 'DOMAIN_UNKNOWN' as const };
      const user = SqlApiStore.toUser(u);
      if (ins) {
        await insertAudit(tx, { at, customerId, actorType: 'SYSTEM', actorId: null, action: 'user.enrol_domain', targetType: 'User', targetId: user.id, before: null, after: { kind: 'CUSTOMER', role: 'VIEWER', status: 'ACTIVE', reason: 'LOGIN_DOMAIN' } });
        return { user, created: true };
      }
      if (user.kind === 'INTERNAL') return { refused: 'STAFF_EMAIL' as const };
      if (user.customerId !== customerId) return { refused: 'OTHER_CUSTOMER' as const };
      return user.status === 'ACTIVE' ? { user, created: false } : { refused: 'USER_INACTIVE' as const };
    });
  }
  async bindGoogleSub(userId: string, sub: string, at: Date): Promise<BindGoogleOutcome> {
    if (typeof sub !== 'string' || !sub || sub.length > 255 || /[\u0000-\u001f\u007f]/.test(sub)) throw new Error('bindGoogleSub: invalid sub');
    const mismatch = async (tx: SqlExecutor, customerId: string | null, reason: string): Promise<'mismatch'> => {
      await insertAudit(tx, { at, customerId, actorType: 'SYSTEM', actorId: null, action: 'user.google_mismatch', targetType: 'User', targetId: userId, before: null, after: { reason } });
      return 'mismatch';
    };
    try {
      return await this.sql.transaction(async (tx) => {
        // The row lock makes "was null, now set" one winner: a parallel bind waits, then sees the value.
        const [cur] = await tx.query(`SELECT "customerId", "googleSub" FROM "User" WHERE "id" = $1 FOR UPDATE`, [userId]);
        if (!cur) return 'NOT_FOUND' as const;
        const customerId = (cur.customerId ?? null) as string | null;
        if (cur.googleSub === sub) return 'ok' as const;
        if (cur.googleSub) return mismatch(tx, customerId, 'GOOGLE_SUB_MISMATCH');
        if ((await tx.query(`SELECT 1 FROM "User" WHERE "googleSub" = $1 AND "id" <> $2`, [sub, userId])).length) return mismatch(tx, customerId, 'GOOGLE_SUB_IN_USE');
        await tx.query(`UPDATE "User" SET "googleSub" = $2, "updatedAt" = ${this.sql.now()} WHERE "id" = $1`, [userId, sub]);
        await insertAudit(tx, { at, customerId, actorType: 'SYSTEM', actorId: null, action: 'user.google_bind', targetType: 'User', targetId: userId, before: null, after: { reason: 'FIRST_SIGN_IN' } });
        return 'bound' as const;
      });
    } catch (err) {
      if (pgCode(err) !== PG.UNIQUE) throw err;
      // the same Google account was bound to another user a moment ago (unique index): refuse, and say so
      await this.sql.transaction((tx) => mismatch(tx, null, 'GOOGLE_SUB_IN_USE'));
      return 'mismatch';
    }
  }

  /** Responders version = number of Responders audit rows of the customer (written in the same transaction as each change). */
  private async respondersVersionOf(q: SqlExecutor, customerId: string): Promise<number> {
    const [r] = await q.query(`SELECT count(*)::int AS "n" FROM "AuditLog" WHERE "customerId" = $1 AND "targetType" = 'Responders'`, [customerId]);
    return (r?.n as number) ?? 0;
  }

  async respondersState(customerId: string): Promise<RespondersState> {
    const [entries, scopes, cust, version] = await Promise.all([
      this.sql.query(
        `SELECT r."contactId", r."role", r."source", r."templateId", t."name" AS "templateName", r."order" FROM "Responder" r LEFT JOIN "ResponderTemplate" t ON t."id" = r."templateId"
          WHERE r."customerId" = $1 ORDER BY r."order", r."contactId"`, [customerId]),
      this.sql.query(
        `SELECT cs."contactId", cs."scopeType", cs."scopeId", cs."role",
                COALESCE(CASE cs."scopeType" WHEN 'CUSTOMER' THEN (SELECT x."name" FROM "Customer" x WHERE x."id" = cs."scopeId")
                                              WHEN 'PROJECT' THEN (SELECT x."name" FROM "Project" x WHERE x."id" = cs."scopeId" AND x."customerId" = $1)
                                              ELSE (SELECT x."name" FROM "Service" x WHERE x."id" = cs."scopeId" AND x."customerId" = $1) END, cs."scopeId") AS "scopeName"
           FROM "ContactScope" cs WHERE cs."customerId" = $1 ORDER BY cs."createdAt", cs."id"`, [customerId]),
      this.sql.query(`SELECT c."responderTemplateId", t."name" AS "templateName" FROM "Customer" c LEFT JOIN "ResponderTemplate" t ON t."id" = c."responderTemplateId" WHERE c."id" = $1`, [customerId]),
      this.respondersVersionOf(this.sql, customerId),
    ]);
    return {
      version, templateId: (cust[0]?.responderTemplateId ?? null) as string | null, templateName: (cust[0]?.templateName ?? null) as string | null,
      entries: entries.map((r) => ({ contactId: r.contactId, role: r.role, source: r.source, templateId: r.templateId ?? null, templateName: r.templateName ?? null, order: r.order })),
      scopes: scopes.map((r) => ({ contactId: r.contactId, scopeType: r.scopeType, scopeId: r.scopeId, scopeName: r.scopeName, role: r.role })),
    };
  }

  async writeResponders(customerId: string, expectedVersion: number, op: ResponderOp, audit: AuditInput): Promise<ResponderWriteOutcome> {
    if (typeof customerId !== 'string' || !customerId || audit.customerId !== customerId) throw new Error('writeResponders: audit must be for the same customer');
    try {
      return await this.sql.transaction(async (tx) => {
        // The customer row is the lock of its Responders list: writers queue here, then re-read the version.
        const [locked] = await tx.query(`SELECT "id" FROM "Customer" WHERE "id" = $1 FOR UPDATE`, [customerId]);
        if (!locked) return 'CONFLICT' as const;
        if ((await this.respondersVersionOf(tx, customerId)) !== expectedVersion) return 'CONFLICT' as const;
        const has = async (id: string) => (await tx.query(`SELECT 1 FROM "Responder" WHERE "customerId" = $1 AND "contactId" = $2`, [customerId, id])).length > 0;
        const insert = async (id: string, role: string) => tx.query(
          `INSERT INTO "Responder"("customerId", "contactId", "role", "order", "source", "createdBy", "createdAt")
           VALUES ($1, $2, $3::"ResponderRole", COALESCE((SELECT max("order") + 1 FROM "Responder" WHERE "customerId" = $1), 0), 'DIRECT', $4, ${this.sql.now()})`,
          [customerId, id, role, audit.actorId]);
        let contactId: string;
        if (op.kind === 'add') {
          if (await has(op.contactId)) return 'EXISTS' as const;
          // tenant rule in the statement: staff, or a person of THIS customer
          const [ok] = await tx.query(`SELECT 1 FROM "Contact" WHERE "id" = $1 AND "active" AND ("kind" = 'INTERNAL' OR "customerId" = $2)`, [op.contactId, customerId]);
          if (!ok) return 'GONE' as const;
          await insert(op.contactId, op.role);
          contactId = op.contactId;
        } else if (op.kind === 'create') {
          contactId = newId('ct');
          await tx.query(
            `INSERT INTO "Contact"("id", "kind", "customerId", "name", "email", "phone", "active", "createdAt", "updatedAt") VALUES ($1, 'CUSTOMER', $2, $3, $4, $5, true, ${this.sql.now()}, ${this.sql.now()})`,
            [contactId, customerId, op.name, op.email, op.phone]);
          await insert(contactId, op.role);
          for (const role of op.extras) {
            await tx.query(`INSERT INTO "ContactScope"("id", "customerId", "contactId", "scopeType", "scopeId", "role", "createdAt") VALUES ($1, $2, $3, 'CUSTOMER', $2, $4::"ContactScopeRole", ${this.sql.now()})`,
              [newId('cs'), customerId, contactId, role]);
          }
        } else if (op.kind === 'role') {
          const r = await tx.query(`UPDATE "Responder" SET "role" = $3::"ResponderRole" WHERE "customerId" = $1 AND "contactId" = $2 RETURNING 1`, [customerId, op.contactId, op.role]);
          if (!r.length) return 'GONE' as const;
          contactId = op.contactId;
        } else {
          const r = await tx.query(`DELETE FROM "Responder" WHERE "customerId" = $1 AND "contactId" = $2 RETURNING 1`, [customerId, op.contactId]);
          if (!r.length) return 'GONE' as const;
          contactId = op.contactId;
        }
        await insertAudit(tx, { ...audit, targetType: 'Responders', targetId: contactId });
        return { contactId, version: expectedVersion + 1 };
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return 'EXISTS';
      throw err;
    }
  }

  // ───────────────────────────── Responder templates (MSP-level; API-CONTRACT §8.3) ─────────────────────────────

  private async templateViews(q: SqlExecutor, id: string | null): Promise<ResponderTemplateView[]> {
    const ts = await q.query(`SELECT "id", "name", "version", "updatedAt", "updatedBy" FROM "ResponderTemplate" WHERE ($1::text IS NULL OR "id" = $1) ORDER BY "name", "id"`, [id]);
    if (!ts.length) return [];
    const ids = ts.map((t) => t.id as string);
    const [ms, cs] = await Promise.all([
      q.query(`SELECT m."templateId", m."contactId", c."name" FROM "ResponderTemplateMember" m JOIN "Contact" c ON c."id" = m."contactId" WHERE m."templateId" = ANY($1::text[]) ORDER BY c."name", m."contactId"`, [ids]),
      q.query(`SELECT "id", "name", "responderTemplateId" AS "tid" FROM "Customer" WHERE "responderTemplateId" = ANY($1::text[]) AND "status" <> 'TERMINATED' ORDER BY "name", "id"`, [ids]),
    ]);
    return ts.map((t) => ({
      id: t.id, name: t.name, version: t.version, updatedAt: dReq(t.updatedAt), updatedBy: t.updatedBy ?? null,
      members: ms.filter((m) => m.templateId === t.id).map((m) => ({ contactId: m.contactId, name: m.name })),
      customers: cs.filter((c) => c.tid === t.id).map((c) => ({ id: c.id, name: c.name })),
    }));
  }
  async listResponderTemplates(): Promise<ResponderTemplateView[]> { return this.templateViews(this.sql, null); }
  async getResponderTemplate(id: string): Promise<ResponderTemplateView | null> { return (await this.templateViews(this.sql, id))[0] ?? null; }

  /** The impact inputs, read through `q` (the save reads them inside its transaction, after locking the customers). */
  private async impactInput(q: SqlExecutor, id: string, proposed: string[], lock: boolean): Promise<TemplateImpactInput | null> {
    const [t] = await q.query(`SELECT "id", "name", "version" FROM "ResponderTemplate" WHERE "id" = $1`, [id]);
    if (!t) return null;
    const members = (await q.query(`SELECT "contactId" FROM "ResponderTemplateMember" WHERE "templateId" = $1 ORDER BY "contactId"`, [id])).map((r) => r.contactId as string);
    const all = [...new Set([...members, ...proposed])];
    // customers locked in id order (every writer of a Responders list takes the customer row first)
    const custs = await q.query(`SELECT "id", "name" FROM "Customer" WHERE "responderTemplateId" = $1 AND "status" <> 'TERMINATED' ORDER BY "id"${lock ? ' FOR UPDATE' : ''}`, [id]);
    const cids = custs.map((c) => c.id as string);
    const [names, rs, steps] = await Promise.all([
      all.length ? q.query(`SELECT "id", "name" FROM "Contact" WHERE "id" = ANY($1::text[])`, [all]) : Promise.resolve([]),
      cids.length ? q.query(`SELECT "customerId", "contactId", "source", "templateId" FROM "Responder" WHERE "customerId" = ANY($1::text[])`, [cids]) : Promise.resolve([]),
      cids.length && all.length
        ? q.query(`SELECT pc."customerId", es."index", es."targetId" FROM "PagingConfig" pc JOIN "EscalationStep" es ON es."pagingConfigId" = pc."id"
                    WHERE pc."customerId" = ANY($1::text[]) AND es."targetType" = 'PERSON' AND es."targetId" = ANY($2::text[])`, [cids, all])
        : Promise.resolve([]),
    ]);
    // one batched read for all customers (the locks are held while it runs)
    const [ctxs, slackOk] = await Promise.all([this.pagingContextsVia(q, cids), this.slackVerifiedMany(q, cids)]);
    const paging = new Map<string, TemplatePaging>();
    for (const id of cids) { const { configs, world } = ctxs.get(id)!; paging.set(id, { configs, world, slackVerified: slackOk.has(id) }); }
    return {
      templateId: t.id, version: t.version, name: t.name, members,
      names: Object.fromEntries(names.map((n) => [n.id as string, n.name as string])),
      customers: custs.map((c) => ({
        id: c.id, name: c.name, paging: paging.get(c.id as string),
        responders: rs.filter((r) => r.customerId === c.id).map((r) => ({ contactId: r.contactId, source: r.source, templateId: r.templateId ?? null })),
        namedSteps: steps.filter((x) => x.customerId === c.id).map((x) => ({ contactId: x.targetId as string, stepIndex: (x.index as number) + 1 })),
      })),
    };
  }
  async responderTemplateImpactInput(id: string, proposedMembers: string[]): Promise<TemplateImpactInput | null> {
    return this.sql.transaction((tx) => this.impactInput(tx, id, proposedMembers, false));
  }

  private async allStaff(q: SqlExecutor, ids: string[]): Promise<boolean> {
    if (!ids.length) return false;
    const [r] = await q.query(`SELECT count(*)::int AS "n" FROM "Contact" WHERE "id" = ANY($1::text[]) AND "kind" = 'INTERNAL' AND "active"`, [ids]);
    return (r?.n as number) === ids.length;
  }

  async createResponderTemplate(t: TemplateCreate, audit: AuditInput): Promise<ResponderTemplateView | 'NAME_EXISTS' | 'BAD_MEMBER'> {
    try {
      return await this.sql.transaction(async (tx) => {
        if (!(await this.allStaff(tx, t.members))) return 'BAD_MEMBER' as const;
        const id = newId('rt');
        await tx.query(`INSERT INTO "ResponderTemplate"("id", "name", "updatedBy", "updatedAt", "version") VALUES ($1, $2, $3, $4::timestamptz, 0)`, [id, t.name, t.actorId, iso(t.at)]);
        for (const c of t.members) await tx.query(`INSERT INTO "ResponderTemplateMember"("templateId", "contactId") VALUES ($1, $2)`, [id, c]);
        await insertAudit(tx, { ...audit, customerId: null, targetType: 'ResponderTemplate', targetId: id });
        return (await this.templateViews(tx, id))[0]!;
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return 'NAME_EXISTS';
      throw err;
    }
  }

  async updateResponderTemplate(u: TemplateUpdate, audit: AuditInput): Promise<TemplateUpdateOutcome> {
    try {
      return await this.sql.transaction(async (tx): Promise<TemplateUpdateOutcome> => {
        const [cur] = await tx.query(`SELECT "name", "version" FROM "ResponderTemplate" WHERE "id" = $1 FOR UPDATE`, [u.id]);
        if (!cur) return 'NOT_FOUND';
        if (cur.version !== u.expectedVersion) return 'CONFLICT';
        // only people being ADDED must be active staff: a rename (or any save) must not fail because an existing member was deactivated since
        const have = new Set((await tx.query(`SELECT "contactId" FROM "ResponderTemplateMember" WHERE "templateId" = $1`, [u.id])).map((r) => r.contactId as string));
        const added = u.proposal.members.filter((m) => !have.has(m));
        if (added.length && !(await this.allStaff(tx, added))) return 'BAD_MEMBER';
        // The same function the preview used, on data read now with the customers locked: the hash is checked against what WILL happen.
        const input = await this.impactInput(tx, u.id, u.proposal.members, true);
        if (!input) return 'NOT_FOUND';
        const plan = planTemplateChange(input, u.proposal);
        if (plan.previewHash !== u.previewHash) return 'STALE';
        const blocking = templateBlocking(input, plan, u.at);
        if (blocking.length) return { blocking };
        let affected = 0;
        for (const c of plan.customers) {
          const joins = c.effects.filter((e) => e.kind === 'JOINS').map((e) => e.contactId);
          const leaves = c.effects.filter((e) => e.kind === 'LEAVES').map((e) => e.contactId);
          for (const id of joins) {
            await tx.query(
              `INSERT INTO "Responder"("customerId", "contactId", "role", "order", "source", "templateId", "createdBy", "createdAt")
               VALUES ($1, $2, 'PAGEABLE', COALESCE((SELECT max("order") + 1 FROM "Responder" WHERE "customerId" = $1), 0), 'TEMPLATE', $3, $4, ${this.sql.now()})`,
              [c.id, id, u.id, u.actorId]);
          }
          if (leaves.length) await tx.query(`DELETE FROM "Responder" WHERE "customerId" = $1 AND "contactId" = ANY($2::text[]) AND "source" = 'TEMPLATE' AND "templateId" = $3`, [c.id, leaves, u.id]);
          if (joins.length || leaves.length) {
            affected += 1;
            // another targetType than 'Responders': the customer's Responders version does not move (API-CONTRACT)
            await insertAudit(tx, { ...audit, customerId: c.id, action: 'responder_template.apply', targetType: 'ResponderTemplate', targetId: u.id, before: null, after: { added: joins, removed: leaves } });
          }
        }
        await tx.query(`UPDATE "ResponderTemplate" SET "name" = $2, "version" = "version" + 1, "updatedBy" = $3, "updatedAt" = $4::timestamptz WHERE "id" = $1`, [u.id, u.proposal.name, u.actorId, iso(u.at)]);
        if (plan.removed.length) await tx.query(`DELETE FROM "ResponderTemplateMember" WHERE "templateId" = $1 AND "contactId" = ANY($2::text[])`, [u.id, plan.removed]);
        for (const id of plan.added) await tx.query(`INSERT INTO "ResponderTemplateMember"("templateId", "contactId") VALUES ($1, $2)`, [u.id, id]);
        await tx.query(
          `INSERT INTO "BulkChange"("id", "kind", "actorId", "params", "preview", "previewHash", "createdAt") VALUES ($1, 'TEMPLATE_UPDATE'::"BulkChangeKind", $2, $3::jsonb, $4::jsonb, $5, $6::timestamptz)`,
          [newId('bc'), u.actorId, js({ templateId: u.id, added: plan.added, removed: plan.removed }), js({ customers: plan.customers.map((c) => ({ id: c.id, effects: c.effects })), totals: plan.totals }), plan.previewHash, iso(u.at)]);
        await insertAudit(tx, {
          ...audit, customerId: null, targetType: 'ResponderTemplate', targetId: u.id,
          before: { name: input.name, members: [...input.members].sort(), version: input.version },
          after: { name: u.proposal.name, members: [...u.proposal.members].sort(), version: input.version + 1, added: plan.added, removed: plan.removed },
        });
        return { view: (await this.templateViews(tx, u.id))[0]!, affected };
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return 'NAME_EXISTS';
      if (isBusyError(err)) return 'BUSY';
      throw err;
    }
  }

  // ───────────────────────────── one customer's template (D-64) ─────────────────────────────

  private async templateRef(q: SqlExecutor, id: string | null): Promise<TemplateRef | null> {
    if (!id) return null;
    const [t] = await q.query(`SELECT "id", "name", "version" FROM "ResponderTemplate" WHERE "id" = $1`, [id]);
    if (!t) return null;
    const ms = await q.query(`SELECT m."contactId", c."active" FROM "ResponderTemplateMember" m LEFT JOIN "Contact" c ON c."id" = m."contactId" WHERE m."templateId" = $1 ORDER BY m."contactId"`, [id]);
    return { id: t.id, name: t.name, version: t.version, members: ms.map((m) => m.contactId as string), inactive: ms.filter((m) => m.active !== true).map((m) => m.contactId as string) };
  }

  /** Everything `planTemplateAttach` needs, read through `q` (the save reads it inside its transaction, after the locks). */
  private async attachInput(q: SqlExecutor, customerId: string, toId: string | null): Promise<TemplateAttachInput | 'NO_TEMPLATE' | null> {
    const [c] = await q.query(`SELECT "id", "name", "status", "responderTemplateId" FROM "Customer" WHERE "id" = $1`, [customerId]);
    if (!c) return null;
    const to = await this.templateRef(q, toId);
    if (toId !== null && !to) return 'NO_TEMPLATE';
    const from = await this.templateRef(q, (c.responderTemplateId ?? null) as string | null);
    const ids = [...new Set([...(from?.members ?? []), ...(to?.members ?? [])])];
    const [names, rs, steps, version, ctx, slack] = await Promise.all([
      ids.length ? q.query(`SELECT "id", "name" FROM "Contact" WHERE "id" = ANY($1::text[])`, [ids]) : Promise.resolve([]),
      q.query(`SELECT "contactId", "source", "templateId" FROM "Responder" WHERE "customerId" = $1`, [customerId]),
      ids.length ? q.query(`SELECT es."index", es."targetId" FROM "PagingConfig" pc JOIN "EscalationStep" es ON es."pagingConfigId" = pc."id"
                              WHERE pc."customerId" = $1 AND es."targetType" = 'PERSON' AND es."targetId" = ANY($2::text[])`, [customerId, ids]) : Promise.resolve([]),
      this.respondersVersionOf(q, customerId),
      this.pagingContextVia(q, customerId),
      this.slackVerifiedVia(q, customerId),
    ]);
    return {
      customer: {
        id: c.id, name: c.name, status: c.status, templateId: (c.responderTemplateId ?? null) as string | null, version,
        responders: rs.map((r) => ({ contactId: r.contactId, source: r.source, templateId: r.templateId ?? null })),
        namedSteps: steps.map((x) => ({ contactId: x.targetId as string, stepIndex: (x.index as number) + 1 })),
        paging: { configs: ctx.configs, world: ctx.world, slackVerified: slack },
      },
      from, to, names: Object.fromEntries(names.map((n) => [n.id as string, n.name as string])),
    };
  }
  async customerTemplateAttachInput(customerId: string, toTemplateId: string | null): Promise<TemplateAttachInput | 'NO_TEMPLATE' | null> {
    return this.sql.transaction((tx) => this.attachInput(tx, customerId, toTemplateId));
  }

  async setCustomerTemplate(w: TemplateAttachWrite, audit: AuditInput): Promise<TemplateAttachOutcome> {
    if (typeof w.customerId !== 'string' || !w.customerId || audit.customerId !== w.customerId) throw new Error('setCustomerTemplate: audit must be for the same customer');
    try {
      return await this.sql.transaction(async (tx): Promise<TemplateAttachOutcome> => {
        // Lock order: template row(s) in id order, THEN the customer row — the order of updateResponderTemplate (template, then its customers).
        const [pre] = await tx.query(`SELECT "responderTemplateId" FROM "Customer" WHERE "id" = $1`, [w.customerId]);
        if (!pre) return 'NOT_FOUND';
        const preFrom = (pre.responderTemplateId ?? null) as string | null;
        const lockIds = [...new Set([preFrom, w.toTemplateId].filter((x): x is string => !!x))].sort();
        if (lockIds.length) await tx.query(`SELECT "id" FROM "ResponderTemplate" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE`, [lockIds]);
        const [locked] = await tx.query(`SELECT "status", "responderTemplateId" FROM "Customer" WHERE "id" = $1 FOR UPDATE`, [w.customerId]);
        if (!locked) return 'NOT_FOUND';
        if (w.toTemplateId !== null && !(await this.templateRef(tx, w.toTemplateId))) return 'NO_TEMPLATE';
        if (locked.status === 'TERMINATED') return 'TERMINATED';
        if ((await this.respondersVersionOf(tx, w.customerId)) !== w.expectedVersion) return 'CONFLICT';
        // somebody switched the customer's template between our first read and the lock: the preview no longer describes this state
        if (((locked.responderTemplateId ?? null) as string | null) !== preFrom) return 'STALE';
        const input = await this.attachInput(tx, w.customerId, w.toTemplateId);
        if (input === null) return 'NOT_FOUND';
        if (input === 'NO_TEMPLATE') return 'NO_TEMPLATE';
        const plan = planTemplateAttach(input);
        if (plan.previewHash !== w.previewHash) return 'STALE';
        const blocking = attachBlocking(input, plan, w.at);
        if (blocking.length) return { blocking };
        const to = input.to;
        if (plan.leaves.length) await tx.query(`DELETE FROM "Responder" WHERE "customerId" = $1 AND "contactId" = ANY($2::text[]) AND "source" = 'TEMPLATE' AND "templateId" = $3`, [w.customerId, plan.leaves, input.from!.id]);
        if (plan.retarget.length) await tx.query(`UPDATE "Responder" SET "templateId" = $3 WHERE "customerId" = $1 AND "contactId" = ANY($2::text[]) AND "source" = 'TEMPLATE'`, [w.customerId, plan.retarget, to!.id]);
        for (const id of plan.joins) {
          await tx.query(
            `INSERT INTO "Responder"("customerId", "contactId", "role", "order", "source", "templateId", "createdBy", "createdAt")
             VALUES ($1, $2, 'PAGEABLE', COALESCE((SELECT max("order") + 1 FROM "Responder" WHERE "customerId" = $1), 0), 'TEMPLATE', $3, $4, ${this.sql.now()})`,
            [w.customerId, id, to!.id, w.actorId]);
        }
        await tx.query(`UPDATE "Customer" SET "responderTemplateId" = $2, "updatedAt" = ${this.sql.now()} WHERE "id" = $1`, [w.customerId, w.toTemplateId]);
        // targetType 'Responders': the customer's Responders version (the number of these rows) moves by one
        await insertAudit(tx, { ...audit, before: { templateId: input.from?.id ?? null }, after: { templateId: to?.id ?? null, added: plan.joins, removed: plan.leaves } });
        return { version: w.expectedVersion + 1, templateId: w.toTemplateId, joins: plan.joins.length, leaves: plan.leaves.length, skippedInactive: plan.skippedInactive };
      });
    } catch (err) {
      if (isBusyError(err)) return 'BUSY';
      throw err;
    }
  }

  // ───────────────────────────── rotations (D-28, D-41) ─────────────────────────────

  /** One rotation with members (in order), pins, Override rows, the Leaves of the people involved, their contacts and the customers whose steps name it. */
  private async rotationStateVia(q: SqlExecutor, rotationId: string, extra: string[] = []): Promise<RotationState | null> {
    const [r] = await q.query(
      `SELECT r."id", r."scope", r."customerId", r."name", r."cadence", r."anchorAt", r."version",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('contactId', m."contactId", 'order', m."order") ORDER BY m."order", m."contactId")
                          FROM "RotationMember" m WHERE m."rotationId" = r."id"), '[]'::jsonb) AS "members"
         FROM "Rotation" r WHERE r."id" = $1`, [rotationId]);
    if (!r) return null;
    const pins = (await loadPins(q, [rotationId])).get(rotationId) ?? [];
    const ovRows = await q.query(`SELECT "rotationId", "contactId", "startAt", "endAt", "status", "kind" FROM "Override" WHERE "rotationId" = $1 ORDER BY "startAt", "id"`, [rotationId]);
    const overrides: Override[] = ovRows.map((o) => ({ rotationId: o.rotationId, contactId: o.contactId, startAt: dReq(o.startAt), endAt: dReq(o.endAt), status: o.status, kind: o.kind ?? null }));
    const rotation: Rotation = { id: r.id, scope: r.scope, customerId: r.customerId ?? null, name: r.name, cadence: r.cadence, anchorAt: dReq(r.anchorAt), members: r.members, pins, version: Number(r.version) };
    const people = [...new Set([...rotation.members.map((m) => m.contactId), ...pins.map((p) => p.contactId), ...overrides.map((o) => o.contactId), ...extra])];
    const lvRows = people.length ? await q.query(`SELECT "contactId", "replacementId", to_char("startDate", 'YYYY-MM-DD') AS "startDate", to_char("endDate", 'YYYY-MM-DD') AS "endDate", "cancelledAt" FROM "Leave" WHERE "contactId" = ANY($1::text[]) ORDER BY "startDate", "id"`, [people]) : [];
    const leaves: Leave[] = lvRows.map((l) => ({ contactId: l.contactId, replacementId: l.replacementId, startDate: l.startDate, endDate: l.endDate, cancelledAt: d(l.cancelledAt) }));
    const cids = [...new Set([...people, ...leaves.map((l) => l.replacementId)])];
    const cRows = cids.length ? await q.query(`SELECT ${CONTACT_COLS} FROM "Contact" WHERE "id" = ANY($1::text[])`, [cids]) : [];
    const customers = (await q.query(
      `SELECT DISTINCT c."id", c."name" FROM "EscalationStep" es JOIN "PagingConfig" pc ON pc."id" = es."pagingConfigId" JOIN "Customer" c ON c."id" = pc."customerId"
        WHERE es."targetType" = 'ROTATION' AND es."targetId" = $1 AND c."status" <> 'TERMINATED' ORDER BY c."name", c."id"`, [rotationId])).map((c) => ({ id: c.id as string, name: c.name as string }));
    return { rotation, rotations: [rotation], overrides, leaves, contacts: new Map(cRows.map((c) => [c.id as string, toContact(c)])), customers };
  }
  async rotationState(rotationId: string, extraContactIds: string[] = []): Promise<RotationState | null> {
    return this.sql.transaction((tx) => this.rotationStateVia(tx, rotationId, extraContactIds));
  }

  private async usageVia(q: SqlExecutor, rotationId: string, scope: ScopeFilter | null): Promise<RotationUsageRow[]> {
    const all = scope === null || scope.customerIds === '*';
    const ids = scope === null || scope.customerIds === '*' ? [] : [...scope.customerIds];
    const rows = await q.query(
      `SELECT c."id" AS "customerId", c."name" AS "customerName", c."slug" AS "customerSlug", c."status"::text AS "customerStatus", pc."id" AS "pagingConfigId",
              pc."scopeType"::text AS "level", pc."scopeId", es."index",
              CASE pc."scopeType"::text WHEN 'CUSTOMER' THEN c."name" WHEN 'PROJECT' THEN p."name" ELSE s."name" END AS "scopeName",
              CASE pc."scopeType"::text WHEN 'PROJECT' THEN p."id" WHEN 'SERVICE' THEN s."projectId" END AS "projectId", s."id" AS "serviceId"
         FROM "EscalationStep" es JOIN "PagingConfig" pc ON pc."id" = es."pagingConfigId" JOIN "Customer" c ON c."id" = pc."customerId"
         LEFT JOIN "Project" p ON pc."scopeType"::text = 'PROJECT' AND p."id" = pc."scopeId" AND p."customerId" = pc."customerId"
         LEFT JOIN "Service" s ON pc."scopeType"::text = 'SERVICE' AND s."id" = pc."scopeId" AND s."customerId" = pc."customerId"
        WHERE es."targetType" = 'ROTATION' AND es."targetId" = $1 AND ($2::boolean OR c."id" = ANY($3::text[]))
        ORDER BY c."name", c."id", pc."id", es."index"`, [rotationId, all, ids]);
    let out: RotationUsageRow[] = rows.map((r) => ({
      customerId: r.customerId, customerName: r.customerName, customerSlug: r.customerSlug, customerStatus: r.customerStatus as CustomerStatusValue,
      level: r.level, scopeId: r.scopeId, scopeName: r.scopeName ?? r.scopeId, projectId: r.projectId ?? null, serviceId: r.serviceId ?? null, pagingConfigId: r.pagingConfigId, stepIndex: Number(r.index) + 1,
    }));
    if (scope !== null) {
      const projectOf = new Map(out.filter((o) => o.serviceId).map((o) => [o.serviceId as string, o.projectId as string]));
      // staff narrowed by sub-scopes only (customers '*') see the customers they have a sub-scope in, and nothing of the others
      out = out.filter((o) => seesCustomer(scope, o.customerId) && (scope.customerIds !== '*' || scope.subScopes.length === 0 || scope.subScopes.some((x) => x.customerId === o.customerId))
        && nodeVisible(scope, { customerId: o.customerId, ...(o.projectId ? { projectId: o.projectId } : {}), ...(o.serviceId ? { serviceId: o.serviceId } : {}) }, (sid) => projectOf.get(sid)));
    }
    return out;
  }
  async rotationUsage(rotationId: string, scope: ScopeFilter): Promise<RotationUsageRow[]> { return this.usageVia(this.sql, rotationId, scope); }

  /**
   * Active INTERNAL staff, or (customerId given) active PAGEABLE Responders of that customer. `lock`: Contact rows FOR SHARE, then (customer people only)
   * their Responder rows FOR SHARE, both in id order (the order a contact delete takes them: Contact, then the cascade to Responder). So a concurrent
   * contact delete, or a change of the Responder to NOTIFY_ONLY, either commits first (READ COMMITTED re-checks the row: it is not counted) or waits for this write.
   */
  private async membersOkVia(q: SqlExecutor, customerId: string | null, ids: string[], lock: boolean): Promise<boolean> {
    if (!ids.length) return false;
    const rows = await q.query(
      `SELECT c."id", c."kind"::text AS "kind" FROM "Contact" c WHERE c."id" = ANY($1::text[]) AND c."active"
          AND (c."kind" = 'INTERNAL' OR ($2::text IS NOT NULL AND c."customerId" = $2)) ${lock ? 'ORDER BY c."id" FOR SHARE OF c' : ''}`, [ids, customerId]);
    const people = rows.filter((r) => r.kind !== 'INTERNAL').map((r) => r.id as string);
    let pageable = 0;
    if (people.length && customerId !== null) {
      pageable = (await q.query(
        `SELECT r."contactId" FROM "Responder" r WHERE r."customerId" = $2 AND r."contactId" = ANY($1::text[]) AND r."role" = 'PAGEABLE' ${lock ? 'ORDER BY r."contactId" FOR SHARE' : ''}`, [people, customerId])).length;
    }
    return rows.length - people.length + pageable === new Set(ids).size && pageable === people.length;
  }
  async rotationMembersOk(customerId: string | null, ids: string[]): Promise<boolean> { return this.membersOkVia(this.sql, customerId, ids, false); }

  async createRotation(n: NewRotation, audit: AuditTemplate): Promise<RotationCreateOutcome> {
    try {
      return await this.sql.transaction(async (tx): Promise<RotationCreateOutcome> => {
        if (n.customerId !== null) {
          const [c] = await tx.query(`SELECT "status" FROM "Customer" WHERE "id" = $1 FOR SHARE`, [n.customerId]);
          if (c?.status === 'TERMINATED') return 'CUSTOMER_TERMINATED';
        }
        if (!(await this.membersOkVia(tx, n.customerId, n.members, true))) return 'BAD_MEMBER';
        const id = newId('rot');
        const h = handoverOf(n.cadence, n.anchorAt);
        await tx.query(
          `INSERT INTO "Rotation"("id", "scope", "customerId", "name", "cadence", "handoverDow", "handoverMin", "anchorAt", "version")
           VALUES ($1, $2::"RotationScope", $3, $4, $5::"Cadence", $6, $7, $8::timestamptz, 0)`,
          [id, n.scope, n.customerId, n.name, n.cadence, h.dow ?? new Date(n.anchorAt.getTime() + 9 * 3600_000).getUTCDay(), h.minute, iso(n.anchorAt)]);
        for (const [order, contactId] of n.members.entries()) await tx.query(`INSERT INTO "RotationMember"("rotationId", "contactId", "order") VALUES ($1, $2, $3)`, [id, contactId, order]);
        await insertAudit(tx, { ...audit, customerId: n.customerId, targetId: id });
        return { id };
      });
    } catch (err) {
      if (isUniqueOn(err, ROTATION_NAME_KEY)) return 'NAME_EXISTS'; // any other 23505 is not "name taken": it surfaces
      if (isBusyError(err, ROTATION_RACE_FKS)) return 'BUSY';
      throw err;
    }
  }

  /**
   * Lock order of rotation writes: Rotation row (FOR UPDATE; FOR SHARE in a call order save), THEN the Customer row FOR SHARE (a CUSTOMER rotation only) — the
   * order PATCH and DELETE take. createRotation takes Customer FOR SHARE before it inserts its (new, so unlockable by others) Rotation row, which cannot
   * wait on anyone. The customer status change takes Customer FOR UPDATE and never a Rotation lock, so no cycle. Called with the Rotation row already locked.
   */
  private async customerTerminatedUnderShare(tx: SqlExecutor, scope: unknown, customerId: string | null): Promise<boolean> {
    if (scope !== 'CUSTOMER' || customerId === null) return false;
    const [c] = await tx.query(`SELECT "status"::text AS "status" FROM "Customer" WHERE "id" = $1 FOR SHARE`, [customerId]);
    return c?.status === 'TERMINATED';
  }

  async updateRotation(u: RotationUpdate, audit: AuditTemplate): Promise<RotationUpdateOutcome> {
    try {
      return await this.sql.transaction(async (tx): Promise<RotationUpdateOutcome> => {
        const [cur] = await tx.query(`SELECT "customerId", "scope", "version" FROM "Rotation" WHERE "id" = $1 FOR UPDATE`, [u.id]);
        if (!cur) return 'NOT_FOUND';
        if (Number(cur.version) !== u.expectedVersion) return 'CONFLICT';
        const customerId = (cur.customerId ?? null) as string | null;
        if (await this.customerTerminatedUnderShare(tx, cur.scope, customerId)) return 'CUSTOMER_TERMINATED';
        const [taken] = await tx.query(`SELECT 1 AS "x" FROM "Rotation" WHERE "customerId" IS NOT DISTINCT FROM $1 AND "name" = $2 AND "id" <> $3`, [customerId, u.name, u.id]);
        if (taken) return 'NAME_EXISTS';
        const state = (await this.rotationStateVia(tx, u.id, u.members ?? []))!;
        const have = new Set(state.rotation.members.map((m) => m.contactId));
        const added = (u.members ?? []).filter((id) => !have.has(id));
        if (added.length && !(await this.membersOkVia(tx, customerId, added, true))) return 'BAD_MEMBER';
        const ev = evaluateRotationChange(state, { name: u.name, members: u.members, handover: u.handover }, u.at);
        if (!ev.scheduleChanged && !ev.nameChanged) return 'NOOP';
        if (ev.scheduleChanged && u.previewHash !== null && ev.previewHash !== u.previewHash) return 'STALE';
        const r = state.rotation;
        const pinJson = (pins: ReadonlyArray<{ contactId: string; startAt: Date; endAt: Date; reason?: string | null }>) =>
          pins.map((p) => ({ contactId: p.contactId, startAt: p.startAt.toISOString(), endAt: p.endAt.toISOString(), reason: p.reason ?? null }));
        const before = { name: r.name, memberIds: r.members.map((m) => m.contactId), handover: handoverOf(r.cadence, r.anchorAt), anchorAt: r.anchorAt.toISOString(), pins: pinJson(r.pins ?? []) };
        let anchorAt = r.anchorAt;
        let memberIds = before.memberIds;
        let pins: ReadonlyArray<{ contactId: string; startAt: Date; endAt: Date; reason?: string | null }> = r.pins ?? [];
        if (ev.scheduleChanged) {
          anchorAt = ev.plan.anchorAt; pins = ev.plan.pins;
          const h = handoverOf(r.cadence, anchorAt);
          await tx.query(`UPDATE "Rotation" SET "name" = $2, "anchorAt" = $3::timestamptz, "handoverMin" = $4, "handoverDow" = $5, "version" = "version" + 1 WHERE "id" = $1`,
            [u.id, u.name, iso(anchorAt), h.minute, h.dow ?? new Date(anchorAt.getTime() + 9 * 3600_000).getUTCDay()]);
          if (ev.membersChanged) {
            memberIds = ev.members;
            await tx.query(`DELETE FROM "RotationMember" WHERE "rotationId" = $1`, [u.id]);
            for (const [order, contactId] of ev.members.entries()) await tx.query(`INSERT INTO "RotationMember"("rotationId", "contactId", "order") VALUES ($1, $2, $3)`, [u.id, contactId, order]);
          }
          await tx.query(`DELETE FROM "RotationPin" WHERE "rotationId" = $1`, [u.id]);
          for (const p of ev.plan.pins) await tx.query(`INSERT INTO "RotationPin"("id", "rotationId", "contactId", "startAt", "endAt", "reason") VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6)`, [newId('pin'), u.id, p.contactId, iso(p.startAt), iso(p.endAt), p.reason]);
        } else {
          await tx.query(`UPDATE "Rotation" SET "name" = $2, "version" = "version" + 1 WHERE "id" = $1`, [u.id, u.name]);
        }
        const version = Number(cur.version) + 1;
        await insertAudit(tx, { ...audit, customerId, targetId: u.id, before, after: { name: u.name, memberIds, handover: handoverOf(r.cadence, anchorAt), anchorAt: anchorAt.toISOString(), pins: pinJson(pins), version } });
        if (ev.scheduleChanged && cur.scope === 'MSP') {
          for (const c of state.customers) await insertAudit(tx, { ...audit, customerId: c.id, action: 'rotation.apply', targetId: u.id, before: null, after: { rotationId: u.id, changedRows: ev.plan.changedRows, pins: ev.plan.pins.length } });
        }
        return { affected: ev.scheduleChanged ? state.customers.length : 0 };
      });
    } catch (err) {
      if (isUniqueOn(err, ROTATION_NAME_KEY)) return 'NAME_EXISTS'; // any other 23505 is not "name taken": it surfaces
      if (isBusyError(err, ROTATION_RACE_FKS)) return 'BUSY';
      throw err;
    }
  }

  async deleteRotation(rotationId: string, expectedVersion: number, audit: AuditTemplate): Promise<RotationDeleteOutcome> {
    try {
      return await this.sql.transaction(async (tx): Promise<RotationDeleteOutcome> => {
        const [cur] = await tx.query(`SELECT "customerId", "name", "scope", "version" FROM "Rotation" WHERE "id" = $1 FOR UPDATE`, [rotationId]);
        if (!cur) return 'NOT_FOUND';
        if (Number(cur.version) !== expectedVersion) return 'CONFLICT';
        if (await this.customerTerminatedUnderShare(tx, cur.scope, (cur.customerId ?? null) as string | null)) return 'CUSTOMER_TERMINATED';
        // every customer counts, terminated ones too; PUT paging holds FOR SHARE on this row while it saves, so a step it adds is seen here.
        // Of a CUSTOMER rotation only its own customer's rows are shown (a step of another customer from legacy data still blocks, but its name and slug are not given out).
        const usage = await this.usageVia(tx, rotationId, null);
        if (usage.length) return { inUse: cur.scope === 'CUSTOMER' ? usage.filter((u) => u.customerId === cur.customerId) : usage };
        const [cnt] = await tx.query(`SELECT count(*)::int AS "n" FROM "Override" WHERE "rotationId" = $1`, [rotationId]);
        const memberIds = (await tx.query(`SELECT "contactId" FROM "RotationMember" WHERE "rotationId" = $1 ORDER BY "order", "contactId"`, [rotationId])).map((m) => m.contactId as string);
        await tx.query(`DELETE FROM "Rotation" WHERE "id" = $1`, [rotationId]);
        await insertAudit(tx, { ...audit, customerId: (cur.customerId ?? null) as string | null, targetId: rotationId, before: { name: cur.name, scope: cur.scope, memberIds, overrides: Number(cnt?.n ?? 0) }, after: null });
        return 'OK';
      });
    } catch (err) {
      if (isBusyError(err, ROTATION_RACE_FKS)) return 'BUSY';
      throw err;
    }
  }

  async rotationsWorld(scope: ScopeFilter): Promise<RotationsWorld> {
    const all = scope.customerIds === '*';
    const ids = all ? [] : [...scope.customerIds];
    const rows = await this.sql.query(
      `SELECT r."id", r."scope", r."customerId", r."name", r."cadence", r."anchorAt", r."version",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('contactId', m."contactId", 'order', m."order") ORDER BY m."order", m."contactId")
                          FROM "RotationMember" m WHERE m."rotationId" = r."id"), '[]'::jsonb) AS "members"
         FROM "Rotation" r WHERE r."scope" = 'MSP' OR (r."customerId" IS NOT NULL AND ($1::boolean OR r."customerId" = ANY($2::text[]))) ORDER BY r."name", r."id"`, [all, ids]);
    const pinsOf = await loadPins(this.sql, rows.map((r) => r.id as string));
    const rotations: Rotation[] = rows.map((r) => ({ id: r.id, scope: r.scope, customerId: r.customerId ?? null, name: r.name, cadence: r.cadence, anchorAt: dReq(r.anchorAt), members: r.members, version: Number(r.version), pins: pinsOf.get(r.id as string) ?? [] }));
    const rids = rotations.map((r) => r.id);
    const ovRows = rids.length ? await this.sql.query(`SELECT "rotationId", "contactId", "startAt", "endAt", "status" FROM "Override" WHERE "rotationId" = ANY($1::text[]) ORDER BY "startAt", "id"`, [rids]) : [];
    const overrides: Override[] = ovRows.map((r) => ({ rotationId: r.rotationId, contactId: r.contactId, startAt: dReq(r.startAt), endAt: dReq(r.endAt), status: r.status }));
    const people = [...new Set([...rotations.flatMap((r) => [...r.members.map((m) => m.contactId), ...(r.pins ?? []).map((p) => p.contactId)]), ...overrides.map((o) => o.contactId)])];
    const lvRows = people.length ? await this.sql.query(`SELECT "contactId", "replacementId", to_char("startDate", 'YYYY-MM-DD') AS "startDate", to_char("endDate", 'YYYY-MM-DD') AS "endDate", "cancelledAt" FROM "Leave" WHERE "contactId" = ANY($1::text[]) ORDER BY "startDate", "id"`, [people]) : [];
    const leaves: Leave[] = lvRows.map((r) => ({ contactId: r.contactId, replacementId: r.replacementId, startDate: r.startDate, endDate: r.endDate, cancelledAt: d(r.cancelledAt) }));
    const cids = [...new Set([...people, ...leaves.map((l) => l.replacementId)])];
    const cRows = cids.length ? await this.sql.query(`SELECT ${CONTACT_COLS} FROM "Contact" WHERE "id" = ANY($1::text[])`, [cids]) : [];
    return { rotations, overrides, leaves, contacts: new Map(cRows.map((r) => [r.id as string, toContact(r)])) };
  }

  async staffContacts(): Promise<Contact[]> {
    return (await this.sql.query(`SELECT ${CONTACT_COLS} FROM "Contact" WHERE "kind" = 'INTERNAL' AND "active" ORDER BY "name", "id"`)).map(toContact);
  }

  // ───────────────────────────── retention (D-45), export, digest (D-46) ─────────────────────────────

  async retentionView(customerId: string): Promise<RetentionView | null> {
    const [c] = await this.sql.query(`SELECT "name", "status", "statusChangedAt", "legalHold", "legalHoldAt", "legalHoldByUserId", "legalHoldReason" FROM "Customer" WHERE "id" = $1`, [customerId]);
    if (!c) return null;
    return { name: c.name, status: c.status, statusChangedAt: d(c.statusChangedAt), legalHold: { active: c.legalHold === true, at: d(c.legalHoldAt), byUserId: c.legalHoldByUserId ?? null, reason: c.legalHoldReason ?? null } };
  }
  async setLegalHold(customerId: string, hold: { byUserId: string; reason: string; at: Date } | null, audit: AuditInput): Promise<'OK' | 'NOOP' | 'NOT_FOUND'> {
    if (typeof customerId !== 'string' || !customerId || audit.customerId !== customerId) throw new Error('setLegalHold: audit must be for the same customer');
    return this.sql.transaction(async (tx) => {
      const [c] = await tx.query(`SELECT "legalHold" FROM "Customer" WHERE "id" = $1 FOR UPDATE`, [customerId]);
      if (!c) return 'NOT_FOUND' as const;
      if ((c.legalHold === true) === !!hold) return 'NOOP' as const;
      // The retention statements take FOR SHARE on this row (retentionSql GUARD): this FOR UPDATE waits for a chunk that is running,
      // so a hold committed here is seen by every chunk that starts afterwards. A chunk already running finishes first.
      if (hold) {
        await tx.query(`UPDATE "Customer" SET "legalHold" = true, "legalHoldAt" = $2::timestamptz, "legalHoldByUserId" = $3, "legalHoldReason" = $4, "updatedAt" = ${this.sql.now()} WHERE "id" = $1`, [customerId, iso(hold.at), hold.byUserId, hold.reason]);
      } else {
        await tx.query(`UPDATE "Customer" SET "legalHold" = false, "legalHoldAt" = NULL, "legalHoldByUserId" = NULL, "legalHoldReason" = NULL, "updatedAt" = ${this.sql.now()} WHERE "id" = $1`, [customerId]);
      }
      await tx.query(`INSERT INTO "RetentionPurgeLog"("id", "customerId", "stage", "counts", "actor", "at") VALUES ($1, $2, $3::"RetentionStage", '{}'::jsonb, $4, ${this.sql.now()})`,
        [newId('purge'), customerId, hold ? 'LEGAL_HOLD_SET' : 'LEGAL_HOLD_RELEASED', hold ? hold.byUserId : (audit.actorId ?? 'unknown')]);
      await insertAudit(tx, audit);
      return 'OK' as const;
    });
  }
  purgeLog(customerId: string): Promise<PurgeLogEntry[]> { return purgeLogOf(this.sql, customerId); }
  async countExportIncidents(customerId: string): Promise<number> {
    const [r] = await this.sql.query(`SELECT count(*)::int AS "n" FROM "Incident" WHERE "customerId" = $1`, [customerId]);
    return (r?.n as number) ?? 0;
  }
  async exportIncidents(customerId: string, afterNumber: number, limit: number): Promise<ExportIncidentRow[]> {
    const rows = await this.sql.query(
      `SELECT "number", "id", "title", "severity", "status", "triggeredAt", "acknowledgedAt", "resolvedAt", "mttaSec", "mttrSec", "memberCount", "eventCount", "accountIds", "resourceTypes", "pagingSuppressed"
         FROM "Incident" WHERE "customerId" = $1 AND "number" > $2 ORDER BY "number" LIMIT $3`, [customerId, afterNumber, limit]);
    return rows.map((r) => ({
      number: r.number, id: r.id, title: r.title, severity: r.severity, status: r.status, triggeredAt: dReq(r.triggeredAt), acknowledgedAt: d(r.acknowledgedAt), resolvedAt: d(r.resolvedAt),
      mttaSec: r.mttaSec ?? null, mttrSec: r.mttrSec ?? null, memberCount: r.memberCount, eventCount: r.eventCount, accountIds: r.accountIds ?? [], resourceTypes: r.resourceTypes ?? [], pagingSuppressed: r.pagingSuppressed ?? null,
    }));
  }
  async recordAudit(audit: AuditInput): Promise<void> { await insertAudit(this.sql, audit); }
  async digestData(scope: ScopeFilter, from: Date, to: Date): Promise<DigestData> {
    // One parameter list per statement: Postgres cannot type a parameter the statement does not use.
    const ps = new Params();
    const [f, t] = [ps.add(iso(from)), ps.add(iso(to))];
    const susScope = scopeSql(ps, scope, 'i');
    const pr = new Params();
    const [rf, rt] = [pr.add(iso(from)), pr.add(iso(to))];
    const resScope = scopeSql(pr, scope, 'r', { project: 'NULL', service: 'NULL' }); // residuals have no project/service: the whole customer must be in scope
    const [sus, res] = await Promise.all([
      this.sql.query(
        `SELECT i."customerId", c."name", count(*)::int AS "n", min(i."triggeredAt") AS "firstAt", max(i."triggeredAt") AS "lastAt"
           FROM "Incident" i JOIN "Customer" c ON c."id" = i."customerId"
          WHERE i."pagingSuppressed" = 'CUSTOMER_SUSPENDED' AND i."triggeredAt" >= ${f}::timestamptz AND i."triggeredAt" < ${t}::timestamptz AND ${susScope} GROUP BY i."customerId", c."name" ORDER BY c."name"`, ps.values),
      this.sql.query(
        `SELECT r."customerId", c."name", count(*) FILTER (WHERE r."lastAt" >= ${rf}::timestamptz AND r."lastAt" < ${rt}::timestamptz)::int AS "sources", max(r."lastAt") FILTER (WHERE r."lastAt" >= ${rf}::timestamptz AND r."lastAt" < ${rt}::timestamptz) AS "lastAt",
                (SELECT COALESCE(sum(r2."count"), 0)::int FROM "OffboardResidual" r2 WHERE r2."customerId" = r."customerId") AS "total"
           FROM "OffboardResidual" r JOIN "Customer" c ON c."id" = r."customerId"
          WHERE r."lastAt" >= ${rf}::timestamptz AND r."lastAt" < ${rt}::timestamptz AND ${resScope} GROUP BY r."customerId", c."name" ORDER BY c."name"`, pr.values),
    ]);
    return {
      suspended: sus.map((r) => ({ customerId: r.customerId, customerName: r.name, incidents: r.n, firstAt: dReq(r.firstAt), lastAt: dReq(r.lastAt) })),
      terminatedResiduals: res.map((r) => ({ customerId: r.customerId, customerName: r.name, sources: r.sources, lastEventAt: dReq(r.lastAt), totalEvents: r.total })),
    };
  }

  // ───────────────────────────── contact reveal (D-35) ─────────────────────────────

  async responderCustomerIdsOfContact(contactId: string): Promise<string[]> {
    return (await this.sql.query(`SELECT DISTINCT "customerId" FROM "Responder" WHERE "contactId" = $1 ORDER BY 1`, [contactId])).map((r) => r.customerId as string);
  }
  async adminStaff(): Promise<Array<{ contactId: string; name: string }>> {
    return (await this.sql.query(
      `SELECT c."id", c."name" FROM "User" u JOIN "Contact" c ON c."userId" = u."id"
        WHERE u."role" = 'ADMIN' AND u."status" = 'ACTIVE' AND u."customerId" IS NULL AND c."kind" = 'INTERNAL' AND c."active" ORDER BY c."name", c."id"`)).map((r) => ({ contactId: r.id as string, name: r.name as string }));
  }
  async recordReveal(w: RevealWrite): Promise<RevealWriteOutcome> {
    return this.sql.transaction(async (tx) => {
      // One writer per user at a time: the count below and the INSERT are one step, so two requests (or two
      // instances) cannot both pass at 29 of 30. The limit is read from the rows themselves.
      // Never wait for the lock (a waiting request holds a pooled connection): if another request of this user is
      // writing right now, answer 429 with Retry-After 1 at once.
      const [lock] = await tx.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS "got"`, [`contact-reveal:${w.actorUserId}`]);
      if (!lock?.got) return { ok: false as const, retryAfterSec: 1 };
      const now = this.sql.now();
      // The row that, once it leaves the window, frees a slot: the `limit`-th newest inside it.
      const wait = async (windowSec: number, limit: number, emergencyOnly: boolean): Promise<number> => {
        const [r] = await tx.query(
          `SELECT GREATEST(1, ceil(extract(epoch FROM ("at" + make_interval(secs => $2) - ${now}))))::int AS "retry" FROM "ContactRevealLog"
            WHERE "actorUserId" = $1 AND "at" > ${now} - make_interval(secs => $2) AND ($4::boolean = false OR "mode" = 'EMERGENCY')
            ORDER BY "at" DESC, "id" DESC OFFSET $3 LIMIT 1`, [w.actorUserId, windowSec, limit - 1, emergencyOnly]);
        return (r?.retry as number | undefined) ?? 0;
      };
      const minute = await wait(60, w.limits.perMinute, false);
      const hour = w.mode === 'EMERGENCY' ? await wait(3600, w.limits.emergencyPerHour, true) : 0;
      if (minute || hour) return { ok: false as const, retryAfterSec: Math.max(minute, hour) };
      const id = newId('crl');
      const [row] = await tx.query(
        `INSERT INTO "ContactRevealLog"("id", "at", "actorUserId", "actorRole", "contactId", "contactName", "customerId", "channel", "mode", "reason", "notifiedContactIds", "requestId")
         VALUES ($1, ${now}, $2, $3, $4, $5, $6, $7::"RevealChannel", $8::"RevealMode", $9, $10::text[], $11) RETURNING "at"`,
        [id, w.actorUserId, w.actorRole, w.contactId, w.contactName, w.customerId, w.channel, w.mode, w.reason, w.notifiedContactIds, w.requestId]);
      const at = dReq(row!.at);
      await insertAudit(tx, { at, customerId: w.customerId, actorType: 'USER', actorId: w.actorUserId, action: 'contact.reveal', targetType: 'Contact', targetId: w.contactId, after: { revealLogId: id, mode: w.mode }, requestId: w.requestId });
      return { ok: true as const, id, at };
    });
  }
  async revealLog(f: RevealLogFilter): Promise<{ rows: RevealLogRow[]; hasMore: boolean }> {
    const p = new Params();
    const where: string[] = [];
    // The customer condition is part of the query: `null` = every customer (and rows without one), a list = only those.
    if (f.customerIds !== null) where.push(`l."customerId" = ANY(${p.add([...f.customerIds])}::text[])`);
    if (f.mode) where.push(`l."mode" = ${p.add(f.mode)}::"RevealMode"`);
    if (f.actorUserId) where.push(`l."actorUserId" = ${p.add(f.actorUserId)}`);
    if (f.contactId) where.push(`l."contactId" = ${p.add(f.contactId)}`);
    if (f.from) where.push(`l."at" >= ${p.add(iso(f.from))}::timestamptz`);
    if (f.to) where.push(`l."at" <= ${p.add(iso(f.to))}::timestamptz`);
    if (f.after) { const t = p.add(f.after.t); const i = p.add(f.after.id); where.push(`(l."at" < ${t}::timestamptz OR (l."at" = ${t}::timestamptz AND l."id" < ${i}))`); }
    const rows = await this.sql.query(
      `SELECT l."id", l."at", l."mode", l."channel", l."reason", l."actorUserId", l."actorRole", u."name" AS "actorName", l."contactId", l."contactName", l."notifiedContactIds",
              cu."id" AS "cid", cu."name" AS "cname", cu."slug" AS "cslug",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('contactId', n."id", 'name', n."name") ORDER BY x.ord) FROM unnest(l."notifiedContactIds") WITH ORDINALITY AS x(id, ord) JOIN "Contact" n ON n."id" = x.id), '[]'::jsonb) AS "notified"
         FROM "ContactRevealLog" l JOIN "User" u ON u."id" = l."actorUserId" LEFT JOIN "Customer" cu ON cu."id" = l."customerId"
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l."at" DESC, l."id" DESC LIMIT ${p.add(f.limit + 1)}`, p.values);
    return {
      hasMore: rows.length > f.limit,
      rows: rows.slice(0, f.limit).map((r) => ({
        id: r.id, at: dReq(r.at), mode: r.mode, actorUserId: r.actorUserId, actorName: r.actorName, actorRole: r.actorRole, contactId: r.contactId, contactName: r.contactName,
        customer: r.cid ? { id: r.cid, name: r.cname, slug: r.cslug } : null, channel: r.channel, reason: r.reason ?? null,
        notified: (typeof r.notified === 'string' ? JSON.parse(r.notified) : r.notified) as Array<{ contactId: string; name: string }>,
      })),
    };
  }

  // ───────────────────────────── customer status / offboarding (D-43) ─────────────────────────────

  /** Status version = number of 'CustomerStatus' audit rows of the customer (same transaction as each change; no extra column). */
  private async statusVersionOf(q: SqlExecutor, customerId: string): Promise<number> {
    const [r] = await q.query(`SELECT count(*)::int AS "n" FROM "AuditLog" WHERE "customerId" = $1 AND "targetType" = 'CustomerStatus'`, [customerId]);
    return (r?.n as number) ?? 0;
  }
  async customerStatusState(customerId: string): Promise<CustomerStatusState | null> {
    const [c] = await this.sql.query(`SELECT "name", "status", "statusChangedAt" FROM "Customer" WHERE "id" = $1`, [customerId]);
    if (!c) return null;
    return { name: c.name, status: c.status, statusChangedAt: d(c.statusChangedAt), version: await this.statusVersionOf(this.sql, customerId) };
  }
  async changeCustomerStatus(customerId: string, expectedVersion: number, to: CustomerStatusValue, offboarding: { startedByUserId: string; reason: string } | null, audit: AuditInput): Promise<ChangeStatusOutcome> {
    if (typeof customerId !== 'string' || !customerId || audit.customerId !== customerId || audit.targetType !== 'CustomerStatus') throw new Error('changeCustomerStatus: audit must be a CustomerStatus audit of the same customer');
    if (to === 'TERMINATED' && !offboarding) throw new Error('changeCustomerStatus: TERMINATED needs an offboarding');
    return this.sql.transaction(async (tx) => {
      const [c] = await tx.query(`SELECT "status" FROM "Customer" WHERE "id" = $1 FOR UPDATE`, [customerId]);
      if (!c) return 'NOT_FOUND' as const;
      if ((await this.statusVersionOf(tx, customerId)) !== expectedVersion) return 'CONFLICT' as const;
      if (c.status === 'TERMINATED' && to !== 'TERMINATED') return 'CUSTOMER_TERMINATED' as const;
      if (c.status === to) return 'NOOP' as const;
      const [u] = await tx.query(`UPDATE "Customer" SET "status" = $2::"CustomerStatus", "statusChangedAt" = ${this.sql.now()}, "updatedAt" = ${this.sql.now()} WHERE "id" = $1 RETURNING "statusChangedAt"`, [customerId, to]);
      let offboardingId: string | null = null;
      let cloudAccountIds: string[] = [];
      if (to === 'TERMINATED' && offboarding) {
        offboardingId = newId('off');
        const at = iso(audit.at);
        const steps = {
          PAGING_STOPPED: { state: 'DONE', at, byUserId: offboarding.startedByUserId }, ALARMS_DELETED: { state: 'PENDING' },
          CUSTOMER_STACK_REMOVED: { state: 'MANUAL' }, ACCOUNTS_DISABLED: { state: 'MANUAL' }, BUS_ALLOWLIST_REMOVED: { state: 'MANUAL' },
        };
        await tx.query(
          `INSERT INTO "CustomerOffboarding"("id", "customerId", "startedByUserId", "reason", "steps", "startedAt") VALUES ($1, $2, $3, $4, $5::jsonb, ${this.sql.now()})`,
          [offboardingId, customerId, offboarding.startedByUserId, offboarding.reason, js(steps)]);
        cloudAccountIds = (await tx.query(`SELECT "id" FROM "CloudAccount" WHERE "customerId" = $1 ORDER BY "id"`, [customerId])).map((r) => r.id as string);
      }
      await insertAudit(tx, audit);
      return { status: to, statusChangedAt: dReq(u!.statusChangedAt), version: expectedVersion + 1, offboardingId, cloudAccountIds };
    });
  }
  async offboardingState(customerId: string): Promise<OffboardingState | null> {
    const [o] = await this.sql.query(`SELECT "id", "customerId", "startedByUserId", "reason", "steps", "startedAt", "completedAt" FROM "CustomerOffboarding" WHERE "customerId" = $1`, [customerId]);
    if (!o) return null;
    const [r] = await this.sql.query(`SELECT max("lastAt") AS "lastAt", COALESCE(sum("count"), 0)::int AS "n" FROM "OffboardResidual" WHERE "customerId" = $1`, [customerId]);
    const raw = (o.steps ?? {}) as Record<string, OffboardStep>;
    const steps = Object.fromEntries(OFFBOARD_STEP_KEYS.map((k) => [k, raw[k] ?? { state: 'PENDING' }])) as Record<OffboardStepKey, OffboardStep>;
    return { id: o.id, customerId: o.customerId, startedByUserId: o.startedByUserId, reason: o.reason, startedAt: dReq(o.startedAt), completedAt: d(o.completedAt), steps, residual: { lastEventAt: d(r?.lastAt), count: (r?.n as number) ?? 0 } };
  }
  async markOffboardStepDone(customerId: string, key: OffboardStepKey, userId: string, detail: string | null, at: Date, audit: AuditInput): Promise<MarkStepOutcome> {
    if (audit.customerId !== customerId) throw new Error('markOffboardStepDone: audit must be for the same customer');
    return this.sql.transaction(async (tx) => {
      // Same row lock as the engine's record_offboard_result: a person's mark and an account's result never interleave.
      const [o] = await tx.query(`SELECT "steps" FROM "CustomerOffboarding" WHERE "customerId" = $1 FOR UPDATE`, [customerId]);
      if (!o) return 'NOT_FOUND' as const;
      const steps = { ...(o.steps ?? {}) } as Record<string, OffboardStep>;
      const st = steps[key] ?? { state: 'PENDING' };
      if (st.state === 'DONE') return 'ALREADY_DONE' as const;
      if (key === 'ALARMS_DELETED' && st.state !== 'MANUAL') return 'NOT_ALLOWED' as const;
      steps[key] = { ...st, state: 'DONE', at: at.toISOString(), byUserId: userId, ...(detail ? { detail } : {}) };
      const all = OFFBOARD_STEP_KEYS.every((k) => steps[k]?.state === 'DONE');
      await tx.query(`UPDATE "CustomerOffboarding" SET "steps" = $2::jsonb, "completedAt" = CASE WHEN $3::boolean AND "completedAt" IS NULL THEN ${this.sql.now()} ELSE "completedAt" END WHERE "customerId" = $1`, [customerId, js(steps), all]);
      await insertAudit(tx, audit);
      return 'OK' as const;
    });
  }
  async cloudAccountIds(customerId: string): Promise<string[]> {
    return (await this.sql.query(`SELECT "id" FROM "CloudAccount" WHERE "customerId" = $1 ORDER BY "id"`, [customerId])).map((r) => r.id as string);
  }
  async recordOffboardPublishFailure(customerId: string, cloudAccountIds: string[]): Promise<void> {
    await this.sql.transaction(async (tx) => {
      const [o] = await tx.query(`SELECT "steps" FROM "CustomerOffboarding" WHERE "customerId" = $1 FOR UPDATE`, [customerId]);
      if (!o) return;
      const steps = { ...(o.steps ?? {}) } as Record<string, OffboardStep>;
      const st = steps.ALARMS_DELETED ?? { state: 'PENDING' };
      if (st.state === 'DONE') return;
      const mark = `COMMAND_PUBLISH_FAILED: ${cloudAccountIds.join(',')}`;
      steps.ALARMS_DELETED = { ...st, state: 'MANUAL', detail: st.detail ? (st.detail.includes(mark) ? st.detail : `${st.detail}; ${mark}`) : mark };
      await tx.query(`UPDATE "CustomerOffboarding" SET "steps" = $2::jsonb WHERE "customerId" = $1`, [customerId, js(steps)]);
    });
  }

  // ───────────────────────────── onboarding: customers, accounts, contacts, verification (#62) ─────────────────────────────

  async createCustomer(c: { name: string; slug: string; loginDomains: string[] }, audit: AuditTemplate) {
    try {
      return await this.sql.transaction(async (tx) => {
        await SqlApiStore.lockLoginDomains(tx, c.loginDomains);
        if ((await tx.query(`SELECT 1 FROM "Customer" WHERE lower("name") = lower($1)`, [c.name])).length) return 'NAME_EXISTS' as const;
        if ((await tx.query(`SELECT 1 FROM "Customer" WHERE "slug" = $1`, [c.slug])).length) return 'SLUG_EXISTS' as const;
        if (c.loginDomains.length && (await tx.query(`SELECT 1 FROM "Customer" WHERE "loginDomains" && $1::text[]`, [c.loginDomains])).length) return 'DOMAIN_EXISTS' as const;
        const id = newId('cus');
        const [r] = await tx.query(
          `INSERT INTO "Customer"("id", "name", "slug", "loginDomains", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4::text[], ${this.sql.now()}, ${this.sql.now()}) RETURNING "createdAt"`,
          [id, c.name, c.slug, c.loginDomains]);
        await insertAudit(tx, { ...audit, customerId: id, targetId: id });
        return { id, createdAt: dReq(r!.createdAt) };
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return /slug/i.test(String((err as { constraint?: unknown }).constraint ?? '')) ? 'SLUG_EXISTS' : 'NAME_EXISTS';
      throw err;
    }
  }

  /** The columns of a CloudAccount record. First / last event: the stored columns, written by the ingest path (SqlIngestStore.insertRawEvent). */
  private static readonly ACCOUNT_SELECT = `SELECT a."id", a."customerId", a."serviceId", a."awsAccountId", a."alias", a."environment", a."regions", a."externalId",
      a."readerRoleArn", a."eventForwarderRoleArn", a."alarmWriterRoleArn", a."tagWriterRoleArn", a."remediatorRoleArn",
      a."alarmWriterEnabled", a."tagWriterEnabled", a."remediatorEnabled",
      a."readerStatus", a."eventForwarderStatus", a."alarmWriterStatus", a."tagWriterStatus", a."remediatorStatus", a."lastCheckedAt",
      a."firstEventAt", a."lastEventAt",
      a."stackVersion", a."disabled", (a."connectionPurgedAt" IS NOT NULL) AS "connectionPurged", a."createdAt" FROM "CloudAccount" a`;
  private static toAccount(r: Record<string, any>): CloudAccountRecord { // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      id: r.id, customerId: r.customerId, serviceId: r.serviceId ?? null, awsAccountId: String(r.awsAccountId).trim(), alias: r.alias ?? null, environment: r.environment ?? null, regions: r.regions ?? [], externalId: r.externalId,
      readerRoleArn: r.readerRoleArn, eventForwarderRoleArn: r.eventForwarderRoleArn, alarmWriterRoleArn: r.alarmWriterRoleArn ?? null, tagWriterRoleArn: r.tagWriterRoleArn ?? null, remediatorRoleArn: r.remediatorRoleArn ?? null,
      alarmWriterEnabled: r.alarmWriterEnabled, tagWriterEnabled: r.tagWriterEnabled, remediatorEnabled: r.remediatorEnabled,
      readerStatus: r.readerStatus, eventForwarderStatus: r.eventForwarderStatus, alarmWriterStatus: r.alarmWriterStatus, tagWriterStatus: r.tagWriterStatus, remediatorStatus: r.remediatorStatus,
      lastCheckedAt: d(r.lastCheckedAt), firstEventAt: d(r.firstEventAt), lastEventAt: d(r.lastEventAt), stackVersion: r.stackVersion ?? null, disabled: r.disabled, connectionPurged: r.connectionPurged, createdAt: dReq(r.createdAt),
    };
  }
  async listAccounts(customerId: string): Promise<CloudAccountRecord[]> {
    return (await this.sql.query(`${SqlApiStore.ACCOUNT_SELECT} WHERE a."customerId" = $1 ORDER BY a."createdAt", a."id"`, [customerId])).map(SqlApiStore.toAccount);
  }
  async findAccount(scope: ScopeFilter, accountId: string): Promise<CloudAccountRecord | null> {
    const all = scope.customerIds === '*';
    const [r] = await this.sql.query(`${SqlApiStore.ACCOUNT_SELECT} WHERE a."id" = $1 AND ($2::boolean OR a."customerId" = ANY($3::text[]))`, [accountId, all, all ? [] : [...scope.customerIds]]);
    return r ? SqlApiStore.toAccount(r) : null;
  }
  async createAccount(customerId: string, a: NewAccount, audit: AuditTemplate): Promise<AccountWriteOutcome> {
    try {
      return await this.sql.transaction(async (tx) => {
        // FOR SHARE conflicts with the FOR UPDATE of a status change: no account is added behind a termination's account list.
        const [cus] = await tx.query(`SELECT "status" FROM "Customer" WHERE "id" = $1 FOR SHARE`, [customerId]);
        if (!cus) return 'NOT_FOUND' as const;
        if (cus.status === 'TERMINATED') return 'CUSTOMER_TERMINATED' as const;
        if (a.serviceId !== null && !(await tx.query(`SELECT 1 FROM "Service" WHERE "id" = $1 AND "customerId" = $2`, [a.serviceId, customerId])).length) return 'NO_SUCH_SERVICE' as const;
        if ((await tx.query(`SELECT 1 FROM "CloudAccount" WHERE "awsAccountId" = $1`, [a.awsAccountId])).length) return 'EXISTS' as const;
        const id = newId('acc');
        await tx.query(
          `INSERT INTO "CloudAccount"("id", "customerId", "serviceId", "awsAccountId", "alias", "environment", "regions", "externalId", "readerRoleArn", "eventForwarderRoleArn", "alarmWriterRoleArn", "tagWriterRoleArn", "remediatorRoleArn",
             "alarmWriterEnabled", "tagWriterEnabled", "remediatorEnabled", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6::"Environment", $7::text[], $8, $9, $10, $11, $12, $13, $14, $15, $16, ${this.sql.now()}, ${this.sql.now()})`,
          [id, customerId, a.serviceId, a.awsAccountId, a.alias, a.environment, a.regions, a.externalId, a.readerRoleArn, a.eventForwarderRoleArn, a.alarmWriterRoleArn, a.tagWriterRoleArn, a.remediatorRoleArn,
            a.alarmWriterEnabled, a.tagWriterEnabled, a.remediatorEnabled]);
        await insertAudit(tx, { ...audit, customerId, targetId: id });
        const [row] = await tx.query(`${SqlApiStore.ACCOUNT_SELECT} WHERE a."id" = $1 AND a."customerId" = $2`, [id, customerId]);
        return SqlApiStore.toAccount(row!);
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return 'EXISTS';
      throw err;
    }
  }
  async updateAccount(customerId: string, accountId: string, patch: AccountPatch, audit: AuditTemplate): Promise<AccountWriteOutcome> {
    return this.sql.transaction(async (tx) => {
      const [cus] = await tx.query(`SELECT "status" FROM "Customer" WHERE "id" = $1 FOR SHARE`, [customerId]);
      const [acc] = await tx.query(`SELECT "connectionPurgedAt" FROM "CloudAccount" WHERE "id" = $1 AND "customerId" = $2 FOR UPDATE`, [accountId, customerId]);
      if (!cus || !acc) return 'NOT_FOUND' as const;
      if (cus.status === 'TERMINATED' || acc.connectionPurgedAt) return 'CUSTOMER_TERMINATED' as const;
      if (patch.serviceId !== undefined && patch.serviceId !== null && !(await tx.query(`SELECT 1 FROM "Service" WHERE "id" = $1 AND "customerId" = $2`, [patch.serviceId, customerId])).length) return 'NO_SUCH_SERVICE' as const;
      const p = new Params();
      const sets: string[] = [];
      const col = (name: string, v: unknown, cast = ''): void => { if (v !== undefined) sets.push(`"${name}" = ${p.add(v)}${cast}`); };
      col('alias', patch.alias); col('environment', patch.environment, '::"Environment"'); col('regions', patch.regions, '::text[]'); col('serviceId', patch.serviceId);
      col('alarmWriterEnabled', patch.alarmWriterEnabled); col('tagWriterEnabled', patch.tagWriterEnabled); col('remediatorEnabled', patch.remediatorEnabled);
      col('alarmWriterRoleArn', patch.alarmWriterRoleArn); col('tagWriterRoleArn', patch.tagWriterRoleArn); col('remediatorRoleArn', patch.remediatorRoleArn);
      if (sets.length) {
        await tx.query(`UPDATE "CloudAccount" SET ${sets.join(', ')}, "updatedAt" = ${this.sql.now()} WHERE "id" = ${p.add(accountId)} AND "customerId" = ${p.add(customerId)}`, p.values);
      }
      await insertAudit(tx, { ...audit, customerId, targetId: accountId });
      const [row] = await tx.query(`${SqlApiStore.ACCOUNT_SELECT} WHERE a."id" = $1 AND a."customerId" = $2`, [accountId, customerId]);
      return SqlApiStore.toAccount(row!);
    });
  }
  async reserveAccountCheck(customerId: string, accountId: string, now: Date, cooldownSec: number, audit: AuditTemplate): Promise<'OK' | { retryAfterSec: number }> {
    return this.sql.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`check:${accountId}`]); // parallel requests for one account queue here
      const [r] = await tx.query(`SELECT max("at") AS "at" FROM "AuditLog" WHERE "targetType" = 'CloudAccount' AND "targetId" = $1 AND "customerId" = $2 AND "action" = 'account.check'`, [accountId, customerId]);
      const last = d(r?.at);
      if (last && now.getTime() - last.getTime() < cooldownSec * 1000) return { retryAfterSec: Math.max(1, Math.ceil((last.getTime() + cooldownSec * 1000 - now.getTime()) / 1000)) };
      await insertAudit(tx, { ...audit, customerId, targetId: accountId });
      return 'OK' as const;
    });
  }
  async deleteAccount(customerId: string, accountId: string, audit: AuditTemplate) {
    return this.sql.transaction(async (tx) => {
      const [cus] = await tx.query(`SELECT "status" FROM "Customer" WHERE "id" = $1 FOR SHARE`, [customerId]);
      const [acc] = await tx.query(`SELECT 1 FROM "CloudAccount" WHERE "id" = $1 AND "customerId" = $2 FOR UPDATE`, [accountId, customerId]);
      if (!cus || !acc) return 'NOT_FOUND' as const;
      if (cus.status === 'TERMINATED') return 'CUSTOMER_TERMINATED' as const;
      const [used] = await tx.query(`SELECT (EXISTS (SELECT 1 FROM "Resource" WHERE "cloudAccountId" = $1) OR EXISTS (SELECT 1 FROM "ManagedAlarm" WHERE "cloudAccountId" = $1)) AS "used"`, [accountId]);
      if (used?.used) return 'IN_USE' as const;
      await tx.query(`DELETE FROM "CloudAccount" WHERE "id" = $1 AND "customerId" = $2`, [accountId, customerId]);
      await insertAudit(tx, { ...audit, customerId, targetId: accountId });
      return 'OK' as const;
    });
  }

  async portalGrants(customerId: string): Promise<string[]> {
    const [r] = await this.sql.query(`SELECT "portalGrants" FROM "Customer" WHERE "id" = $1`, [customerId]);
    return (r?.portalGrants ?? []) as string[];
  }
  private async linksOf(q: SqlExecutor, contactIds: string[]): Promise<VerificationLink[]> {
    if (!contactIds.length) return [];
    const rows = await q.query(
      `SELECT DISTINCT ON (v."contactId", v."channel") v."contactId", v."channel", v."sentAt", v."expiresAt", v."usedAt" FROM "ChannelVerification" v
        WHERE v."contactId" = ANY($1::text[]) AND v."via" = 'link' ORDER BY v."contactId", v."channel", v."sentAt" DESC`, [contactIds]);
    return rows.map((r) => ({ contactId: r.contactId, channel: r.channel, sentAt: dReq(r.sentAt), expiresAt: dReq(r.expiresAt), usedAt: d(r.usedAt) }));
  }
  async contactsWorld(customerIds: readonly string[] | '*', staff: boolean): Promise<ContactsWorld> {
    const all = customerIds === '*';
    const ids = all ? [] : [...customerIds];
    const [cRows, sRows, rRows] = await Promise.all([
      this.sql.query(`SELECT ${CONTACT_COLS} FROM "Contact" WHERE ("kind" = 'CUSTOMER' AND ($1::boolean OR "customerId" = ANY($2::text[]))) OR ("kind" = 'INTERNAL' AND $3::boolean AND ($1::boolean OR EXISTS (SELECT 1 FROM "Responder" r WHERE r."contactId" = "Contact"."id" AND r."customerId" = ANY($2::text[])))) ORDER BY "name", "id"`, [all, ids, staff]),
      this.sql.query(`SELECT "contactId", "scopeType", "scopeId", "role" FROM "ContactScope" WHERE $1::boolean OR "customerId" = ANY($2::text[])`, [all, ids]),
      this.sql.query(`SELECT "customerId", "contactId", "role" FROM "Responder" WHERE $1::boolean OR "customerId" = ANY($2::text[])`, [all, ids]),
    ]);
    const contacts = cRows.map(toContact);
    const have = new Set(contacts.map((c) => c.id));
    const scopes: ContactScopeInfo[] = sRows.filter((r) => have.has(r.contactId)).map((r) => ({ contactId: r.contactId, scopeType: r.scopeType, scopeId: r.scopeId, role: r.role }));
    const responders = rRows.filter((r) => have.has(r.contactId)).map((r) => ({ customerId: r.customerId, contactId: r.contactId, role: r.role }));
    return { contacts, scopes, responders, links: await this.linksOf(this.sql, [...have]) };
  }
  async findContact(customerIds: readonly string[] | '*', staff: boolean, contactId: string, forWrite = false) {
    const all = customerIds === '*';
    // B-1: an INTERNAL contact belongs to every customer it serves. Writing it needs the whole range; a narrower caller only reads those it shares a customer with.
    const [r] = await this.sql.query(
      `SELECT ${CONTACT_COLS} FROM "Contact" WHERE "id" = $1 AND (("kind" = 'CUSTOMER' AND ($2::boolean OR "customerId" = ANY($3::text[])))
         OR ("kind" = 'INTERNAL' AND $4::boolean AND ($2::boolean OR (NOT $5::boolean AND EXISTS (SELECT 1 FROM "Responder" r WHERE r."contactId" = "Contact"."id" AND r."customerId" = ANY($3::text[]))))))`,
      [contactId, all, all ? [] : [...customerIds], staff, forWrite]);
    if (!r) return null;
    const resp = await this.sql.query(`SELECT DISTINCT "customerId" FROM "Responder" WHERE "contactId" = $1 AND ($2::boolean OR "customerId" = ANY($3::text[])) ORDER BY 1`, [contactId, all, all ? [] : [...customerIds]]);
    return { contact: toContact(r), links: await this.linksOf(this.sql, [contactId]), responderCustomerIds: resp.map((x) => x.customerId as string) };
  }
  async createContact(n: NewContact, audit: AuditTemplate): Promise<ContactWriteOutcome> {
    try {
      return await this.sql.transaction(async (tx) => {
        if (n.kind === 'CUSTOMER' && !(n.customerId && (await tx.query(`SELECT 1 FROM "Customer" WHERE "id" = $1 FOR SHARE`, [n.customerId])).length)) return 'NOT_FOUND' as const;
        const id = newId('ct');
        const [r] = await tx.query(
          `INSERT INTO "Contact"("id", "kind", "customerId", "name", "email", "phone", "slackUserId", "active", "createdAt", "updatedAt") VALUES ($1, $2::"ContactKind", $3, $4, $5, $6, $7, true, ${this.sql.now()}, ${this.sql.now()}) RETURNING ${CONTACT_COLS}`,
          [id, n.kind, n.customerId, n.name, n.email, n.phone, n.slackUserId]);
        await insertAudit(tx, { ...audit, customerId: n.customerId, targetId: id });
        return toContact(r!);
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return 'SLACK_EXISTS';
      throw err;
    }
  }
  async updateContact(contactId: string, customerId: string | null, patch: ContactPatch, audit: AuditTemplate): Promise<ContactWriteOutcome> {
    try {
      return await this.sql.transaction(async (tx) => {
        const [cur] = await tx.query(`SELECT ${CONTACT_COLS} FROM "Contact" WHERE "id" = $1 AND "customerId" IS NOT DISTINCT FROM $2 FOR UPDATE`, [contactId, customerId]);
        if (!cur) return 'NOT_FOUND' as const;
        const p = new Params();
        const sets: string[] = [];
        const channels: Array<[VerifyChannelValue, 'email' | 'phone' | 'slackUserId', string, string, string]> = [
          ['EMAIL', 'email', 'emailVerifiedAt', 'emailVerifiedVia', 'email'], ['SMS', 'phone', 'phoneVerifiedAt', 'phoneVerifiedVia', 'phone'], ['SLACK', 'slackUserId', 'slackVerifiedAt', 'slackVerifiedVia', 'slackUserId'],
        ];
        for (const [ch, key, atCol, viaCol] of channels) {
          const v = patch[key];
          if (v === undefined || (cur[key] ?? null) === v) continue;
          // a changed value is a new, unverified one; a link meant for the old value must not verify it
          sets.push(`"${key}" = ${p.add(v)}`, `"${atCol}" = NULL`, `"${viaCol}" = NULL`);
          await tx.query(`UPDATE "ChannelVerification" SET "expiresAt" = LEAST("expiresAt", ${this.sql.now()}) WHERE "contactId" = $1 AND "channel" = $2::"VerifyChannel" AND "usedAt" IS NULL`, [contactId, ch]);
        }
        if (patch.name !== undefined) sets.push(`"name" = ${p.add(patch.name)}`);
        if (patch.active !== undefined) sets.push(`"active" = ${p.add(patch.active)}`);
        if (sets.length) await tx.query(`UPDATE "Contact" SET ${sets.join(', ')}, "updatedAt" = ${this.sql.now()} WHERE "id" = ${p.add(contactId)}`, p.values);
        await insertAudit(tx, { ...audit, customerId, targetId: contactId });
        const [r] = await tx.query(`SELECT ${CONTACT_COLS} FROM "Contact" WHERE "id" = $1`, [contactId]);
        return toContact(r!);
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE) return 'SLACK_EXISTS';
      throw err;
    }
  }
  async deleteContact(contactId: string, customerId: string | null, audit: AuditTemplate) {
    return this.sql.transaction(async (tx) => {
      const [cur] = await tx.query(`SELECT "userId" FROM "Contact" WHERE "id" = $1 AND "customerId" IS NOT DISTINCT FROM $2 FOR UPDATE`, [contactId, customerId]);
      if (!cur) return 'NOT_FOUND' as const;
      // every one of these tables CASCADEs from Contact: without this check the delete would silently remove the person from a call order
      const [used] = await tx.query(
        `SELECT ($2::text IS NOT NULL OR EXISTS (SELECT 1 FROM "Responder" WHERE "contactId" = $1) OR EXISTS (SELECT 1 FROM "RotationMember" WHERE "contactId" = $1)
            OR EXISTS (SELECT 1 FROM "ResponderTemplateMember" WHERE "contactId" = $1) OR EXISTS (SELECT 1 FROM "EscalationStep" WHERE "targetType" = 'PERSON' AND "targetId" = $1)
            OR EXISTS (SELECT 1 FROM "Leave" WHERE "contactId" = $1 OR "replacementId" = $1) OR EXISTS (SELECT 1 FROM "Override" WHERE "contactId" = $1)
            OR EXISTS (SELECT 1 FROM "RotationPin" WHERE "contactId" = $1 AND "endAt" > $3::timestamptz)) AS "used"`,
        [contactId, cur.userId ?? null, iso(audit.at)]);
      if (used?.used) return 'IN_USE' as const;
      // a running or future pin is why somebody is (or will be) on shift: IN_USE above. Only past ones are left; RotationPin.contactId is RESTRICT.
      await tx.query(`DELETE FROM "RotationPin" WHERE "contactId" = $1`, [contactId]);
      await tx.query(`DELETE FROM "Contact" WHERE "id" = $1 AND "customerId" IS NOT DISTINCT FROM $2`, [contactId, customerId]);
      await insertAudit(tx, { ...audit, customerId, targetId: contactId });
      return 'OK' as const;
    });
  }
  async countAudits(customerId: string, actorId: string, action: string, since: Date): Promise<number> {
    const [r] = await this.sql.query(`SELECT count(*)::int AS "n" FROM "AuditLog" WHERE "customerId" = $1 AND "actorId" = $2 AND "action" = $3 AND "at" > $4::timestamptz`, [customerId, actorId, action, iso(since)]);
    return (r?.n as number) ?? 0;
  }
  async issueVerification(v: VerificationIssue, limits: VerificationLimits): Promise<IssueOutcome> {
    const cooldownSec = limits.cooldownSec;
    return this.sql.transaction(async (tx) => {
      // sends of one customer queue here, so two instances cannot both pass the count
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`verify:${v.customerId ?? '-'}`]);
      // one link at a time per contact + channel: the row lock makes two requests queue instead of both passing the cooldown
      const [c] = await tx.query(`SELECT 1 FROM "Contact" WHERE "id" = $1 FOR UPDATE`, [v.contactId]);
      if (!c) return { cooling: 1 };
      const [recent] = await tx.query(
        `SELECT "sentAt" FROM "ChannelVerification" WHERE "contactId" = $1 AND "channel" = $2::"VerifyChannel" AND "via" = 'link' AND "sentAt" > $3::timestamptz - make_interval(secs => $4) ORDER BY "sentAt" DESC LIMIT 1`,
        [v.contactId, v.channel, iso(v.sentAt), cooldownSec]);
      if (recent) return { cooling: Math.max(1, Math.ceil((dReq(recent.sentAt).getTime() + cooldownSec * 1000 - v.sentAt.getTime()) / 1000)) };
      const capped = async (where: string, param: unknown, cap: number, kind: 'CUSTOMER' | 'DESTINATION'): Promise<IssueOutcome | null> => {
        const rows = await tx.query(`SELECT "sentAt" FROM "ChannelVerification" WHERE ${where} AND "customerId" IS NOT DISTINCT FROM $4 AND "via" = 'link' AND "sentAt" > $2::timestamptz - interval '1 hour' ORDER BY "sentAt" DESC LIMIT $3`, [param, iso(v.sentAt), cap, v.customerId]);
        if (rows.length < cap) return null;
        return { capped: kind, retryAfterSec: Math.max(1, Math.ceil((dReq(rows[cap - 1]!.sentAt).getTime() + 3600_000 - v.sentAt.getTime()) / 1000)) };
      };
      const byCustomer = await capped(`"customerId" IS NOT DISTINCT FROM $1`, v.customerId, limits.perCustomerHour, 'CUSTOMER');
      if (byCustomer) return byCustomer;
      const byDest = await capped(`"note" = $1`, v.destinationHash, limits.perDestinationHour, 'DESTINATION');
      if (byDest) return byDest;
      await tx.query(
        `INSERT INTO "ChannelVerification"("id", "customerId", "contactId", "channel", "tokenHash", "sentAt", "expiresAt", "via", "note") VALUES ($1, $2, $3, $4::"VerifyChannel", $5, $6::timestamptz, $7::timestamptz, 'link', $8)`,
        [newId('cv'), v.customerId, v.contactId, v.channel, v.tokenHash, iso(v.sentAt), iso(v.expiresAt), v.destinationHash]);
      return 'OK' as const;
    });
  }
  async discardVerification(tokenHash: string): Promise<void> {
    await this.sql.query(`DELETE FROM "ChannelVerification" WHERE "tokenHash" = $1 AND "usedAt" IS NULL`, [tokenHash]);
  }
  /** Column names of a channel on Contact. */
  private static channelCols(ch: VerifyChannelValue): { at: string; via: string } {
    return ch === 'EMAIL' ? { at: 'emailVerifiedAt', via: 'emailVerifiedVia' } : ch === 'SMS' ? { at: 'phoneVerifiedAt', via: 'phoneVerifiedVia' } : { at: 'slackVerifiedAt', via: 'slackVerifiedVia' };
  }
  async markVerifiedManually(contactId: string, customerId: string | null, channel: VerifyChannelValue, via: string, note: string | null, now: Date, audit: AuditTemplate) {
    return this.sql.transaction(async (tx) => {
      const { at, via: viaCol } = SqlApiStore.channelCols(channel);
      const r = await tx.query(`UPDATE "Contact" SET "${at}" = $3::timestamptz, "${viaCol}" = $4, "updatedAt" = ${this.sql.now()} WHERE "id" = $1 AND "customerId" IS NOT DISTINCT FROM $2 RETURNING 1`, [contactId, customerId, iso(now), via]);
      if (!r.length) return 'NOT_FOUND' as const;
      // history row, already used; the hash is of a random value nobody has (the column is unique and required)
      await tx.query(
        `INSERT INTO "ChannelVerification"("id", "customerId", "contactId", "channel", "tokenHash", "sentAt", "expiresAt", "usedAt", "via", "note") VALUES ($1, $2, $3, $4::"VerifyChannel", $5, $6::timestamptz, $6::timestamptz, $6::timestamptz, $7, $8)`,
        [newId('cv'), customerId, contactId, channel, `manual:${newId('h')}`, iso(now), via, note]);
      await insertAudit(tx, { ...audit, customerId, targetId: contactId });
      return 'OK' as const;
    });
  }
  async peekVerification(tokenHash: string, now: Date) {
    const [v] = await this.sql.query(
      `SELECT v."channel" FROM "ChannelVerification" v JOIN "Contact" c ON c."id" = v."contactId" WHERE v."tokenHash" = $1 AND v."via" = 'link' AND v."usedAt" IS NULL AND v."expiresAt" > $2::timestamptz AND c."active"`,
      [tokenHash, iso(now)]);
    return v ? { channel: v.channel as VerifyChannelValue } : null;
  }
  async takeVerification(tokenHash: string, now: Date, audit: AuditTemplate): Promise<VerificationTaken | null> {
    return this.sql.transaction(async (tx) => {
      // single use: the UPDATE only matches an unused, unexpired link, so two clicks cannot both win
      const [v] = await tx.query(
        `UPDATE "ChannelVerification" SET "usedAt" = $2::timestamptz WHERE "tokenHash" = $1 AND "via" = 'link' AND "usedAt" IS NULL AND "expiresAt" > $2::timestamptz RETURNING "contactId", "customerId", "channel", "tokenHash"`,
        [tokenHash, iso(now)]);
      if (!v) return null;
      const { at, via } = SqlApiStore.channelCols(v.channel);
      const c = await tx.query(`UPDATE "Contact" SET "${at}" = $2::timestamptz, "${via}" = 'link', "updatedAt" = ${this.sql.now()} WHERE "id" = $1 AND "active" RETURNING 1`, [v.contactId, iso(now)]);
      if (!c.length) throw new Abort(null); // the contact is gone or inactive: the use is rolled back, the link stays unused
      await insertAudit(tx, { ...audit, actorId: v.contactId, customerId: v.customerId ?? null, targetId: v.contactId });
      return { contactId: v.contactId as string, customerId: (v.customerId ?? null) as string | null, channel: v.channel as VerifyChannelValue, tokenHash: v.tokenHash as string };
    }).catch((e) => { if (e instanceof Abort) return null; throw e; });
  }

  // ───────────────────────────── idempotency ─────────────────────────────

  async getIdempotent(key: string, now: Date): Promise<IdempotentEntry | null> {
    const [r] = await this.sql.query(`SELECT "fingerprint", "response" FROM "IdempotencyKey" WHERE "key" = $1 AND "expiresAt" > $2::timestamptz`, [key, iso(now)]);
    return r ? { fingerprint: r.fingerprint, res: r.response } : null;
  }

  /**
   * One transaction, serialised per owner (advisory lock): drop the owner's expired entries, drop the owner's oldest
   * entries beyond `maxPerOwner − 1`, then store this one as the newest. Other owners' rows are never touched (N-19).
   */
  async putIdempotent(key: string, entry: IdempotentEntry, expiresAt: Date, cap: { owner: string; maxPerOwner: number }): Promise<void> {
    if (typeof cap.owner !== 'string' || !cap.owner) throw new Error('putIdempotent: owner is required');
    const now = this.sql.now();
    await this.sql.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`idem:${cap.owner}`]);
      await tx.query(`DELETE FROM "IdempotencyKey" WHERE "ownerUserId" = $1 AND "expiresAt" <= ${now}`, [cap.owner]);
      await tx.query(
        `DELETE FROM "IdempotencyKey" WHERE "key" IN (SELECT "key" FROM "IdempotencyKey" WHERE "ownerUserId" = $1 AND "key" <> $2 ORDER BY "seq" DESC OFFSET $3)`,
        [cap.owner, key, Math.max(0, cap.maxPerOwner - 1)]);
      await tx.query(`DELETE FROM "IdempotencyKey" WHERE "key" = $1`, [key]);
      await tx.query(
        `INSERT INTO "IdempotencyKey"("key", "ownerUserId", "fingerprint", "response", "expiresAt", "createdAt") VALUES ($1, $2, $3, $4::json, $5::timestamptz, ${now})`,
        [key, cap.owner, entry.fingerprint, js(entry.res), iso(expiresAt)]);
    });
  }
}

async function insertSteps(tx: SqlExecutor, configId: string, steps: PagingConfig['steps']): Promise<void> {
  if (!steps.length) return;
  const rows = steps.map((s) => ({ id: newId('stp'), index: s.index, atMin: s.atMin, targetType: s.targetType, targetId: s.targetId ?? null, channels: s.channels, advanceOnAllFail: s.advanceOnAllFail === true }));
  await tx.query(
    `INSERT INTO "EscalationStep"("id", "pagingConfigId", "index", "atMin", "targetType", "targetId", "channels", "advanceOnAllFail")
     SELECT t.x->>'id', $1, (t.x->>'index')::int, (t.x->>'atMin')::int, (t.x->>'targetType')::"StepTargetType", t.x->>'targetId',
            ARRAY(SELECT jsonb_array_elements_text(t.x->'channels')), (t.x->>'advanceOnAllFail')::boolean
       FROM jsonb_array_elements($2::jsonb) AS t(x)`,
    [configId, js(rows)],
  );
}

