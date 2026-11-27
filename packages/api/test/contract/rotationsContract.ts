/**
 * Contract suite of the Rotation API (D-28 shift handover, D-41 roles): GET /rotations/{id}/shifts|usage, POST /rotations,
 * POST /rotations/{id}/preview, PATCH|DELETE /rotations/{id} — the SAME tests against MemoryApiStore
 * (test/contract.memory.test.ts) and the SQL store (packages/store-sql/test/contract.api.test.ts).
 *
 * Expected values come from the criteria (issue text), not from running the implementation. Wire shapes the criteria leave open
 * are fixed in ONE place each (`rowsOf`, `usageRows`, `pinList`, the proposal bodies); change them there if the contract names them differently:
 *  - rotation body: { id, scope, customerId, name, cadence, handover: { dow?, minute }, members: [{ contactId, name }], version, onShift: { contactId, name, until }, next }
 *  - POST body: { scope, customerId?, name, cadence, handover: { dow?, minute }, members: [contactId, ...] } (PATCH/preview: any of name, cadence, handover, members)
 *  - handover.minute = minutes after midnight KST, handover.dow = 0 (Sun) ... 6 (Sat)
 *  - preview: { previewHash, rows: [{ start, end, before: { contactId }, after: { contactId }, changed }], nextShift: { before, after }, totals: { changedRows } }
 *  - shifts: { rows: [{ start, end, contactId, pinned, overrides: [{ status }] }] }; usage: { customers: [{ id, name, nodes: [{ level, id, name, stepIndex }] }] }
 *  - memory store extras the seed uses: Rotation.handoverDow / handoverMin / version, MemoryApiStore.rotationPins (see fixture.ts rotationPins)
 *
 * World (now = Tue 2026-11-10 12:00 KST): MSP rotation rot_abc = DAILY [A=Haeun, B=Junho, C=Minjae], handover 09:00 KST, stored handoverDow=1 / handoverMin=0 and
 * anchorAt Mon 09:00 KST; B is on shift. Mirae's call order pages rot_abc first. Hanbit has its own WEEKLY rotation (rot_hanbit) and pages rot_abc second.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TickRepository } from '@alarmops/core';
import type { MakeFixture, StoreFixture } from '../../../core/test/contract/fixture.js';
import { CSim } from '../../../core/test/contract/tickContract.js';
import { config, seedWorld, step } from '../../../core/test/world.js';
import { createApi, MemoryApiStore, type ApiRepository, type ApiRequest, type ApiResponse, type AuthContext } from '../../src/index.js';
import { USERS, body } from '../helpers.js';

type Repo = TickRepository & ApiRepository;
type Call = (auth: AuthContext | null, method: ApiRequest['method'], path: string, opts?: { query?: Record<string, string | undefined>; body?: unknown; headers?: Record<string, string> }) => Promise<ApiResponse>;
export interface RWorld { fx: StoreFixture<Repo>; sim: CSim; call: Call; setNow(d: Date): void; readonly now: Date }

// time (Asia/Seoul = UTC+9, no DST)
export const kst = (s: string): Date => new Date(`${s}:00+09:00`); // '2026-11-10T12:00'
export const TUE12 = kst('2026-11-10T12:00');
const TUE09 = kst('2026-11-10T09:00'), WED09 = kst('2026-11-11T09:00'), WED10 = kst('2026-11-11T10:00'), THU09 = kst('2026-11-12T09:00'), THU10 = kst('2026-11-12T10:00'), FRI10 = kst('2026-11-13T10:00');
const DAY = 86_400_000;
const hm = (d: Date): string => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(11, 16);
const iso = (d: Date): string => d.toISOString();

const A = 'ct_haeun', B = 'ct_junho', C = 'ct_minjae';
const NAME: Record<string, string> = { ct_haeun: 'Haeun Kim', ct_junho: 'Junho Park', ct_minjae: 'Minjae Lee' };

export const ADMIN = USERS.minjae;
const OPER = USERS.haeun;
const VIEW = USERS.viewer;
const PORTAL = { ...USERS.yuna, role: 'ADMIN' } as AuthContext; // the stored role is ADMIN: it must not matter
const nList = (role: AuthContext['role'] = 'ADMIN', ids: string[] = ['cus_mirae']): AuthContext => ({ ...ADMIN, role, customerIds: ids });
const nSub = (role: AuthContext['role'] = 'ADMIN', customerId = 'cus_mirae', projectId = 'prj_core'): AuthContext => ({ ...ADMIN, role, customerIds: '*', subScopes: [{ customerId, projectId }] });
const im = (v: number | string) => ({ 'if-match': String(v) });

export async function rworld(make: MakeFixture<Repo>, customize?: (seed: MemoryApiStore) => void): Promise<RWorld> {
  const seed = seedWorld(new MemoryApiStore()) as MemoryApiStore;
  for (const [id, name, contactId, role] of [['usr_minjae', 'Minjae Lee', 'ct_minjae', 'ADMIN'], ['usr_haeun', 'Haeun Kim', 'ct_haeun', 'OPERATOR']] as const) {
    seed.users.set(id, { id, name, contactId, email: `${id}@example.test`, role, customerId: null });
  }
  seed.rotations.set('rot_abc', { id: 'rot_abc', scope: 'MSP', customerId: null, name: 'ABC desk', cadence: 'DAILY', anchorAt: kst('2026-11-09T09:00'), handoverDow: 1, handoverMin: 0,
    members: [{ contactId: A, order: 0 }, { contactId: B, order: 1 }, { contactId: C, order: 2 }] } as never);
  seed.configs.push(
    config('cus_mirae', [step(0, 0, 'ROTATION', 'rot_abc', ['SMS'])], { style: 'SHARED_ROTATION' }),
    config('cus_hanbit', [step(0, 0, 'ROTATION', 'rot_hanbit', ['SMS']), step(1, 10, 'ROTATION', 'rot_abc', ['SMS'])], { style: 'CUSTOM' }),
  );
  customize?.(seed);
  const fx = await make(seed);
  const sim = new CSim(fx);
  sim.now = TUE12;
  const api = createApi({ repo: fx.repo, now: () => sim.now });
  let seq = 0;
  return {
    fx, sim, get now() { return sim.now; }, setNow: (d) => { sim.now = d; },
    call: (auth, method, path, o = {}) => api.handle({ method, path, auth, query: o.query, body: o.body, headers: o.headers, requestId: `req_${++seq}` }),
  };
}

/** Hanbit does not page rot_abc (so another customer can add that step later). */
const withoutHanbitAbc = (seed: MemoryApiStore): void => {
  const i = seed.configs.findIndex((c) => c.customerId === 'cus_hanbit');
  seed.configs[i] = config('cus_hanbit', [step(0, 0, 'ROTATION', 'rot_hanbit', ['SMS'])], { style: 'CUSTOM' });
};

const MSP_BODY = { scope: 'MSP', name: 'Weekend desk', cadence: 'DAILY', handover: { minute: 540 }, members: [A, B, C] };
const HANBIT_BODY = { scope: 'CUSTOMER', customerId: 'cus_hanbit', name: 'Hanbit night', cadence: 'WEEKLY', handover: { dow: 1, minute: 540 }, members: ['ct_dohyun', 'ct_sora'] };

const extraStaff = (n: number): string[] => Array.from({ length: n }, (_, i) => `ct_s${i}`);
/** n more active MSP staff (ct_s0..), same shape as the seeded MSP contact A. */
const addStaff = (s: MemoryApiStore, n: number): void => {
  for (const [i, id] of extraStaff(n).entries()) {
    s.contacts.set(id, { ...s.contacts.get(A)!, id, name: `Staff ${i}`, email: `s${i}@example.test`, phone: `+8210555${String(10000 + i)}`, slackUserId: `U_s${i}` });
  }
};

