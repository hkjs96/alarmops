/**
 * Security review of feat/sql-adapter (docs: alarmops-security-review-sql) — what only a database can show.
 * B-1 concurrent claims, R-2 clocks with the production wiring (the database's own now()), R-3 pool limits and the
 * transaction-pooler mode, R-4 Data API roles, R-7 nothing secret at rest, N-7 reserved slugs.
 * "server" tests need a real Postgres (TEST_DATABASE_URL); the others also run on PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { CLOCK_SKEW_LIMIT_MS, MemoryTickStore, heartbeatHealth, runTick } from '@alarmops/core';
import { RESERVED_SLUGS, createApi, slugProblem, type AuthContext } from '@alarmops/api';
import { CONNECT_TIMEOUT_MS, QUERY_TIMEOUT_MS, STATEMENT_TIMEOUT_MS, SqlApiStore, SqlTickStore, pgClient, pgCode } from '../src/index.js';
import { MIGRATION, openTestDb, TEST_DATABASE_URL, TEST_PG_POOLER, type TestDb } from './db.js';
import { sqlFixture } from './sqlFixture.js';

const server = it.skipIf(!TEST_DATABASE_URL);
let db: TestDb;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

const seed = (): MemoryTickStore => {
  const s = new MemoryTickStore();
  s.customers.set('cus_a', { id: 'cus_a', name: 'A', slug: 'a' });
  return s;
};
beforeEach(async () => { await sqlFixture(db, seed()); });

/** `customers` customers, `perCustomer` SMS pages each, due a second ago by the database's clock. One statement. */
async function outbox(customers: number, perCustomer: number): Promise<void> {
  await db.client.query(`INSERT INTO "Customer"("id", "name", "slug", "updatedAt") SELECT 'cus_x' || c, 'X' || c, 'x' || c, now() FROM generate_series(1, $1) c`, [customers]);
  await db.client.query(`INSERT INTO "Incident"("id", "axis", "customerId", "title", "severity", "triggeredAt") SELECT 'inc-x' || c, 'ax' || c, 'cus_x' || c, 't', 'SEV_1', now() FROM generate_series(1, $1) c`, [customers]);
  await db.client.query(`INSERT INTO "Contact"("id", "kind", "customerId", "name", "phone", "phoneVerifiedAt", "updatedAt") SELECT 'ct_x' || c, 'CUSTOMER', 'cus_x' || c, 'P' || c, '+82105550' || lpad(c::text, 4, '0'), now(), now() FROM generate_series(1, $1) c`, [customers]);
  await db.client.query(
    `INSERT INTO "NotificationJob"("id", "idempotencyKey", "customerId", "incidentId", "purpose", "channel", "targetRef", "contactId", "contactName", "nextAttemptAt", "dueAt", "payload")
     SELECT 'job_' || c || '_' || k, 'key_' || c || '_' || k, 'cus_x' || c, 'inc-x' || c, 'INITIAL', 'SMS', 'ct_x' || c, 'ct_x' || c, 'P' || c, now() - interval '1 second', now() - interval '1 second', '{"severity":"SEV_1","title":"t","text":"t","stepLabel":"s"}'
       FROM generate_series(1, $1) c, generate_series(1, $2) k`, [customers, perCustomer]);
}

