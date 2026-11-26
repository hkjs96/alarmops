/** The API store contract (test/contract) against MemoryApiStore. The SQL store runs the same suite in packages/store-sql. */
import { describe } from 'vitest';
import { memoryFixture } from '../../core/test/contract/fixture.js';
import type { MemoryApiStore } from '../src/index.js';
import { peopleContract } from './contract/peopleContract.js';
import { apiContract } from './contract/apiContract.js';
import { retentionContract } from './contract/retentionContract.js';
import { revealContract } from './contract/revealContract.js';
import { onboardingContract } from './contract/onboardingContract.js';
import { orgContract } from './contract/orgContract.js';
import { monitoringContract } from './contract/monitoringContract.js';
import { usersContract } from './contract/usersContract.js';

describe('api store contract: memory', () => {
  apiContract(async (seed) => memoryFixture(seed as MemoryApiStore));
  retentionContract(async (seed) => memoryFixture(seed as MemoryApiStore));
  peopleContract(async (seed) => memoryFixture(seed as MemoryApiStore));
  revealContract(async (seed) => memoryFixture(seed as MemoryApiStore));
  onboardingContract(async (seed) => memoryFixture(seed as MemoryApiStore));
  usersContract(async (seed) => memoryFixture(seed as MemoryApiStore));
  orgContract(async (seed) => memoryFixture(seed as MemoryApiStore));
  monitoringContract(async (seed) => memoryFixture(seed as MemoryApiStore));
});