export function rotationsContract(make: MakeFixture<Repo>): void {
  let w: RWorld;
  const open = async (customize?: (s: MemoryApiStore) => void): Promise<RWorld> => { await w?.fx.close(); return (w = await rworld(make, customize)); };
  afterEach(async () => { await w?.fx.close(); });

  const counts = async () => JSON.stringify(await w.fx.rotationCounts!());
  const err = (r: ApiResponse) => body(r).error as { code: string; message: string; details: any };
  const fieldsOf = (r: ApiResponse): string[] => (err(r).details?.fields ?? []).map((f: { field: string }) => f.field);
  const hasField = (r: ApiResponse, f: string): boolean => fieldsOf(r).some((x) => x === f || x.startsWith(`${f}.`) || x.startsWith(`${f}[`));
  const expectNone = async (before: string): Promise<void> => { expect(await counts()).toBe(before); };

  const pv = (id: string, b: unknown, auth: AuthContext = ADMIN) => w.call(auth, 'POST', `/rotations/${id}/preview`, { body: b });
  const patch = (id: string, b: unknown, version: number | string, auth: AuthContext = ADMIN) => w.call(auth, 'PATCH', `/rotations/${id}`, { body: b, headers: im(version) });
  /** preview, then PATCH with that previewHash. */
  const apply = async (id: string, b: Record<string, unknown>, version: number): Promise<ApiResponse> => {
    const p = await pv(id, b);
    expect(p.status).toBe(200);
    return patch(id, { ...b, previewHash: body(p).previewHash }, version);
  };
  const rowsOf = async (id: string, from: Date, to: Date, auth: AuthContext = ADMIN): Promise<Array<{ start: string; end: string; contactId: string; pinned: boolean }>> => {
    const r = await w.call(auth, 'GET', `/rotations/${id}/shifts`, { query: { from: iso(from), to: iso(to) } });
    expect(r.status).toBe(200);
    return body(r).rows;
  };
  const whoAt = (rows: Array<{ start: string; end: string; contactId: string }>, t: Date): string | undefined =>
    rows.find((r) => new Date(r.start).getTime() <= t.getTime() && t.getTime() < new Date(r.end).getTime())?.contactId;
  const pinList = async (id: string) => (await w.fx.rotationPins!(id)).map((p) => [p.contactId, iso(p.startAt), iso(p.endAt)]);
  const noOverlap = async (id: string): Promise<void> => {
    const pins = await w.fx.rotationPins!(id);
    for (let i = 1; i < pins.length; i++) expect(pins[i]!.startAt.getTime()).toBeGreaterThanOrEqual(pins[i - 1]!.endAt.getTime());
  };
  const usageRows = (b: any): string[][] => b.customers.flatMap((c: any) => c.nodes.map((n: any) => [c.id, n.level, n.id, String(n.stepIndex)]));
  const getRot = async (id: string) => {
    const r = await w.call(ADMIN, 'GET', '/rotations');
    expect(r.status).toBe(200);
    return body(r).find((x: any) => x.id === id);
  };
  /** Opens a new Mirae incident at `t` (a fresh severity each time) and returns who its ROTATION step resolved to first. */
  let sevN = 0;
  const openAt = async (t: Date): Promise<string | undefined> => {
    const sev = (['SEV_1', 'SEV_2', 'SEV_3', 'SEV_4', 'SEV_5'] as const)[sevN++ % 5]!;
    w.setNow(t);
    await w.sim.group({ customerId: 'cus_mirae', severity: sev, at: t, alerts: [{ id: `al_rot_${sevN}` }] });
    await w.sim.tick();
    const inc = (await w.fx.incidents()).at(-1)!;
    const snap = typeof inc.assignmentSnapshot === 'string' ? JSON.parse(inc.assignmentSnapshot) : inc.assignmentSnapshot;
    return snap.steps.find((s: any) => s.targetType === 'ROTATION').resolved[0]?.contactId;
  };

  // ---------------------------------------------------------------- tenancy and roles
  describe('portal users get the one 404 (stored role ADMIN or not), nothing is written', () => {
    it('every endpoint, same body, row counts unchanged', async () => {
      await open();
      const before = await counts();
      const calls: Array<[ApiRequest['method'], string, unknown]> = [
        ['GET', '/rotations/rot_abc/shifts', undefined], ['GET', '/rotations/rot_abc/usage', undefined], ['POST', '/rotations', MSP_BODY], ['POST', '/rotations/rot_abc/preview', { members: [A, C, B] }],
        ['PATCH', '/rotations/rot_abc', { name: 'x' }], ['DELETE', '/rotations/rot_abc', undefined],
      ];
      const seen = new Set<string>();
      for (const [m, p, b] of calls) {
        const r = await w.call(PORTAL, m, p, { body: b, headers: im(0) });
        expect(r.status, `${m} ${p}`).toBe(404);
        seen.add(`${err(r).code}|${err(r).message}`);
      }
      expect(seen.size).toBe(1);
      await expectNone(before);
    });

    it('POST /rotations: no body, no scope, a wrong scope or a valid body are all the same 404, never 400', async () => {
      await open();
      const before = await counts();
      const seen = new Set<string>();
      for (const b of [undefined, {}, { ...MSP_BODY, scope: undefined }, { ...MSP_BODY, scope: 'GLOBAL' }, MSP_BODY, HANBIT_BODY]) {
        const r = await w.call(PORTAL, 'POST', '/rotations', { body: b });
        expect(r.status).toBe(404);
        seen.add(`${err(r).code}|${err(r).message}`);
      }
      expect(seen.size).toBe(1);
      await expectNone(before);
    });
  });

  describe('MSP rotation writes: ROLE_REQUIRED for full-scope VIEWER/OPERATOR, FORBIDDEN for narrowed staff', () => {
    const attempts = (): Array<[ApiRequest['method'], string, unknown]> => [
      ['POST', '/rotations', MSP_BODY], ['PATCH', '/rotations/rot_abc', { name: 'x' }], ['DELETE', '/rotations/rot_abc', undefined], ['POST', '/rotations/rot_abc/preview', { members: [A, C, B] }],
    ];
    it('VIEWER and OPERATOR with full scope: 403 ROLE_REQUIRED, details.role ADMIN, nothing written or audited', async () => {
      await open();
      const before = await counts();
      for (const who of [VIEW, OPER]) for (const [m, p, b] of attempts()) {
        const r = await w.call(who, m, p, { body: b, headers: im(0) });
        expect([r.status, err(r).code, err(r).details.role], `${who.role} ${m} ${p}`).toEqual([403, 'ROLE_REQUIRED', 'ADMIN']);
      }
      await expectNone(before);
    });
    it('narrowed staff, VIEWER or ADMIN (customer list or project scope): 403 FORBIDDEN, a different code from ROLE_REQUIRED', async () => {
      await open();
      const before = await counts();
      for (const who of [nList('VIEWER'), nList('ADMIN'), nSub('VIEWER'), nSub('ADMIN')]) for (const [m, p, b] of attempts()) {
        const r = await w.call(who, m, p, { body: b, headers: im(0) });
        expect([r.status, err(r).code], `${who.role} ${JSON.stringify(who.subScopes ?? who.customerIds)} ${m} ${p}`).toEqual([403, 'FORBIDDEN']);
      }
      await expectNone(before);
    });
    it('check order on PATCH: narrowed VIEWER without If-Match is FORBIDDEN; full VIEWER without If-Match is ROLE_REQUIRED (not 400); full ADMIN on an unknown id is 404', async () => {
      await open();
      const before = await counts();
      for (const who of [nList('VIEWER'), nSub('VIEWER')]) {
        const r = await w.call(who, 'PATCH', '/rotations/rot_abc', { body: { name: 'x' } });
        expect([r.status, err(r).code]).toEqual([403, 'FORBIDDEN']);
      }
      const v = await w.call(VIEW, 'PATCH', '/rotations/rot_abc', { body: { name: 'x' } });
      expect([v.status, err(v).code, err(v).details.role]).toEqual([403, 'ROLE_REQUIRED', 'ADMIN']);
      const missing = await w.call(ADMIN, 'PATCH', '/rotations/rot_nope', { body: { name: 'x' }, headers: im(0) });
      expect(missing.status).toBe(404);
      await expectNone(before);
    });
    it('POST check order: full VIEWER/OPERATOR is ROLE_REQUIRED for no body, no scope and a valid body; narrowed staff: no scope 400 on scope, MSP 403 FORBIDDEN, a hidden customer 404', async () => {
      await open();
      const before = await counts();
      for (const who of [VIEW, OPER]) for (const b of [undefined, {}, { name: 'x' }, MSP_BODY]) {
        const r = await w.call(who, 'POST', '/rotations', { body: b });
        expect([r.status, err(r).code, err(r).details.role]).toEqual([403, 'ROLE_REQUIRED', 'ADMIN']);
      }
      for (const who of [nList('ADMIN'), nList('VIEWER')]) {
        const noScope = await w.call(who, 'POST', '/rotations', { body: { ...MSP_BODY, scope: undefined } });
        expect([noScope.status, err(noScope).code, hasField(noScope, 'scope')]).toEqual([400, 'VALIDATION_FAILED', true]);
        const msp = await w.call(who, 'POST', '/rotations', { body: MSP_BODY });
        expect([msp.status, err(msp).code]).toEqual([403, 'FORBIDDEN']);
        const hidden = await w.call(who, 'POST', '/rotations', { body: HANBIT_BODY });
        expect(hidden.status).toBe(404);
      }
      await expectNone(before);
    });
  });

  describe('CUSTOMER rotations', () => {
    it('the customer\'s full-scope ADMIN creates, edits and deletes; a project-scoped ADMIN and an ADMIN of another customer get the same 404 as for an unknown id (not FORBIDDEN); a full-scope VIEWER is ROLE_REQUIRED', async () => {
      await open();
      const full = nList('ADMIN', ['cus_hanbit']);
      const post = await w.call(full, 'POST', '/rotations', { body: HANBIT_BODY });
      expect(post.status).toBe(201);
      const id = body(post).id as string;
      expect(body(post)).toMatchObject({ scope: 'CUSTOMER', customerId: 'cus_hanbit', name: 'Hanbit night', version: 0 });
      const p = await w.call(full, 'PATCH', `/rotations/${id}`, { body: { name: 'Hanbit night 2' }, headers: im(0) });
      expect([p.status, body(p).name, body(p).version]).toEqual([200, 'Hanbit night 2', 1]);
      const before = await counts();
      const unknown = await w.call(ADMIN, 'PATCH', '/rotations/rot_nope', { body: { name: 'x' }, headers: im(0) });
      expect(unknown.status).toBe(404);
      for (const who of [nSub('ADMIN', 'cus_hanbit', 'prj_shop'), nList('ADMIN', ['cus_mirae'])]) {
        for (const [m, path, b] of [['PATCH', `/rotations/${id}`, { name: 'zz' }], ['DELETE', `/rotations/${id}`, undefined], ['POST', `/rotations/${id}/preview`, { name: 'zz' }]] as const) {
          const r = await w.call(who, m, path, { body: b, headers: im(1) });
          expect([r.status, err(r).code, err(r).message], `${m} ${path}`).toEqual([404, err(unknown).code, err(unknown).message]);
        }
        const post2 = await w.call(who, 'POST', '/rotations', { body: { ...HANBIT_BODY, name: 'Another' } });
        expect(post2.status).toBe(404);
      }
      const viewer = nList('VIEWER', ['cus_hanbit']);
      for (const [m, path, b] of [['PATCH', `/rotations/${id}`, { name: 'zz' }], ['DELETE', `/rotations/${id}`, undefined], ['POST', '/rotations', { ...HANBIT_BODY, name: 'Another' }]] as const) {
        const r = await w.call(viewer, m, path, { body: b, headers: im(1) });
        expect([r.status, err(r).code, err(r).details.role], `${m} ${path}`).toEqual([403, 'ROLE_REQUIRED', 'ADMIN']);
      }
      await expectNone(before);
      const del = await w.call(full, 'DELETE', `/rotations/${id}`, { headers: im(1) });
      expect(del.status).toBe(200);
    });
  });

  describe('reads: shifts and usage', () => {
    it('MSP staff VIEWER, OPERATOR and ADMIN all read an MSP rotation (200); a hidden customer\'s rotation and an unknown id are the same 404', async () => {
      await open();
      for (const who of [VIEW, OPER, ADMIN]) for (const p of ['shifts', 'usage']) expect((await w.call(who, 'GET', `/rotations/rot_abc/${p}`)).status, `${who.role} ${p}`).toBe(200);
      const narrow = nList('VIEWER', ['cus_mirae']);
      for (const p of ['shifts', 'usage']) {
        const hidden = await w.call(narrow, 'GET', `/rotations/rot_hanbit/${p}`);
        const missing = await w.call(narrow, 'GET', `/rotations/rot_nope/${p}`);
        expect([hidden.status, err(hidden).code, err(hidden).message]).toEqual([404, err(missing).code, err(missing).message]);
      }
    });

    it('usage: ROTATION steps and the first step of a SHARED_ROTATION, per customer and node, stepIndex from 1', async () => {
      await open();
      const u = body(await w.call(ADMIN, 'GET', '/rotations/rot_abc/usage'));
      // Mirae: SHARED_ROTATION, step 1 on the customer node. Hanbit: second step of a custom order.
      expect(usageRows(u).sort()).toEqual([['cus_hanbit', 'CUSTOMER', 'cus_hanbit', '2'], ['cus_mirae', 'CUSTOMER', 'cus_mirae', '1']]);
      expect(usageRows(body(await w.call(ADMIN, 'GET', '/rotations/rot_hanbit/usage')))).toEqual([['cus_hanbit', 'CUSTOMER', 'cus_hanbit', '1']]);
    });

    it('a narrowed staff member reading an MSP rotation\'s usage sees only the visible customers; the hidden one leaves no id, name or count', async () => {
      await open();
      for (const who of [nList('VIEWER'), nSub('ADMIN')]) {
        const r = await w.call(who, 'GET', '/rotations/rot_abc/usage');
        expect(r.status).toBe(200);
        expect(usageRows(body(r))).toEqual([['cus_mirae', 'CUSTOMER', 'cus_mirae', '1']]);
        const text = JSON.stringify(body(r));
        for (const leak of ['cus_hanbit', 'Hanbit', 'hanbit']) expect(text).not.toContain(leak);
      }
    });

    it('shifts: default range DAILY 8 days / WEEKLY 28 days; bad ranges are 400; PENDING and ACCEPTED overrides show on the rows they overlap', async () => {
      await open();
      const d = body(await w.call(ADMIN, 'GET', '/rotations/rot_abc/shifts'));
      expect(new Date(d.rows[0].start).getTime()).toBeLessThanOrEqual(TUE12.getTime());
      expect(new Date(d.rows.at(-1).end).getTime()).toBeGreaterThanOrEqual(TUE12.getTime() + 8 * DAY);
      expect(new Date(d.rows.at(-1).start).getTime()).toBeLessThan(TUE12.getTime() + 8 * DAY);
      expect(d.rows.length).toBeGreaterThanOrEqual(8);
      expect(d.rows.length).toBeLessThanOrEqual(9);
      const wk = body(await w.call(ADMIN, 'GET', '/rotations/rot_hanbit/shifts'));
      expect(new Date(wk.rows.at(-1).end).getTime()).toBeGreaterThanOrEqual(TUE12.getTime() + 28 * DAY);
      expect(wk.rows.length).toBeGreaterThanOrEqual(4);
      expect(wk.rows.length).toBeLessThanOrEqual(5);
      const bad: Array<Record<string, string>> = [
        { from: iso(WED09), to: iso(TUE09) }, { from: iso(WED09), to: iso(WED09) }, { from: 'yesterday', to: iso(WED09) }, { from: iso(TUE09), to: 'soon' },
        { from: iso(TUE09), to: iso(new Date(TUE09.getTime() + 63 * DAY)) },
      ];
      for (const q of bad) expect((await w.call(ADMIN, 'GET', '/rotations/rot_abc/shifts', { query: q })).status, JSON.stringify(q)).toBe(400);
      expect((await w.call(ADMIN, 'GET', '/rotations/rot_abc/shifts', { query: { from: iso(TUE09), to: iso(new Date(TUE09.getTime() + 62 * DAY)) } })).status).toBe(200);
      await w.fx.addOverride!({ rotationId: 'rot_abc', contactId: A, startAt: WED09, endAt: THU09, status: 'PENDING' });
      await w.fx.addOverride!({ rotationId: 'rot_abc', contactId: A, startAt: THU09, endAt: kst('2026-11-13T09:00'), status: 'ACCEPTED' });
      const rows = body(await w.call(ADMIN, 'GET', '/rotations/rot_abc/shifts', { query: { from: iso(TUE09), to: iso(kst('2026-11-14T09:00')) } })).rows;
      const at = (t: Date) => rows.find((r: any) => new Date(r.start).getTime() === t.getTime());
      expect(at(TUE09).overrides ?? []).toHaveLength(0);
      expect(at(WED09).overrides.map((o: any) => o.status)).toEqual(['PENDING']);
      expect(at(THU09).overrides.map((o: any) => o.status)).toEqual(['ACCEPTED']);
    });
  });

  // ---------------------------------------------------------------- POST /rotations
  describe('POST /rotations', () => {
    it('a valid body is 201 with ETag "0"; members[0] is on shift now; one rotation.create audit row', async () => {
      await open();
      const r = await w.call(ADMIN, 'POST', '/rotations', { body: { ...MSP_BODY, members: [C, A, B] } });
      expect(r.status).toBe(201);
      expect(r.headers.etag).toBe('"0"');
      const b = body(r);
      expect(b).toMatchObject({ scope: 'MSP', name: 'Weekend desk', cadence: 'DAILY', version: 0 });
      expect(b.members[0].contactId).toBe(C);
      expect(b.onShift.contactId).toBe(C);
      expect(b.next).toBe(NAME[A]);
      const a = (await w.fx.audits()).filter((x) => x.action === 'rotation.create');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ actorId: 'usr_minjae', targetId: b.id });
    });

    it('the limits are inclusive: 50 real members and an 80-char name are 201; 51 real members is 400 members', async () => {
      await open((s) => { addStaff(s, 48); });
      const fifty = [A, B, C, ...extraStaff(47)];
      const ok = await w.call(ADMIN, 'POST', '/rotations', { body: { ...MSP_BODY, name: 'n'.repeat(80), members: fifty } });
      expect([ok.status, body(ok).members?.length, body(ok).name?.length]).toEqual([201, 50, 80]);
      const before = await counts();
      const over = await w.call(ADMIN, 'POST', '/rotations', { body: { ...MSP_BODY, name: 'Over limit', members: [...fifty, extraStaff(48)[47]] } });
      expect([over.status, err(over).code, hasField(over, 'members')]).toEqual([400, 'VALIDATION_FAILED', true]);
      await expectNone(before);
    });

    it('invalid bodies are 400 VALIDATION_FAILED on the named field and write nothing', async () => {
      await open((s) => { addStaff(s, 48); s.contacts.set('ct_off', { ...s.contacts.get(A)!, id: 'ct_off', name: 'Off Duty', email: 'off@example.test', phone: '+821077770001', slackUserId: 'U_off', active: false }); });
      const before = await counts();
      const fiftyOne = [A, B, C, ...extraStaff(48)]; // 51 real, active MSP staff: only the limit can reject this
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ['name empty', { ...MSP_BODY, name: '' }, 'name'], ['name 81', { ...MSP_BODY, name: 'n'.repeat(81) }, 'name'],
        ['cadence typo', { ...MSP_BODY, cadence: 'DAYLY' }, 'cadence'],
        ['minute 1440', { ...MSP_BODY, handover: { minute: 1440 } }, 'handover.minute'],
        ['WEEKLY no dow', { ...MSP_BODY, cadence: 'WEEKLY', handover: { minute: 540 } }, 'handover.dow'],
        ['DAILY with dow', { ...MSP_BODY, handover: { dow: 1, minute: 540 } }, 'handover.dow'],
        ['0 members', { ...MSP_BODY, members: [] }, 'members'], ['51 members', { ...MSP_BODY, members: fiftyOne }, 'members'], ['duplicate member', { ...MSP_BODY, members: [A, A] }, 'members'],
        ['customer person in MSP', { ...MSP_BODY, members: [A, 'ct_yuna'] }, 'members'],
        ['other customer\'s person', { ...HANBIT_BODY, members: ['ct_dohyun', 'ct_yuna'] }, 'members'],
        ['NOTIFY_ONLY person', { scope: 'CUSTOMER', customerId: 'cus_mirae', name: 'Mirae own', cadence: 'DAILY', handover: { minute: 540 }, members: ['ct_yuna', 'ct_seojun'] }, 'members'],
        ['inactive contact', { ...MSP_BODY, members: [A, 'ct_off'] }, 'members'],
        ['unknown key timezone', { ...MSP_BODY, timezone: 'UTC' }, 'timezone'], ['unknown key', { ...MSP_BODY, color: 'red' }, 'color'],
      ];
      for (const [label, b, field] of cases) {
        const r = await w.call(ADMIN, 'POST', '/rotations', { body: b });
        expect([r.status, err(r).code, hasField(r, field)], `${label}: ${JSON.stringify(fieldsOf(r))}`).toEqual([400, 'VALIDATION_FAILED', true]);
      }
      await expectNone(before);
    });

    it('an existing name in the same customer (MSP: among MSP rotations) is 409 ALREADY_EXISTS; the same name in another customer is fine', async () => {
      await open();
      const before = await counts();
      const dupMsp = await w.call(ADMIN, 'POST', '/rotations', { body: { ...MSP_BODY, name: 'ABC desk' } });
      expect([dupMsp.status, err(dupMsp).code]).toEqual([409, 'ALREADY_EXISTS']);
      const dupCus = await w.call(ADMIN, 'POST', '/rotations', { body: { ...HANBIT_BODY, name: 'Hanbit on-call' } });
      expect([dupCus.status, err(dupCus).code]).toEqual([409, 'ALREADY_EXISTS']);
      await expectNone(before);
      const other = await w.call(ADMIN, 'POST', '/rotations', { body: { scope: 'CUSTOMER', customerId: 'cus_mirae', name: 'Hanbit on-call', cadence: 'DAILY', handover: { minute: 540 }, members: ['ct_yuna'] } });
      expect(other.status).toBe(201);
    });
  });

  // ---------------------------------------------------------------- PATCH / DELETE basics
  describe('PATCH basics', () => {
    it('renaming onto another rotation\'s name in the same customer is 409 ALREADY_EXISTS (not 500), nothing written', async () => {
      await open();
      const before = await counts();
      const r = await patch('rot_abc', { name: 'MSP night desk' }, 0);
      expect([r.status, err(r).code]).toEqual([409, 'ALREADY_EXISTS']);
      await expectNone(before);
      const c = await w.call(ADMIN, 'POST', '/rotations', { body: { ...HANBIT_BODY, name: 'Second' } });
      const before2 = await counts();
      const r2 = await patch(body(c).id, { name: 'Hanbit on-call' }, 0);
      expect([r2.status, err(r2).code]).toEqual([409, 'ALREADY_EXISTS']);
      await expectNone(before2);
      expect((await w.fx.rotationRow!('rot_abc'))!.version).toBe(0);
    });

    it('a cadence different from the stored one is 400 on cadence (version and rows unchanged); the same cadence is no error; scope and customerId keys are unknown keys', async () => {
      await open();
      const before = await counts();
      const r = await patch('rot_abc', { cadence: 'WEEKLY' }, 0);
      expect([r.status, err(r).code, hasField(r, 'cadence')]).toEqual([400, 'VALIDATION_FAILED', true]);
      for (const extra of [{ scope: 'MSP' }, { customerId: 'cus_mirae' }, { scope: 'CUSTOMER', customerId: 'cus_mirae' }]) {
        const k = await patch('rot_abc', { name: 'ABC desk 2', ...extra }, 0);
        expect([k.status, err(k).code, Object.keys(extra).every((f) => hasField(k, f))]).toEqual([400, 'VALIDATION_FAILED', true]);
      }
      await expectNone(before);
      expect((await w.fx.rotationRow!('rot_abc'))!.version).toBe(0);
      const ok = await patch('rot_abc', { cadence: 'DAILY', name: 'ABC desk 2' }, 0);
      expect([ok.status, body(ok).version, body(ok).name]).toEqual([200, 1, 'ABC desk 2']);
    });

    it('If-Match: missing is 400 (field If-Match); a version that is not the current one is 409 VERSION_CONFLICT with details.currentVersion; PATCH and DELETE alike', async () => {
      await open();
      const created = body(await w.call(ADMIN, 'POST', '/rotations', { body: HANBIT_BODY }));
      const before = await counts();
      for (const [m, b] of [['PATCH', { name: 'x' }], ['DELETE', undefined]] as const) {
        const none = await w.call(ADMIN, m, `/rotations/${created.id}`, { body: b });
        expect([none.status, hasField(none, 'If-Match')], m).toEqual([400, true]);
        const stale = await w.call(ADMIN, m, `/rotations/${created.id}`, { body: b, headers: im(5) });
        expect([stale.status, err(stale).code, err(stale).details.currentVersion], m).toEqual([409, 'VERSION_CONFLICT', 0]);
      }
      await expectNone(before);
    });

    it('MSP rotation PATCH with members or handover needs a previewHash of 64 hex characters (400 on previewHash)', async () => {
      await open();
      const before = await counts();
      for (const b of [{ members: [A, C, B] }, { handover: { minute: 600 } }]) for (const hash of [undefined, 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
        const r = await patch('rot_abc', { ...b, previewHash: hash }, 0);
        expect([r.status, hasField(r, 'previewHash')], `${JSON.stringify(b)} ${hash}`).toEqual([400, true]);
      }
      await expectNone(before);
    });

    it('a PATCH that changes nothing (same name, member order, handover) is 200 and leaves version, AuditLog and RotationPin alone', async () => {
      await open();
      const same = { name: 'ABC desk', members: [A, B, C], handover: { minute: 540 } };
      const before = await counts();
      const r = await apply('rot_abc', same, 0);
      expect([r.status, body(r).version]).toEqual([200, 0]);
      await expectNone(before);
      expect((await w.fx.rotationRow!('rot_abc'))!.version).toBe(0);
      expect(await pinList('rot_abc')).toEqual([]);
    });
  });

  describe('DELETE', () => {
    it('a rotation any customer\'s step points at (ROTATION target) is 409 IN_USE with details.usage in the shape of GET usage; nothing is deleted', async () => {
      await open();
      const before = await counts();
      const usage = body(await w.call(ADMIN, 'GET', '/rotations/rot_abc/usage'));
      const r = await w.call(ADMIN, 'DELETE', '/rotations/rot_abc', { headers: im(0) });
      expect([r.status, err(r).code]).toEqual([409, 'IN_USE']);
      expect(err(r).details.usage).toEqual(usage);
      await expectNone(before);
    });

    it('a TERMINATED customer\'s step counts too', async () => {
      await open((s) => {
        s.customers.set('cus_old', { id: 'cus_old', name: 'Old Co', slug: 'old', status: 'TERMINATED' });
        s.rotations.set('rot_old', { id: 'rot_old', scope: 'MSP', customerId: null, name: 'Old desk', cadence: 'DAILY', anchorAt: kst('2026-11-09T09:00'), handoverDow: 1, handoverMin: 0,
          members: [{ contactId: A, order: 0 }, { contactId: B, order: 1 }] } as never);
        s.configs.push(config('cus_old', [step(0, 0, 'ROTATION', 'rot_old', ['SMS'])], { style: 'SHARED_ROTATION' }));
      });
      const before = await counts();
      const r = await w.call(ADMIN, 'DELETE', '/rotations/rot_old', { headers: im(0) });
      expect([r.status, err(r).code]).toEqual([409, 'IN_USE']);
      expect(usageRows(err(r).details.usage)).toEqual([['cus_old', 'CUSTOMER', 'cus_old', '1']]);
      await expectNone(before);
    });

    it('without references: 200, the rotation with its members, pins and overrides is gone, one rotation.delete audit row', async () => {
      await open();
      const c = body(await w.call(ADMIN, 'POST', '/rotations', { body: MSP_BODY }));
      const id = c.id as string;
      const base = JSON.parse(await counts());
      expect((await apply(id, { handover: { minute: 600 } }, 0)).status).toBe(200); // makes a pin
      await w.fx.addOverride!({ rotationId: id, contactId: B, startAt: WED09, endAt: THU09, status: 'PENDING' });
      expect((await w.fx.rotationPins!(id)).length).toBeGreaterThan(0);
      const r = await w.call(ADMIN, 'DELETE', `/rotations/${id}`, { headers: im(1) });
      expect(r.status).toBe(200);
      const after = JSON.parse(await counts());
      expect([after.Rotation, after.RotationMember, after.RotationPin, after.Override]).toEqual([base.Rotation - 1, base.RotationMember - 3, 0, 0]);
      expect((await w.fx.audits()).filter((a) => a.action === 'rotation.delete')).toHaveLength(1);
      expect(await w.fx.rotationRow!(id)).toBeNull();
    });
  });

  // ---------------------------------------------------------------- PUT /customers/{id}/paging against rotations
  describe('call order PUT keeps its rotation checks', () => {
    const put = (cid: string, targetId: string, version: number) => w.call(ADMIN, 'PUT', `/customers/${cid}/paging`, {
      body: { style: 'CUSTOM', plan: 'STANDARD', repeatCount: 0, steps: [{ atMin: 0, targetType: 'ROTATION', targetId, channels: ['SMS'] }] }, headers: im(version) });
    it('another customer\'s CUSTOMER rotation is 422 CROSS_CUSTOMER on steps[0].targetId; an unknown rotation is 400 "Unknown rotation."', async () => {
      await open();
      const x = await put('cus_mirae', 'rot_hanbit', 1);
      expect([x.status, err(x).code, err(x).details.field]).toEqual([422, 'CROSS_CUSTOMER', 'steps[0].targetId']);
      const u = await put('cus_mirae', 'rot_nope', 1);
      expect([u.status, err(u).code]).toEqual([400, 'VALIDATION_FAILED']);
      expect(err(u).details.fields[0]).toMatchObject({ field: 'steps[0].targetId', message: 'Unknown rotation.' });
    });
    it('a rotation that was just deleted is 400 on steps[0].targetId and the PagingConfig version stays', async () => {
      await open();
      const c = body(await w.call(ADMIN, 'POST', '/rotations', { body: MSP_BODY }));
      expect((await w.call(ADMIN, 'DELETE', `/rotations/${c.id}`, { headers: im(0) })).status).toBe(200);
      const r = await put('cus_mirae', c.id, 1);
      expect([r.status, hasField(r, 'steps[0].targetId')]).toEqual([400, true]);
      expect(body(await w.call(ADMIN, 'GET', '/customers/cus_mirae/paging')).version).toBe(1);
    });
  });

  // ---------------------------------------------------------------- handover, plan, preview
  describe('preview', () => {
    it('writes nothing, twice at the same time gives the same previewHash; row counts: 8 DAILY / 4 WEEKLY for a reorder, 15 for 09:00 -> 10:00', async () => {
      await open();
      const before = await counts();
      const p1 = await pv('rot_abc', { members: [A, C, B] });
      const p2 = await pv('rot_abc', { members: [A, C, B] });
      expect([p1.status, p2.status]).toEqual([200, 200]);
      expect(body(p1).previewHash).toMatch(/^[0-9a-f]{64}$/);
      expect(body(p1).previewHash).toBe(body(p2).previewHash);
      expect(body(p1).rows).toHaveLength(8);
      await expectNone(before);
      const wk = await pv('rot_hanbit', { members: ['ct_sora', 'ct_dohyun'] });
      expect([wk.status, body(wk).rows.length]).toEqual([200, 4]);
      const late = body(await pv('rot_abc', { handover: { minute: 600 } }));
      expect(late.rows).toHaveLength(15);
      const first = late.rows.slice(0, 3).map((r: any) => [new Date(r.start).getTime(), new Date(r.end).getTime(), r.before.contactId, r.after.contactId, r.changed]);
      expect(first).toEqual([
        [TUE09.getTime(), WED09.getTime(), B, B, false],
        [WED09.getTime(), WED10.getTime(), C, B, true],
        [WED10.getTime(), THU09.getTime(), C, C, false],
      ]);
      expect(late.nextShift.before).toMatchObject({ contactId: C, start: iso(WED09), end: iso(THU09) });
      expect(late.nextShift.after).toMatchObject({ contactId: C, start: iso(WED10), end: iso(THU10) });
      expect(late.totals.changedRows).toBe(late.rows.filter((r: any) => r.changed).length);
      await expectNone(before);
    });

    it('a previewHash is accepted as is: PATCH is 200, version + 1, one rotation.update and one rotation.apply per affected customer (with that customerId)', async () => {
      await open();
      const before = (await w.fx.audits()).length;
      const r = await apply('rot_abc', { members: [A, C, B] }, 0);
      expect([r.status, body(r).version]).toEqual([200, 1]);
      expect(r.headers.etag).toBe('"1"');
      const audits = (await w.fx.audits()).slice(before);
      expect(audits.filter((a) => a.action === 'rotation.update')).toHaveLength(1);
      const applied = audits.filter((a) => a.action === 'rotation.apply');
      expect(applied.map((a) => a.customerId).sort()).toEqual(['cus_hanbit', 'cus_mirae']);
    });
  });

  describe('previewHash goes stale (409 PREVIEW_STALE), or does not', () => {
    // [A,B,C] -> [A,C,B] at Tue 12:00 (B on shift). The new order from the current shift is B, A, C, B, A, C ...
    // k shifts after the current one the old holder is B, C, A, B, C, A ..., so k = 3, 6, 9 are B -> B and every other k differs.
    const proposal = { members: [A, C, B] };
    const run = async (mutate: (x: RWorld) => Promise<void>, expectStatus: 200 | 409): Promise<void> => {
      await open(withoutHanbitAbc);
      const p = body(await pv('rot_abc', proposal));
      await mutate(w);
      const before = await counts();
      const pinsBefore = await pinList('rot_abc');
      const r = await patch('rot_abc', { ...proposal, previewHash: p.previewHash }, 0);
      expect(r.status).toBe(expectStatus);
      if (expectStatus === 409) {
        expect([err(r).code, err(r).details.currentVersion]).toEqual(['PREVIEW_STALE', 0]);
        await expectNone(before);
        expect(await pinList('rot_abc')).toEqual(pinsBefore);
        expect((await w.fx.rotationRow!('rot_abc'))!.version).toBe(0);
      }
    };
    const ov = (start: string, end: string) => async (x: RWorld) => { await x.fx.addOverride!({ rotationId: 'rot_abc', contactId: A, startAt: kst(start), endAt: kst(end), status: 'PENDING' }); };

    it('(i) another customer saved a step that points at this rotation', async () => {
      await run(async (x) => {
        const put = await x.call(ADMIN, 'PUT', '/customers/cus_hanbit/paging', { headers: im(1), body: { style: 'CUSTOM', plan: 'STANDARD', repeatCount: 0, steps: [
          { atMin: 0, targetType: 'ROTATION', targetId: 'rot_hanbit', channels: ['SMS'] }, { atMin: 10, targetType: 'ROTATION', targetId: 'rot_abc', channels: ['SMS'] }] } });
        expect(put.status).toBe(200);
      }, 409);
    });
    it('(ii) a PENDING Override on a shift where the new holder differs from the old one: inside the window or far outside it', async () => {
      await run(ov('2026-11-11T09:00', '2026-11-12T09:00'), 409); // C -> A, in the window
      await run(ov('2026-11-20T09:00', '2026-11-21T09:00'), 409); // C -> A, 10 shifts out
    });
    it('(iii) a PENDING Override on a shift inside the window where old and new holder are the same (kept changes)', async () => {
      await run(ov('2026-11-13T09:00', '2026-11-14T09:00'), 409); // B -> B
    });
    it('(iv) the clock passed the end of the current shift', async () => {
      await run(async (x) => { x.setNow(new Date(WED09.getTime() + 60_000)); }, 409);
    });
    it('the one case that stays 200: outside the window and the same holder for the whole shift (B -> B); the next shift (C -> A) is stale', async () => {
      await run(ov('2026-11-19T09:00', '2026-11-20T09:00'), 200);
      await run(ov('2026-11-20T09:00', '2026-11-21T09:00'), 409);
    });
  });

  describe('plan of a handover/order change (D-28)', () => {
    it('order only: [A,B,C] -> [A,C,B] keeps B on shift with no pin and A next; removing B ([A,C]) pins B for the current shift and C is next', async () => {
      await open();
      const r = await apply('rot_abc', { members: [A, C, B] }, 0);
      expect(r.status).toBe(200);
      expect([body(r).onShift.contactId, body(r).onShift.until, body(r).next]).toEqual([B, iso(WED09), NAME[A]]);
      expect(await pinList('rot_abc')).toEqual([]);
      await open();
      const r2 = await apply('rot_abc', { members: [A, C] }, 0);
      expect(r2.status).toBe(200);
      expect([body(r2).onShift.contactId, body(r2).next]).toEqual([B, NAME[C]]);
      expect(await pinList('rot_abc')).toEqual([[B, iso(TUE09), iso(WED09)]]);
    });

    it('handover derived from the stored anchor, not from handoverMin: 09:00 -> 10:00 pins B [Tue 09:00, Wed 10:00) only; then C, A on the new boundaries', async () => {
      await open();
      expect(await w.fx.rotationRow!('rot_abc')).toMatchObject({ handoverDow: 1, handoverMin: 0 }); // stale column, the anchor says 09:00
      const r = await apply('rot_abc', { handover: { minute: 600 } }, 0);
      expect(r.status).toBe(200);
      expect(await pinList('rot_abc')).toEqual([[B, iso(TUE09), iso(WED10)]]);
      const rows = await rowsOf('rot_abc', TUE09, FRI10);
      expect(rows.map((x) => [x.start, x.end, x.contactId])).toEqual([[iso(TUE09), iso(WED10), B], [iso(WED10), iso(THU10), C], [iso(THU10), iso(FRI10), A]]);
      expect(rows[0]!.pinned).toBe(true);
      expect(rows[1]!.pinned).toBe(false);
      expect((await w.fx.rotationRow!('rot_abc'))!.version).toBe(1);
    });

    it('later handover (09:00 -> 10:00): B until Wed 10:00, C next; incidents opened Tue 12:00 / Wed 09:30 / Wed 10:00 page B, B, C', async () => {
      await open();
      expect((await apply('rot_abc', { handover: { minute: 600 } }, 0)).status).toBe(200);
      const g = await getRot('rot_abc');
      expect([g.onShift.contactId, g.onShift.until, g.next]).toEqual([B, iso(WED10), NAME[C]]);
      const got = [await openAt(TUE12), await openAt(kst('2026-11-11T09:30')), await openAt(WED10)];
      expect(got).toEqual([B, B, C]);
    });

    it('every path reads the pins the same: tick snapshot, /oncall/paging-path nowIds and /oncall/now rotations[].onShift at Wed 09:30 (inside the pin) all say B', async () => {
      await open();
      expect((await apply('rot_abc', { handover: { minute: 600 } }, 0)).status).toBe(200);
      const t = kst('2026-11-11T09:30');
      expect(await openAt(t)).toBe(B);
      const path = body(await w.call(ADMIN, 'GET', '/oncall/paging-path', { query: { customerId: 'cus_mirae' } }));
      expect(path.steps[0].nowIds).toEqual([B]);
      const now = body(await w.call(ADMIN, 'GET', '/oncall/now'));
      expect(now.rotations.find((r: any) => r.id === 'rot_abc').onShift.contactId).toBe(B);
    });

    it('every path reads the pins the same where the schedule and the pin differ: after 09:00 -> 08:00, Wed 08:30 is pin B (the schedule says C) in tick, paging-path nowIds and /oncall/now', async () => {
      await open();
      expect((await apply('rot_abc', { handover: { minute: 480 } }, 0)).status).toBe(200);
      const t = kst('2026-11-11T08:30');
      w.setNow(t);
      const path = body(await w.call(ADMIN, 'GET', '/oncall/paging-path', { query: { customerId: 'cus_mirae' } }));
      expect(path.steps[0].nowIds).toEqual([B]);
      const now = body(await w.call(ADMIN, 'GET', '/oncall/now'));
      expect(now.rotations.find((r: any) => r.id === 'rot_abc').onShift.contactId).toBe(B);
      expect(await openAt(t)).toBe(B);
      // and right after the pin the schedule takes over in all three
      const t2 = WED09;
      w.setNow(t2);
      expect(body(await w.call(ADMIN, 'GET', '/oncall/paging-path', { query: { customerId: 'cus_mirae' } })).steps[0].nowIds).toEqual([C]);
      expect(body(await w.call(ADMIN, 'GET', '/oncall/now')).rotations.find((r: any) => r.id === 'rot_abc').onShift.contactId).toBe(C);
      expect(await openAt(t2)).toBe(C);
    });

    it('earlier handover (09:00 -> 08:00): pin [Tue 09:00, Wed 09:00) B only; C has a short first shift [Wed 09:00, Thu 08:00), A [Thu 08:00, Fri 08:00); B until Wed 09:00, C next; incidents Wed 08:30 -> B, Wed 09:00 -> C', async () => {
      await open();
      expect((await apply('rot_abc', { handover: { minute: 480 } }, 0)).status).toBe(200);
      expect(await pinList('rot_abc')).toEqual([[B, iso(TUE09), iso(WED09)]]);
      const rows = await rowsOf('rot_abc', TUE09, kst('2026-11-13T08:00'));
      expect(rows.map((x) => [x.start, x.end, x.contactId])).toEqual([[iso(TUE09), iso(WED09), B], [iso(WED09), iso(kst('2026-11-12T08:00')), C], [iso(kst('2026-11-12T08:00')), iso(kst('2026-11-13T08:00')), A]]);
      const g = await getRot('rot_abc');
      expect([g.onShift.contactId, g.onShift.until, g.next]).toEqual([B, iso(WED09), NAME[C]]);
      expect([await openAt(kst('2026-11-11T08:30')), await openAt(WED09)]).toEqual([B, C]);
    });

    it('re-PATCH inside a pin after an earlier handover: members only keeps handover 08:00 (response, GET /rotations, stored anchorAt); A takes the short first shift [Wed 09:00, Thu 08:00), then C, B', async () => {
      await open();
      expect((await apply('rot_abc', { handover: { minute: 480 } }, 0)).status).toBe(200);
      const r = await apply('rot_abc', { members: [A, C, B] }, 1);
      expect(r.status).toBe(200);
      expect(body(r).handover.minute).toBe(480);
      expect((await getRot('rot_abc')).handover.minute).toBe(480);
      expect(hm((await w.fx.rotationRow!('rot_abc'))!.anchorAt)).toBe('08:00');
      const rows = await rowsOf('rot_abc', TUE09, kst('2026-11-14T08:00'));
      expect(rows.map((x) => [x.start, x.end, x.contactId])).toEqual([
        [iso(TUE09), iso(WED09), B], [iso(WED09), iso(kst('2026-11-12T08:00')), A], [iso(kst('2026-11-12T08:00')), iso(kst('2026-11-13T08:00')), C], [iso(kst('2026-11-13T08:00')), iso(kst('2026-11-14T08:00')), B]]);
      expect(body(r).onShift.contactId).toBe(B);
      expect([await openAt(WED09), await openAt(kst('2026-11-12T08:00'))]).toEqual([A, C]);
    });

    it('a cover request on the next old shift protects it: later handover keeps C on [Wed 09:00, Thu 09:00) (KEEP_OVERRIDE pin), C also holds [Thu 09:00, Thu 10:00), A starts Thu 10:00; ACCEPTED gives the same pins', async () => {
      const scenario = async (status: 'PENDING' | 'ACCEPTED') => {
        await open();
        await w.fx.addOverride!({ rotationId: 'rot_abc', contactId: A, startAt: WED09, endAt: THU09, status });
        expect((await apply('rot_abc', { handover: { minute: 600 } }, 0)).status).toBe(200);
        return pinList('rot_abc');
      };
      const pins = await scenario('PENDING');
      expect(pins.find((p) => p[0] === B)).toEqual([B, iso(TUE09), iso(WED09)]);
      expect(pins.some((p) => p[0] === C && p[1] === iso(WED09) && p[2]! >= iso(THU09))).toBe(true);
      expect((await w.fx.rotationPins!('rot_abc')).some((p) => p.kind === 'KEEP_OVERRIDE')).toBe(true);
      await noOverlap('rot_abc');
      const rows = await rowsOf('rot_abc', TUE09, kst('2026-11-13T10:00'));
      for (const [t, who] of [[TUE12, B], [kst('2026-11-11T08:59'), B], [WED09, C], [kst('2026-11-11T09:30'), C], [kst('2026-11-12T09:30'), C], [THU10, A], [kst('2026-11-13T09:59'), A]] as const) {
        expect(whoAt(rows, t), iso(t)).toBe(who);
      }
      expect([await openAt(kst('2026-11-12T09:30')), await openAt(THU10)]).toEqual([C, A]);
      expect(await scenario('ACCEPTED')).toEqual(pins);
    });

    it('re-PATCH inside that protected pin: members only [A,C,B] keeps handover 10:00; C holds until Thu 10:00 as ONE pin [Wed 09:00, Thu 10:00), then B, then A', async () => {
      await open();
      await w.fx.addOverride!({ rotationId: 'rot_abc', contactId: A, startAt: WED09, endAt: THU09, status: 'PENDING' });
      expect((await apply('rot_abc', { handover: { minute: 600 } }, 0)).status).toBe(200);
      w.setNow(kst('2026-11-11T12:00'));
      const r = await apply('rot_abc', { members: [A, C, B] }, 1);
      expect(r.status).toBe(200);
      expect(body(r).handover.minute).toBe(600);
      expect(hm((await w.fx.rotationRow!('rot_abc'))!.anchorAt)).toBe('10:00');
      expect((await pinList('rot_abc')).filter((p) => p[2]! > iso(w.now))).toEqual([[C, iso(WED09), iso(THU10)]]);
      await noOverlap('rot_abc');
      const rows = await rowsOf('rot_abc', WED09, kst('2026-11-14T10:00'));
      expect(whoAt(rows, kst('2026-11-12T09:30'))).toBe(C);
      expect(rows.filter((x) => new Date(x.start).getTime() >= THU10.getTime()).map((x) => [x.start, x.end, x.contactId]).slice(0, 2))
        .toEqual([[iso(THU10), iso(kst('2026-11-13T10:00')), B], [iso(kst('2026-11-13T10:00')), iso(kst('2026-11-14T10:00')), A]]);
      expect([await openAt(kst('2026-11-12T09:30')), await openAt(THU10)]).toEqual([C, B]);
    });

    it('a cover request on the next shift and an earlier handover (09:00 -> 08:00): C keeps [Wed 09:00, Thu 09:00), A takes over from Thu 09:00; farther shifts follow the new order with no pin', async () => {
      await open();
      await w.fx.addOverride!({ rotationId: 'rot_abc', contactId: A, startAt: WED09, endAt: THU09, status: 'PENDING' });
      expect((await apply('rot_abc', { handover: { minute: 480 } }, 0)).status).toBe(200);
      const rows = await rowsOf('rot_abc', TUE09, kst('2026-11-16T09:00'));
      for (const [t, who] of [[TUE12, B], [WED09, C], [kst('2026-11-12T08:59'), C], [THU09, A], [kst('2026-11-12T12:00'), A]] as const) expect(whoAt(rows, t), iso(t)).toBe(who);
      const pins = await w.fx.rotationPins!('rot_abc');
      expect(pins.every((p) => p.endAt.getTime() <= THU09.getTime())).toBe(true);
      expect(pins.some((p) => p.contactId === C && p.startAt.getTime() === WED09.getTime())).toBe(true);
      await noOverlap('rot_abc');
    });
  });

  describe('onShift.until and next', () => {
    it('one member, no Override or Leave: until = now + 62 days to the millisecond, next = that member; two or more: the first change', async () => {
      await open();
      const c = body(await w.call(ADMIN, 'POST', '/rotations', { body: { ...MSP_BODY, name: 'Solo', members: [A] } }));
      expect(c.onShift.until).toBe(iso(new Date(TUE12.getTime() + 62 * DAY)));
      expect(c.next).toBe(NAME[A]);
      const g = await getRot('rot_abc');
      expect([g.onShift.until, g.next]).toEqual([iso(WED09), NAME[C]]);
    });

    it('a Leave that lets the current holder replace the next shift\'s holder moves until to when the resolved holder first changes, and next to that holder; /rotations and /oncall/now agree', async () => {
      // C is on leave Wed and Thu (KST dates), covered by B: B holds Tue, Wed and Thu until A\'s shift starts Thu 09:00.
      await open((s) => { s.leaves.push({ contactId: C, replacementId: B, startDate: '2026-11-11', endDate: '2026-11-12' }); });
      const g = await getRot('rot_abc');
      expect([g.onShift.contactId, g.onShift.until, g.next]).toEqual([B, iso(THU09), NAME[A]]);
      const now = body(await w.call(ADMIN, 'GET', '/oncall/now')).rotations.find((r: any) => r.id === 'rot_abc');
      expect([now.onShift.until, now.next]).toEqual([g.onShift.until, g.next]);
    });

    it('a Leave that ends inside the next shift: until is the end of the leave (Thu 00:00 KST), next is the shift\'s own holder C', async () => {
      await open((s) => { s.leaves.push({ contactId: C, replacementId: B, startDate: '2026-11-11', endDate: '2026-11-11' }); });
      const g = await getRot('rot_abc');
      expect([g.onShift.until, g.next]).toEqual([iso(kst('2026-11-12T00:00')), NAME[C]]);
    });

    it('an ACCEPTED Override that lets the current holder cover the next shift too moves until to the end of that cover; next is the holder after it', async () => {
      await open((s) => { s.overrides.push({ rotationId: 'rot_abc', contactId: B, startAt: WED09, endAt: THU09, status: 'ACCEPTED' }); });
      const g = await getRot('rot_abc');
      expect([g.onShift.until, g.next]).toEqual([iso(THU09), NAME[A]]);
      const now = body(await w.call(ADMIN, 'GET', '/oncall/now')).rotations.find((r: any) => r.id === 'rot_abc');
      expect([now.onShift.until, now.next]).toEqual([g.onShift.until, g.next]);
    });
  });

  describe('contacts and pins', () => {
    const tae = (s: MemoryApiStore): void => { s.contacts.set('ct_tae', { ...s.contacts.get(A)!, id: 'ct_tae', name: 'Tae Han', email: 'tae@example.test', phone: '+821099990001', slackUserId: 'U_tae' }); };
    it('DELETE /contacts/{id}: someone with a running or future pin is 409 IN_USE and nothing changes; with only past pins the contact is deleted and so are those pins', async () => {
      await open(tae);
      const c = body(await w.call(ADMIN, 'POST', '/rotations', { body: { ...MSP_BODY, name: 'Tae desk', members: ['ct_tae', A, C] } }));
      expect(c.onShift.contactId).toBe('ct_tae');
      expect((await apply(c.id, { members: [A, C] }, 0)).status).toBe(200); // Tae leaves while on shift: pinned for the current shift
      expect((await w.fx.rotationPins!(c.id)).map((p) => p.contactId)).toEqual(['ct_tae']);
      const before = await counts();
      const r = await w.call(ADMIN, 'DELETE', '/contacts/ct_tae');
      expect([r.status, err(r).code]).toEqual([409, 'IN_USE']);
      expect(await w.fx.repo.getContact('ct_tae')).not.toBeNull();
      await expectNone(before);
      w.setNow(new Date(THU09.getTime() + 60_000)); // the pin is over
      const ok = await w.call(ADMIN, 'DELETE', '/contacts/ct_tae');
      expect(ok.status).toBe(200);
      expect(await w.fx.repo.getContact('ct_tae')).toBeNull();
      expect(await w.fx.rotationPins!(c.id)).toEqual([]);
    });

    it('DELETE /contacts/{id}: a pin that has not started yet ([Thu 09:00, Fri 09:00), now Tue 12:00) is 409 IN_USE too', async () => {
      await open((s) => {
        tae(s);
        s.rotations.set('rot_future', { id: 'rot_future', scope: 'MSP', customerId: null, name: 'Future pin', cadence: 'DAILY', anchorAt: kst('2026-11-09T09:00'), handoverDow: 1, handoverMin: 0,
          members: [{ contactId: A, order: 0 }, { contactId: C, order: 1 }] } as never);
        ((s as unknown as { rotationPins?: Array<Record<string, unknown>> }).rotationPins ??= []).push(
          { id: 'pin_future_tae', rotationId: 'rot_future', contactId: 'ct_tae', startAt: THU09, endAt: kst('2026-11-13T09:00') });
      });
      expect(w.now.getTime()).toBeLessThan(THU09.getTime());
      const before = await counts();
      const r = await w.call(ADMIN, 'DELETE', '/contacts/ct_tae');
      expect([r.status, err(r).code]).toEqual([409, 'IN_USE']);
      expect(await w.fx.repo.getContact('ct_tae')).not.toBeNull();
      expect((await w.fx.rotationPins!('rot_future')).map((p) => p.contactId)).toEqual(['ct_tae']);
      await expectNone(before);
    });
  });
}
