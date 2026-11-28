/**
 * Rotation writes on the SQL store: retry-safe failures are 503 BUSY (Retry-After: 1) and wrote nothing; and DELETE /rotations/{id}
 * against PUT /customers/{id}/paging (a step that names the rotation) ends one way or the other, never with a step that points at nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type ApiResponse, type MemoryApiStore } from '../../api/src/index.js';
import { rworld, ADMIN, kst } from '../../api/test/contract/rotationsContract.js';
import { body } from '../../api/test/helpers.js';
import { config, step } from '../../core/test/world.js';
import { SqlApiStore, type SqlClient, type SqlExecutor } from '../src/index.js';
import { openTestDb, type TestDb } from './db.js';
import { sqlFixture } from './sqlFixture.js';

let db: TestDb;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

/** A client whose transactions fail with a Postgres error code at the first statement matching `when` (really rolled back). */
function failing(client: SqlClient, code: string, when: RegExp, constraint?: string): SqlClient {
  return {
    ...client,
    query: (t, p) => client.query(t, p),
    now: () => client.now(),
    transaction: (fn) => client.transaction((tx: SqlExecutor) => fn({
      query: (t, p) => { if (when.test(t)) throw Object.assign(new Error(`simulated ${code}`), { code, ...(constraint ? { constraint } : {}) }); return tx.query(t as never, p as never) as never; },
    })),
  } as SqlClient;
}
const im = (v: number) => ({ 'if-match': String(v) });
const make: Parameters<typeof rworld>[0] = (seed) => sqlFixture(db, seed);
const header = (r: ApiResponse, name: string): string | undefined => Object.entries(r.headers).find(([k]) => k.toLowerCase() === name)?.[1] as string | undefined;

const INSERT_MEMBER = /INSERT INTO "RotationMember"/;
const INSERT_PIN = /INSERT INTO "RotationPin"/;
// PATCH bodies: a member change writes RotationMember rows; a later handover (09:00 -> 10:00) writes a RotationPin row for the person on shift.
const MEMBERS = { members: ['ct_haeun', 'ct_minjae', 'ct_junho'] };
const HANDOVER = { handover: { minute: 600 } };

describe('rotation PATCH: retry-safe failures are BUSY', () => {
  const attempt = async (code: string, when: RegExp, proposal: Record<string, unknown>, constraint?: string) => {
    const w = await rworld(make);
    try {
      const before = JSON.stringify(await w.fx.rotationCounts!());
      const p = await w.call(ADMIN, 'POST', '/rotations/rot_abc/preview', { body: proposal });
      expect(p.status).toBe(200);
      const store = new SqlApiStore(failing(db.client, code, when, constraint));
      const api = createApi({ repo: store, now: () => w.now });
      const r = await api.handle({ method: 'PATCH', path: '/rotations/rot_abc', auth: ADMIN, body: { ...proposal, previewHash: body(p).previewHash }, headers: im(0), requestId: 'req_busy' });
      expect(JSON.stringify(await w.fx.rotationCounts!())).toBe(before);
      expect((await w.fx.rotationRow!('rot_abc'))!.version).toBe(0);
      expect(await w.fx.rotationPins!('rot_abc')).toEqual([]);
      return r;
    } finally { await w.fx.close(); }
  };

  it.each([
    ['23503', INSERT_MEMBER, MEMBERS, 'RotationMember_contactId_fkey'],
    ['23503', INSERT_PIN, HANDOVER, 'RotationPin_contactId_fkey'],
    ['40P01', INSERT_MEMBER, MEMBERS, undefined], ['40001', INSERT_MEMBER, MEMBERS, undefined], ['55P03', INSERT_MEMBER, MEMBERS, undefined], ['57014', INSERT_MEMBER, MEMBERS, undefined],
    ['40P01', INSERT_PIN, HANDOVER, undefined], ['40001', INSERT_PIN, HANDOVER, undefined], ['55P03', INSERT_PIN, HANDOVER, undefined], ['57014', INSERT_PIN, HANDOVER, undefined],
  ] as const)('%s on %s is 503 BUSY with Retry-After: 1 and nothing is written', async (code, when, proposal, constraint) => {
    const r = await attempt(code, when, proposal as Record<string, unknown>, constraint);
    expect([r.status, body(r).error.code, header(r, 'retry-after')]).toEqual([503, 'BUSY', '1']);
  });

  it.each([undefined, 'RotationMember_rotationId_fkey', 'Responder_contactId_fkey'])('a 23503 on another constraint (%s) is a 500, not BUSY', async (constraint) => {
    const r = await attempt('23503', INSERT_MEMBER, MEMBERS, constraint);
    expect(r.status).toBe(500);
  });

  it('any other error code is a 500', async () => {
    expect((await attempt('22P02', INSERT_MEMBER, MEMBERS)).status).toBe(500);
  });
});

describe('DELETE /rotations/{id} against PUT /customers/{id}/paging', () => {
  it('every run ends as (DELETE 200 + PUT 400 on steps[0].targetId) or (PUT 200 + DELETE 409 IN_USE); no step is left pointing at a missing rotation', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const w = await rworld(make, (s) => {
        s.rotations.set('rot_race', { id: 'rot_race', scope: 'MSP', customerId: null, name: 'Race desk', cadence: 'DAILY', anchorAt: kst('2026-11-09T09:00'), handoverDow: 1, handoverMin: 0,
          members: [{ contactId: 'ct_haeun', order: 0 }, { contactId: 'ct_junho', order: 1 }] } as never);
        s.configs.splice(s.configs.findIndex((c) => c.customerId === 'cus_mirae'), 1, config('cus_mirae', [step(0, 0, 'ALL_RESPONDERS', null, ['SMS'])], { style: 'ALL_AT_ONCE' }));
      });
      try {
        const other = createApi({ repo: w.fx.secondRunner(), now: () => w.now });
        const putBody = { style: 'CUSTOM', plan: 'STANDARD', repeatCount: 0, steps: [{ atMin: 0, targetType: 'ROTATION', targetId: 'rot_race', channels: ['SMS'] }] };
        const [del, put] = await Promise.all([
          w.call(ADMIN, 'DELETE', '/rotations/rot_race', { headers: im(0) }),
          other.handle({ method: 'PUT', path: '/customers/cus_mirae/paging', auth: ADMIN, body: putBody, headers: im(1), requestId: `req_put_${i}` }),
        ]);
        if (del.status === 200) {
          expect(put.status).toBe(400);
          expect(JSON.stringify(body(put).error.details.fields)).toContain('steps[0].targetId');
          seen.add('delete-first');
        } else {
          expect([del.status, body(del).error.code, put.status]).toEqual([409, 'IN_USE', 200]);
          seen.add('put-first');
        }
        const sql = (w.fx as unknown as { sql: SqlClient }).sql;
        const orphans = await sql.query(`SELECT count(*)::int AS n FROM "EscalationStep" s WHERE s."targetType" = 'ROTATION' AND NOT EXISTS (SELECT 1 FROM "Rotation" r WHERE r."id" = s."targetId")`);
        expect(orphans[0]!.n).toBe(0);
      } finally { await w.fx.close(); }
    }
    expect(seen.size).toBeGreaterThan(0);
  }, 120_000);
});
