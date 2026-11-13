/**
 * The contract fixture (packages/core/test/contract/fixture.ts) on Postgres: loads a seeded MemoryTickStore /
 * MemoryApiStore into the real tables and reads them back. Seeding writes rows the way ingest and the admin
 * screens will (Alert + RawEvent rows for group members, NotificationChannel rows for Slack channels, …).
 */
import type { Contact, GroupMember, GroupRow, MemoryTickStore, NotificationJob } from '@alarmops/core';
import type { MemoryApiStore } from '@alarmops/api';
import type { StoreFixture } from '../../core/test/contract/fixture.js';
import { SqlApiStore, tracked, withClock, type SqlClient } from '../src/index.js';
import { GROUP_COLS, incidentCols, iso, jobCols, js, toEvent, toGroup, toIncident, toJob, toLog, d, dReq } from '../src/rows.js';
import type { TestDb } from './db.js';

export interface SqlFixture extends StoreFixture<SqlApiStore> {
  /** The client the store uses (tracked, on the fixture's clock) — for assertions on the tables. */
  sql: SqlClient;
  /** Statements sent so far. */
  statements(): number;
}

const arr = (v: unknown[]): string => JSON.stringify(v);

export async function sqlFixture(db: TestDb, seed: MemoryTickStore): Promise<SqlFixture> {
  await db.reset();
  let clock: () => Date = () => new Date();
  const counted = tracked(db.client);
  const sql = withClock(counted, () => clock());
  const q = (text: string, params?: unknown[]) => sql.query(text, params);
  const store = new SqlApiStore(sql);

  const addContact = async (c: Contact): Promise<void> => {
    await q(
      `INSERT INTO "Contact"("id", "kind", "customerId", "name", "email", "phone", "slackUserId", "emailVerifiedAt", "phoneVerifiedAt", "slackVerifiedAt", "active", "updatedAt")
       VALUES ($1, $2::"ContactKind", $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11, now())`,
      [c.id, c.kind, c.customerId, c.name, c.email ?? null, c.phone ?? null, c.slackUserId ?? null, iso(c.emailVerifiedAt ?? null), iso(c.phoneVerifiedAt ?? null), iso(c.slackVerifiedAt ?? null), c.active]);
  };
  const addGroup = async (g: GroupRow, members: GroupMember[]): Promise<void> => {
    await q(
      `INSERT INTO "AlertGroup"("id", "groupKey", "customerId", "severity", "status", "openedAt", "groupWaitSec", "closeAt", "closedAt", "pauseUntil", "staleAfter", "deliveredAt", "version")
       VALUES ($1, $2, $3, $4::"Severity", $5::"GroupStatus", $6::timestamptz, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::timestamptz, $13)`,
      [g.id, g.groupKey, g.customerId, g.severity, g.status, iso(g.openedAt), g.groupWaitSec, iso(g.closeAt), iso(g.closedAt ?? null), iso(g.pauseUntil), iso(g.staleAfter), iso(g.deliveredAt), g.version]);
    let n = 0;
    for (const m of members) {
      const open = seed.episodes.get(m.alertId) ?? m.episodeOpen;
      await q(
        `INSERT INTO "Alert"("id", "fingerprint", "fingerprintVersion", "customerId", "source", "awsAccountId", "resourceType", "title", "status", "severity", "episodeOpen", "firstSeenAt", "lastEventAt")
         VALUES ($1, $2, 1, $3, $4::"SourceKind", $5, $6, $7, $8::"AlertStatus", $9::"Severity", $10, $11::timestamptz, $11::timestamptz) ON CONFLICT ("id") DO NOTHING`,
        [m.alertId, m.fingerprint, g.customerId, m.source ?? 'CLOUDWATCH', m.awsAccountId, m.resourceType, m.title, open ? 'FIRING' : 'RESOLVED', m.severity, open, iso(g.openedAt)]);
      for (let k = 0; k < Math.max(1, m.eventCount); k++, n++) {
        const t = new Date(g.openedAt.getTime() + n);
        await q(
          `INSERT INTO "RawEvent"("id", "dedupKey", "customerId", "source", "awsAccountId", "fingerprint", "fingerprintVersion", "state", "severity", "occurredAt", "receivedAt", "decision", "decisionReason", "groupId", "alertId", "raw")
           VALUES ($1, $1, $2, $3::"SourceKind", $4, $5, 1, 'FIRING', $6::"Severity", $7::timestamptz, $7::timestamptz, $8::"Decision", 'seed', $9, $10, '{}'::jsonb)`,
          [`${g.id}:${m.alertId}:${k}`, g.customerId, m.source ?? 'CLOUDWATCH', m.awsAccountId, m.fingerprint, m.severity, iso(t), m.decision, g.id, m.alertId]);
      }
    }
  };
  const putJob = async (j: NotificationJob): Promise<void> => {
    await q(
      `INSERT INTO "NotificationJob"("id", "idempotencyKey", "customerId", "incidentId", "purpose", "channel", "targetRef", "status", "attempts", "nextAttemptAt", "lastError", "payload",
         "stepIndex", "repeat", "contactId", "contactName", "claimSeq", "dueAt", "providerMessageId", "createdAt")
       VALUES ($1, $2, $3, $4, $5::"NotificationPurpose", $6::"NotificationChannelType", $7, $8::"JobStatus", $9, $10::timestamptz, $11, $12::jsonb, $13, $14,
         (SELECT c."id" FROM "Contact" c WHERE c."id" = $15), $16, $17, $18::timestamptz, $19, $20::timestamptz)`,
      [j.id, j.idempotencyKey, j.customerId, j.incidentId, j.purpose, j.channel, j.targetRef, j.status, j.attempts, iso(j.nextAttemptAt), j.lastError, js(j.payload), j.stepIndex, j.repeat,
        j.contactId, j.contactName, j.claimSeq, iso(j.dueAt), j.providerMessageId, iso(j.createdAt)]);
  };
  const addWindow: SqlFixture['addWindow'] = async (w) => {
    await q(
      `INSERT INTO "MaintenanceWindow"("id", "customerId", "scopeType", "scopeId", "resourceType", "startsAt", "endsAt", "reason", "createdBy", "revokedAt")
       VALUES ($1, $2, $3::"MaintenanceScope", $4, $5, $6::timestamptz, $7::timestamptz, 'test', 'seed', $8::timestamptz)`,
      [w.id, w.customerId, w.scopeType, w.scopeId, w.resourceType ?? null, iso(w.startsAt), iso(w.endsAt), iso(w.revokedAt ?? null)]);
  };

  // ── load the seed ──
  const api = seed as Partial<MemoryApiStore> & MemoryTickStore;
  const msp = seed.slackChannels.get('msp') ?? [];
  await q(`INSERT INTO "MspOrg"("id", "name", "defaultSlackChannelId", "updatedAt") VALUES ('msp', 'Test MSP', $1, now())`, [msp[0] ?? null]);
  const p = seed.policy;
  await q(
    `INSERT INTO "SuppressionPolicy"("id", "repeatIntervalSec", "flappingPerDay", "flappingWindowDays", "flappingQuarantineSec", "groupWaitSec", "autoPauseSec", "renotifyAfterSec", "incidentMergeMaxSec", "updatedAt")
     VALUES ('global', $1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())`,
    [p.repeatIntervalSec, p.flappingPerDay, p.flappingWindowDays, p.flappingQuarantineSec, p.groupWaitSec, js(p.autoPauseSec), p.renotifyAfterSec, p.incidentMergeMaxSec]);
  let order = 0;
  for (const c of seed.customers.values()) await q(`INSERT INTO "Customer"("id", "name", "slug", "status", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4::"CustomerStatus", now() + make_interval(secs => $5), now())`, [c.id, c.name, c.slug, c.status ?? 'ACTIVE', order++]);
  for (const x of seed.projects.values()) await q(`INSERT INTO "Project"("id", "customerId", "name", "slug") VALUES ($1, $2, $3, $4)`, [x.id, x.customerId, x.name, x.slug]);
  for (const x of seed.services.values()) await q(`INSERT INTO "Service"("id", "customerId", "projectId", "name", "slug") VALUES ($1, $2, $3, $4, $5)`, [x.id, x.customerId, x.projectId, x.name, x.slug]);
  const accountRow = async (id: string, customerId: string, serviceId: string | null, awsAccountId: string): Promise<void> => {
    await q(
      `INSERT INTO "CloudAccount"("id", "customerId", "serviceId", "awsAccountId", "externalId", "readerRoleArn", "eventForwarderRoleArn", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'arn:reader', 'arn:forwarder', now())`,
      [id, customerId, serviceId, awsAccountId, `ext-${id}`]);
  };
  for (const a of seed.accounts.values()) await accountRow(`ca_${a.awsAccountId}`, a.customerId, a.serviceId, a.awsAccountId);
  for (const c of seed.contacts.values()) await addContact(c);
  for (const [i, r] of seed.responders.entries()) {
    await q(`INSERT INTO "Responder"("customerId", "contactId", "role", "order") VALUES ($1, $2, $3::"ResponderRole", $4)`, [r.customerId, r.contactId, r.role, typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : 0]);
    void i;
  }
  for (const r of seed.rotations.values()) {
    await q(`INSERT INTO "Rotation"("id", "scope", "customerId", "name", "cadence", "handoverDow", "handoverMin", "anchorAt") VALUES ($1, $2::"RotationScope", $3, $4, $5::"Cadence", 1, 0, $6::timestamptz)`, [r.id, r.scope, r.customerId, r.name, r.cadence, iso(r.anchorAt)]);
    for (const m of r.members) await q(`INSERT INTO "RotationMember"("rotationId", "contactId", "order") VALUES ($1, $2, $3)`, [r.id, m.contactId, m.order]);
  }
  for (const [i, o] of seed.overrides.entries()) {
    await q(`INSERT INTO "Override"("id", "rotationId", "contactId", "startAt", "endAt", "createdBy", "kind", "status") VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, 'seed', 'COVER', $6::"OverrideStatus")`, [`ov_${i}`, o.rotationId, o.contactId, iso(o.startAt), iso(o.endAt), o.status]);
  }
  for (const [i, l] of seed.leaves.entries()) {
    await q(`INSERT INTO "Leave"("id", "contactId", "replacementId", "startDate", "endDate", "createdBy", "cancelledAt") VALUES ($1, $2, $3, $4::date, $5::date, 'seed', $6::timestamptz)`, [`lv_${i}`, l.contactId, l.replacementId, l.startDate, l.endDate, iso(l.cancelledAt ?? null)]);
  }
  for (const c of seed.configs) {
    await q(
      `INSERT INTO "PagingConfig"("id", "customerId", "scopeType", "scopeId", "style", "plan", "edited", "repeatCount", "renotifyAfterAckSec", "version", "updatedAt")
       VALUES ($1, $2, $3::"ScopeType", $4, $5::"PagingStyle", $6::"PagingPlan", $7, $8, $9, $10, now())`,
      [c.id, c.customerId, c.scopeType, c.scopeId, c.style, c.plan, c.edited, c.repeatCount, c.renotifyAfterAckSec ?? null, c.version]);
    for (const s of c.steps) {
      await q(
        `INSERT INTO "EscalationStep"("id", "pagingConfigId", "index", "atMin", "targetType", "targetId", "channels", "advanceOnAllFail")
         VALUES ($1, $2, $3, $4, $5::"StepTargetType", $6, ARRAY(SELECT jsonb_array_elements_text($7::jsonb)), $8)`,
        [`${c.id}_s${s.index}`, c.id, s.index, s.atMin, s.targetType, s.targetId, arr(s.channels), s.advanceOnAllFail === true]);
    }
  }
  for (const w of seed.windows) await addWindow(w);
  const verified = api.verifiedSlack ?? new Set<string>();
  for (const [key, ids] of seed.slackChannels) {
    if (!key.startsWith('customer:')) continue;
    const cid = key.slice('customer:'.length);
    for (const [i, ch] of ids.entries()) {
      await q(`INSERT INTO "NotificationChannel"("id", "customerId", "scopeType", "scopeId", "kind", "slackChannelId", "verifiedAt", "enabled") VALUES ($1, $2, 'CUSTOMER', $2, 'SLACK_BOT', $3, $4::timestamptz, true)`,
        [`nc_${cid}_${i}`, cid, ch, verified.has(cid) ? '2026-10-01T00:00:00Z' : null]);
    }
  }
  for (const [gid, g] of seed.groups) await addGroup(g, seed.members.get(gid) ?? []);
  // API-side seed (MemoryApiStore)
  for (const u of api.users?.values() ?? []) {
    // as stored: never derived from the contact (sessionPrincipal fails closed on a mismatch, memory and SQL alike)
    const customerId = u.customerId ?? null;
    await q(`INSERT INTO "User"("id", "email", "name", "status", "customerId", "role", "updatedAt") VALUES ($1, $2, $3, $4::"UserStatus", $5, $6::"ConsoleRole", now())`,
      [u.id, u.email ?? `${u.id}@example.test`, u.name, u.status ?? 'ACTIVE', customerId, u.role ?? (customerId ? 'VIEWER' : 'OPERATOR')]);
    if (u.contactId) await q(`UPDATE "Contact" SET "userId" = $1 WHERE "id" = $2`, [u.id, u.contactId]);
  }
  for (const [i, s] of (api.contactScopes ?? []).entries()) {
    await q(`INSERT INTO "ContactScope"("id", "customerId", "contactId", "scopeType", "scopeId", "role", "createdAt") VALUES ($1, $2, $3, $4::"ScopeType", $5, $6::"ContactScopeRole", now() + make_interval(secs => $7))`, [`cs_${i}`, s.customerId, s.contactId, s.scopeType, s.scopeId, s.role, i]);
  }
  for (const r of api.resources?.values() ?? []) {
    const known = [...seed.accounts.values()].find((a) => a.customerId === r.customerId && a.serviceId === r.serviceId);
    let accountId = known ? `ca_${known.awsAccountId}` : `ca_res_${r.id}`;
    if (!known) await accountRow(accountId, r.customerId, r.serviceId, String(700000000000 + Math.abs(hash(r.id)) % 99999999999).slice(0, 12));
    accountId = accountId; // eslint-disable-line no-self-assign
    await q(`INSERT INTO "Resource"("id", "customerId", "cloudAccountId", "region", "resourceType", "resourceArn", "resourceKey", "name", "lastSeenAt", "updatedAt") VALUES ($1, $2, $3, 'ap-northeast-2', 'EC2', $4, $1, $5, now(), now())`,
      [r.id, r.customerId, accountId, `arn:aws:ec2:::${r.id}`, r.name]);
  }

  return {
    kind: 'sql', label: db.label, repo: store, concurrent: db.concurrent, sql,
    statements: () => counted.statements,
    secondRunner: () => new SqlApiStore(sql),
    setClock: (c) => { clock = c; },
    busy: () => counted.busy(),
    addContact, addGroup, addWindow, putJob,
    async addResidual(customerId, sourceKey, count, lastAt) {
      await q(`INSERT INTO "OffboardResidual"("customerId", "sourceKey", "firstAt", "lastAt", "count") VALUES ($1, $2, $3::timestamptz, $3::timestamptz, $4)`, [customerId, sourceKey, lastAt.toISOString(), count]);
    },
    async setCustomerStatus(customerId, status) { await q(`UPDATE "Customer" SET "status" = $2::"CustomerStatus" WHERE "id" = $1`, [customerId, status]); },
    async patchContact(id, patch) {
      for (const [k, v] of Object.entries(patch)) await q(`UPDATE "Contact" SET "${k}" = ${k.endsWith('At') ? '$2::timestamptz' : k === 'kind' ? '$2::"ContactKind"' : '$2'} WHERE "id" = $1`, [id, v instanceof Date ? v.toISOString() : v]);
    },
    async setEpisode(alertId, open) { await q(`UPDATE "Alert" SET "episodeOpen" = $2, "status" = CASE WHEN $2 THEN 'FIRING'::"AlertStatus" ELSE 'RESOLVED'::"AlertStatus" END WHERE "id" = $1`, [alertId, open]); },
    async revokeWindow(id, at) { await q(`UPDATE "MaintenanceWindow" SET "revokedAt" = $2::timestamptz, "revokedBy" = 'seed' WHERE "id" = $1`, [id, iso(at)]); },
    async patchJob(key, patch) {
      for (const [k, v] of Object.entries(patch)) await q(`UPDATE "NotificationJob" SET "${k}" = ${k.endsWith('At') ? '$2::timestamptz' : k === 'status' ? '$2::"JobStatus"' : '$2'} WHERE "idempotencyKey" = $1`, [key, v instanceof Date ? v.toISOString() : v]);
    },
    async clearTickClaims() { await q(`DELETE FROM "TickClaim"`); },
    async incidents() { return (await q(`SELECT ${incidentCols()} FROM "Incident" ORDER BY "number"`)).map(toIncident); },
    async jobs(incidentId) { return (await q(`SELECT ${jobCols()} FROM "NotificationJob" WHERE $1::text IS NULL OR "incidentId" = $1 ORDER BY "seq"`, [incidentId ?? null])).map(toJob); },
    async events(incidentId) { return (await q(`SELECT * FROM "IncidentEvent" WHERE "incidentId" = $1 ORDER BY "seq"`, [incidentId])).map(toEvent); },
    async logs() { return (await q(`SELECT * FROM "NotificationLog" ORDER BY "seq"`)).map(toLog); },
    async group(id) { const [r] = await q(`SELECT ${GROUP_COLS} FROM "AlertGroup" WHERE "id" = $1`, [id]); return r ? toGroup(r) : null; },
    async alertAcked(alertId) { const [r] = await q(`SELECT "status" FROM "Alert" WHERE "id" = $1`, [alertId]); return r?.status === 'ACKNOWLEDGED'; },
    async resolutions() {
      return (await q(`SELECT * FROM "Resolution" ORDER BY "resolvedAt", "id"`)).map((r) => ({ incidentId: r.incidentId, customerId: r.customerId ?? null, via: r.via, kind: r.kind ?? null, note: r.note ?? null,
        serviceId: r.serviceId ?? null, durationSec: r.durationSec, escalationStep: r.escalationStep, resolvedBy: r.resolvedBy ?? null, resolvedAt: dReq(r.resolvedAt) }));
    },
    async audits() {
      return (await q(`SELECT * FROM "AuditLog" ORDER BY "at", "id"`)).map((r) => ({ at: dReq(r.at), customerId: r.customerId ?? null, actorType: r.actorType, actorId: r.actorId ?? null, action: r.action,
        targetType: r.targetType, targetId: r.targetId, before: r.before ?? undefined, after: r.after ?? undefined, requestId: r.requestId ?? null }));
    },
    async close() { void d; },
  };
}

function hash(s: string): number { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
