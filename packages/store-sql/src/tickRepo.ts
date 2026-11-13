/**
 * TickRepository on Postgres (explicit SQL, no generated client). Same conflict semantics as MemoryTickStore —
 * the shared contract suite (packages/core/test/contract) runs against both.
 *
 * Rules kept in every statement:
 * - CLOCK (R-14; security review SQL R-2): due / lease / retry decisions of the outbox use the store clock
 *   `sql.now()` (the database's `now()`), never a time handed in by the runner. Where a caller's time is stored it
 *   is bounded by the store clock: a new or restored page is due at LEAST(caller time, now); a held page at most
 *   RELEASE_HOLD_MAX_SEC ahead; "due" lists (groups, escalation) never look past now; `claimTick` refuses a caller
 *   whose clock is more than CLOCK_SKEW_LIMIT_MS away.
 * - CLAIMS: rows are taken with `FOR UPDATE SKIP LOCKED` and every later write of a claimed job carries
 *   `WHERE status = 'SENDING' AND "claimSeq" = ?` (R-2).
 * - VERSIONS: incident / group writes are `UPDATE … WHERE version = ?`; zero rows = CONFLICT.
 * - TENANT: joins between tenant tables always carry the customer column (IS NOT DISTINCT FROM for unmapped rows).
 * - TIMEOUT (N-33): every transaction starts with SET LOCAL statement_timeout (client.ts), below 5 s.
 */
import {
  CLAIM_LEASE_SEC, CLOCK_SKEW_LIMIT_MS, LANE_CHANNELS, LANES, MAX_ATTEMPTS, RELEASE_HOLD_MAX_SEC, RETRY_DELAYS_SEC, claimReserve, policyFromRow, sanitizeProviderError,
  type AuditInput, type Contact, type CustomerStatus, type DeliveryLog, type DeliveryReason, type GroupDeliveryCommit, type GroupMember, type GroupRow, type HeartbeatRow,
  type HeartbeatWrite, type IncidentCommit, type IncidentEventInput, type IncidentRow, type Leave, type MaintenanceWindow, type NotificationIntent,
  type NotificationJob, type Override, type PagingConfig, type PagingWorld, type ResolutionInput, type Responder, type Rotation, type SenderKind,
  type SuppressionPolicy, type TickJob, type TickRepository, TICK_JOBS, MAX_MEMBERS,
} from '@alarmops/core';
import { PG, pgCode, type SqlClient, type SqlExecutor, type SqlRow } from './client.js';
import { CONTACT_COLS, GROUP_COLS, d, dReq, incidentCols, iso, jobCols, js, newId, toContact, toGroup, toIncident, toJob } from './rows.js';

/** Thrown inside a transaction to roll it back and return a value (e.g. 'CONFLICT') to the caller. */
class Abort<T> { constructor(readonly value: T) {} }

const ALL_CHANNELS = Object.values(LANE_CHANNELS).flat();
const SLACK_CHANNEL_KINDS = ['SLACK_BOT', 'SLACK_WEBHOOK'];
/** `(ARRAY[30,60,120,300,600])[attempt]` — retryAt() of core as SQL. */
const RETRY_SQL = `(ARRAY[${RETRY_DELAYS_SEC.join(',')}])`;

export class SqlTickStore implements TickRepository {
  constructor(protected readonly sql: SqlClient) {}

