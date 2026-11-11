/**
 * What only the SQL store has: the database's own clock, statement and lock timeouts (N-33), row locks that are
 * skipped, and the hand-written constraints of the migration. Tests marked "server" need two connections or an
 * enforced `statement_timeout`; they run when TEST_DATABASE_URL points at a real Postgres and are skipped on PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLAIM_LEASE_SEC, STORE_CALL_TIMEOUT_MS, MemoryTickStore, type NotificationJob } from '@alarmops/core';
import { LOCK_TIMEOUT_MS, PG, STATEMENT_TIMEOUT_MS, SqlTickStore, pgCode } from '../src/index.js';
import { openTestDb, TEST_DATABASE_URL, type TestDb } from './db.js';
import { sqlFixture, type SqlFixture } from './sqlFixture.js';

const server = it.skipIf(!TEST_DATABASE_URL);
let db: TestDb;
let fx: SqlFixture;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

const seed = (): MemoryTickStore => {
  const s = new MemoryTickStore();
  s.customers.set('cus_a', { id: 'cus_a', name: 'A', slug: 'a' });
  s.customers.set('cus_b', { id: 'cus_b', name: 'B', slug: 'b' });
  return s;
};
/** An incident row and `n` queued SMS pages for it, due one second ago by the DATABASE's clock. */
async function pages(customerId: string, n: number): Promise<string[]> {
  const inc = `inc-${customerId}`;
  await db.client.query(`INSERT INTO "Incident"("id", "axis", "customerId", "title", "severity", "triggeredAt") VALUES ($1, $1, $2, 't', 'SEV_1', now()) ON CONFLICT DO NOTHING`, [inc, customerId]);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `job_${customerId}_${i}`;
    await db.client.query(
      `INSERT INTO "NotificationJob"("id", "idempotencyKey", "customerId", "incidentId", "purpose", "channel", "targetRef", "nextAttemptAt", "dueAt", "payload")
       VALUES ($1, $1, $2, $3, 'INITIAL', 'SMS', 'x', now() - interval '1 second', now() - interval '1 second', '{"severity":"SEV_1","title":"t","text":"t","stepLabel":"s"}')`,
      [id, customerId, inc]);
    ids.push(id);
  }
  return ids;
}

beforeEach(async () => { fx = await sqlFixture(db, seed()); });

describe('store clock = the database clock (R-14, N-40)', () => {
  it('claim, lease and retry time come from now() of the database, whatever the process clock says', async () => {
    const store = new SqlTickStore(db.client); // production wiring: no test clock
    await pages('cus_a', 1);
    const realNow = Date.now;
    // On a server the process clock is set a year back: nothing may change. (PGlite runs inside this process and
    // reads the same clock, so there the two cannot be told apart and the skew is left out.)
    if (TEST_DATABASE_URL) Date.now = () => realNow() - 86_400_000 * 365;
    let claimed: NotificationJob[];
    let attempt: number | null;
    try {
      claimed = await store.claimDueJobs(10, { kinds: ['SMS'] });
      attempt = await store.beginSend(claimed[0]!.id, claimed[0]!.claimSeq);
    } finally { Date.now = realNow; }
    expect(claimed).toHaveLength(1);
    expect(attempt).toBe(1);
    const [lease] = await db.client.query(`SELECT extract(epoch FROM ($1::timestamptz - now()))::float AS "s"`, [claimed[0]!.nextAttemptAt.toISOString()]);
    expect(lease!.s).toBeGreaterThan(CLAIM_LEASE_SEC - 5);
    expect(lease!.s).toBeLessThanOrEqual(CLAIM_LEASE_SEC);
    const [retry] = await db.client.query(`SELECT extract(epoch FROM ("nextAttemptAt" - now()))::float AS "s", ("dueAt" = "nextAttemptAt") AS "same" FROM "NotificationJob" WHERE "id" = $1`, [claimed[0]!.id]);
    expect(retry!.s).toBeGreaterThan(25);
    expect(retry!.s).toBeLessThanOrEqual(30);
    expect(retry!.same).toBe(true);
    expect(await store.outboxBacklog()).toMatchObject({ dueUnattempted: 0 });
    expect(await store.claimTick('2026-11-09T03:00Z')).toBe(true);
    expect(await store.claimTick('2026-11-09T03:00Z')).toBe(false);
  });
});