describe('B-1: overlapping claimers never get an empty claim while pages are due', () => {
  server.each([[2, 25, 6, 20], [4, 25, 6, 20], [8, 50, 8, 50], [8, 10, 8, 50], [8, 50, 80, 5]])(
    'server: %i runners × limit %i over %i customers × %i pages — drained in the minimum number of rounds, every claim full, no duplicate (5 times)', async (runners, limit, customers, per) => {
      const total = customers * per;
      for (let rep = 0; rep < 5; rep++) {
        await db.reset();
        await outbox(customers, per);
        const seen = new Map<string, number>();
        let rounds = 0; let emptyWhileDue = 0; let short = 0; let calls = 0;
        const stores = Array.from({ length: runners }, () => new SqlTickStore(db.client));
        while (seen.size < total && rounds < 200) {
          const left = total - seen.size;
          const claims = await Promise.all(stores.map((s) => s.claimDueJobs(limit, { kinds: ['SMS'] })));
          rounds++;
          // what an ideal sequence of claims gives: full claims until the queue is empty
          const ideal = Array.from({ length: runners }, (_, i) => Math.max(0, Math.min(limit, left - i * limit))).sort((a, b) => b - a);
          const got = claims.map((c) => c.length).sort((a, b) => b - a);
          for (let i = 0; i < runners; i++) { calls++; if (ideal[i]! > 0 && got[i] === 0) emptyWhileDue++; if (got[i]! < ideal[i]!) short++; }
          for (const j of claims.flat()) seen.set(j.id, (seen.get(j.id) ?? 0) + 1);
        }
        const label = `rep ${rep}: ${calls} claim calls`;
        expect([...seen.values()].filter((n) => n > 1), label).toEqual([]);
        expect(emptyWhileDue, `${label}: empty claims while pages were due`).toBe(0);
        expect(short, `${label}: claims with fewer rows than were available`).toBe(0);
        expect(rounds, label).toBe(Math.ceil(total / (runners * limit)));
        const [r] = await db.client.query(`SELECT count(*)::int AS "n", max("claimSeq") AS "maxSeq" FROM "NotificationJob" WHERE "status" = 'SENDING'`);
        expect(r, label).toMatchObject({ n: total, maxSeq: 1 });
      }
    }, 120_000);

  server('server: the lane lock is per lane and per transaction — a held SMS claim does not delay a VOICE claim, and a claim behind a stuck one fails after lock_timeout instead of hanging', async () => {
    await outbox(2, 3);
    await db.client.query(`UPDATE "NotificationJob" SET "channel" = 'VOICE' WHERE "customerId" = 'cus_x2'`);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // someone holds the SMS lane lock (as a claim in flight does)
    const holder = db.client.transaction(async (tx) => { await tx.query(`SELECT pg_advisory_xact_lock(hashtext('alarmops:outbox-claim'), hashtext('SMS'))`); await gate; });
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    expect(await new SqlTickStore(db.client).claimDueJobs(50, { kinds: ['VOICE'] })).toHaveLength(3);
    expect(Date.now() - t0).toBeLessThan(1_000);
    const t1 = Date.now();
    const err = await new SqlTickStore(db.client).claimDueJobs(50, { kinds: ['SMS'] }).then(() => null, (e: unknown) => e);
    expect(pgCode(err)).toBe('55P03');
    expect(Date.now() - t1).toBeLessThan(STATEMENT_TIMEOUT_MS);
    release();
    await holder;
    expect(await new SqlTickStore(db.client).claimDueJobs(50, { kinds: ['SMS'] })).toHaveLength(3); // the lock went with the transaction
  }, 30_000);
});

