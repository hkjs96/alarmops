/** The API store contract of packages/api/test/contract against the SQL store (PGlite, or TEST_DATABASE_URL). */
import { afterAll, beforeAll, describe } from 'vitest';
import { peopleContract } from '../../api/test/contract/peopleContract.js';
import { apiContract } from '../../api/test/contract/apiContract.js';
import { retentionContract } from '../../api/test/contract/retentionContract.js';
import { revealContract } from '../../api/test/contract/revealContract.js';
import { onboardingContract } from '../../api/test/contract/onboardingContract.js';
import { orgContract } from '../../api/test/contract/orgContract.js';
import { monitoringContract } from '../../api/test/contract/monitoringContract.js';
import { usersContract } from '../../api/test/contract/usersContract.js';
import { openTestDb, type TestDb } from './db.js';
import { sqlFixture } from './sqlFixture.js';

let db: TestDb;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

describe(`api store contract: sql (${process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite'})`, () => {
  apiContract((seed) => sqlFixture(db, seed));
  retentionContract((seed) => sqlFixture(db, seed));
  peopleContract((seed) => sqlFixture(db, seed));
  revealContract((seed) => sqlFixture(db, seed));
  onboardingContract((seed) => sqlFixture(db, seed));
  usersContract((seed) => sqlFixture(db, seed));
  orgContract((seed) => sqlFixture(db, seed));
  monitoringContract((seed) => sqlFixture(db, seed));
});
