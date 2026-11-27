/**
 * The same rotation, the same clock, in the memory store and the SQL store: the previewHash is the same, and it does not carry
 * anything the stores make up on their own (pin ids, createdAt).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryApiStore } from '../../api/src/index.js';
import { rworld, ADMIN, type RWorld } from '../../api/test/contract/rotationsContract.js';
import { body } from '../../api/test/helpers.js';
import { memoryFixture } from '../../core/test/contract/fixture.js';
import { openTestDb, type TestDb } from './db.js';
import { sqlFixture } from './sqlFixture.js';

let db: TestDb;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

const REORDER = { members: ['ct_haeun', 'ct_minjae', 'ct_junho'] };
const LATE = { handover: { minute: 600 } };

describe('previewHash is the same in both stores', () => {
  let mem: RWorld | undefined, sql: RWorld | undefined;
  const both = async () => {
    mem = await rworld(async (seed) => memoryFixture(seed as MemoryApiStore));
    sql = await rworld((seed) => sqlFixture(db, seed));
    return [mem, sql] as const;
  };
  const hash = async (w: RWorld, proposal: unknown) => { const r = await w.call(ADMIN, 'POST', '/rotations/rot_abc/preview', { body: proposal }); expect(r.status).toBe(200); return body(r).previewHash as string; };
  const closeBoth = async () => { await mem?.fx.close(); await sql?.fx.close(); };

  it('same fixture and same now: equal hashes for an order change and for a handover change', async () => {
    try {
      const [m, s] = await both();
      for (const proposal of [REORDER, LATE, { name: 'Renamed' }]) {
        const [a, b] = [await hash(m, proposal), await hash(s, proposal)];
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(a).toBe(b);
      }
    } finally { await closeBoth(); }
  });

  it('pin ids and createdAt are not part of the hash: after the same plan is saved in both stores (different ids, different clocks), the next preview still hashes the same', async () => {
    try {
      const [m, s] = await both();
      for (const w of [m, s]) {
        const r = await w.call(ADMIN, 'PATCH', '/rotations/rot_abc', { body: { ...LATE, previewHash: await hash(w, LATE) }, headers: { 'if-match': '0' } });
        expect(r.status).toBe(200);
      }
      // the SQL row got a generated id and the database clock; the memory row a counter id. Make the clocks differ on purpose.
      s.setNow(new Date(s.now.getTime() + 5 * 60_000));
      m.setNow(new Date(m.now.getTime() + 5 * 60_000));
      expect((await m.fx.rotationPins!('rot_abc')).map((p) => [p.contactId, p.startAt, p.endAt])).toEqual((await s.fx.rotationPins!('rot_abc')).map((p) => [p.contactId, p.startAt, p.endAt]));
      for (const proposal of [REORDER, { name: 'Renamed' }]) expect(await hash(m, proposal)).toBe(await hash(s, proposal));
    } finally { await closeBoth(); }
  });
});