describe('timeouts (N-33: every statement ends well before STORE_CALL_TIMEOUT_MS)', () => {
  it('the configured limits are below the tick’s 5 s guard, and every transaction sets them', async () => {
    expect(STATEMENT_TIMEOUT_MS).toBeLessThan(STORE_CALL_TIMEOUT_MS);
    expect(LOCK_TIMEOUT_MS).toBeLessThan(STATEMENT_TIMEOUT_MS);
    const shown = await db.client.transaction(async (tx) => [(await tx.query('SHOW statement_timeout'))[0]!.statement_timeout, (await tx.query('SHOW lock_timeout'))[0]!.lock_timeout]);
    expect(shown).toEqual(['4500ms', '3s']);
  });

  server('server: a statement that does not come back is cancelled by the database after 4.5 s — in a transaction and outside one', async () => {
    for (const run of [() => db.client.query('SELECT pg_sleep(8)'), () => db.client.transaction((tx) => tx.query('SELECT pg_sleep(8)'))]) {
      const t0 = Date.now();
      const err = await run().then(() => null, (e: unknown) => e);
      expect(pgCode(err)).toBe(PG.QUERY_CANCELED);
      expect(Date.now() - t0).toBeLessThan(STORE_CALL_TIMEOUT_MS);
    }
    expect((await db.client.query('SELECT 1 AS "ok"'))[0]!.ok).toBe(1); // the connection is usable afterwards
  }, 20_000);

  server('server: a write that waits for another transaction’s row lock gives up after 3 s instead of holding the tick', async () => {
    await fx.addGroup({ id: 'g1', groupKey: 'cus_a#SEV-2', customerId: 'cus_a', severity: 'SEV_2', status: 'CLOSED', openedAt: new Date(), groupWaitSec: 30, closeAt: new Date(), closedAt: new Date(), pauseUntil: null, staleAfter: new Date(), deliveredAt: null, version: 1 }, []);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holder = db.client.transaction(async (tx) => { await tx.query(`SELECT 1 FROM "AlertGroup" WHERE "id" = 'g1' FOR UPDATE`); await gate; });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    const err = await fx.repo.commitGroupDelivery({ groupId: 'g1', groupVersion: 1, deliveredAt: new Date(), incident: null, members: [], events: [], jobs: [], finalized: [] }).then(() => null, (e: unknown) => e);
    const took = Date.now() - t0;
    release();
    await holder;
    expect(pgCode(err)).toBe(PG.LOCK_NOT_AVAILABLE);
    expect(took).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS - 300);
    expect(took).toBeLessThan(STORE_CALL_TIMEOUT_MS);
    expect((await fx.group('g1'))!.status).toBe('CLOSED'); // nothing was written; the next tick delivers it
  }, 20_000);
});

describe('row locks', () => {
  server('server: the outbox claim skips rows another transaction holds (FOR UPDATE SKIP LOCKED) and does not wait for them', async () => {
    const store = new SqlTickStore(db.client);
    const ids = [...await pages('cus_a', 6), ...await pages('cus_b', 6)];
    const held = [ids[0]!, ids[1]!, ids[6]!];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holder = db.client.transaction(async (tx) => { await tx.query(`SELECT 1 FROM "NotificationJob" WHERE "id" = ANY($1::text[]) FOR UPDATE`, [held]); await gate; });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    const got = await store.claimDueJobs(50, { kinds: ['SMS'] });
    const took = Date.now() - t0;
    release();
    await holder;
    expect(took).toBeLessThan(1_000);
    expect(got.map((j) => j.id).sort()).toEqual(ids.filter((i) => !held.includes(i)).sort());
    // the rows that were held are still due and are claimed next
    expect((await store.claimDueJobs(50, { kinds: ['SMS'] })).map((j) => j.id).sort()).toEqual([...held].sort());
  }, 20_000);

  server('server: 8 runners × 5 rounds claiming at once over a pool: 400 pages, each claimed exactly once', async () => {
    for (let c = 0; c < 4; c++) {
      await db.client.query(`INSERT INTO "Customer"("id", "name", "slug", "updatedAt") VALUES ($1, $1, $2, now()) ON CONFLICT DO NOTHING`, [`cus_c${c}`, `c${c}`]);
      await pages(`cus_c${c}`, 100);
    }
    const seen = new Map<string, number>();
    for (let round = 0; round < 12; round++) {
      const claims = await Promise.all(Array.from({ length: 8 }, () => new SqlTickStore(db.client).claimDueJobs(50, { kinds: ['SMS'] })));
      for (const j of claims.flat()) seen.set(j.id, (seen.get(j.id) ?? 0) + 1);
      if (seen.size === 400) break;
    }
    expect(seen.size).toBe(400);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    const [r] = await db.client.query(`SELECT count(*)::int AS "n", max("claimSeq") AS "maxSeq" FROM "NotificationJob" WHERE "status" = 'SENDING'`);
    expect(r).toMatchObject({ n: 400, maxSeq: 1 });
  }, 30_000);
});

