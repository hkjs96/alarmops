/**
 * Contract suite of GET /me, /oncall/now, paging-health, Responders, /rotations, /staff — same tests against
 * MemoryApiStore (test/contract.memory.test.ts) and the SQL store (packages/store-sql/test/contract.api.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TickRepository } from '@alarmops/core';
import type { MakeFixture, StoreFixture } from '../../../core/test/contract/fixture.js';
import { PATTERNS, config, seedWorld, step, T0 } from '../../../core/test/world.js';
import { authFromPrincipal, createApi, encodeCursor, MemoryApiStore, type ApiRepository, type ApiRequest, type ApiResponse, type AuthContext } from '../../src/index.js';
import { USERS, body } from '../helpers.js';

type Repo = TickRepository & ApiRepository;

interface PWorld {
  fx: StoreFixture<Repo>;
  call: (auth: AuthContext | null, method: ApiRequest['method'], path: string, opts?: { query?: Record<string, string | undefined>; body?: unknown; headers?: Record<string, string> }) => Promise<ApiResponse>;
}

async function pworld(make: MakeFixture<Repo>, customize?: (seed: MemoryApiStore) => void): Promise<PWorld> {
  const seed = seedWorld(new MemoryApiStore()) as MemoryApiStore;
  seed.users.set('usr_haeun', { id: 'usr_haeun', name: 'Haeun Kim', contactId: 'ct_haeun', email: 'usr_haeun@example.test', role: 'OPERATOR', customerId: null });
  seed.users.set('usr_minjae', { id: 'usr_minjae', name: 'Minjae Lee', contactId: 'ct_minjae', email: 'usr_minjae@example.test', role: 'ADMIN', customerId: null });
  seed.users.set('usr_yuna', { id: 'usr_yuna', name: 'Yuna Seo', contactId: 'ct_yuna', email: 'usr_yuna@example.test', role: 'VIEWER', customerId: 'cus_mirae' });
  seed.users.set('usr_off', { id: 'usr_off', name: 'Gone', contactId: null, email: 'usr_off@example.test', role: 'ADMIN', customerId: null, status: 'DISABLED' });
  // Hanbit: its own rotation only, so who holds the rotation decides whether anybody is reached.
  seed.configs.push(PATTERNS.templateStandard(), config('cus_hanbit', [step(0, 0, 'ROTATION', 'rot_hanbit', ['SMS', 'VOICE'])], { style: 'CUSTOMER_ROTATION' }));
  seed.contactScopes.push({ contactId: 'ct_seojun', customerId: 'cus_mirae', scopeType: 'SERVICE', scopeId: 'svc_pay', role: 'NOTIFY' });
  seed.verifiedSlack.add('cus_mirae');
  customize?.(seed);
  const fx = await make(seed);
  fx.setClock(() => T0);
  const api = createApi({ repo: fx.repo, now: () => T0 });
  let seq = 0;
  return { fx, call: (auth, method, path, o = {}) => api.handle({ method, path, auth, query: o.query, body: o.body, headers: o.headers, requestId: `req_${++seq}` }) };
}

const ADMIN = USERS.minjae;
const im = (v: number | string) => ({ 'if-match': String(v) });

export function peopleContract(make: MakeFixture<Repo>): void {
  let w: PWorld;
  afterEach(async () => { await w?.fx.close(); });

  describe('session principal and GET /me', () => {
    it('active users only; staff get every customer, a portal user its own', async () => {
      w = await pworld(make);
      const staff = await w.fx.repo.sessionPrincipal('usr_minjae');
      expect(staff).toMatchObject({ userId: 'usr_minjae', name: 'Minjae Lee', email: 'usr_minjae@example.test', customerId: null, role: 'ADMIN', contactId: 'ct_minjae' });
      expect(authFromPrincipal(staff!)).toMatchObject({ kind: 'INTERNAL', customerIds: '*', role: 'ADMIN' });
      const portal = await w.fx.repo.sessionPrincipal('usr_yuna');
      expect(authFromPrincipal(portal!)).toMatchObject({ kind: 'CUSTOMER', customerIds: ['cus_mirae'] });
      expect(await w.fx.repo.sessionPrincipal('usr_off')).toBeNull();
      expect(await w.fx.repo.sessionPrincipal('usr_nobody')).toBeNull();
      expect(body(await w.call(ADMIN, 'GET', '/me'))).toEqual({ id: 'usr_minjae', name: 'Minjae Lee', email: 'usr_minjae@example.test', role: 'ADMIN', kind: 'INTERNAL' });
      expect((await w.call(null, 'GET', '/me')).status).toBe(401);
    });
  });

  describe('customer status (D-42)', () => {
    const withStatus = (status: 'SUSPENDED' | 'TERMINATED') => (seed: MemoryApiStore) => {
      seed.customers.set('cus_mirae', { ...seed.customers.get('cus_mirae')!, status });
      seed.users.set('usr_dohyun', { id: 'usr_dohyun', name: 'Dohyun Han', contactId: 'ct_dohyun', email: 'usr_dohyun@example.test', role: 'VIEWER', customerId: 'cus_hanbit' });
    };
    for (const status of ['SUSPENDED', 'TERMINATED'] as const) {
      it(`${status}: its portal users get no session (null → 401); other customers' portal users and MSP staff are unaffected`, async () => {
        w = await pworld(make, withStatus(status));
        const p = await w.fx.repo.sessionPrincipal('usr_yuna');
        expect(p).toBeNull();
        // what the console adapter does with it (authForSession): no principal → no AuthContext → 401
        expect((await w.call(p ? authFromPrincipal(p) : null, 'GET', '/me')).status).toBe(401);
        expect(await w.fx.repo.sessionPrincipal('usr_dohyun')).toMatchObject({ userId: 'usr_dohyun', customerId: 'cus_hanbit' });
        // staff, including a responder of the suspended customer, keep their session and still see that customer
        expect(await w.fx.repo.sessionPrincipal('usr_haeun')).toMatchObject({ userId: 'usr_haeun', customerId: null, role: 'OPERATOR' });
        expect(await w.fx.repo.sessionPrincipal('usr_minjae')).toMatchObject({ userId: 'usr_minjae', customerId: null, role: 'ADMIN' });
        expect((await w.call(USERS.haeun, 'GET', '/customers/cus_mirae/responders')).status).toBe(200);
      });
    }
    it('ACTIVE (the default) keeps the portal session', async () => {
      w = await pworld(make);
      expect(await w.fx.repo.sessionPrincipal('usr_yuna')).toMatchObject({ userId: 'usr_yuna', customerId: 'cus_mirae' });
    });
  });

  describe('roles on Responders, paging-health, /oncall/now, /rotations, /staff (D-41)', () => {
    const PORTAL_ADMIN: AuthContext = { userId: 'usr_yuna', name: 'Yuna Seo', kind: 'CUSTOMER', customerIds: ['cus_mirae'], role: 'ADMIN' };
    const READS = ['/customers/cus_mirae/responders', '/customers/cus_mirae/paging-health', '/oncall/now', '/rotations', '/staff'];
    const writes = (v: number) => [
      ['POST', '/customers/cus_mirae/responders', { contactId: 'ct_minjae' }, v],
      ['PATCH', '/customers/cus_mirae/responders/ct_yuna', { role: 'NOTIFY_ONLY' }, v],
      ['DELETE', '/customers/cus_mirae/responders/ct_seojun', undefined, v],
    ] as const;

    it('READ: VIEWER, OPERATOR and ADMIN staff get 200', async () => {
      w = await pworld(make);
      for (const auth of [USERS.viewer, USERS.haeun, ADMIN]) {
        for (const path of READS) expect([auth.role, path, (await w.call(auth, 'GET', path)).status]).toEqual([auth.role, path, 200]);
      }
    });

    it('READ: portal users get the one 404, whatever their stored role', async () => {
      w = await pworld(make);
      const ref = body(await w.call(ADMIN, 'GET', '/customers/cus_nope/responders')).error;
      for (const auth of [USERS.yuna, PORTAL_ADMIN]) {
        for (const path of READS) {
          const r = await w.call(auth, 'GET', path);
          expect([path, r.status]).toEqual([path, 404]);
          expect({ ...body(r).error, requestId: '' }).toEqual({ ...ref, requestId: '' });
        }
      }
    });

    it('WRITE: VIEWER and OPERATOR staff get 403 ROLE_REQUIRED and nothing changes; portal users 404; ADMIN succeeds', async () => {
      w = await pworld(make);
      for (const auth of [USERS.viewer, USERS.haeun]) {
        for (const [method, path, b, v] of writes(0)) {
          const r = await w.call(auth, method, path, { body: b, headers: im(v) });
          expect([auth.role, method, r.status, body(r).error.code, body(r).error.details.role]).toEqual([auth.role, method, 403, 'ROLE_REQUIRED', 'ADMIN']);
        }
      }
      for (const auth of [USERS.yuna, PORTAL_ADMIN]) {
        for (const [method, path, b, v] of writes(0)) expect([method, (await w.call(auth, method, path, { body: b, headers: im(v) })).status]).toEqual([method, 404]);
      }
      expect(body(await w.call(ADMIN, 'GET', '/customers/cus_mirae/responders')).version).toBe(0);
      expect((await w.fx.audits()).filter((a) => a.targetType === 'Responders')).toHaveLength(0);
      let v = 0;
      for (const [method, path, b] of writes(0)) {
        const r = await w.call(ADMIN, method, path, { body: b, headers: im(v), query: { confirmUnreachable: 'true' } });
        expect([method, r.status]).toEqual([method, method === 'POST' ? 201 : 200]);
        v = body(r).version;
      }
      expect(v).toBe(3);
    });
  });

  describe('Responders', () => {
    it('GET: staff and customer people with channel states and masked contact, a list version; never the address', async () => {
      w = await pworld(make);
      const r = await w.call(USERS.viewer, 'GET', '/customers/cus_mirae/responders');
      expect(r.status).toBe(200);
      const b = body(r);
      expect(b.version).toBe(0);
      expect(b.slackChannel).toBe('VERIFIED');
      expect(b.staff.map((s: any) => [s.contactId, s.source])).toEqual([['ct_haeun', 'DIRECT'], ['ct_junho', 'DIRECT']]);
      expect(b.people.map((p: any) => [p.contactId, p.role, p.scope.level])).toEqual([['ct_seojun', 'NOTIFY_ONLY', 'SERVICE'], ['ct_yuna', 'PAGEABLE', 'CUSTOMER']]); // Responder order, then contactId
      expect(b.staff[0].channels).toEqual({ SLACK: 'VERIFIED', EMAIL: 'VERIFIED', SMS: 'VERIFIED', VOICE: 'VERIFIED' });
      expect(b.staff[0].emailMasked).toBe('c•••@example.test');
      expect(JSON.stringify(b)).not.toContain('ct_haeun@example.test');
      expect(JSON.stringify(b)).not.toContain('+8210000');
    });

    it('portal users, unknown customers and other customers are the same 404', async () => {
      w = await pworld(make);
      for (const path of ['/customers/cus_mirae/responders', '/customers/cus_mirae/paging-health', '/oncall/now', '/rotations', '/staff']) {
        expect((await w.call(USERS.yuna, 'GET', path)).status).toBe(404);
      }
      expect((await w.call(ADMIN, 'GET', '/customers/cus_nope/responders')).status).toBe(404);
      expect((await w.call(ADMIN, 'DELETE', '/customers/cus_mirae/responders/ct_dohyun', { headers: im(0) })).status).toBe(404);
    });

    it('writes need ADMIN, If-Match = the list version; each write moves the version by one', async () => {
      w = await pworld(make);
      const add = (auth: AuthContext, v: number | null, b: unknown) => w.call(auth, 'POST', '/customers/cus_mirae/responders', { body: b, headers: v === null ? {} : im(v) });
      expect((await add(USERS.haeun, 0, { contactId: 'ct_minjae' })).status).toBe(403);
      expect(body(await add(ADMIN, null, { contactId: 'ct_minjae' })).error.code).toBe('VALIDATION_FAILED');
      const stale = await add(ADMIN, 3, { contactId: 'ct_minjae' });
      expect(stale.status).toBe(409);
      expect(body(stale).error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 0 } });
      const ok = await add(ADMIN, 0, { contactId: 'ct_minjae' });
      expect(ok.status).toBe(201);
      expect(body(ok)).toEqual({ contactId: 'ct_minjae', version: 1 });
      expect(body(await add(ADMIN, 1, { contactId: 'ct_minjae' })).error.code).toBe('ALREADY_EXISTS');
      // another customer's person: the same 404 as an unknown id
      expect((await add(ADMIN, 1, { contactId: 'ct_dohyun' })).status).toBe(404);
      expect((await add(ADMIN, 1, { contactId: 'ct_ghost' })).status).toBe(404);
      const created = await add(ADMIN, 1, { name: 'Nari Kang', email: 'nari@mirae.example', role: 'NOTIFY_ONLY', extras: ['APPROVER'] });
      expect(created.status).toBe(201);
      const nid = body(created).contactId as string;
      expect(body(created).version).toBe(2);
      const after = body(await w.call(ADMIN, 'GET', '/customers/cus_mirae/responders'));
      expect(after.version).toBe(2);
      expect(after.people.find((p: any) => p.contactId === nid)).toMatchObject({ name: 'Nari Kang', role: 'NOTIFY_ONLY', extras: ['APPROVER'], emailMasked: 'n•••@mirae.example', channels: { EMAIL: 'UNVERIFIED', SMS: 'NOT_SET' } });
      const audits = await w.fx.audits();
      expect(audits.filter((a) => a.targetType === 'Responders')).toHaveLength(2);
      expect(JSON.stringify(audits)).not.toContain('nari@mirae.example');
      // Hanbit's list is separate
      expect(body(await w.call(ADMIN, 'GET', '/customers/cus_hanbit/responders')).version).toBe(0);
    });

    it('a change that would leave the customer unreachable is 409 WOULD_BE_UNREACHABLE unless confirmed', async () => {
      w = await pworld(make);
      expect(body(await w.call(ADMIN, 'GET', '/customers/cus_hanbit/paging-health')).level).not.toBe('UNREACHABLE');
      // Dohyun holds the Hanbit rotation this week: without him as a pageable responder nobody is reached.
      const patch = await w.call(ADMIN, 'PATCH', '/customers/cus_hanbit/responders/ct_dohyun', { body: { role: 'NOTIFY_ONLY' }, headers: im(0) });
      expect(patch.status).toBe(409);
      expect(body(patch).error.code).toBe('WOULD_BE_UNREACHABLE');
      const del = await w.call(ADMIN, 'DELETE', '/customers/cus_hanbit/responders/ct_dohyun', { headers: im(0) });
      expect(body(del).error.code).toBe('WOULD_BE_UNREACHABLE');
      expect(body(await w.call(ADMIN, 'GET', '/customers/cus_hanbit/responders')).version).toBe(0);
      const confirmed = await w.call(ADMIN, 'DELETE', '/customers/cus_hanbit/responders/ct_dohyun', { headers: im(0), query: { confirmUnreachable: 'true' } });
      expect(confirmed.status).toBe(200);
      expect(body(confirmed)).toEqual({ contactId: 'ct_dohyun', version: 1 });
      expect(body(await w.call(ADMIN, 'GET', '/customers/cus_hanbit/paging-health')).level).toBe('UNREACHABLE');
      // a notify-only person goes without a question
      expect((await w.call(ADMIN, 'DELETE', '/customers/cus_mirae/responders/ct_seojun', { headers: im(0) })).status).toBe(200);
    });
  });

  describe('Call order list, rotations, staff', () => {
    it('GET /oncall/now: a row per customer (worst health first), steps resolved now, rotations on shift', async () => {
      w = await pworld(make);
      const b = body(await w.call(USERS.viewer, 'GET', '/oncall/now'));
      expect(b.rows.map((r: any) => r.key).sort()).toEqual(['hanbit', 'mirae']);
      const mirae = b.rows.find((r: any) => r.key === 'mirae');
      expect(mirae).toMatchObject({ level: 'CUSTOMER', own: true, inheritedFrom: null, style: 'SHARED_ROTATION', plan: 'STANDARD', org: { customer: { slug: 'mirae' } } });
      expect(mirae.steps[0]).toMatchObject({ targetType: 'ROTATION', targetId: 'rot_night', targetName: 'MSP night desk', nowIds: ['ct_haeun'] });
      expect(mirae.health.level).toMatch(/OK|AT_RISK|UNREACHABLE/);
      const night = b.rotations.find((r: any) => r.id === 'rot_night');
      expect(night.onShift).toMatchObject({ contactId: 'ct_haeun', name: 'Haeun Kim', until: '2026-11-10T00:00:00.000Z' });
      expect(night.next).toBe('Junho Park');
      // asked node: a service without own steps inherits the customer's
      const svc = body(await w.call(ADMIN, 'GET', '/oncall/now', { query: { customer: 'mirae', project: 'core', service: 'payments-api' } }));
      expect(svc.rows.map((r: any) => [r.key, r.own, r.inheritedFrom?.level ?? null])).toEqual([['mirae', true, null], ['mirae/core/payments-api', false, 'CUSTOMER']]);
      expect((await w.call(ADMIN, 'GET', '/oncall/now', { query: { customer: 'nope' } })).status).toBe(404);
    });

    it('GET /rotations and GET /staff', async () => {
      w = await pworld(make);
      const all = body(await w.call(ADMIN, 'GET', '/rotations'));
      expect(all.map((r: any) => r.id)).toEqual(['rot_night', 'rot_hanbit']);
      expect(body(await w.call(ADMIN, 'GET', '/rotations', { query: { customerId: 'cus_mirae' } })).map((r: any) => r.id)).toEqual(['rot_night']);
      expect((await w.call(ADMIN, 'GET', '/rotations', { query: { customerId: 'cus_nope' } })).status).toBe(404);
      expect(body(await w.call(ADMIN, 'GET', '/staff')).map((s: any) => s.contactId)).toEqual(['ct_haeun', 'ct_junho', 'ct_minjae']);
      expect(body(await w.call(ADMIN, 'GET', '/staff', { query: { q: 'jun' } })).map((s: any) => s.name)).toEqual(['Junho Park']);
    });
  });

  describe('cursor (issue #10 P-2)', () => {
    it('a cursor in year 0000 is 400, not a database error', async () => {
      w = await pworld(make);
      const r = await w.call(ADMIN, 'GET', '/incidents', { query: { cursor: encodeCursor({ t: '0000-01-01T00:00:00.000Z', id: 'inc-x' }) } });
      expect(r.status).toBe(400);
      expect(body(r).error.details.fields[0].field).toBe('cursor');
    });
  });
}
