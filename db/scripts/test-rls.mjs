// D-40 behaviour test against a migrated real Postgres (CI db job, `npm run test:db`).
// The connecting role must be the owner of the tables (it ran `prisma migrate deploy`).
//  - anon / authenticated (created here if missing) have no privileges after the migrations: permission denied.
//  - granted SELECT on purpose, they still read 0 rows (RLS on, no policies) and cannot insert.
//  - the owner reads the seeded row (RLS not forced).
// Everything this test adds (row, grants, roles it created) is removed at the end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { rlsProblems } from './check-rls.mjs';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

test('D-40: RLS hides rows from non-owner roles, owner bypasses', async () => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const created = [];
  const id = 'rls-test-' + process.pid;
  try {
    assert.deepEqual((await rlsProblems(c)).problems, []);
    for (const r of ['anon', 'authenticated']) {
      const { rowCount } = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [r]);
      if (!rowCount) { await c.query(`CREATE ROLE ${r} NOLOGIN`); created.push(r); }
      await c.query(`GRANT ${r} TO CURRENT_USER`); // so SET ROLE works without superuser
      await c.query(`GRANT USAGE ON SCHEMA public TO ${r}`);
    }
    await c.query(`INSERT INTO "Customer" (id, name, slug, "updatedAt") VALUES ($1, 'RLS test', $1, now())`, [id]);

    const owner = await c.query('SELECT count(*)::int AS n FROM "Customer" WHERE id = $1', [id]);
    assert.equal(owner.rows[0].n, 1, 'owner reads the seeded row');

    for (const r of ['anon', 'authenticated']) {
      // Roles that existed before migrate deploy had their privileges revoked; roles created here never had any.
      await c.query(`SET ROLE ${r}`);
      await assert.rejects(c.query('SELECT * FROM "Customer"'), /permission denied/);
      await c.query('RESET ROLE');

      await c.query(`GRANT SELECT, INSERT ON "Customer" TO ${r}`);
      await c.query(`SET ROLE ${r}`);
      const seen = await c.query('SELECT count(*)::int AS n FROM "Customer"');
      assert.equal(seen.rows[0].n, 0, `${r} with SELECT granted reads 0 rows`);
      await assert.rejects(
        c.query(`INSERT INTO "Customer" (id, name, slug, "updatedAt") VALUES ('x-${r}', 'x', 'x-${r}', now())`),
        /row-level security/);
      await c.query('RESET ROLE');
      await c.query(`REVOKE ALL ON "Customer" FROM ${r}`);
    }
  } finally {
    await c.query('RESET ROLE').catch(() => {});
    await c.query('DELETE FROM "Customer" WHERE id = $1', [id]);
    for (const r of ['anon', 'authenticated']) {
      await c.query(`REVOKE ALL ON "Customer" FROM ${r}`).catch(() => {});
      await c.query(`REVOKE USAGE ON SCHEMA public FROM ${r}`).catch(() => {});
      await c.query(`REVOKE ${r} FROM CURRENT_USER`).catch(() => {});
    }
    for (const r of created) await c.query(`DROP ROLE ${r}`);
    await c.end();
  }
});
