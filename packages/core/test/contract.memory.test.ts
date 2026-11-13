/** The store contract (test/contract) against MemoryTickStore. The SQL store runs the same suite in packages/store-sql. */
import { describe } from 'vitest';
import { memoryFixture } from './contract/fixture.js';
import { inactiveContract } from './contract/inactiveContract.js';
import { lanesContract } from './contract/lanesContract.js';
import { tickContract } from './contract/tickContract.js';

describe('store contract: memory', () => {
  tickContract(async (seed) => memoryFixture(seed));
  lanesContract(async (seed) => memoryFixture(seed));
  inactiveContract(async (seed) => memoryFixture(seed));
});