describe('R-2: a runner whose clock is wrong, against the database’s own now()', () => {
  const MIN10 = 10 * 60_000; const DAYS3 = 3 * 86_400_000;

  it.each([['10 minutes ahead', MIN10], ['10 minutes behind', -MIN10], ['3 days ahead', DAYS3]])('%s: runTick does nothing, claims no minute, pages nobody; the heartbeat says ERROR and reads as stale', async (_label, ms) => {
    const store = new SqlTickStore(db.client); // production wiring: now() of the database
    await outbox(1, 2);
    const sent: string[] = [];
    const sender = { send: async (m: { idempotencyKey: string }) => { sent.push(m.idempotencyKey); return { ok: true as const, providerMessageId: 'p' }; } };
    const now = (): Date => new Date(Date.now() + ms);
    const r = await runTick({}, { repo: store, senders: { SMS: sender }, now });
    expect(r).toMatchObject({ skipped: 'clock-skew' });
    expect(Math.abs((r as { clockSkewMs: number }).clockSkewMs - ms)).toBeLessThan(5_000);
    expect(sent).toEqual([]);
    expect((await db.client.query(`SELECT count(*)::int AS "n" FROM "TickClaim"`))[0]!.n).toBe(0);
    expect((await db.client.query(`SELECT count(*)::int AS "n" FROM "NotificationJob" WHERE "claimSeq" > 0`))[0]!.n).toBe(0);
    const hbs = await store.readHeartbeats();
    expect(hbs).toHaveLength(4);
    for (const h of hbs) expect(h).toMatchObject({ lastStatus: 'ERROR', lastFinishedAt: null, lastStats: { skipped: 'clock-skew' } });
    expect(heartbeatHealth(hbs, new Date()).stale).toBe(true);
    // lastStartedAt is the DATABASE's time, not the runner's
    expect(Math.abs(hbs[0]!.lastStartedAt!.getTime() - Date.now())).toBeLessThan(5_000);
    // the store refuses on its own as well (a caller that skipped the check)
    expect(await store.claimTick('2026-11-09T03:00Z', now())).toBe('CLOCK_SKEW');
    expect((await db.client.query(`SELECT count(*)::int AS "n" FROM "TickClaim"`))[0]!.n).toBe(0);
    // a runner with the right clock then runs normally and pages
    const ok = await runTick({}, { repo: store, senders: { SMS: sender } });
    expect('skipped' in ok).toBe(false);
    expect(sent).toHaveLength(2);
    expect(heartbeatHealth(await store.readHeartbeats(), new Date()).stale).toBe(false);
  }, 30_000);

  it('a runner 20 s ahead (inside the limit) pages on the database’s time: what is due in 10 s is not sent, what is due now is', async () => {
    const store = new SqlTickStore(db.client);
    await outbox(1, 2);
    await db.client.query(`UPDATE "NotificationJob" SET "nextAttemptAt" = now() + interval '10 seconds', "dueAt" = now() + interval '10 seconds' WHERE "id" = 'job_1_2'`);
    const sent: string[] = [];
    const sender = { send: async (m: { idempotencyKey: string }) => { sent.push(m.idempotencyKey); return { ok: true as const, providerMessageId: 'p' }; } };
    expect(CLOCK_SKEW_LIMIT_MS).toBe(30_000);
    const r = await runTick({ jobs: ['notify'] }, { repo: store, senders: { SMS: sender }, now: () => new Date(Date.now() + 20_000) });
    expect('skipped' in r).toBe(false);
    expect(sent).toEqual(['key_1_1']);
    // the heartbeat carries the database's time (within a second or two), not runner time (+20 s)
    const hb = (await store.readHeartbeats()).find((h) => h.name === 'notify')!;
    const [d] = await db.client.query(`SELECT extract(epoch FROM (now() - $1::timestamptz))::float AS "s"`, [hb.lastFinishedAt!.toISOString()]);
    expect(d!.s).toBeGreaterThanOrEqual(0);
    expect(d!.s).toBeLessThan(5);
  }, 30_000);

  it('purgeExpired cannot delete a live tick claim, whatever was passed as the minute; rows older than two days go', async () => {
    const store = new SqlTickStore(db.client);
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    expect(await store.claimTick(minute.toISOString(), new Date())).toBe(true);
    // a row whose MINUTE is far in the past but which was claimed just now (a late tick, or a wrong scheduledAt)
    expect(await store.claimTick('2020-01-01T00:00:00Z', new Date())).toBe(true);
    await db.client.query(`INSERT INTO "TickClaim"("minute", "claimedAt") VALUES (now() - interval '3 days', now() - interval '3 days')`);
    expect(await store.purgeExpired()).toBe(1);
    expect(await store.claimTick(minute.toISOString(), new Date())).toBe(false); // still claimed
    expect(await store.claimTick('2020-01-01T00:00:00Z', new Date())).toBe(false);
    expect((await db.client.query(`SELECT count(*)::int AS "n" FROM "TickClaim"`))[0]!.n).toBe(2);
  });
});

