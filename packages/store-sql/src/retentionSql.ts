/**
 * D-45 retention on Postgres. Every statement carries `customerId = $1` AND the guard "that customer is TERMINATED and not
 * on legal hold" (checked again inside each statement, so a hold set while the job runs stops the next chunk).
 * Big tables are removed in chunks of CHUNK rows, each its own short statement (the driver's statement_timeout is 4.5 s);
 * the job stops starting chunks at `deadlineMs` and reports `partial`, the next tick continues.
 */
import { AUDIT_CONTACT_VALUE_KEYS, PROTECTED_AUDIT_TARGET_TYPES, type PurgeLogEntry, type RetentionCandidate, type RetentionStage, type StageResult } from '@alarmops/core';
import type { SqlClient } from './client.js';
import { d, dReq, newId } from './rows.js';

const CHUNK = 1000;
const SCRUB_CHUNK = 500;
/**
 * The guard of every statement: that customer is TERMINATED and not on hold. `FOR SHARE` locks the Customer row for the
 * statement, so setLegalHold's `FOR UPDATE` waits for a running chunk to end, and a chunk that starts after the hold
 * committed sees it (READ COMMITTED re-checks the row). A chunk already running finishes; the next one is refused.
 */
const HELD_OR_ACTIVE = `EXISTS (SELECT 1 FROM "Customer" g_ WHERE g_."id" = $1 AND g_."status" = 'TERMINATED' AND NOT g_."legalHold" FOR SHARE)`;
/**
 * R-2: due time is decided by the DATABASE clock inside the statement, not by the runner: `statusChangedAt + days <= now()`
 * (CONNECTIONS: the offboarding is complete). A runner whose clock runs early cannot purge early.
 */
const guardFor = (sql: SqlClient, days: number | null): string => {
  const due = days === null
    ? `EXISTS (SELECT 1 FROM "CustomerOffboarding" o_ WHERE o_."customerId" = $1 AND o_."completedAt" IS NOT NULL)`
    : `EXISTS (SELECT 1 FROM "Customer" t_ WHERE t_."id" = $1 AND t_."statusChangedAt" IS NOT NULL AND t_."statusChangedAt" + make_interval(days => ${Math.trunc(days)}) <= ${sql.now()})`;
  return `(${HELD_OR_ACTIVE} AND ${due})`;
};

export async function claimDay(sql: SqlClient, day: string): Promise<boolean> {
  await sql.query(`DELETE FROM "RetentionClaim" WHERE "claimedAt" < ${sql.now()} - interval '60 days'`);
  // A claim that was never finished and is older than 30 minutes (the run died) can be taken again.
  const rows = await sql.query(
    `INSERT INTO "RetentionClaim"("day", "claimedAt") VALUES ($1, ${sql.now()})
     ON CONFLICT ("day") DO UPDATE SET "claimedAt" = ${sql.now()} WHERE "RetentionClaim"."finishedAt" IS NULL AND "RetentionClaim"."claimedAt" < ${sql.now()} - interval '30 minutes' RETURNING "day"`, [day]);
  return rows.length > 0;
}
export async function finishDay(sql: SqlClient, day: string): Promise<void> {
  await sql.query(`UPDATE "RetentionClaim" SET "finishedAt" = ${sql.now()} WHERE "day" = $1`, [day]);
}
export async function releaseDay(sql: SqlClient, day: string): Promise<void> {
  await sql.query(`DELETE FROM "RetentionClaim" WHERE "day" = $1`, [day]);
}

export async function candidates(sql: SqlClient, limit: number): Promise<RetentionCandidate[]> {
  const rows = await sql.query(
    `SELECT c."id", c."statusChangedAt", o."completedAt" FROM "Customer" c LEFT JOIN "CustomerOffboarding" o ON o."customerId" = c."id"
      WHERE c."status" = 'TERMINATED' AND NOT c."legalHold" AND c."statusChangedAt" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "RetentionPurgeLog" l WHERE l."customerId" = c."id" AND l."stage" = 'SLA_EXPIRY') ORDER BY c."statusChangedAt", c."id" LIMIT $1`, [limit]);
  return rows.map((r) => ({ customerId: r.id, statusChangedAt: dReq(r.statusChangedAt), offboardingCompletedAt: d(r.completedAt) }));
}