describe('constraints of the migration that the store relies on', () => {
  const group = (id: string, status = 'OPEN') => db.client.query(
    `INSERT INTO "AlertGroup"("id", "groupKey", "customerId", "severity", "status", "openedAt", "groupWaitSec", "closeAt", "staleAfter") VALUES ($1, 'cus_a#SEV-2', 'cus_a', 'SEV_2', $2::"GroupStatus", now(), 30, now(), now())`, [id, status]);
  const incident = (id: string, target: boolean) => db.client.query(
    `INSERT INTO "Incident"("id", "axis", "customerId", "title", "severity", "triggeredAt", "isMergeTarget") VALUES ($1, 'cus_a#SEV-2', 'cus_a', 't', 'SEV_2', now(), $2)`, [id, target]);

  it('one OPEN group per axis, one merge target per axis, one outbox row per page key, slug format, tenant shape of a contact', async () => {
    await group('g1');
    await group('g2', 'CLOSED');
    expect(pgCode(await group('g3').then(() => null, (e) => e))).toBe(PG.UNIQUE);
    await incident('i1', true);
    await incident('i2', false);
    expect(pgCode(await incident('i3', true).then(() => null, (e) => e))).toBe(PG.UNIQUE);
    await pages('cus_a', 1);
    expect(pgCode(await pages('cus_a', 1).then(() => null, (e) => e))).toBe(PG.UNIQUE);
    const CHECK = '23514';
    expect(pgCode(await db.client.query(`INSERT INTO "Customer"("id", "name", "slug", "updatedAt") VALUES ('x', 'X', 'Bad Slug', now())`).then(() => null, (e) => e))).toBe(CHECK);
    expect(pgCode(await db.client.query(`INSERT INTO "Contact"("id", "kind", "customerId", "name", "updatedAt") VALUES ('c1', 'CUSTOMER', NULL, 'n', now())`).then(() => null, (e) => e))).toBe(CHECK);
    expect(pgCode(await db.client.query(`INSERT INTO "Contact"("id", "kind", "customerId", "name", "updatedAt") VALUES ('c2', 'INTERNAL', 'cus_a', 'n', now())`).then(() => null, (e) => e))).toBe(CHECK);
  });

  it('the tick’s hot queries have their indexes (names the migration must keep)', async () => {
    const rows = await db.client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename IN ('NotificationJob', 'Incident', 'AlertGroup', 'TickClaim', 'IdempotencyKey')`);
    const names = rows.map((r) => r.indexname as string);
    for (const n of ['NotificationJob_due_idx', 'NotificationJob_idempotencyKey_key', 'NotificationJob_incidentId_stepIndex_repeat_idx', 'Incident_nextEscalationAt_due_idx', 'Incident_active_idx',
      'Incident_axis_mergeTarget_key', 'AlertGroup_status_closeAt_idx', 'AlertGroup_status_closedAt_idx', 'AlertGroup_groupKey_open_key', 'TickClaim_pkey', 'IdempotencyKey_ownerUserId_seq_idx']) expect(names, n).toContain(n);
  });
});
