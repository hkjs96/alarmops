/**
 * The store contract of packages/core/test/contract against the SQL store.
 * Default: PGlite. `TEST_DATABASE_URL=postgres://…` → that server (what CI runs with a postgres:16 service).
 */
import { afterAll, beforeAll, describe } from 'vitest';
import { tickContract } from '../../core/test/contract/tickContract.js';
import { openTestDb, type TestDb } from './db.js';
import { sqlFixture } from './sqlFixture.js';

let db: TestDb;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

describe(`store contract: sql (${process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite'})`, () => {
  tickContract((seed) => sqlFixture(db, seed));
});
