/**
 * D-45 on Postgres: what the memory store cannot show — the rows that stay (CloudAccount, scrubbed User), the secrets
 * that go, the guard inside each statement, the chunking/partial path and the RLS of the new tables.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SqlApiStore, withClock } from '../src/index.js';
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
  // The store's clock is the test's NOW: stage due times are decided by the database clock inside the statements.
  return new SqlApiStore(withClock(db.client, () => NOW));
}
const DAYS = { CONNECTIONS: null, RETURN_PERIOD: 30, AUDIT_EXPIRY: 730, SLA_EXPIRY: 1826 } as const;
const stage = (s: SqlApiStore, cid: string, st: keyof typeof DAYS, deadlineMs = Date.now() + 60_000, days: number | null = DAYS[st]) => s.runRetentionStage(cid, st, { deadlineMs, now: NOW, days });

describe('retention on Postgres (D-45)', () => {
  let store: SqlApiStore;
  beforeEach(async () => { store = await seed(); });

  it('CONNECTIONS: secrets are emptied and the account is disabled, but the CloudAccount row stays so residual events still map to the customer', async () => {
    await q(`INSERT INTO "CustomerOffboarding"("id", "customerId", "startedByUserId", "reason", "steps", "completedAt") VALUES ('off_t', 'cus_t', 'u', 'r', '{}'::jsonb, now())`);
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
    const r = await stage(store, 'cus_t', 'AUDIT_EXPIRY', Date.now() - 1, 30);
    expect(r).toMatchObject({ partial: true, counts: {} });
    const full = await stage(store, 'cus_t', 'AUDIT_EXPIRY', undefined, 30);
    expect(full).toMatchObject({ partial: false, counts: { AuditLog: 1500, ContactRevealLog: 1 } });
  });

  it('AUDIT_EXPIRY keeps CustomerStatus and Responders rows; SLA_EXPIRY removes the incidents', async () => {
    await q(`INSERT INTO "AuditLog"("id", "customerId", "actorType", "action", "targetType") VALUES ('a1', 'cus_t', 'USER', 'x', 'CustomerStatus'), ('a2', 'cus_t', 'USER', 'x', 'Responders'), ('a3', 'cus_t', 'USER', 'x', 'Contact'), ('a4', 'cus_t', 'USER', 'x', NULL), ('a5', 'cus_o', 'USER', 'x', 'Contact')`);
    await stage(store, 'cus_t', 'AUDIT_EXPIRY', undefined, 30);
    expect((await q(`SELECT "id" FROM "AuditLog" ORDER BY "id"`)).map((r) => r.id)).toEqual(['a1', 'a2', 'a5']);
    expect(await q(`SELECT 1 FROM "ContactRevealLog" WHERE "customerId" = 'cus_t'`)).toEqual([]);
    expect(await q(`SELECT 1 FROM "ContactRevealLog" WHERE "customerId" = 'cus_o'`)).toHaveLength(1);
    await stage(store, 'cus_t', 'SLA_EXPIRY', undefined, 30);
    expect(await q(`SELECT 1 FROM "Incident" WHERE "customerId" = 'cus_t'`)).toEqual([]);
    expect(await q(`SELECT 1 FROM "Incident" WHERE "customerId" = 'cus_o'`)).toHaveLength(3);
  });

  it('migration constraints: a purged incident has an outcome; a hold needs reason, time and author; RLS is on for the new tables', async () => {
    await expect(q(`UPDATE "Incident" SET "purgedAt" = now() WHERE "id" = 'inc_cus_t_0'`)).rejects.toThrow(/Incident_purged_outcome_chk/);
    await expect(q(`UPDATE "Customer" SET "legalHold" = true WHERE "id" = 'cus_t'`)).rejects.toThrow(/Customer_legal_hold_chk/);
    const rls = await q(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies FROM pg_class c WHERE c.relname IN ('RetentionPurgeLog', 'RetentionClaim') AND c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace ORDER BY 1`);
    expect(rls).toEqual([{ relname: 'RetentionClaim', relrowsecurity: true, relforcerowsecurity: false, policies: 0 }, { relname: 'RetentionPurgeLog', relrowsecurity: true, relforcerowsecurity: false, policies: 0 }]);
  });

  it('R-2: a stage whose period has not passed on the DATABASE clock does nothing, whatever the runner says', async () => {
    // statusChangedAt is 2026-12-01 and the store clock is 2027-01-10 (40 days): 100 000 days is not due, 30 is.
    expect((await stage(store, 'cus_t', 'RETURN_PERIOD', Date.now() + 60_000, 100_000)).counts).toEqual({});
    expect((await stage(store, 'cus_t', 'AUDIT_EXPIRY')).counts).toEqual({}); // 730 days: not due
    expect((await stage(store, 'cus_t', 'SLA_EXPIRY')).counts).toEqual({});
    expect(await q(`SELECT 1 FROM "Incident" WHERE "customerId" = 'cus_t' AND "purgedAt" IS NOT NULL`)).toEqual([]);
    expect(await q(`SELECT 1 FROM "Incident" WHERE "customerId" = 'cus_t'`)).toHaveLength(3);
    // CONNECTIONS needs the offboarding complete on the row itself
    await q(`INSERT INTO "CustomerOffboarding"("id", "customerId", "startedByUserId", "reason", "steps") VALUES ('off_t', 'cus_t', 'u', 'r', '{}'::jsonb)`);
    expect((await stage(store, 'cus_t', 'CONNECTIONS')).counts).toEqual({});
    await q(`UPDATE "CustomerOffboarding" SET "completedAt" = now() WHERE "customerId" = 'cus_t'`);
    expect((await stage(store, 'cus_t', 'CONNECTIONS')).counts).toMatchObject({ CloudAccount: 1 });
  });

  it('R-4: contact values nested in AuditLog before/after are removed at every depth', async () => {
    await q(`INSERT INTO "AuditLog"("id", "customerId", "actorType", "action", "targetType", "before", "after") VALUES
      ('n1', 'cus_t', 'USER', 'x', 'Foo', '{"a": {"contact": {"phone": "+82101", "ok": 1}}, "list": [{"email": "e@x", "keep": true}]}'::jsonb, '{"name": "Kim", "n": 2}'::jsonb),
      ('n2', 'cus_o', 'USER', 'x', 'Foo', '{"a": {"phone": "+82102"}}'::jsonb, NULL)`);
    const r = await stage(store, 'cus_t', 'RETURN_PERIOD');
    expect(r.counts['AuditLog.masked']).toBe(1);
    const [n1] = await q(`SELECT "before", "after" FROM "AuditLog" WHERE "id" = 'n1'`);
    expect(n1).toEqual({ before: { a: { contact: { ok: 1 } }, list: [{ keep: true }] }, after: { n: 2 } });
    expect((await q(`SELECT "before" FROM "AuditLog" WHERE "id" = 'n2'`))[0]!.before).toEqual({ a: { phone: '+82102' } });
    expect((await stage(store, 'cus_t', 'RETURN_PERIOD')).counts).toEqual({}); // idempotent
  });

  it('R-5: a Resource with a RemediationRequest survives CONNECTIONS (scrubbed) and goes with its request at AUDIT_EXPIRY', async () => {
    await q(`INSERT INTO "Resource"("id", "customerId", "cloudAccountId", "region", "resourceType", "resourceArn", "resourceKey", "name", "lastSeenAt", "updatedAt") VALUES ('res_keep', 'cus_t', 'ca_cus_t', 'ap-northeast-2', 'ec2', 'arn:secret', 'i-secret', 'secret-name', now(), now())`);
    await q(`INSERT INTO "RemediationRequest"("id", "customerId", "cloudAccountId", "resourceId", "trigger", "action", "status", "requestedAt") VALUES ('rr1', 'cus_t', 'ca_cus_t', 'res_keep', '{}'::jsonb, 'EC2_STOP', 'NOTIFIED', now())`);
    await q(`INSERT INTO "CustomerOffboarding"("id", "customerId", "startedByUserId", "reason", "steps", "completedAt") VALUES ('off_t', 'cus_t', 'u', 'r', '{}'::jsonb, now())`);
    const r = await stage(store, 'cus_t', 'CONNECTIONS');
    expect(r.counts).toMatchObject({ Resource: 1, 'Resource.scrubbed': 1 });
    expect((await q(`SELECT "name", "resourceArn", "resourceKey" FROM "Resource" WHERE "id" = 'res_keep'`))[0]).toEqual({ name: null, resourceArn: 'purged:res_keep', resourceKey: 'res_keep' });
    expect(await q(`SELECT 1 FROM "RemediationRequest" WHERE "id" = 'rr1'`)).toHaveLength(1);
    const a = await stage(store, 'cus_t', 'AUDIT_EXPIRY', Date.now() + 60_000, 30);
    expect(a.counts).toMatchObject({ RemediationRequest: 1, Resource: 1 });
    expect(await q(`SELECT 1 FROM "Resource" WHERE "customerId" = 'cus_t'`)).toEqual([]);
    expect(await q(`SELECT 1 FROM "Resource" WHERE "customerId" = 'cus_o'`)).toHaveLength(1);
  });

  it('claim: once per day; a finished claim is final; an unfinished one older than 30 minutes can be taken again; SLA_EXPIRY done = not a candidate', async () => {
    expect(await store.claimRetentionDay('2027-01-10')).toBe(true);
    expect(await store.claimRetentionDay('2027-01-10')).toBe(false);
    await q(`UPDATE "RetentionClaim" SET "claimedAt" = '2027-01-09T23:00:00Z'`); // 1 h before the store clock, unfinished
    expect(await store.claimRetentionDay('2027-01-10')).toBe(true);
    await store.finishRetentionDay('2027-01-10');
    await q(`UPDATE "RetentionClaim" SET "claimedAt" = '2027-01-09T23:00:00Z'`);
    expect(await store.claimRetentionDay('2027-01-10')).toBe(false);
    expect((await store.retentionCandidates(10)).map((c) => c.customerId).sort()).toEqual(['cus_o', 'cus_t']);
    await stage(store, 'cus_t', 'SLA_EXPIRY', Date.now() + 60_000, 1);
    expect((await store.retentionCandidates(10)).map((c) => c.customerId)).toEqual(['cus_o']);
  });
});
