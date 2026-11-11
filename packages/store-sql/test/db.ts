/**
 * A database for one test file.
 * - default: PGlite (Postgres as WASM, in-process, nothing to install);
 * - TEST_DATABASE_URL set: that server (CI: a postgres:16 service; later a Supabase branch). Every test file works in
 *   its own schema, created from the real migration and dropped at the end.
 * Either way the schema is `db/prisma/migrations/0001_init/migration.sql` — the file `prisma migrate deploy` applies.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { pgClient, pgliteClient, type SqlClient } from '../src/index.js';

export const MIGRATION = readFileSync(new URL('../../../db/prisma/migrations/0001_init/migration.sql', import.meta.url), 'utf8');
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
export const TEST_PG_POOLER: 'direct' | 'transaction' = process.env.TEST_PG_POOLER === 'transaction' ? 'transaction' : 'direct';

export interface TestDb {
  client: SqlClient;
  label: 'sql:pglite' | 'sql:postgres';
  /** Real concurrent transactions (a server with a pool). */
  concurrent: boolean;
  /** Empty every table, restart sequences. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

async function tablesOf(client: SqlClient, schema: string): Promise<string> {
  const rows = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations'`, [schema]);
  return rows.map((r) => `"${schema}"."${r.tablename}"`).join(', ');
}

export async function openTestDb(): Promise<TestDb> {
  if (TEST_DATABASE_URL) {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    try {
      // citext lives in `public` for every schema of this database; two test files may race to create it.
      for (let i = 0; ; i++) {
        try { await admin.query('CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA public'); break; } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 100 * (i + 1))); }
      }
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`SET search_path = "${schema}", public`);
      await admin.query(MIGRATION);
    } finally {
      await admin.end();
    }
    // TEST_PG_POOLER=transaction runs every suite the way the store talks through a transaction-mode pooler:
    // no startup options, every single statement in its own short transaction (drivers/pg.ts).
    const client = pgClient({ connectionString: TEST_DATABASE_URL, schema, max: 12, pooler: TEST_PG_POOLER });
    const tables = await tablesOf(client, schema);
    return {
      client, label: 'sql:postgres', concurrent: true,
      reset: async () => { await client.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`); },
      close: async () => {
        await client.close?.();
        const a = new pg.Client({ connectionString: TEST_DATABASE_URL });
        await a.connect();
        try { await a.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await a.end(); }
      },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const db = new PGlite({ extensions: { citext } });
  await db.exec(MIGRATION);
  const client = pgliteClient(db as never);
  const tables = await tablesOf(client, 'public');
  return {
    client, label: 'sql:pglite', concurrent: false,
    reset: async () => { await client.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`); },
    close: async () => { await client.close?.(); },
  };
}
