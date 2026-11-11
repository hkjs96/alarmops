/** The API store contract (test/contract) against MemoryApiStore. The SQL store runs the same suite in packages/store-sql. */
import { describe } from 'vitest';
import { memoryFixture } from '../../core/test/contract/fixture.js';
import type { MemoryApiStore } from '../src/index.js';
import { apiContract } from './contract/apiContract.js';

describe('api store contract: memory', () => {
  apiContract(async (seed) => memoryFixture(seed as MemoryApiStore));
});
