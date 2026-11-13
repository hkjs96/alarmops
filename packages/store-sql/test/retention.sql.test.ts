/**
 * D-45 on Postgres: what the memory store cannot show — the rows that stay (CloudAccount, scrubbed User), the secrets
 * that go, the guard inside each statement, the chunking/partial path and the RLS of the new tables.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SqlApiStore } from '../src/index.js';
import { openTestDb, type TestDb } from './db.js';

let db: TestDb;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

const NOW = new Date('2027-01-10T00:00:00Z');
const q = (t: string, p?: unknown[]) => db.client.query(t, p);

async function seed(opts: { hold?: boolean } = {}): Promise<SqlApiStore> {
  await db.reset();
  for (const [id, status] of [['cus_t', 'TERMINATED'], ['cus_o', 'TERMINATED']] as const) {
    await q(`INSERT INTO "Customer"("id", "name", "slug", "status", "statusChangedAt", "legalHold", "legalHoldAt", "legalHoldByUserId", "legalHoldReason", "updatedAt") VALUES ($1, $1, replace($1, '_', '-'), $2::"CustomerStatus", '2026-12-01T00:00:00Z', $3, $4::timestamptz, $5, $6, now())`,
      [id, status, id === 'cus_t' && !!opts.hold, id === 'cus_t' && opts.hold ? NOW.toISOString() : null, id === 'cus_t' && opts.hold ? 'u1' : null, id === 'cus_t' && opts.hold ? 'dispute' : null]);
    await q(`INSERT INTO "CloudAccount"("id", "customerId", "awsAccountId", "externalId", "readerRoleArn", "eventForwarderRoleArn", "alarmWriterRoleArn", "alarmWriterEnabled", "updatedAt") VALUES ($1, $2, $3, $4, 'arn:aws:iam::1:role/r', 'arn:aws:iam::1:role/f', 'arn:aws:iam::1:role/w', true, now())`,
      [`ca_${id}`, id, id === 'cus_t' ? '111111111111' : '222222222222', `ext_${id}`]);
    await q(`INSERT INTO "IntegrationSource"("id", "customerId", "kind", "name", "tokenHash", "tokenPrefix") VALUES ($1, $2, 'GRAFANA', 'g', $3, 'abcd')`, [`src_${id}`, id, `hash_${id}`]);
    await q(`INSERT INTO "Resource"("id", "customerId", "cloudAccountId", "region", "resourceType", "resourceArn", "resourceKey", "lastSeenAt", "updatedAt") VALUES ($1, $2, $3, 'ap-northeast-2', 'ec2', 'arn:x', $1, now(), now())`, [`res_${id}`, id, `ca_${id}`]);
    await q(`INSERT INTO "User"("id", "email", "name", "customerId", "status", "updatedAt") VALUES ($1, $2, 'Portal Person', $3, 'ACTIVE', now()), ($4, $5, 'Plain Person', $3, 'ACTIVE', now())`, [`usr_rev_${id}`, `rev_${id}@x.test`, id, `usr_plain_${id}`, `plain_${id}@x.test`]);
    await q(`INSERT INTO "ContactRevealLog"("id", "actorUserId", "actorRole", "contactId", "contactName", "customerId", "channel", "mode") VALUES ($1, $2, 'VIEWER', 'gone_contact', 'Secret Name', $3, 'PHONE', 'NORMAL')`, [`rev_${id}`, `usr_rev_${id}`, id]);
    // three incidents: acked by u1, resolved by u2, never touched; one delivered page
    for (let i = 0; i < 3; i++) {
      await q(`INSERT INTO "Incident"("id", "axis", "customerId", "title", "severity", "triggeredAt", "acknowledgedBy", "resolvedBy") VALUES ($1, $1, $2, 'payments down', 'SEV_1', $3::timestamptz, $4, $5)`,
        [`inc_${id}_${i}`, id, new Date(NOW.getTime() - (3 - i) * 3600_000).toISOString(), i < 2 ? (i === 0 ? 'usr_a' : 'usr_b') : null, i === 1 ? 'usr_a' : null]);
    }
    await q(`INSERT INTO "NotificationLog"("id", "customerId", "incidentId", "channel", "status", "targetSummary", "targetKind") VALUES ($1, $2, $3, 'SMS', 'SENT', 'x', 'STAFF'), ($4, $2, $5, 'SMS', 'FAILED', 'x', 'STAFF')`,
      [`log_a_${id}`, id, `inc_${id}_0`, `log_b_${id}`, `inc_${id}_1`]);
  }
  return new SqlApiStore(db.client);
}
const stage = (s: SqlApiStore, cid: string, st: 'CONNECTIONS' | 'RETURN_PERIOD' | 'AUDIT_EXPIRY' | 'SLA_EXPIRY', deadlineMs = Date.now() + 60_000) => s.runRetentionStage(cid, st, { deadlineMs, now: NOW });

describe('retention on Postgres (D-45)', () => {
  let store: SqlApiStore;
  beforeEach(async () => { store = await seed(); });

  it('CONNECTIONS: secrets are emptied and the account is disabled, but the CloudAccount row stays so residual events still map to the customer', async () => {
    const r = await stage(store, 'cus_t', 'CONNECTIONS');
    expect(r.counts).toMatchObject({ CloudAccount: 1, IntegrationSource: 1, Resource: 1 });
    const [a] = await q(`SELECT * FROM "CloudAccount" WHERE "id" = 'ca_cus_t'`);
    expect(a).toMatchObject({ customerId: 'cus_t', awsAccountId: '111111111111', readerRoleArn: '', eventForwarderRoleArn: '', alarmWriterRoleArn: null, externalId: 'purged-ca_cus_t', disabled: true, alarmWriterEnabled: false });
    expect(a!.connectionPurgedAt).toBeInstanceOf(Date);
    expect((await q(`SELECT "tokenHash", "tokenPrefix", "enabled" FROM "IntegrationSource" WHERE "id" = 'src_cus_t'`))[0]).toEqual({ tokenHash: null, tokenPrefix: null, enabled: false });
    expect(await q(`SELECT 1 FROM "Resource" WHERE "customerId" = 'cus_t'`)).toEqual([]);
    // the other terminated customer: untouched
    expect((await q(`SELECT "readerRoleArn", "disabled" FROM "CloudAccount" WHERE "id" = 'ca_cus_o'`))[0]).toEqual({ readerRoleArn: 'arn:aws:iam::1:role/r', disabled: false });
    expect((await q(`SELECT "tokenHash" FROM "IntegrationSource" WHERE "id" = 'src_cus_o'`))[0]!.tokenHash).toBe('hash_cus_o');
    expect(await q(`SELECT 1 FROM "Resource" WHERE "customerId" = 'cus_o'`)).toHaveLength(1);
    // rerun: nothing changes, no second log row
    expect((await stage(store, 'cus_t', 'CONNECTIONS')).counts).toEqual({});
    expect(await store.purgeLog('cus_t')).toHaveLength(1);
  });

  it('RETURN_PERIOD: SLA record keeps ids, times, severity and paging outcome; people become Responder N; a user a reveal record points to is scrubbed, not deleted', async () => {
    const r = await stage(store, 'cus_t', 'RETURN_PERIOD');
    expect(r.counts).toMatchObject({ Incident: 3, NotificationLog: 2, User: 1, 'User.scrubbed': 1, 'ContactRevealLog.masked': 1 });
    const inc = await q(`SELECT * FROM "Incident" WHERE "customerId" = 'cus_t' ORDER BY "triggeredAt"`);
    expect(inc.map((i) => [i.title, i.acknowledgedBy, i.resolvedBy, i.pagingOutcome, i.severity])).toEqual([
      ['[purged]', 'Responder 1', null, 'DELIVERED', 'SEV_1'],
      ['[purged]', 'Responder 2', 'Responder 1', 'FAILED', 'SEV_1'],
      ['[purged]', null, null, 'NOT_PAGED', 'SEV_1'],
    ]);
    expect(inc.every((i) => i.purgedAt instanceof Date && i.axis === `purged:${i.id}` && i.isMergeTarget === false)).toBe(true);
    const users = await q(`SELECT "id", "email", "name", "status" FROM "User" WHERE "customerId" = 'cus_t'`);
    expect(users).toEqual([{ id: 'usr_rev_cus_t', email: 'purged-usr_rev_cus_t@invalid.invalid', name: 'Removed user', status: 'DISABLED' }]);
    expect((await q(`SELECT "contactName" FROM "ContactRevealLog" WHERE "customerId" = 'cus_t'`))[0]!.contactName).toBe('[purged]');
    // the other customer: everything as it was
    expect((await q(`SELECT "title", "purgedAt" FROM "Incident" WHERE "customerId" = 'cus_o' ORDER BY "id"`)).map((i) => i.title)).toEqual(['payments down', 'payments down', 'payments down']);
    expect(await q(`SELECT 1 FROM "NotificationLog" WHERE "customerId" = 'cus_o'`)).toHaveLength(2);
    expect(await q(`SELECT 1 FROM "User" WHERE "customerId" = 'cus_o'`)).toHaveLength(2);
    expect((await q(`SELECT "contactName" FROM "ContactRevealLog" WHERE "customerId" = 'cus_o'`))[0]!.contactName).toBe('Secret Name');
    // rerun is a no-op
    expect((await stage(store, 'cus_t', 'RETURN_PERIOD')).counts).toEqual({});
  });

  it('every stage is skipped for a customer on legal hold and for one that is not TERMINATED (the guard sits in the statements)', async () => {
    store = await seed({ hold: true });
    for (const st of ['CONNECTIONS', 'RETURN_PERIOD', 'AUDIT_EXPIRY', 'SLA_EXPIRY'] as const) expect(await stage(store, 'cus_t', st)).toEqual({ counts: {}, partial: false, skipped: true });
    expect(await q(`SELECT 1 FROM "Incident" WHERE "customerId" = 'cus_t'`)).toHaveLength(3);
    expect(await store.retentionCandidates(10)).toMatchObject([{ customerId: 'cus_o' }]); // the held customer is not even a candidate
    await q(`UPDATE "Customer" SET "status" = 'ACTIVE' WHERE "id" = 'cus_o'`);
    expect((await stage(store, 'cus_o', 'SLA_EXPIRY')).skipped).toBe(true);
    expect(await q(`SELECT 1 FROM "Incident" WHERE "customerId" = 'cus_o'`)).toHaveLength(3);
  });

  it('a stage past its deadline stops before the next chunk and reports partial; the next call finishes it', async () => {
    // 2 chunks of 1000 rows; the deadline is already past after the first chunk.
    await q(`INSERT INTO "AuditLog"("id", "customerId", "actorType", "action", "targetType") SELECT 'aud_' || g, 'cus_t', 'USER', 'x', 'Contact' FROM generate_series(1, 1500) g`);
    const r = await stage(store, 'cus_t', 'AUDIT_EXPIRY', Date.now() - 1);
    expect(r).toMatchObject({ partial: true, counts: {} });
    const full = await stage(store, 'cus_t', 'AUDIT_EXPIRY');
    expect(full).toMatchObject({ partial: false, counts: { AuditLog: 1500, ContactRevealLog: 1 } });
  });

  it('AUDIT_EXPIRY keeps CustomerStatus and Responders rows; SLA_EXPIRY removes the incidents', async () => {
    await q(`INSERT INTO "AuditLog"("id", "customerId", "actorType", "action", "targetType") VALUES ('a1', 'cus_t', 'USER', 'x', 'CustomerStatus'), ('a2', 'cus_t', 'USER', 'x', 'Responders'), ('a3', 'cus_t', 'USER', 'x', 'Contact'), ('a4', 'cus_t', 'USER', 'x', NULL), ('a5', 'cus_o', 'USER', 'x', 'Contact')`);
    await stage(store, 'cus_t', 'AUDIT_EXPIRY');
    expect((await q(`SELECT "id" FROM "AuditLog" ORDER BY "id"`)).map((r) => r.id)).toEqual(['a1', 'a2', 'a5']);
    expect(await q(`SELECT 1 FROM "ContactRevealLog" WHERE "customerId" = 'cus_t'`)).toEqual([]);
    expect(await q(`SELECT 1 FROM "ContactRevealLog" WHERE "customerId" = 'cus_o'`)).toHaveLength(1);
    await stage(store, 'cus_t', 'SLA_EXPIRY');
    expect(await q(`SELECT 1 FROM "Incident" WHERE "customerId" = 'cus_t'`)).toEqual([]);
    expect(await q(`SELECT 1 FROM "Incident" WHERE "customerId" = 'cus_o'`)).toHaveLength(3);
  });

  it('migration constraints: a purged incident has an outcome; a hold needs reason, time and author; RLS is on for the new tables', async () => {
    await expect(q(`UPDATE "Incident" SET "purgedAt" = now() WHERE "id" = 'inc_cus_t_0'`)).rejects.toThrow(/Incident_purged_outcome_chk/);
    await expect(q(`UPDATE "Customer" SET "legalHold" = true WHERE "id" = 'cus_t'`)).rejects.toThrow(/Customer_legal_hold_chk/);
    const rls = await q(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies FROM pg_class c WHERE c.relname IN ('RetentionPurgeLog', 'RetentionClaim') AND c.relkind = 'r' ORDER BY 1`);
    expect(rls).toEqual([{ relname: 'RetentionClaim', relrowsecurity: true, relforcerowsecurity: false, policies: 0 }, { relname: 'RetentionPurgeLog', relrowsecurity: true, relforcerowsecurity: false, policies: 0 }]);
  });
});
