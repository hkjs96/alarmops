/** The API store contract of packages/api/test/contract against the SQL store (PGlite, or TEST_DATABASE_URL). */
import { afterAll, beforeAll, describe } from 'vitest';
import { peopleContract } from '../../api/test/contract/peopleContract.js';
import { apiContract } from '../../api/test/contract/apiContract.js';
import { openTestDb, type TestDb } from './db.js';
import { sqlFixture } from './sqlFixture.js';

let db: TestDb;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

describe(`api store contract: sql (${process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite'})`, () => {
  apiContract((seed) => sqlFixture(db, seed));
  peopleContract((seed) => sqlFixture(db, seed));
});