class Run {
  counts: Record<string, number> = {};
  partial = false;
  constructor(readonly sql: SqlClient, readonly cid: string, readonly deadlineMs: number, readonly guard: string) {}
  add(k: string, n: number): void { if (n > 0) this.counts[k] = (this.counts[k] ?? 0) + n; }
  /** `body` is the part after `WITH c AS (` — it must contain `$1` (customerId), the GUARD, `LIMIT ${n}` and end in RETURNING 1. Loops until a short chunk. */
  async chunked(key: string, body: (limit: number) => string, params: readonly unknown[] = [], limit = CHUNK): Promise<void> {
    if (this.partial) return;
    for (;;) {
      if (Date.now() >= this.deadlineMs) { this.partial = true; return; }
      const [r] = await this.sql.query(`WITH c AS (${body(limit)}) SELECT count(*)::int AS "n" FROM c`, [this.cid, ...params]);
      const n = (r?.n as number) ?? 0;
      this.add(key, n);
      if (n < limit) return;
    }
  }
  del(table: string, key = table, extraWhere = 'true', params: readonly unknown[] = []): Promise<void> {
    return this.chunked(key, (n) => `DELETE FROM "${table}" WHERE "id" IN (SELECT "id" FROM "${table}" WHERE "customerId" = $1 AND ${extraWhere} AND ${this.guard} LIMIT ${n}) RETURNING 1`, params);
  }
}

export async function runStage(sql: SqlClient, customerId: string, stage: RetentionStage, opts: { deadlineMs: number; now: Date; days: number | null }): Promise<StageResult> {
  const [cus] = await sql.query(`SELECT 1 AS "ok" FROM "Customer" WHERE "id" = $1 AND "status" = 'TERMINATED' AND NOT "legalHold"`, [customerId]);
  if (!cus) return { counts: {}, partial: false, skipped: true };
  const run = new Run(sql, customerId, opts.deadlineMs, guardFor(sql, stage === 'CONNECTIONS' ? null : opts.days));
  const G = run.guard;
  const now = sql.now();
  if (stage === 'CONNECTIONS') {
    await run.del('ManagedAlarm');
    // R-5: a Resource that a RemediationRequest points to stays (the composite FK cascades, and the approval history must be kept
    // until AUDIT_EXPIRY): its name, ARN, key and tags are scrubbed instead.
    await run.del('Resource', 'Resource', `NOT EXISTS (SELECT 1 FROM "RemediationRequest" rr WHERE rr."resourceId" = "Resource"."id" AND rr."customerId" = "Resource"."customerId")`);
    await run.chunked('Resource.scrubbed', (n) => `UPDATE "Resource" SET "name" = NULL, "tags" = '{}'::jsonb, "resourceArn" = 'purged:' || "id", "resourceKey" = "id", "needsReviewReason" = NULL, "updatedAt" = ${now}
      WHERE "id" IN (SELECT "id" FROM "Resource" WHERE "customerId" = $1 AND "resourceArn" NOT LIKE 'purged:%' AND ${G} LIMIT ${n}) RETURNING 1`);
    await run.del('ThresholdChange');
    if (!run.partial) {
      // The CloudAccount row stays: ingest still maps residual events of this account to the customer. Secrets go, `disabled` is set.
      const a = await sql.query(
        `WITH c AS (UPDATE "CloudAccount" SET "externalId" = 'purged-' || "id", "readerRoleArn" = '', "eventForwarderRoleArn" = '', "alarmWriterRoleArn" = NULL, "tagWriterRoleArn" = NULL,
            "remediatorRoleArn" = NULL, "alarmWriterEnabled" = false, "tagWriterEnabled" = false, "remediatorEnabled" = false, "readerStatus" = 'UNKNOWN', "eventForwarderStatus" = 'UNKNOWN',
            "alarmWriterStatus" = 'UNKNOWN', "tagWriterStatus" = 'UNKNOWN', "remediatorStatus" = 'UNKNOWN', "alias" = NULL, "stackVersion" = NULL, "disabled" = true,
            "connectionPurgedAt" = ${now}, "updatedAt" = ${now}
          WHERE "customerId" = $1 AND "connectionPurgedAt" IS NULL AND ${G} RETURNING 1) SELECT count(*)::int AS "n" FROM c`, [customerId]);
      run.add('CloudAccount', (a[0]?.n as number) ?? 0);
      const s = await sql.query(
        `WITH c AS (UPDATE "IntegrationSource" SET "tokenHash" = NULL, "tokenPrefix" = NULL, "tokenRotatedAt" = NULL, "enabled" = false
          WHERE "customerId" = $1 AND ("tokenHash" IS NOT NULL OR "enabled") AND ${G} RETURNING 1) SELECT count(*)::int AS "n" FROM c`, [customerId]);
      run.add('IntegrationSource', (s[0]?.n as number) ?? 0);
    }
  } else if (stage === 'RETURN_PERIOD') {
    await returnPeriod(run, now);
  } else if (stage === 'AUDIT_EXPIRY') {
    // Approval history (R-5) goes with the audit records; the Resources it pinned follow.
    await run.del('RemediationRequest');
    await run.del('Resource');
    await run.del('AuditLog', 'AuditLog', `COALESCE("targetType", '') <> ALL($2::text[])`, [PROTECTED_AUDIT_TARGET_TYPES as string[]]);
    await run.del('ContactRevealLog');
  } else {
    // The SLA records. IncidentAlert / IncidentEvent / jobs / logs are gone already; any left cascade with the incident.
    await run.del('Incident');
  }
  // SLA_EXPIRY is logged once even when nothing was left: it marks the customer as finished (no longer a candidate).
  const firstSla = stage === 'SLA_EXPIRY' && !run.partial && (await sql.query(`SELECT 1 FROM "RetentionPurgeLog" WHERE "customerId" = $1 AND "stage" = 'SLA_EXPIRY'`, [customerId])).length === 0;
  if (Object.keys(run.counts).length || firstSla) {
    await sql.query(`INSERT INTO "RetentionPurgeLog"("id", "customerId", "stage", "counts", "actor", "at") VALUES ($1, $2, $3::"RetentionStage", $4::jsonb, 'system', ${now})`,
      [newId('purge'), customerId, stage, JSON.stringify(run.counts)]);
  }
  return { counts: run.counts, partial: run.partial };
}