describe('R-3: every wait on the database has an upper bound', () => {
  server('server (direct): the limits are connection defaults — a single pooled statement has them without asking', async () => {
    if (TEST_PG_POOLER !== 'direct') return;
    const show = async (name: string): Promise<unknown> => (await db.client.query(`SHOW ${name}`))[0]![name];
    expect(await show('statement_timeout')).toBe('4500ms');
    expect(await show('lock_timeout')).toBe('3s');
    expect(await show('idle_in_transaction_session_timeout')).toBe('15s');
    expect(await show('default_transaction_isolation')).toBe('read committed');
  });

  server('server (transaction pooler mode): no startup options and no session state — single statements still run under the limits, and the connection is left as the server gave it', async () => {
    const c = pgClient({ connectionString: TEST_DATABASE_URL, max: 2, pooler: 'transaction' });
    try {
      // a raw statement on the pool shows the server's own defaults: nothing was SET on the session
      const raw = async (name: string): Promise<unknown> => (await c.pool.query(`SHOW ${name}`)).rows[0][name];
      const serverDefault = await raw('statement_timeout');
      expect(serverDefault).not.toBe('4500ms');
      // … while a statement through the client runs inside a short transaction with SET LOCAL
      expect((await c.query('SHOW statement_timeout'))[0]!.statement_timeout).toBe('4500ms');
      expect((await c.query('SHOW lock_timeout'))[0]!.lock_timeout).toBe('3s');
      expect((await c.query('SHOW transaction_isolation'))[0]!.transaction_isolation).toBe('read committed');
      expect((await c.query('SHOW idle_in_transaction_session_timeout'))[0]!.idle_in_transaction_session_timeout).toBe('15s');
      const t0 = Date.now();
      expect(pgCode(await c.query('SELECT pg_sleep(8)').then(() => null, (e: unknown) => e))).toBe('57014');
      expect(Date.now() - t0).toBeLessThan(5_000);
      // and afterwards the session is unchanged (SET LOCAL ended with the transaction), no transaction is left open
      expect(await raw('statement_timeout')).toBe(serverDefault);
      expect((await c.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = pg_backend_pid() AND state = 'idle in transaction'`)).rows[0].n).toBe(0);
      // the isolation level holds even when the server default is something else
      await c.pool.query(`SET default_transaction_isolation = 'serializable'`); // (test only: session state on purpose)
      const levels = await Promise.all([c.transaction(async (tx) => (await tx.query('SHOW transaction_isolation'))[0]!.transaction_isolation), c.query('SHOW transaction_isolation').then((r) => r[0]!.transaction_isolation)]);
      expect(levels).toEqual(['read committed', 'read committed']);
    } finally { await c.close?.(); }
  }, 30_000);

  server('server: a full pool fails the next call after the connection timeout instead of queueing without end', async () => {
    expect(CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
    const c = pgClient({ connectionString: TEST_DATABASE_URL, max: 2, connectionTimeoutMs: 400 });
    try {
      const busy = [c.query('SELECT pg_sleep(2)'), c.query('SELECT pg_sleep(2)')];
      await new Promise((r) => setTimeout(r, 100));
      const t0 = Date.now();
      const err = await c.query('SELECT 1').then(() => null, (e: unknown) => e);
      expect(String((err as Error)?.message)).toMatch(/timeout/i);
      expect(Date.now() - t0).toBeLessThan(1_500);
      const t1 = Date.now();
      const txErr = await c.transaction((tx) => tx.query('SELECT 1')).then(() => null, (e: unknown) => e);
      expect(String((txErr as Error)?.message)).toMatch(/timeout/i);
      expect(Date.now() - t1).toBeLessThan(1_500);
      await Promise.all(busy);
      expect((await c.query('SELECT 1 AS "ok"'))[0]!.ok).toBe(1);
    } finally { await c.close?.(); }
  }, 30_000);

  server('server: a statement the server does not answer in time fails on the CLIENT (query_timeout) and the connection is not reused', async () => {
    expect(QUERY_TIMEOUT_MS).toBeGreaterThan(STATEMENT_TIMEOUT_MS); // the server cancels a slow statement first
    // server limit far away, client limit 300 ms: stands for a server that does not answer at all
    const c = pgClient({ connectionString: TEST_DATABASE_URL, max: 1, statementTimeoutMs: 4_000, queryTimeoutMs: 300 });
    try {
      for (const run of [() => c.query('SELECT pg_sleep(2)'), () => c.transaction((tx) => tx.query('SELECT pg_sleep(2)'))]) {
        const pidBefore = (await c.query('SELECT pg_backend_pid() AS "pid"'))[0]!.pid;
        const t0 = Date.now();
        const err = await run().then(() => null, (e: unknown) => e);
        expect(String((err as Error)?.message)).toMatch(/timeout/i);
        expect(Date.now() - t0).toBeLessThan(1_500);
        // max 1: the next call needs a NEW connection (the old one was destroyed, not handed back mid-statement)
        const pidAfter = (await c.query('SELECT pg_backend_pid() AS "pid"'))[0]!.pid;
        expect(pidAfter).not.toBe(pidBefore);
      }
    } finally { await c.close?.(); }
  }, 30_000);

  it('the schema option is a plain identifier or the client is not built (it is spliced into SQL)', () => {
    for (const bad of ['public; DROP TABLE x', 'a b', 'a"b', '', 'x'.repeat(64), 'a,b']) expect(() => pgClient({ connectionString: 'postgres://localhost/none', schema: bad })).toThrow(/identifier/);
  });
});

describe('R-4: Supabase Data API roles get nothing', () => {
  server('server: with roles anon / authenticated present (as on Supabase), the migration’s block revokes what they hold and what later tables would get', async () => {
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    try {
      const [{ schema }] = (await db.client.query(`SELECT current_schema() AS "schema"`)) as [{ schema: string }];
      for (const role of ['anon', 'authenticated']) {
        try { await admin.query(`CREATE ROLE ${role} NOLOGIN`); } catch (e) { if (pgCode(e) !== '42710' && pgCode(e) !== '23505') throw e; }
      }
      await admin.query(`SET search_path = "${schema}", public`);
      // what Supabase's defaults do: everything in the schema is granted, and so is whatever is created later
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO anon, authenticated`);
      await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA "${schema}" TO anon, authenticated`);
      await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schema}" TO anon, authenticated`);
      await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO anon, authenticated`);
      const can = async (role: string, table: string): Promise<boolean> =>
        (await admin.query(`SELECT bool_or(has_table_privilege($1, format('%I.%I', $2::text, $3::text), p)) AS "any" FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p`, [role, schema, table])).rows[0].any;
      expect(await can('anon', 'Contact')).toBe(true);
      const block = /DO \$\$[\s\S]*?END \$\$;/.exec(MIGRATION.slice(MIGRATION.indexOf('Supabase Data API')))?.[0];
      expect(block).toBeTruthy();
      await admin.query(block!);
      const tables = (await admin.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [schema])).rows.map((r) => r.tablename as string);
      expect(tables.length).toBeGreaterThan(40);
      for (const role of ['anon', 'authenticated']) for (const t of tables) expect(await can(role, t), `${role} on ${t}`).toBe(false);
      const seqs = (await admin.query(`SELECT bool_or(has_sequence_privilege('anon', format('%I.%I', schemaname, sequencename), 'USAGE')) AS "any" FROM pg_sequences WHERE schemaname = $1`, [schema])).rows[0].any;
      expect(seqs).toBe(false);
      await admin.query(`CREATE TABLE "LaterTable" ("id" text PRIMARY KEY)`);
      expect(await can('anon', 'LaterTable')).toBe(false);
      expect(await can('authenticated', 'LaterTable')).toBe(false);
      await admin.query(`DROP TABLE "LaterTable"`);
      // the application's own role is not touched
      expect((await db.client.query(`SELECT count(*)::int AS "n" FROM "Customer"`))[0]!.n).toBeGreaterThanOrEqual(1);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('the block is in the migration, guarded by role existence, and does nothing where the roles do not exist (this run got here)', () => {
    expect(MIGRATION).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)/);
    expect(MIGRATION).toMatch(/REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I/);
    expect(MIGRATION).toMatch(/ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I/);
    expect(MIGRATION).not.toMatch(/ENABLE ROW LEVEL SECURITY/); // a decision, not taken here (db/README.md)
  });
});

describe('R-7: nothing that works as a credential or a contact detail is at rest outside its table', () => {
  it('after ack (with an Idempotency-Key), bulk ack and undo: no undo token in any table; UndoRecord holds only SHA-256 hex', async () => {
    const s = seed();
    s.customers.set('cus_b', { id: 'cus_b', name: 'B', slug: 'b' });
    const fx = await sqlFixture(db, s);
    await db.client.query(`INSERT INTO "Incident"("id", "axis", "customerId", "title", "severity", "triggeredAt", "version") VALUES ('inc-1', 'ax1', 'cus_a', 't', 'SEV_1', now(), 1), ('inc-2', 'ax2', 'cus_b', 't', 'SEV_1', now(), 1)`);
    const api = createApi({ repo: fx.repo as SqlApiStore });
    const auth: AuthContext = { userId: 'usr_1', kind: 'INTERNAL', customerIds: '*', role: 'ADMIN' };
    await db.client.query(`INSERT INTO "User"("id", "email", "name", "status", "updatedAt") VALUES ('usr_1', 'u1@example.test', 'U1', 'ACTIVE', now())`);
    const a = await api.handle({ method: 'POST', path: '/incidents/inc-1/ack', auth, headers: { 'if-match': '1', 'idempotency-key': 'k1' }, requestId: 'r1' });
    const b = await api.handle({ method: 'POST', path: '/incidents/bulk', auth, headers: { 'idempotency-key': 'k2' }, body: { action: 'ack', preview: false, items: [{ id: 'inc-2', version: 1 }] }, requestId: 'r2' });
    expect([a.status, b.status]).toEqual([200, 200]);
    const tokens = [(a.body as { undoToken: string }).undoToken, (b.body as { undoToken: string }).undoToken];
    expect(tokens.every((t) => /^undo_/.test(t))).toBe(true);
    const tables = (await db.client.query(`SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`)).map((r) => r.tablename as string);
    let scanned = 0;
    for (const t of tables) {
      const rows = await db.client.query(`SELECT row_to_json(x)::text AS "j" FROM "${t}" x`);
      for (const r of rows) { scanned++; expect(r.j, t).not.toContain('undo_'); for (const tok of tokens) expect(r.j, t).not.toContain(tok.slice(5)); }
    }
    expect(scanned).toBeGreaterThan(5);
    expect((await db.client.query(`SELECT count(*)::int AS "n" FROM "IdempotencyKey"`))[0]!.n).toBe(2);
    const undo = await db.client.query(`SELECT "token" FROM "UndoRecord"`);
    expect(undo).toHaveLength(2);
    for (const u of undo) expect(u.token).toMatch(/^[0-9a-f]{64}$/);
    // the replay carries no token; the first token still works
    const replay = await api.handle({ method: 'POST', path: '/incidents/inc-1/ack', auth, headers: { 'if-match': '1', 'idempotency-key': 'k1' }, requestId: 'r3' });
    expect(replay.status).toBe(200);
    expect(JSON.stringify(replay.body)).not.toContain('undo');
    const undone = await api.handle({ method: 'POST', path: '/incidents/bulk/undo', auth, body: { undoToken: tokens[0] }, requestId: 'r4' });
    expect((undone.body as { restored: string[] }).restored).toEqual(['inc-1']);
  });
});

describe('N-7: slugs — format and reserved words, in the application and in the database', () => {
  it('RESERVED_SLUGS is the list of the migration’s CHECK constraints, for all three tables', () => {
    const lists = [...MIGRATION.matchAll(/"(Customer|Project|Service)_slug_reserved_chk" CHECK \("slug" NOT IN \(([^)]*)\)\)/g)];
    expect(lists.map((m) => m[1])).toEqual(['Customer', 'Project', 'Service']);
    for (const m of lists) expect(m[2]!.split(',').map((x) => x.trim().replace(/^'|'$/g, ''))).toEqual([...RESERVED_SLUGS]);
    expect([...RESERVED_SLUGS].sort()).toEqual(['-', 'admin', 'all', 'api', 'auth', 'c', 'call-order', 'customers', 'incident', 'login', 'maintenance', 'monitoring', 'new', 'people', 'settings', 'unmapped'].sort());
  });

  it('every reserved word is refused by slugProblem and by the database on Customer, Project and Service; ordinary slugs pass both', async () => {
    const CHECK = '23514';
    const customer = (slug: string) => db.client.query(`INSERT INTO "Customer"("id", "name", "slug", "updatedAt") VALUES ($1, $1, $2, now())`, [`cus_s_${slug}`, slug]);
    const project = (slug: string) => db.client.query(`INSERT INTO "Project"("id", "customerId", "name", "slug") VALUES ($1, 'cus_a', $1, $2)`, [`prj_s_${slug}`, slug]);
    for (const word of RESERVED_SLUGS) {
      expect(slugProblem(word), word).not.toBeNull();
      expect(pgCode(await customer(word).then(() => null, (e: unknown) => e)), `Customer ${word}`).toBe(CHECK);
      expect(pgCode(await project(word).then(() => null, (e: unknown) => e)), `Project ${word}`).toBe(CHECK);
    }
    // Service: checked through the catalog (a row needs more parents than this test wants to build)
    const svc = await db.client.query(`SELECT pg_get_constraintdef(c.oid) AS "def" FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = current_schema() AND t.relname = 'Service' AND c.conname = 'Service_slug_reserved_chk'`);
    expect(svc).toHaveLength(1);
    for (const word of RESERVED_SLUGS) expect(svc[0]!.def, word).toContain(`'${word}'`);
    for (const bad of ['Bad Slug', '-lead', 'a/b', 'a..b', '', 'x'.repeat(65), '한글', 'a\nb']) expect(slugProblem(bad), bad).toBe('FORMAT');
    for (const word of ['new', 'api', 'admin', 'all', 'unmapped']) expect(slugProblem(word), word).toBe('RESERVED');
    for (const good of ['mirae', 'payments-api', 'news', 'api-gateway', 'c2', 'administrators', 'a--b', 'trail-']) {
      expect(slugProblem(good), good).toBeNull();
      await customer(good);
      await project(good);
    }
    for (const v of [null, undefined, 5, {}]) expect(slugProblem(v)).toBe('FORMAT');
  });
});
