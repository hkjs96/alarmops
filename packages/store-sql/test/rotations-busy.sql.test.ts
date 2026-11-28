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

const INSERT_ROTATION = /INSERT INTO "Rotation"\(/;
const RENAME_ROTATION = /UPDATE "Rotation" SET "name"/;
const NAME_KEY = 'Rotation_customerId_name_key';

describe('a unique violation on a rotation write is a taken name only when it is the name constraint', () => {
  const run = async (when: RegExp, constraint: string | undefined, act: (api: ReturnType<typeof createApi>, w: Awaited<ReturnType<typeof rworld>>) => Promise<ApiResponse>) => {
    const w = await rworld(make);
    try {
      const before = JSON.stringify(await w.fx.rotationCounts!());
      const api = createApi({ repo: new SqlApiStore(failing(db.client, '23505', when, constraint)), now: () => w.now });
      const r = await act(api, w);
      expect(JSON.stringify(await w.fx.rotationCounts!())).toBe(before);
      return r;
    } finally { await w.fx.close(); }
  };
  const create = (api: ReturnType<typeof createApi>) => api.handle({ method: 'POST', path: '/rotations', auth: ADMIN, requestId: 'req_u1',
    body: { scope: 'MSP', name: 'Weekend desk', cadence: 'DAILY', handover: { minute: 540 }, members: ['ct_haeun', 'ct_junho'] } });
  const rename = (api: ReturnType<typeof createApi>) => api.handle({ method: 'PATCH', path: '/rotations/rot_abc', auth: ADMIN, body: { name: 'Renamed desk' }, headers: im(0), requestId: 'req_u2' });

  it('POST: 23505 on Rotation_customerId_name_key is 409 ALREADY_EXISTS', async () => {
    const r = await run(INSERT_ROTATION, NAME_KEY, (api) => create(api));
    expect([r.status, body(r).error.code]).toEqual([409, 'ALREADY_EXISTS']);
  });
  it('PATCH rename: 23505 on Rotation_customerId_name_key is 409 ALREADY_EXISTS', async () => {
    const r = await run(RENAME_ROTATION, NAME_KEY, (api) => rename(api));
    expect([r.status, body(r).error.code]).toEqual([409, 'ALREADY_EXISTS']);
  });
  it.each([undefined, 'Rotation_pkey', 'RotationMember_pkey'])('POST and PATCH: 23505 on another constraint (%s) is a 500, not a taken name', async (constraint) => {
    expect((await run(INSERT_ROTATION, constraint, (api) => create(api))).status).toBe(500);
    expect((await run(RENAME_ROTATION, constraint, (api) => rename(api))).status).toBe(500);
  });
});

describe('members of a CUSTOMER rotation are checked under a lock on their Responder rows', () => {
  it('a create reads the Responder rows FOR SHARE (a concurrent delete or NOTIFY_ONLY change cannot slip past the check)', async () => {
    const w = await rworld(make);
    try {
      const seen: string[] = [];
      const spy: SqlClient = {
        ...db.client, query: (t, p) => db.client.query(t, p), now: () => db.client.now(),
        transaction: (fn) => db.client.transaction((tx: SqlExecutor) => fn({ query: (t, p) => { seen.push(t); return tx.query(t as never, p as never) as never; } })),
      } as SqlClient;
      const api = createApi({ repo: new SqlApiStore(spy), now: () => w.now });
      const c = await api.handle({ method: 'POST', path: '/rotations', auth: ADMIN, requestId: 'req_l1',
        body: { scope: 'CUSTOMER', customerId: 'cus_hanbit', name: 'Hanbit night', cadence: 'WEEKLY', handover: { dow: 1, minute: 540 }, members: ['ct_dohyun', 'ct_sora'] } });
      expect(c.status).toBe(201);
      const lockedResponders = (t: string) => /FROM "Responder"/.test(t) && /FOR SHARE/.test(t) && !/EXISTS \(SELECT 1 FROM "Responder"/.test(t);
      expect(seen.filter(lockedResponders).length).toBeGreaterThan(0);
    } finally { await w.fx.close(); }
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