  /** Run `fn` in one transaction; an `Abort` rolls back and yields its value. */
  protected async tx<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await this.sql.transaction(fn);
    } catch (err) {
      if (err instanceof Abort) return err.value as T;
      throw err;
    }
  }

  // ───────────────────────────── tick claim · policy ─────────────────────────────

  async now(): Promise<Date> {
    const [r] = await this.sql.query(`SELECT ${this.sql.now()} AS "now"`);
    return dReq(r!.now);
  }

  /**
   * One row per claimed minute. R-2: `at` (the caller's clock) more than CLOCK_SKEW_LIMIT_MS from the store clock →
   * nothing is claimed and the answer is 'CLOCK_SKEW'. Old rows are removed by `purgeExpired`, by the time they
   * were CLAIMED on the store clock — a caller with a wrong clock cannot make this statement delete live rows.
   */
  async claimTick(minuteKey: string, at?: Date): Promise<boolean | 'CLOCK_SKEW'> {
    const now = this.sql.now();
    const [r] = await this.sql.query(
      `WITH ok AS (SELECT ($2::timestamptz IS NULL OR abs(extract(epoch FROM ($2::timestamptz - ${now}))) * 1000 <= ${CLOCK_SKEW_LIMIT_MS}) AS v),
            ins AS (INSERT INTO "TickClaim"("minute", "claimedAt") SELECT $1::timestamptz, ${now} FROM ok WHERE ok.v ON CONFLICT ("minute") DO NOTHING RETURNING 1)
       SELECT ok.v AS "inSync", EXISTS (SELECT 1 FROM ins) AS "claimed" FROM ok`,
      [minuteKey, iso(at)],
    );
    return !r!.inSync ? 'CLOCK_SKEW' : r!.claimed === true;
  }

  /** R-7: expired rows of every owner, on the store clock, at most 5 000 per table and call. */
  async purgeExpired(): Promise<number> {
    const now = this.sql.now();
    const [r] = await this.sql.query(
      `WITH t AS (DELETE FROM "TickClaim" WHERE "minute" IN (SELECT "minute" FROM "TickClaim" WHERE "claimedAt" < ${now} - interval '2 days' AND "minute" < ${now} - interval '2 days' LIMIT 5000) RETURNING 1),
            i AS (DELETE FROM "IdempotencyKey" WHERE "key" IN (SELECT "key" FROM "IdempotencyKey" WHERE "expiresAt" <= ${now} LIMIT 5000) RETURNING 1),
            u AS (DELETE FROM "UndoRecord" WHERE "token" IN (SELECT "token" FROM "UndoRecord" WHERE "expiresAt" < ${now} - interval '1 day' LIMIT 5000) RETURNING 1)
       SELECT ((SELECT count(*) FROM t) + (SELECT count(*) FROM i) + (SELECT count(*) FROM u))::int AS "n"`,
    );
    return r?.n ?? 0;
  }

  async loadPolicy(): Promise<SuppressionPolicy> {
    const [row] = await this.sql.query(`SELECT * FROM "SuppressionPolicy" WHERE "id" = 'global'`);
    return policyFromRow(row ?? null);
  }

  // ───────────────────────────── ① groups ─────────────────────────────

  async listGroupsToClose(now: Date, limit: number): Promise<GroupRow[]> {
    return (await this.sql.query(`SELECT ${GROUP_COLS} FROM "AlertGroup" WHERE "status" = 'OPEN' AND "closeAt" <= LEAST($1::timestamptz, ${this.sql.now()}) ORDER BY "closeAt", "id" LIMIT $2`, [iso(now), limit])).map(toGroup);
  }
  async closeGroup(groupId: string, at: Date): Promise<boolean> {
    const rows = await this.sql.query(`UPDATE "AlertGroup" SET "status" = 'CLOSED', "closedAt" = $2::timestamptz, "version" = "version" + 1 WHERE "id" = $1 AND "status" = 'OPEN' RETURNING "id"`, [groupId, iso(at)]);
    return rows.length > 0;
  }
  async listGroupsToDeliver(closedBefore: Date, limit: number): Promise<GroupRow[]> {
    return (await this.sql.query(
      `SELECT ${GROUP_COLS} FROM "AlertGroup" WHERE "status" = 'CLOSED' AND "deliveredAt" IS NULL AND COALESCE("closedAt", "closeAt") <= LEAST($1::timestamptz, ${this.sql.now()}) ORDER BY "openedAt", "id" LIMIT $2`,
      [iso(closedBefore), limit],
    )).map(toGroup);
  }
  /** RawEvent rows of the group that entered it (NOTIFY / DEFER), one line per alert, in the order the alerts first arrived. */
  async groupMembers(groupId: string): Promise<GroupMember[]> {
    const rows = await this.sql.query(
      `SELECT a."id" AS "alertId", a."fingerprint", a."severity", a."title", a."awsAccountId", a."resourceType", a."source", a."episodeOpen",
              count(*)::int AS "eventCount", bool_or(e."decision" = 'NOTIFY') AS "notify"
         FROM "AlertGroup" g
         JOIN "RawEvent" e ON e."groupId" = g."id" AND e."decision" IN ('NOTIFY', 'DEFER')
         JOIN "Alert" a ON a."id" = e."alertId" AND a."customerId" IS NOT DISTINCT FROM g."customerId"
        WHERE g."id" = $1
        GROUP BY a."id"
        ORDER BY min(e."occurredAt"), min(e."receivedAt"), a."id"`,
      [groupId],
    );
    return rows.map((r) => ({
      alertId: r.alertId, fingerprint: r.fingerprint, severity: r.severity, title: r.title, awsAccountId: r.awsAccountId ?? null, resourceType: r.resourceType ?? null,
      source: r.source ?? null, decision: r.notify ? 'NOTIFY' : 'DEFER', episodeOpen: r.episodeOpen, eventCount: r.eventCount,
    }));
  }
  async findMergeTarget(axis: string): Promise<IncidentRow | null> {
    const [r] = await this.sql.query(`SELECT ${incidentCols()} FROM "Incident" WHERE "axis" = $1 AND "isMergeTarget"`, [axis]);
    return r ? toIncident(r) : null;
  }
  async incidentIdExists(id: string): Promise<boolean> {
    return (await this.sql.query(`SELECT 1 FROM "Incident" WHERE "id" = $1`, [id])).length > 0;
  }
  async incidentFingerprints(incidentId: string): Promise<string[]> {
    return (await this.sql.query(`SELECT a."fingerprint" FROM "IncidentAlert" ia JOIN "Alert" a ON a."id" = ia."alertId" WHERE ia."incidentId" = $1`, [incidentId])).map((r) => r.fingerprint as string);
  }
  async orgForAccount(customerId: string, awsAccountId: string): Promise<{ projectId: string; serviceId: string } | null> {
    const [r] = await this.sql.query(
      `SELECT s."projectId", s."id" AS "serviceId" FROM "CloudAccount" ca JOIN "Service" s ON s."id" = ca."serviceId" AND s."customerId" = ca."customerId"
        WHERE ca."awsAccountId" = $2 AND ca."customerId" = $1`,
      [customerId, awsAccountId],
    );
    return r ? { projectId: r.projectId, serviceId: r.serviceId } : null;
  }

  /** D-43. A customer that is not found is ACTIVE (when in doubt, page). */
  async customerStatus(customerId: string): Promise<CustomerStatus> {
    const [r] = await this.sql.query(`SELECT "status" FROM "Customer" WHERE "id" = $1`, [customerId]);
    return (r?.status as CustomerStatus | undefined) ?? 'ACTIVE';
  }

  async pagingContext(customerId: string): Promise<{ configs: PagingConfig[]; world: PagingWorld }> {
    const q = this.sql;
    const [cfgRows, contactRows, responderRows, rotationRows] = await Promise.all([
      q.query(
        `SELECT c."id", c."customerId", c."scopeType", c."scopeId", c."style", c."plan", c."edited", c."repeatCount", c."renotifyAfterAckSec", c."version",
                COALESCE((SELECT jsonb_agg(jsonb_build_object('index', s."index", 'atMin', s."atMin", 'targetType', s."targetType", 'targetId', s."targetId",
                           'channels', to_jsonb(s."channels"), 'advanceOnAllFail', s."advanceOnAllFail") ORDER BY s."index")
                            FROM "EscalationStep" s WHERE s."pagingConfigId" = c."id"), '[]'::jsonb) AS "steps"
           FROM "PagingConfig" c WHERE c."customerId" = $1 ORDER BY c."id"`, [customerId]),
      q.query(`SELECT ${CONTACT_COLS} FROM "Contact" WHERE "kind" = 'INTERNAL' OR "customerId" = $1`, [customerId]),
      q.query(`SELECT "customerId", "contactId", "role", "order" FROM "Responder" WHERE "customerId" = $1 ORDER BY "order", "contactId"`, [customerId]),
      q.query(
        `SELECT r."id", r."scope", r."customerId", r."name", r."cadence", r."anchorAt",
                COALESCE((SELECT jsonb_agg(jsonb_build_object('contactId', m."contactId", 'order', m."order") ORDER BY m."order", m."contactId")
                            FROM "RotationMember" m WHERE m."rotationId" = r."id"), '[]'::jsonb) AS "members"
           FROM "Rotation" r WHERE r."scope" = 'MSP' OR r."customerId" = $1`, [customerId]),
    ]);
    const contacts = new Map<string, Contact>(contactRows.map((r) => [r.id as string, toContact(r)]));
    const rotations = new Map<string, Rotation>(rotationRows.map((r) => [r.id as string, {
      id: r.id, scope: r.scope, customerId: r.customerId ?? null, name: r.name, cadence: r.cadence, anchorAt: dReq(r.anchorAt), members: r.members,
    }]));
    const rotationIds = [...rotations.keys()];
    const contactIds = [...contacts.keys()];
    const [overrideRows, leaveRows] = await Promise.all([
      rotationIds.length ? q.query(`SELECT "rotationId", "contactId", "startAt", "endAt", "status" FROM "Override" WHERE "rotationId" = ANY($1::text[]) ORDER BY "startAt", "id"`, [rotationIds]) : Promise.resolve([] as SqlRow[]),
      // Leave dates are KST calendar days (inclusive); they travel as 'yyyy-mm-dd' strings.
      contactIds.length ? q.query(`SELECT "contactId", "replacementId", to_char("startDate", 'YYYY-MM-DD') AS "startDate", to_char("endDate", 'YYYY-MM-DD') AS "endDate", "cancelledAt" FROM "Leave" WHERE "contactId" = ANY($1::text[]) ORDER BY "startDate", "id"`, [contactIds]) : Promise.resolve([] as SqlRow[]),
    ]);
    const configs: PagingConfig[] = cfgRows.map((r) => ({
      id: r.id, customerId: r.customerId, scopeType: r.scopeType, scopeId: r.scopeId, style: r.style, plan: r.plan, edited: r.edited, repeatCount: r.repeatCount,
      renotifyAfterAckSec: r.renotifyAfterAckSec ?? null, version: r.version, steps: r.steps,
    }));
    const responders: Responder[] = responderRows.map((r) => ({ customerId: r.customerId, contactId: r.contactId, role: r.role, order: r.order }));
    const overrides: Override[] = overrideRows.map((r) => ({ rotationId: r.rotationId, contactId: r.contactId, startAt: dReq(r.startAt), endAt: dReq(r.endAt), status: r.status }));
    const leaves: Leave[] = leaveRows.map((r) => ({ contactId: r.contactId, replacementId: r.replacementId, startDate: r.startDate, endDate: r.endDate, cancelledAt: d(r.cancelledAt) }));
    return { configs, world: { customerId, contacts, responders, rotations, overrides, leaves } };
  }

  async commitGroupDelivery(c: GroupDeliveryCommit): Promise<'OK' | 'CONFLICT' | 'ALREADY_DELIVERED'> {
    try {
      return await this.tx(async (tx) => {
        const [g] = await tx.query(`SELECT "status", "deliveredAt", "version", "customerId" FROM "AlertGroup" WHERE "id" = $1 FOR UPDATE`, [c.groupId]);
        if (!g || g.status !== 'CLOSED' || g.deliveredAt) return 'ALREADY_DELIVERED' as const;
        if (g.version !== c.groupVersion) return 'CONFLICT' as const;
        if (c.incident) {
          const row = c.incident.row;
          if (c.incident.mode === 'CREATE') {
            const demoteId = c.incident.demoteId;
            const clash = await tx.query(`SELECT 1 FROM "Incident" WHERE "id" = $1 OR ("axis" = $2 AND "isMergeTarget" AND "id" IS DISTINCT FROM $3)`, [row.id, row.axis, demoteId]);
            if (clash.length) throw new Abort('CONFLICT' as const);
            if (demoteId) await tx.query(`UPDATE "Incident" SET "isMergeTarget" = false, "version" = "version" + 1 WHERE "id" = $1 AND "axis" = $2`, [demoteId, row.axis]);
            await this.insertIncident(tx, row);
          } else {
            const saved = await this.updateIncident(tx, row, c.incident.expectedVersion, true);
            if (!saved) throw new Abort('CONFLICT' as const);
          }
          for (const m of c.members) {
            // I-4: a known member only grows its eventCount; a new one is added while the incident has fewer than 200.
            const known = await tx.query(`UPDATE "IncidentAlert" SET "eventCount" = "eventCount" + $3 WHERE "incidentId" = $1 AND "alertId" = $2 RETURNING 1 AS "ok"`, [row.id, m.alertId, m.eventCount]);
            if (known.length) continue;
            await tx.query(
              `INSERT INTO "IncidentAlert"("incidentId", "alertId", "customerId", "joinedAt", "eventCount")
               SELECT $1, a."id", a."customerId", $4::timestamptz, $3 FROM "Alert" a
                WHERE a."id" = $2 AND a."customerId" IS NOT DISTINCT FROM $5
                  AND (SELECT count(*) FROM "IncidentAlert" WHERE "incidentId" = $1) < ${MAX_MEMBERS}
               ON CONFLICT ("incidentId", "alertId") DO UPDATE SET "eventCount" = "IncidentAlert"."eventCount" + EXCLUDED."eventCount"`,
              [row.id, m.alertId, m.eventCount, iso(c.deliveredAt), row.customerId],
            );
          }
        }
        await this.insertEvents(tx, c.events);
        await this.insertJobs(tx, c.jobs, c.deliveredAt);
        if (c.finalized.length) {
          await tx.query(
            `UPDATE "RawEvent" e SET "finalAction" = (f.x->>'finalAction')::"Decision", "finalReason" = f.x->>'finalReason', "finalizedAt" = $3::timestamptz
               FROM jsonb_array_elements($2::jsonb) AS f(x)
              WHERE e."groupId" = $1 AND e."alertId" = f.x->>'alertId' AND e."finalizedAt" IS NULL`,
            [c.groupId, js(c.finalized), iso(c.deliveredAt)],
          );
        }
        await tx.query(`UPDATE "AlertGroup" SET "status" = 'DELIVERED', "deliveredAt" = $2::timestamptz, "version" = "version" + 1 WHERE "id" = $1`, [c.groupId, iso(c.deliveredAt)]);
        return 'OK' as const;
      });
    } catch (err) {
      // Lost a race on a unique index (incident id, one merge target per axis): the caller re-reads and re-applies (I-7).
      if (pgCode(err) === PG.UNIQUE) return 'CONFLICT';
      throw err;
    }
  }

  // ───────────────────────────── ② / ③ incidents ─────────────────────────────

  async listAutoResolvable(limit: number): Promise<IncidentRow[]> {
    return (await this.sql.query(
      `SELECT ${incidentCols('i')} FROM "Incident" i
        WHERE i."status" <> 'RESOLVED'
          AND EXISTS (SELECT 1 FROM "IncidentAlert" ia WHERE ia."incidentId" = i."id")
          AND NOT EXISTS (SELECT 1 FROM "IncidentAlert" ia JOIN "Alert" a ON a."id" = ia."alertId" WHERE ia."incidentId" = i."id" AND a."episodeOpen")
        ORDER BY i."triggeredAt", i."number" LIMIT $1`,
      [limit],
    )).map(toIncident);
  }
  async listEscalationDue(now: Date, limit: number, excludeIds: string[] = []): Promise<IncidentRow[]> {
    return (await this.sql.query(
      `SELECT ${incidentCols()} FROM "Incident"
        WHERE "status" <> 'RESOLVED' AND "nextEscalationAt" IS NOT NULL AND "nextEscalationAt" <= LEAST($1::timestamptz, ${this.sql.now()}) AND NOT ("id" = ANY($3::text[]))
        ORDER BY "nextEscalationAt", "id" LIMIT $2`,
      [iso(now), limit, excludeIds],
    )).map(toIncident);
  }
  async maintenanceWindows(customerId: string | null, at: Date): Promise<MaintenanceWindow[]> {
    return (await this.sql.query(
      `SELECT "id", "customerId", "scopeType", "scopeId", "resourceType", "startsAt", "endsAt", "revokedAt" FROM "MaintenanceWindow"
        WHERE ("customerId" IS NULL OR "customerId" = $1) AND ("revokedAt" IS NULL OR "revokedAt" > $2::timestamptz)
          AND "startsAt" <= $2::timestamptz AND $2::timestamptz < "endsAt" ORDER BY "startsAt", "id"`,
      [customerId, iso(at)],
    )).map(toWindow);
  }
  async stepAllFailed(incidentId: string, stepIndex: number, repeat: number): Promise<boolean> {
    const [r] = await this.sql.query(
      `SELECT count(*)::int AS "n", (count(*) FILTER (WHERE "status" IN ('FAILED', 'SKIPPED')))::int AS "f" FROM "NotificationJob"
        WHERE "incidentId" = $1 AND "purpose" <> 'RENOTIFY' AND "stepIndex" = $2 AND "repeat" = $3`,
      [incidentId, stepIndex, repeat],
    );
    return !!r && r.n > 0 && r.n === r.f;
  }

  async commitIncident(c: IncidentCommit): Promise<IncidentRow | 'CONFLICT'> {
    return this.tx(async (tx) => {
      const saved = await this.updateIncident(tx, c.row, c.expectedVersion, c.bump);
      if (!saved) return 'CONFLICT' as const;
      const events = c.events ?? [];
      await this.insertEvents(tx, events);
      // No event → no time from the caller: the pages are due at the store's now (never 1970).
      await this.insertJobs(tx, c.jobs ?? [], events.length ? new Date(Math.max(...events.map((e) => e.at.getTime()))) : null);
      if (c.restoreAckSkipped) {
        const r = c.restoreAckSkipped;
        await tx.query(
          `UPDATE "NotificationJob" SET "status" = 'QUEUED', "lastError" = NULL, "nextAttemptAt" = LEAST($4::timestamptz, ${this.sql.now()}), "dueAt" = LEAST($4::timestamptz, ${this.sql.now()})
            WHERE "incidentId" = $1 AND "status" = 'SKIPPED' AND "lastError" = 'acknowledged' AND "purpose" <> 'RENOTIFY' AND "stepIndex" = $2 AND "repeat" = $3`,
          [saved.id, r.stepIndex, r.repeat, iso(r.at)],
        );
      }
      if (c.memberEffect) {
        const [from, to] = c.memberEffect === 'ACK' ? ['FIRING', 'ACKNOWLEDGED'] : ['ACKNOWLEDGED', 'FIRING'];
        await tx.query(
          `UPDATE "Alert" a SET "status" = '${to}' FROM "IncidentAlert" ia
            WHERE ia."incidentId" = $1 AND a."id" = ia."alertId" AND a."status" = '${from}' AND a."customerId" IS NOT DISTINCT FROM $2`,
          [saved.id, saved.customerId],
        );
      }
      if (c.resolution) await this.insertResolution(tx, c.resolution);
      if (c.audit) await insertAudit(tx, c.audit);
      return saved;
    });
  }

  protected async insertIncident(tx: SqlExecutor, r: IncidentRow): Promise<void> {
    await tx.query(
      `INSERT INTO "Incident"("id", "axis", "customerId", "title", "severity", "status", "triggeredAt", "acknowledgedAt", "resolvedAt", "acknowledgedBy", "resolvedBy",
         "resolvedVia", "mttaSec", "mttrSec", "memberCount", "eventCount", "accountIds", "resourceTypes", "assignmentSnapshot", "pagingConfigId",
         "escalationStep", "escalationRepeat", "escalationBaseAt", "escalationDoneAt", "renotifiedAt", "version", "isMergeTarget", "nextEscalationAt",
         "lastMergedAt", "renotifyCount", "projectId", "serviceId", "source", "lastManualEscalationAt", "pagingSuppressed")
       VALUES ($1, $2, $3, $4, $5::"Severity", $6::"IncidentStatus", $7::timestamptz, $8::timestamptz, $9::timestamptz, $10, $11,
         $12::"ResolvedVia", $13, $14, $15, $16, $17::text[], $18::text[], $19::jsonb, $20,
         $21, $22, $23::timestamptz, $24::timestamptz, $25::timestamptz, 0, $26, $27::timestamptz,
         $28::timestamptz, $29, $30, $31, $32::"SourceKind", $33::timestamptz, $34::"PagingSuppressedReason")`,
      [r.id, r.axis, r.customerId, r.title, r.severity, r.status, iso(r.triggeredAt), iso(r.acknowledgedAt), iso(r.resolvedAt), r.acknowledgedBy, r.resolvedBy,
        r.resolvedVia, r.mttaSec, r.mttrSec, r.memberCount, r.eventCount, r.accountIds, r.resourceTypes, js(r.assignmentSnapshot), r.pagingConfigId,
        r.escalationStep, r.escalationRepeat, iso(r.escalationBaseAt), iso(r.escalationDoneAt), iso(r.renotifiedAt), r.isMergeTarget, iso(r.nextEscalationAt),
        iso(r.lastMergedAt), r.renotifyCount, r.projectId, r.serviceId, r.source, iso(r.lastManualEscalationAt), r.pagingSuppressed ?? null],
    );
  }

  /**
   * `UPDATE … WHERE id = ? AND version = ?`. The identity of an incident (axis, customer, triggeredAt, number) and
   * what was fixed at open (pagingConfigId, projectId, serviceId, source) are not written again.
   */
  protected async updateIncident(tx: SqlExecutor, r: IncidentRow, expectedVersion: number, bump: boolean): Promise<IncidentRow | null> {
    const [row] = await tx.query(
      `UPDATE "Incident" SET "title" = $3, "severity" = $4::"Severity", "status" = $5::"IncidentStatus", "acknowledgedAt" = $6::timestamptz, "resolvedAt" = $7::timestamptz,
         "acknowledgedBy" = $8, "resolvedBy" = $9, "resolvedVia" = $10::"ResolvedVia", "mttaSec" = $11, "mttrSec" = $12, "memberCount" = $13, "eventCount" = $14,
         "accountIds" = $15::text[], "resourceTypes" = $16::text[], "assignmentSnapshot" = $17::jsonb, "escalationStep" = $18, "escalationRepeat" = $19,
         "escalationBaseAt" = $20::timestamptz, "escalationDoneAt" = $21::timestamptz, "renotifiedAt" = $22::timestamptz, "isMergeTarget" = $23,
         "nextEscalationAt" = $24::timestamptz, "lastMergedAt" = $25::timestamptz, "renotifyCount" = $26, "lastManualEscalationAt" = $27::timestamptz,
         "pagingSuppressed" = COALESCE("pagingSuppressed", $29::"PagingSuppressedReason"),
         "version" = "version" + $28
       WHERE "id" = $1 AND "version" = $2 RETURNING ${incidentCols()}`,
      [r.id, expectedVersion, r.title, r.severity, r.status, iso(r.acknowledgedAt), iso(r.resolvedAt), r.acknowledgedBy, r.resolvedBy, r.resolvedVia, r.mttaSec, r.mttrSec,
        r.memberCount, r.eventCount, r.accountIds, r.resourceTypes, js(r.assignmentSnapshot), r.escalationStep, r.escalationRepeat, iso(r.escalationBaseAt),
        iso(r.escalationDoneAt), iso(r.renotifiedAt), r.isMergeTarget, iso(r.nextEscalationAt), iso(r.lastMergedAt), r.renotifyCount, iso(r.lastManualEscalationAt ?? null),
        bump ? 1 : 0, r.pagingSuppressed ?? null],
    );
    return row ? toIncident(row) : null;
  }

  protected async insertEvents(tx: SqlExecutor, events: IncidentEventInput[]): Promise<void> {
    if (!events.length) return;
    const rows = events.map((e) => ({ id: newId('ev'), incidentId: e.incidentId, customerId: e.customerId, at: e.at.toISOString(), kind: e.kind, actorType: e.actorType, actorId: e.actorId, message: e.message, data: e.data ?? null }));
    await tx.query(
      `INSERT INTO "IncidentEvent"("id", "incidentId", "customerId", "at", "kind", "actorType", "actorId", "message", "data")
       SELECT t.x->>'id', t.x->>'incidentId', t.x->>'customerId', (t.x->>'at')::timestamptz, (t.x->>'kind')::"IncidentEventKind", (t.x->>'actorType')::"ActorType",
              t.x->>'actorId', t.x->>'message', NULLIF(t.x->'data', 'null'::jsonb)
         FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(x, ord) ORDER BY t.ord`,
      [js(rows)],
    );
  }

  /**
   * INSERT … ON CONFLICT (idempotencyKey) DO NOTHING: the same page is never queued twice.
   * Due at LEAST(at, store now) (R-2): a new page means "send now", so a caller whose clock is ahead cannot park
   * it in the future; a clock that is behind only makes it due in the past, which is harmless. `at` null → now.
   */
  protected async insertJobs(tx: SqlExecutor, intents: NotificationIntent[], at: Date | null): Promise<void> {
    if (!intents.length) return;
    const due = `LEAST(COALESCE($2::timestamptz, ${this.sql.now()}), ${this.sql.now()})`;
    const rows = intents.map((i) => ({ ...i, id: newId('job') }));
    await tx.query(
      `INSERT INTO "NotificationJob"("id", "idempotencyKey", "customerId", "incidentId", "purpose", "channel", "targetRef", "status", "attempts", "nextAttemptAt", "dueAt",
         "createdAt", "payload", "stepIndex", "repeat", "contactId", "contactName")
       SELECT t.x->>'id', t.x->>'idempotencyKey', t.x->>'customerId', t.x->>'incidentId', (t.x->>'purpose')::"NotificationPurpose", (t.x->>'channel')::"NotificationChannelType",
              t.x->>'targetRef', 'QUEUED', 0, ${due}, ${due}, ${due}, t.x->'payload', (t.x->>'stepIndex')::int, (t.x->>'repeat')::int,
              (SELECT c."id" FROM "Contact" c WHERE c."id" = t.x->>'contactId'), t.x->>'contactName'
         FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(x, ord) ORDER BY t.ord
       ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [js(rows), iso(at)],
    );
  }

  protected async insertResolution(tx: SqlExecutor, r: ResolutionInput): Promise<void> {
    await tx.query(
      `INSERT INTO "Resolution"("id", "customerId", "incidentId", "via", "kind", "note", "serviceId", "durationSec", "escalationStep", "resolvedBy", "resolvedAt")
       VALUES ($1, $2, $3, $4::"ResolutionVia", $5::"ResolutionKind", $6, $7, $8, $9, $10, $11::timestamptz)`,
      [newId('res'), r.customerId, r.incidentId, r.via, r.kind, r.note, r.serviceId, r.durationSec, r.escalationStep, r.resolvedBy, iso(r.resolvedAt)],
    );
  }

  // ───────────────────────────── ④ outbox ─────────────────────────────

  /**
   * One transaction:
   * 0. `pg_advisory_xact_lock` for every lane of the claim, in a fixed order (security review SQL, B-1). Claims of
   *    one lane therefore run one after the other: the second runner's statements start after the first one
   *    committed (READ COMMITTED: a new snapshot per statement), see its rows as SENDING with a lease, and choose
   *    among what is left. Without it both runners ranked the same first rows, one locked them, and the other
   *    skipped them WITHOUT taking others — an empty claim while pages were due. The lock is transaction-scoped
   *    (nothing to release, nothing kept on a pooled connection), is held for the few milliseconds of the claim,
   *    and waits at most `lock_timeout` (3 s). Other lanes are not affected.
   * 1. due jobs that already used every attempt → FAILED + a NotificationLog row (GAVE_UP);
   * 2. the claim. The ORDER is `selectForClaim` of core, as SQL: per-customer round-robin
   *    (`ROW_NUMBER() OVER (PARTITION BY customer ORDER BY sev1 DESC, tried, dueAt, createdAt, seq)`), rounds ordered
   *    by `rn, sev1 DESC, tried, dueAt, createdAt`, and NON_SEV1_RESERVE_PCT of the claim kept for the oldest
   *    non-SEV-1 jobs the fair order did not reach. With `rotateAfter` (R-24) the rows are CHOSEN on rotated rounds
   *    (`rn`, customers after the cursor first, customer key in byte order) and still returned in fair order.
   *    The chosen rows are LOCKED with FOR UPDATE SKIP LOCKED (kept as a second guard: the due condition is
   *    re-checked under the lock) and updated: SENDING, claimSeq + 1, lease from the store clock.
   *    `attempts` and `dueAt` are not touched.
   */
  async claimDueJobs(limit: number, opts: { kinds?: readonly SenderKind[]; rotateAfter?: string | null } = {}): Promise<NotificationJob[]> {
    const kinds = [...new Set(opts.kinds ?? LANES)].sort();
    const channels = opts.kinds ? opts.kinds.flatMap((k) => LANE_CHANNELS[k]) : ALL_CHANNELS;
    const reserve = claimReserve(limit);
    const now = this.sql.now();
    const rotate = opts.rotateAfter != null;
    // `sel`: the position that decides WHICH rows are taken; `pos` (fair order) is what the result is sorted by.
    const sel = rotate ? `ROW_NUMBER() OVER (ORDER BY rn, (ck COLLATE "C" <= $4::text COLLATE "C"), ck COLLATE "C")` : `ROW_NUMBER() OVER (ORDER BY rn, sev1 DESC, tried, "dueAt", "createdAt", cseq)`;
    return this.tx(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('alarmops:outbox-claim'), hashtext(k)) FROM unnest($1::text[]) AS t(k)`, [kinds]); // `kinds` is sorted: every runner takes the locks in the same order
      const gone = await tx.query(
        `UPDATE "NotificationJob" SET "status" = 'FAILED', "lastError" = COALESCE("lastError", 'gave up after a send that never finished')
          WHERE "status" IN ('QUEUED', 'SENDING') AND "nextAttemptAt" <= ${now} AND "attempts" >= ${MAX_ATTEMPTS} AND "channel" = ANY($1::text[]::"NotificationChannelType"[])
          RETURNING "id", "customerId", "incidentId", "channel", "contactId", "contactName", "stepIndex", "attempts", "lastError"`,
        [channels],
      );
      if (gone.length) {
        const logs = gone.map((j) => {
          const toChannel = SLACK_CHANNEL_KINDS.includes(j.channel);
          return { at: null, customerId: j.customerId, incidentId: j.incidentId, jobId: j.id, channel: j.channel, status: 'FAILED', targetSummary: toChannel ? 'Slack channel' : j.contactName ?? 'Unknown person',
            targetKind: toChannel ? 'MSP_CHANNEL' : 'STAFF', contactId: toChannel ? null : j.contactId, escalationStep: j.stepIndex, attempt: j.attempts, providerMessageId: null, error: j.lastError, errorCode: 'GAVE_UP', warnings: [] };
        });
        await insertLogs(tx, logs, now);
      }
      const rows = await tx.query(
        `WITH due AS (
           SELECT j."id", COALESCE(j."customerId", '') AS ck, (j."payload"->>'severity' = 'SEV_1') AS sev1, (j."attempts" > 0) AS tried, j."dueAt", j."createdAt", j."seq"
             FROM "NotificationJob" j
            WHERE j."status" IN ('QUEUED', 'SENDING') AND j."nextAttemptAt" <= ${now} AND j."attempts" < ${MAX_ATTEMPTS} AND j."channel" = ANY($1::text[]::"NotificationChannelType"[])
         ), ranked AS (
           SELECT due.*, ROW_NUMBER() OVER (PARTITION BY ck ORDER BY sev1 DESC, tried, "dueAt", "createdAt", "seq") AS rn, MIN("seq") OVER (PARTITION BY ck) AS cseq FROM due
         ), ordered AS (
           SELECT ranked.*, ROW_NUMBER() OVER (ORDER BY rn, sev1 DESC, tried, "dueAt", "createdAt", cseq) AS pos, ${sel} AS sel, COUNT(*) OVER () AS total FROM ranked
         ), head AS (
           SELECT "id" FROM ordered WHERE total <= $2 OR sel <= $2 - $3
         ), low AS (
           SELECT "id" FROM ordered WHERE total > $2 AND sel > $2 - $3 AND NOT sev1 ORDER BY "dueAt", "createdAt", sel LIMIT $3
         ), chosen AS (
           SELECT "id" FROM head UNION ALL SELECT "id" FROM low
         ), fill AS (
           SELECT "id" FROM ordered WHERE "id" NOT IN (SELECT "id" FROM chosen) ORDER BY sel LIMIT GREATEST(0, $2 - (SELECT count(*) FROM chosen))
         ), picked AS (
           SELECT o."id", o.pos FROM ordered o WHERE o."id" IN (SELECT "id" FROM chosen UNION ALL SELECT "id" FROM fill)
         ), locked AS (
           SELECT j."id" FROM "NotificationJob" j
            WHERE j."id" IN (SELECT "id" FROM picked) AND j."status" IN ('QUEUED', 'SENDING') AND j."nextAttemptAt" <= ${now} AND j."attempts" < ${MAX_ATTEMPTS}
              FOR UPDATE SKIP LOCKED
         )
         UPDATE "NotificationJob" j SET "status" = 'SENDING', "claimSeq" = j."claimSeq" + 1, "nextAttemptAt" = ${now} + make_interval(secs => ${CLAIM_LEASE_SEC})
           FROM locked, picked WHERE j."id" = locked."id" AND picked."id" = j."id"
         RETURNING ${jobCols('j')}, picked.pos AS "pos"`,
        rotate ? [channels, limit, reserve, opts.rotateAfter] : [channels, limit, reserve],
      );
      return rows.sort((a, b) => Number(a.pos) - Number(b.pos)).map(toJob);
    });
  }

  async beginSend(jobId: string, claimSeq: number): Promise<number | null> {
    const now = this.sql.now();
    const [r] = await this.sql.query(
      `UPDATE "NotificationJob" SET "attempts" = "attempts" + 1,
              "nextAttemptAt" = ${now} + make_interval(secs => ${RETRY_SQL}[LEAST(GREATEST("attempts" + 1, 1), ${RETRY_DELAYS_SEC.length})]),
              "dueAt" = ${now} + make_interval(secs => ${RETRY_SQL}[LEAST(GREATEST("attempts" + 1, 1), ${RETRY_DELAYS_SEC.length})])
        WHERE "id" = $1 AND "status" = 'SENDING' AND "claimSeq" = $2 RETURNING "attempts"`,
      [jobId, claimSeq],
    );
    return r ? (r.attempts as number) : null;
  }

  async releaseJob(jobId: string, claimSeq: number, opts: { notBefore?: Date; note?: string; event?: IncidentEventInput } = {}): Promise<boolean> {
    const run = async (q: SqlExecutor): Promise<boolean> => {
      const rows = await q.query(
        `UPDATE "NotificationJob" SET "status" = 'QUEUED',
                "dueAt" = CASE WHEN $3::timestamptz IS NULL THEN "dueAt" ELSE LEAST($3::timestamptz, ${this.sql.now()} + make_interval(secs => ${RELEASE_HOLD_MAX_SEC})) END,
                "nextAttemptAt" = CASE WHEN $3::timestamptz IS NULL THEN "dueAt" ELSE LEAST($3::timestamptz, ${this.sql.now()} + make_interval(secs => ${RELEASE_HOLD_MAX_SEC})) END,
                "lastError" = CASE WHEN $4::boolean THEN $5 ELSE "lastError" END
          WHERE "id" = $1 AND "status" = 'SENDING' AND "claimSeq" = $2 RETURNING "id"`,
        [jobId, claimSeq, iso(opts.notBefore), opts.note !== undefined, opts.note ?? null],
      );
      if (!rows.length) return false;
      if (opts.event) await this.insertEvents(q, [opts.event]);
      return true;
    };
    return opts.event ? this.tx(run) : run(this.sql);
  }

  async outboxBacklog(): Promise<{ dueUnattempted: number; dueSev1Unattempted: number; oldestDueAt: Date | null }> {
    const [r] = await this.sql.query(
      `SELECT count(*)::int AS "n", (count(*) FILTER (WHERE "payload"->>'severity' = 'SEV_1'))::int AS "sev1", min("dueAt") AS "oldest" FROM "NotificationJob"
        WHERE "status" IN ('QUEUED', 'SENDING') AND "nextAttemptAt" <= ${this.sql.now()} AND "attempts" = 0`,
    );
    return { dueUnattempted: r?.n ?? 0, dueSev1Unattempted: r?.sev1 ?? 0, oldestDueAt: d(r?.oldest) };
  }

  async findIncidentById(id: string): Promise<IncidentRow | null> {
    const [r] = await this.sql.query(`SELECT ${incidentCols()} FROM "Incident" WHERE "id" = $1`, [id]);
    return r ? toIncident(r) : null;
  }
  async getContact(id: string): Promise<Contact | null> {
    const [r] = await this.sql.query(`SELECT ${CONTACT_COLS} FROM "Contact" WHERE "id" = $1`, [id]);
    return r ? toContact(r) : null;
  }

  /**
   * The customer's own Slack channels at the incident's most specific level that has one (service › project ›
   * customer, R4-3), else the MSP default channel. Channel rows are read with the job's customer in the WHERE.
   * `NotificationChannel.conditions` is not evaluated yet (rows with conditions are used like rows without).
   */
  async slackDestinations(job: NotificationJob): Promise<{ channels: string[]; owner: 'CUSTOMER' | 'MSP' }> {
    const mspOf = async (): Promise<{ channels: string[]; owner: 'MSP' }> => {
      const [m] = await this.sql.query(`SELECT "defaultSlackChannelId" FROM "MspOrg" WHERE "id" = 'msp'`);
      return { channels: m?.defaultSlackChannelId ? [m.defaultSlackChannelId as string] : [], owner: 'MSP' };
    };
    if (job.targetRef === 'msp-default' || !job.customerId) return mspOf();
    const rows = await this.sql.query(
      `SELECT nc."scopeType", nc."slackChannelId" FROM "NotificationChannel" nc
         JOIN "Incident" i ON i."id" = $2 AND i."customerId" = $1
        WHERE nc."customerId" = $1 AND nc."kind" IN ('SLACK_BOT', 'SLACK_WEBHOOK') AND nc."enabled" AND nc."slackChannelId" IS NOT NULL
          AND ((nc."scopeType" = 'SERVICE' AND nc."scopeId" = i."serviceId") OR (nc."scopeType" = 'PROJECT' AND nc."scopeId" = i."projectId") OR (nc."scopeType" = 'CUSTOMER' AND nc."scopeId" = $1))
        ORDER BY nc."id"`,
      [job.customerId, job.incidentId],
    );
    for (const level of ['SERVICE', 'PROJECT', 'CUSTOMER']) {
      const own = rows.filter((r) => r.scopeType === level).map((r) => r.slackChannelId as string);
      if (own.length) return { channels: own, owner: 'CUSTOMER' };
    }
    return mspOf();
  }

  async completeJob(
    jobId: string, claimSeq: number,
    r: { status: 'SENT' | 'FAILED' | 'SKIPPED' | 'QUEUED'; providerMessageId?: string | null; error?: string | null; errorCode?: DeliveryReason | null },
    log?: DeliveryLog, event?: IncidentEventInput,
  ): Promise<boolean> {
    const hasError = r.error != null;
    const error = hasError ? (r.status === 'SKIPPED' ? r.error! : sanitizeProviderError(r.error)) : null;
    const run = async (q: SqlExecutor): Promise<boolean> => {
      const rows = await q.query(
        `UPDATE "NotificationJob" SET "status" = $3::"JobStatus", "providerMessageId" = COALESCE($4, "providerMessageId"),
                "lastError" = CASE WHEN $5::boolean THEN $6 WHEN $3 = 'SENT' THEN NULL ELSE "lastError" END
          WHERE "id" = $1 AND "status" = 'SENDING' AND "claimSeq" = $2 RETURNING "id"`,
        [jobId, claimSeq, r.status, r.providerMessageId || null, hasError, error],
      );
      if (!rows.length) return false; // the claim moved on: nothing is written (a SENT job can never go back to QUEUED)
      if (log) await insertLogs(q, [{ ...log, at: log.at.toISOString() }], null);
      if (event) await this.insertEvents(q, [event]);
      return true;
    };
    return log || event ? this.tx(run) : run(this.sql);
  }

  // ───────────────────────────── ⑤ heartbeat ─────────────────────────────

  /** Start and finish times are bounded by the store clock (R-2): a runner whose clock is ahead cannot make the heartbeat look fresh for longer. */
  async writeHeartbeat(hb: HeartbeatWrite): Promise<void> {
    const now = this.sql.now();
    await this.sql.query(
      `INSERT INTO "TickHeartbeat"("name", "lastStartedAt", "lastFinishedAt", "lastStatus", "lastDurationMs", "lastStats", "consecutiveFailures")
       VALUES ($1, CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE LEAST($2::timestamptz, ${now}) END, CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE LEAST($3::timestamptz, ${now}) END,
               $4::"TickStatus", $5, $6::jsonb, CASE WHEN $4 <> 'OK' THEN 1 ELSE 0 END)
       ON CONFLICT ("name") DO UPDATE SET "lastStartedAt" = EXCLUDED."lastStartedAt", "lastFinishedAt" = EXCLUDED."lastFinishedAt", "lastStatus" = EXCLUDED."lastStatus",
         "lastDurationMs" = EXCLUDED."lastDurationMs", "lastStats" = EXCLUDED."lastStats",
         "consecutiveFailures" = CASE WHEN EXCLUDED."lastStatus" <> 'OK' THEN "TickHeartbeat"."consecutiveFailures" + 1 ELSE 0 END`,
      [hb.name, iso(hb.lastStartedAt), iso(hb.lastFinishedAt), hb.lastStatus, Math.round(hb.lastDurationMs), js(hb.lastStats)],
    );
  }
  async readHeartbeats(): Promise<HeartbeatRow[]> {
    const rows = await this.sql.query(`SELECT * FROM "TickHeartbeat" WHERE "name" = ANY($1::text[]) ORDER BY "name"`, [[...TICK_JOBS]]);
    return rows.map((r) => ({
      name: r.name as TickJob, lastStartedAt: d(r.lastStartedAt), lastFinishedAt: d(r.lastFinishedAt), lastStatus: r.lastStatus ?? 'OK',
      lastDurationMs: r.lastDurationMs ?? 0, lastStats: r.lastStats ?? {}, consecutiveFailures: r.consecutiveFailures,
    }));
  }
}