async function returnPeriod(run: Run, now: string): Promise<void> {
  const { sql, cid } = run;
  const G = run.guard;
  // 1. Pseudonymized SLA records. People become "Responder N" in order of first appearance; the number continues after
  //    labels given by an earlier (interrupted) run. Paging outcome is read from the delivery logs BEFORE they are deleted.
  const people = await sql.query(
    `SELECT p."p", p."first" FROM (SELECT x."p", min(x."t") AS "first" FROM (
        SELECT "acknowledgedBy" AS "p", "triggeredAt" AS "t" FROM "Incident" WHERE "customerId" = $1 AND "purgedAt" IS NULL AND "acknowledgedBy" IS NOT NULL
        UNION ALL SELECT "resolvedBy", "triggeredAt" FROM "Incident" WHERE "customerId" = $1 AND "purgedAt" IS NULL AND "resolvedBy" IS NOT NULL) x GROUP BY x."p") p ORDER BY p."first", p."p"`, [cid]);
  const [off] = await sql.query(
    `SELECT COALESCE(max(substring(v FROM '^Responder ([0-9]+)$')::int), 0) AS "n" FROM (SELECT "acknowledgedBy" AS v FROM "Incident" WHERE "customerId" = $1 AND "purgedAt" IS NOT NULL
       UNION ALL SELECT "resolvedBy" FROM "Incident" WHERE "customerId" = $1 AND "purgedAt" IS NOT NULL) t`, [cid]);
  const base = (off?.n as number) ?? 0;
  const labels: Record<string, string> = {};
  people.forEach((r, i) => { labels[r.p as string] = `Responder ${base + i + 1}`; });
  await run.chunked('Incident', (n) => `UPDATE "Incident" i SET "title" = '[purged]', "axis" = 'purged:' || i."id", "isMergeTarget" = false, "accountIds" = '{}', "resourceTypes" = '{}',
        "assignmentSnapshot" = NULL, "rcaPlaceholder" = NULL, "acknowledgedBy" = $2::jsonb ->> i."acknowledgedBy", "resolvedBy" = $2::jsonb ->> i."resolvedBy",
        "pagingOutcome" = CASE WHEN EXISTS (SELECT 1 FROM "NotificationLog" l WHERE l."incidentId" = i."id" AND l."customerId" = $1 AND l."status" = 'SENT') THEN 'DELIVERED'::"PagingOutcome"
                               WHEN EXISTS (SELECT 1 FROM "NotificationLog" l WHERE l."incidentId" = i."id" AND l."customerId" = $1) THEN 'FAILED'::"PagingOutcome" ELSE 'NOT_PAGED'::"PagingOutcome" END,
        "purgedAt" = ${now}, "version" = i."version" + 1
      WHERE i."id" IN (SELECT "id" FROM "Incident" WHERE "customerId" = $1 AND "purgedAt" IS NULL AND ${G} LIMIT ${n}) RETURNING 1`, [JSON.stringify(labels)], SCRUB_CHUNK);
  if (run.partial) return; // the logs are still needed for the incidents not yet scrubbed
  // 2. Delivery records and confidential content.
  await run.del('NotificationLog');
  await run.del('NotificationJob');
  await run.del('SlackMessage');
  await run.del('IncidentEvent');
  await run.del('Resolution');
  await run.del('RawEvent');
  await run.del('Alert');
  await run.del('AlertGroup');
  if (run.partial) return;
  // 3. Customer contacts and portal users. A user that a reveal record points to (FK RESTRICT) is scrubbed instead of deleted.
  const refd = `(EXISTS (SELECT 1 FROM "ContactRevealLog" r WHERE r."actorUserId" = u."id") OR EXISTS (SELECT 1 FROM "BulkChange" b WHERE b."actorId" = u."id"))`;
  await run.chunked('Contact', (n) => `DELETE FROM "Contact" WHERE "id" IN (SELECT "id" FROM "Contact" WHERE "customerId" = $1 AND "kind" = 'CUSTOMER' AND ${G} LIMIT ${n}) RETURNING 1`);
  await run.chunked('User', (n) => `DELETE FROM "User" WHERE "id" IN (SELECT u."id" FROM "User" u WHERE u."customerId" = $1 AND NOT ${refd} AND ${G} LIMIT ${n}) RETURNING 1`);
  await run.chunked('User.scrubbed', (n) => `UPDATE "User" SET "email" = 'purged-' || "id" || '@invalid.invalid', "name" = 'Removed user', "status" = 'DISABLED', "seeAll" = false, "updatedAt" = ${now}
      WHERE "id" IN (SELECT u."id" FROM "User" u WHERE u."customerId" = $1 AND ${refd} AND u."email"::text NOT LIKE 'purged-%@invalid.invalid' AND ${G} LIMIT ${n}) RETURNING 1`);
  // 4. Customer contact values inside the records that stay (2 years): names of deleted contacts, contact keys in AuditLog before/after.
  await run.chunked('ContactRevealLog.masked', (n) => `UPDATE "ContactRevealLog" r SET "contactName" = '[purged]' WHERE r."id" IN (SELECT r2."id" FROM "ContactRevealLog" r2
      WHERE r2."customerId" = $1 AND r2."contactName" <> '[purged]' AND NOT EXISTS (SELECT 1 FROM "Contact" k WHERE k."id" = r2."contactId") AND ${G} LIMIT ${n}) RETURNING 1`);
  const keys = [...AUDIT_CONTACT_VALUE_KEYS];
  // Recursive (R-4): contact values inside nested objects and arrays go too. Idempotent: only rows that change are selected.
  await run.chunked('AuditLog.masked', (n) => `UPDATE "AuditLog" a SET "before" = retention_mask_json(a."before", $2::text[]), "after" = retention_mask_json(a."after", $2::text[])
      WHERE a."id" IN (SELECT a2."id" FROM "AuditLog" a2 WHERE a2."customerId" = $1
        AND (a2."before" IS DISTINCT FROM retention_mask_json(a2."before", $2::text[]) OR a2."after" IS DISTINCT FROM retention_mask_json(a2."after", $2::text[])) AND ${G} LIMIT ${n}) RETURNING 1`, [keys]);
}

export async function purgeLogOf(sql: SqlClient, customerId: string): Promise<PurgeLogEntry[]> {
  const rows = await sql.query(`SELECT "id", "customerId", "stage", "counts", "actor", "at" FROM "RetentionPurgeLog" WHERE "customerId" = $1 ORDER BY "at", "id"`, [customerId]);
  return rows.map((r) => ({ id: r.id, customerId: r.customerId, stage: r.stage, counts: (r.counts ?? {}) as Record<string, number>, actor: r.actor, at: dReq(r.at) }));
}
