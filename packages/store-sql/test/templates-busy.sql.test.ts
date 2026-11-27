/**
 * Template saves on the SQL store (#176): the failures that wrote nothing and are safe to repeat are 'BUSY'
 * (deadlock 40P01, serialization 40001, lock_timeout 55P03, statement_timeout 57014, foreign-key race 23503 on the contact FKs only), and the
 * customers' paging contexts are read in a constant number of statements while their rows are locked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryApiStore } from '../../api/src/index.js';
import type { AuditInput } from '@alarmops/core';
import { SqlApiStore, type SqlClient, type SqlExecutor } from '../src/index.js';
import { seedWorld } from '../../core/test/world.js';
import { openTestDb, type TestDb } from './db.js';
import { sqlFixture } from './sqlFixture.js';

let db: TestDb;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

const AT = new Date('2026-11-27T00:00:00Z');
const audit = (customerId: string | null): AuditInput => ({ at: AT, customerId, actorType: 'USER', actorId: 'usr_minjae', action: 'x', targetType: 'X', targetId: '', before: null, after: null, requestId: 'r' });

/** A client whose transactions fail with a Postgres error code at the first statement that takes a row lock (really rolled back). */
function failing(client: SqlClient, code: string, when = /FOR UPDATE/, constraint?: string): SqlClient {
  return {
    ...client,
    query: (t, p) => client.query(t, p),
    now: () => client.now(),
    transaction: (fn) => client.transaction((tx: SqlExecutor) => fn({
      query: (t, p) => { if (when.test(t)) throw Object.assign(new Error(`simulated ${code}`), { code, ...(constraint ? { constraint } : {}) }); return tx.query(t as never, p as never) as never; },
    })),
  } as SqlClient;
}

describe('template saves: retry-safe failures are BUSY', () => {
  it.each([
    ['40P01', undefined], ['40001', undefined], ['55P03', undefined], ['57014', undefined],
    ['23503', 'Responder_contactId_fkey'], ['23503', 'ResponderTemplateMember_contactId_fkey'],
  ] as const)('updateResponderTemplate and setCustomerTemplate map %s (%s) to BUSY', async (code, constraint) => {
    await sqlFixture(db, seedWorld(new MemoryApiStore()));
    const store = new SqlApiStore(failing(db.client, code, undefined, constraint));
    const u = await store.updateResponderTemplate({ id: 'rt_x', expectedVersion: 0, proposal: { name: 'n', members: ['ct_haeun'] }, previewHash: 'h', actorId: 'usr_minjae', at: AT }, audit(null));
    const s = await store.setCustomerTemplate({ customerId: 'cus_mirae', toTemplateId: null, expectedVersion: 0, previewHash: 'h', actorId: 'usr_minjae', at: AT }, audit('cus_mirae'));
    expect([u, s]).toEqual(['BUSY', 'BUSY']);
  });

  it.each([undefined, 'BulkChange_actorId_fkey'])('a foreign-key violation on another constraint (%s) still surfaces', async (constraint) => {
    await sqlFixture(db, seedWorld(new MemoryApiStore()));
    const store = new SqlApiStore(failing(db.client, '23503', undefined, constraint));
    await expect(store.updateResponderTemplate({ id: 'rt_x', expectedVersion: 0, proposal: { name: 'n', members: ['ct_haeun'] }, previewHash: 'h', actorId: 'usr_minjae', at: AT }, audit(null))).rejects.toThrow(/simulated/);
    await expect(store.setCustomerTemplate({ customerId: 'cus_mirae', toTemplateId: null, expectedVersion: 0, previewHash: 'h', actorId: 'usr_minjae', at: AT }, audit('cus_mirae'))).rejects.toThrow(/simulated/);
  });

  it('any other error still surfaces', async () => {
    await sqlFixture(db, seedWorld(new MemoryApiStore()));
    const store = new SqlApiStore(failing(db.client, '22P02'));
    await expect(store.updateResponderTemplate({ id: 'rt_x', expectedVersion: 0, proposal: { name: 'n', members: ['ct_haeun'] }, previewHash: 'h', actorId: 'usr_minjae', at: AT }, audit(null))).rejects.toThrow(/simulated/);
  });
});

describe('template impact input: time under the customer locks', () => {
  it('reads every customer\'s paging context in a constant number of statements', async () => {
    const withCustomers = async (n: number): Promise<number> => {
      const seed = seedWorld(new MemoryApiStore()) as MemoryApiStore;
      seed.templates.set('rt_t', { id: 'rt_t', name: 'T', version: 0, updatedBy: null, updatedAt: AT, members: ['ct_haeun'] });
      seed.customerTemplate.set('cus_mirae', 'rt_t');
      for (let i = 0; i < n - 1; i++) { seed.customers.set(`cus_n${i}`, { id: `cus_n${i}`, name: `N${i}`, slug: `n${i}` }); seed.customerTemplate.set(`cus_n${i}`, 'rt_t'); }
      const fx = await sqlFixture(db, seed);
      let n_ = 0;
      const counting: SqlClient = { ...db.client, query: (t, p) => db.client.query(t, p), now: () => db.client.now(), transaction: (fn) => db.client.transaction((tx) => fn({ query: (t, p) => { n_++; return tx.query(t as never, p as never) as never; } })) } as SqlClient;
      const input = await new SqlApiStore(counting).responderTemplateImpactInput('rt_t', ['ct_haeun', 'ct_junho']);
      expect(input?.customers).toHaveLength(n);
      for (const c of input!.customers) expect(c.paging?.world.customerId).toBe(c.id);
      void fx;
      return n_;
    };
    const [few, many] = [await withCustomers(1), await withCustomers(6)];
    expect(many).toBe(few);
  });
});