export function toWindow(r: SqlRow): MaintenanceWindow {
  return { id: r.id, customerId: r.customerId ?? null, scopeType: r.scopeType, scopeId: r.scopeId ?? null, resourceType: r.resourceType ?? null, startsAt: dReq(r.startsAt), endsAt: dReq(r.endsAt), revokedAt: d(r.revokedAt) };
}

/**
 * NotificationLog rows (append-only). `at` null in a row → `nowSql` (the store clock).
 * R-9: `error` is masked HERE (`sanitizeProviderError`, the rule of `NotificationJob.lastError`), whatever the
 * caller did before — the table can never hold a provider's raw text. Masking twice only ever masks more.
 */
export async function insertLogs(tx: SqlExecutor, logs: Array<Record<string, unknown>>, nowSql: string | null): Promise<void> {
  const rows = logs.map((l) => ({ ...l, error: l.error == null ? null : sanitizeProviderError(l.error), id: newId('log') }));
  await tx.query(
    `INSERT INTO "NotificationLog"("id", "at", "customerId", "incidentId", "jobId", "channel", "status", "targetSummary", "escalationStep", "providerMessageId", "error",
       "attempt", "warnings", "errorCode", "targetKind", "contactId")
     SELECT t.x->>'id', COALESCE((t.x->>'at')::timestamptz, ${nowSql ?? 'now()'}), t.x->>'customerId', t.x->>'incidentId', t.x->>'jobId', (t.x->>'channel')::"NotificationChannelType",
            (t.x->>'status')::"LogStatus", t.x->>'targetSummary', (t.x->>'escalationStep')::int, t.x->>'providerMessageId', t.x->>'error', COALESCE((t.x->>'attempt')::int, 0),
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(NULLIF(t.x->'warnings', 'null'::jsonb), '[]'::jsonb))), (t.x->>'errorCode')::"DeliveryReason", (t.x->>'targetKind')::"DeliveryTargetKind",
            (SELECT c."id" FROM "Contact" c WHERE c."id" = t.x->>'contactId')
       FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(x, ord) ORDER BY t.ord`,
    [js(rows)],
  );
}

export async function insertAudit(tx: SqlExecutor, a: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO "AuditLog"("id", "at", "customerId", "actorType", "actorId", "action", "targetType", "targetId", "before", "after", "requestId")
     VALUES ($1, $2::timestamptz, $3, $4::"AuditActorType", $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)`,
    [newId('aud'), iso(a.at), a.customerId, a.actorType, a.actorId, a.action, a.targetType, a.targetId, js(a.before), js(a.after), a.requestId ?? null],
  );
}
