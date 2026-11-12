/**
 * Lane fairness (security reviews 4 and 5) with the SQL store behind the real `runTick`: the same scenarios as
 * packages/core/test/contract.memory.test.ts. Fake timers for the tick, real I/O for the store.
 */
import { afterAll, beforeAll, describe } from 'vitest';
import { lanesContract } from '../../core/test/contract/lanesContract.js';
import { openTestDb, type TestDb } from './db.js';
import { sqlFixture } from './sqlFixture.js';

let db: TestDb;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

describe(`lane contract: sql (${process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite'})`, () => {
  lanesContract((seed) => sqlFixture(db, seed));
});
