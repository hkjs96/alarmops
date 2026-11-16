/**
 * Contract suite of D-35 (POST /contacts/{id}/reveal, GET /contact-reveals, canReveal on Responders) — the same tests
 * against MemoryApiStore (test/contract.memory.test.ts) and the SQL store (packages/store-sql/test/contract.api.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Contact, TickRepository } from '@alarmops/core';
import type { MakeFixture, StoreFixture } from '../../../core/test/contract/fixture.js';
import { seedWorld, PATTERNS, config, step, T0 } from '../../../core/test/world.js';
import { createApi, MemoryApiStore, REVEAL_LIMITS, VIEWER_RESPONDER_MAY_REVEAL, revealStanding, type ApiRepository, type ApiRequest, type ApiResponse, type AuthContext } from '../../src/index.js';
import { USERS, body } from '../helpers.js';

type Repo = TickRepository & ApiRepository;
type Call = (auth: AuthContext | null, method: ApiRequest['method'], path: string, opts?: { query?: Record<string, string | undefined>; body?: unknown; headers?: Record<string, string> }) => Promise<ApiResponse>;
interface Logged { level: string; msg: string; data?: Record<string, unknown> }
interface RWorld { fx: StoreFixture<Repo>; call: Call; callOn2: Call; clock: { now: Date }; logs: Logged[] }

const JUNHO: AuthContext = { userId: 'usr_junho', name: 'Junho Park', kind: 'INTERNAL', customerIds: '*', role: 'VIEWER' }; // VIEWER, Responder of Mirae
const ROOT: AuthContext = { userId: 'usr_root', name: 'Root Admin', kind: 'INTERNAL', customerIds: '*', role: 'ADMIN' }; // ADMIN, Responder nowhere
const HAEUN = USERS.haeun; // OPERATOR, Responder of Mirae
const MINJAE = USERS.minjae; // ADMIN, Responder of Hanbit (not of Mirae)
const HANBIT_ONLY: AuthContext = { userId: 'usr_minjae', name: 'Minjae Lee', kind: 'INTERNAL', customerIds: ['cus_hanbit'], role: 'ADMIN' };

async function rworld(make: MakeFixture<Repo>, o: { hanbitConfig?: boolean; mirae?: 'default' | 'none' | 'customerPerson'; rootRole?: 'ADMIN' | 'OPERATOR' } = {}): Promise<RWorld> {
  const seed = seedWorld(new MemoryApiStore()) as MemoryApiStore;
  const user = (id: string, name: string, contactId: string | null, role: 'VIEWER' | 'OPERATOR' | 'ADMIN', customerId: string | null) =>
    seed.users.set(id, { id, name, contactId, email: `${id}@example.test`, role, customerId });
  user('usr_haeun', 'Haeun Kim', 'ct_haeun', 'OPERATOR', null);
  user('usr_minjae', 'Minjae Lee', 'ct_minjae', 'ADMIN', null);
  user('usr_junho', 'Junho Park', 'ct_junho', 'VIEWER', null);
  user('usr_root', 'Root Admin', 'ct_root', o.rootRole ?? 'ADMIN', null);
  user('usr_viewer', 'Viewer', null, 'VIEWER', null);
  user('usr_yuna', 'Yuna Seo', 'ct_yuna', 'VIEWER', 'cus_mirae');
  user('usr_dohyun', 'Dohyun Han', 'ct_dohyun', 'VIEWER', 'cus_hanbit');
  seed.contacts.set('ct_root', { id: 'ct_root', kind: 'INTERNAL', customerId: null, name: 'Root Admin', active: true, email: 'root@msp.example', phone: '+821099990000', slackUserId: 'U_root' });
  seed.contacts.set('ct_nophone', { id: 'ct_nophone', kind: 'CUSTOMER', customerId: 'cus_mirae', name: 'No Phone', active: true, email: 'nophone@mirae.example', phone: null, slackUserId: null });
  // Mirae: step 1 = rotation rot_night → Haeun is on shift at T0
  if (o.mirae === 'customerPerson') seed.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_yuna', ['SMS'])]));
  else if (o.mirae !== 'none') seed.configs.push(PATTERNS.templateStandard());
  if (o.hanbitConfig !== false) seed.configs.push(config('cus_hanbit', [step(0, 0, 'ROTATION', 'rot_hanbit', ['SMS'])], { style: 'CUSTOMER_ROTATION' }));
  const fx = await make(seed);
  const clock = { now: T0 };
  const logs: Logged[] = [];
  fx.setClock(() => clock.now);
  const mk = (repo: Repo): Call => {
    const api = createApi({ repo, now: () => clock.now, log: (level, msg, data) => { logs.push({ level, msg, data }); } });
    let seq = 0;
    return (auth, method, path, c = {}) => api.handle({ method, path, auth, query: c.query, body: c.body, headers: c.headers, requestId: `req_${++seq}` });
  };
  return { fx, call: mk(fx.repo), callOn2: mk(fx.secondRunner()), clock, logs };
}

const reveal = (id: string, b: unknown) => ['POST', `/contacts/${id}/reveal`, { body: b }] as const;
const noValue = (r: ApiResponse, ...values: Array<string | null | undefined>) => {
  const wire = JSON.stringify([r.status, r.headers, r.body]);
  for (const v of values) if (v) expect(wire).not.toContain(v);
};

export function revealContract(make: MakeFixture<Repo>): void {
  let w: RWorld;
  afterEach(async () => { await w?.fx.close(); });
  const phoneOf = async (id: string): Promise<string> => (await w.fx.repo.getContact(id) as Contact).phone!;
  const rows = async () => w.fx.revealRows!();

  describe('who may open a value (D-35)', () => {
    it('a Responder of the customer: NORMAL, value, no-store, one log row without any value, one audit row', async () => {
      w = await rworld(make);
      const r = await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' }));
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const b = body(r);
      expect(b).toMatchObject({ channel: 'PHONE', value: await phoneOf('ct_yuna'), mode: 'NORMAL' });
      expect(Object.keys(b).sort()).toEqual(['auditId', 'channel', 'mode', 'revealedAt', 'value']);
      expect(b.revealedAt).toBe(T0.toISOString());
      const log = await rows();
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ id: b.auditId, actorUserId: 'usr_haeun', actorRole: 'OPERATOR', contactId: 'ct_yuna', contactName: 'Yuna Seo', customerId: 'cus_mirae', channel: 'PHONE', mode: 'NORMAL', reason: null });
      const dump = JSON.stringify(log) + JSON.stringify(await w.fx.audits());
      expect(dump).not.toContain(b.value);
      expect(dump).not.toContain('ct_yuna@');
      const audit = (await w.fx.audits()).filter((a) => a.action === 'contact.reveal');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ targetType: 'Contact', targetId: 'ct_yuna', customerId: 'cus_mirae', actorId: 'usr_haeun', after: { revealLogId: b.auditId, mode: 'NORMAL' } });
    });

    it('EMAIL and SLACK channels; an optional reason is kept (trimmed)', async () => {
      w = await rworld(make);
      const e = await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'EMAIL', reason: '  post-incident note  ' }));
      expect(body(e)).toMatchObject({ channel: 'EMAIL', value: 'ct_yuna@example.test', mode: 'NORMAL' });
      expect(body(await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'SLACK' })))).toMatchObject({ value: 'U_ct_yuna' });
      expect((await rows())[0]).toMatchObject({ reason: 'post-incident note' });
    });

    it('an INTERNAL contact: a Responder of a customer they share (NORMAL); a stranger is NOT_A_RESPONDER, even an ADMIN (no emergency for staff)', async () => {
      w = await rworld(make);
      // Haeun and Junho are both Responders of Mirae
      const ok = await w.call(HAEUN, ...reveal('ct_junho', { channel: 'EMAIL' }));
      expect(body(ok)).toMatchObject({ mode: 'NORMAL', value: 'ct_junho@example.test' });
      expect((await rows())[0]).toMatchObject({ customerId: 'cus_mirae', contactId: 'ct_junho' });
      for (const who of [MINJAE, ROOT]) {
        const r = await w.call(who, ...reveal('ct_junho', { channel: 'EMAIL', reason: 'need it now' }));
        expect([who.userId, r.status, body(r).error.code]).toEqual([who.userId, 403, 'NOT_A_RESPONDER']);
        noValue(r, 'ct_junho@example.test');
      }
      expect(await rows()).toHaveLength(1);
    });

    it('an ADMIN who is a Responder of that customer reveals as NORMAL, no reason needed', async () => {
      w = await rworld(make);
      const r = await w.call(MINJAE, ...reveal('ct_dohyun', { channel: 'PHONE' }));
      expect(body(r)).toMatchObject({ mode: 'NORMAL' });
    });

    it('a non-Responder who is not ADMIN (OPERATOR, VIEWER): 403 NOT_A_RESPONDER, nothing logged', async () => {
      w = await rworld(make);
      for (const who of [HAEUN, USERS.viewer]) {
        const r = await w.call(who, ...reveal('ct_sora', { channel: 'PHONE', reason: 'please' }));
        expect([who.userId, r.status, body(r).error.code]).toEqual([who.userId, 403, 'NOT_A_RESPONDER']);
        noValue(r, await phoneOf('ct_sora'));
      }
      expect(await rows()).toHaveLength(0);
    });

    it('a VIEWER who is a Responder: 403 ROLE_REQUIRED for now (user decision pending, one named rule), nothing logged', async () => {
      w = await rworld(make);
      expect(VIEWER_RESPONDER_MAY_REVEAL).toBe(false);
      const r = await w.call(JUNHO, ...reveal('ct_yuna', { channel: 'PHONE' }));
      expect(r.status).toBe(403);
      expect(body(r).error.code).toBe('ROLE_REQUIRED');
      noValue(r, await phoneOf('ct_yuna'));
      expect(await rows()).toHaveLength(0);
    });
  });

  describe('emergency reveal (ADMIN who is not a Responder)', () => {
    it('without a reason (missing, empty, blank): 422 EMERGENCY_REASON_REQUIRED, no value, no log row', async () => {
      w = await rworld(make);
      for (const b of [{ channel: 'PHONE' }, { channel: 'PHONE', reason: '' }, { channel: 'PHONE', reason: '   \n ' }, { channel: 'PHONE', reason: null }]) {
        const r = await w.call(MINJAE, ...reveal('ct_yuna', b));
        expect([r.status, body(r).error.code]).toEqual([422, 'EMERGENCY_REASON_REQUIRED']);
        noValue(r, await phoneOf('ct_yuna'));
        expect(r.headers['cache-control']).toBe('no-store');
      }
      expect(await rows()).toHaveLength(0);
      expect((await w.fx.audits()).filter((a) => a.action === 'contact.reveal')).toHaveLength(0);
    });

    it('with a reason: EMERGENCY, logged with the reason, the primary Responder (step 1 first target, on shift now) is the one notified', async () => {
      w = await rworld(make);
      const r = await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE', reason: ' SEV-1 and nobody answers ' }));
      expect(body(r)).toMatchObject({ mode: 'EMERGENCY', value: await phoneOf('ct_yuna') });
      const [row] = await rows();
      expect(row).toMatchObject({ mode: 'EMERGENCY', reason: 'SEV-1 and nobody answers', customerId: 'cus_mirae', actorUserId: 'usr_minjae' });
      expect(row!.notifiedContactIds).toEqual(['ct_haeun']);
      expect(JSON.stringify(row)).not.toContain(body(r).value);
    });

    it('no primary Responder (no call order): every OTHER active ADMIN is notified; with one, only that person', async () => {
      w = await rworld(make, { hanbitConfig: false });
      await w.call(ROOT, ...reveal('ct_dohyun', { channel: 'PHONE', reason: 'tracking lead is unreachable' }));
      expect((await rows())[0]!.notifiedContactIds).toEqual(['ct_minjae']);
      // Minjae asks for a Mirae person whose step-1 target is Haeun: Haeun, not the admins
      await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE', reason: 'x' }));
      expect((await rows())[1]!.notifiedContactIds).toEqual(['ct_haeun']);
    });

    it('a reason longer than 500 characters is a 400, and a reason that is not text too', async () => {
      w = await rworld(make);
      expect((await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE', reason: 'x'.repeat(501) }))).status).toBe(400);
      expect((await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE', reason: 5 }))).status).toBe(400);
      expect((await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE', reason: 'x'.repeat(500) }))).status).toBe(200);
    });
  });

  describe('scope: the one 404 comes first', () => {
    it('a portal user opens people of its own customer (NORMAL, never EMERGENCY); another customer, an INTERNAL contact and an unknown id are the same 404', async () => {
      w = await rworld(make);
      const own = await w.call(USERS.yuna, ...reveal('ct_seojun', { channel: 'EMAIL' }));
      expect(body(own)).toMatchObject({ mode: 'NORMAL', value: 'ct_seojun@example.test' });
      const unknown = await w.call(USERS.yuna, ...reveal('ct_nope', { channel: 'EMAIL' }));
      expect(unknown.status).toBe(404);
      for (const id of ['ct_dohyun', 'ct_sora', 'ct_haeun', 'ct_junho']) {
        const r = await w.call(USERS.yuna, ...reveal(id, { channel: 'PHONE', reason: 'please, urgent' }));
        expect(r.status).toBe(404);
        expect({ ...body(r).error, requestId: '' }).toEqual({ ...body(unknown).error, requestId: '' });
        expect(Object.keys(r.headers).sort()).toEqual(Object.keys(unknown.headers).sort());
      }
      expect((await rows()).filter((x) => x.mode === 'EMERGENCY')).toHaveLength(0);
      expect(await rows()).toHaveLength(1);
    });

    it('staff without that customer in range: 404 before any 403 / 422, even for an ADMIN without a reason', async () => {
      w = await rworld(make);
      const unknown = await w.call(HANBIT_ONLY, ...reveal('ct_nope', { channel: 'PHONE' }));
      const r = await w.call(HANBIT_ONLY, ...reveal('ct_yuna', { channel: 'PHONE' }));
      expect(r.status).toBe(404);
      expect({ ...body(r).error, requestId: '' }).toEqual({ ...body(unknown).error, requestId: '' });
      expect((await w.call(HANBIT_ONLY, ...reveal('ct_yuna', { channel: 'NOPE' }))).status).toBe(404); // not even the body is looked at
      expect(await rows()).toHaveLength(0);
    });

    it('signed out: 401', async () => {
      w = await rworld(make);
      expect((await w.call(null, ...reveal('ct_yuna', { channel: 'PHONE' }))).status).toBe(401);
    });
  });

  describe('input and the value', () => {
    it('a bad channel / body is a 400; a channel with nothing on file is a 422 and logs nothing', async () => {
      w = await rworld(make);
      for (const b of [{}, { channel: 'FAX' }, { channel: 'phone' }, 'x', null]) expect([b, (await w.call(HAEUN, ...reveal('ct_yuna', b))).status]).toEqual([b, 400]);
      const r = await w.call(HAEUN, ...reveal('ct_nophone', { channel: 'PHONE' }));
      expect([r.status, body(r).error.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await w.call(HAEUN, ...reveal('ct_nophone', { channel: 'EMAIL' }))).status).toBe(200);
      expect(await rows()).toHaveLength(1);
    });

    it('a repeated Idempotency-Key is NOT replayed: the value is never stored, the second call runs and is logged again', async () => {
      w = await rworld(make);
      const h = { 'idempotency-key': 'k-1' };
      const a = await w.call(HAEUN, 'POST', '/contacts/ct_yuna/reveal', { body: { channel: 'PHONE' }, headers: h });
      const b = await w.call(HAEUN, 'POST', '/contacts/ct_yuna/reveal', { body: { channel: 'PHONE' }, headers: h });
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(body(a).auditId).not.toBe(body(b).auditId);
      expect(await rows()).toHaveLength(2);
    });
  });

  describe('the log comes first', () => {
    it('if the log write fails there is no value: 500, nothing written', async () => {
      w = await rworld(make);
      await w.fx.breakRevealLog!();
      const r = await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' }));
      expect(r.status).toBe(500);
      noValue(r, await phoneOf('ct_yuna'), 'ct_yuna@example.test');
      expect((await w.fx.audits()).filter((a) => a.action === 'contact.reveal')).toHaveLength(0);
      const e = await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE', reason: 'urgent' }));
      expect(e.status).toBe(500);
      noValue(e, await phoneOf('ct_yuna'));
    });
  });

  describe('rate limit, counted in the database', () => {
    it('30 a minute per user: the 31st is 429 RATE_LIMITED with retryAfterSec / Retry-After, no value, no row; other users and the next minute are free', async () => {
      w = await rworld(make);
      expect(REVEAL_LIMITS).toEqual({ perMinute: 30, emergencyPerHour: 10 });
      for (let i = 0; i < 30; i++) {
        w.clock.now = new Date(T0.getTime() + i * 1000);
        expect([i, (await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' }))).status]).toEqual([i, 200]);
      }
      w.clock.now = new Date(T0.getTime() + 30_000);
      const r = await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' }));
      expect(r.status).toBe(429);
      expect(body(r).error.code).toBe('RATE_LIMITED');
      expect(body(r).error.details.retryAfterSec).toBe(30); // the oldest row (T0) leaves the window at T0+60s
      expect(r.headers['retry-after']).toBe('30');
      expect(r.headers['cache-control']).toBe('no-store');
      noValue(r, await phoneOf('ct_yuna'));
      expect(await rows()).toHaveLength(30);
      // someone else is not affected
      expect((await w.call(MINJAE, ...reveal('ct_dohyun', { channel: 'PHONE' }))).status).toBe(200);
      // a failed attempt costs nothing; once the oldest row leaves the window there is room again
      w.clock.now = new Date(T0.getTime() + 60_001);
      expect((await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' }))).status).toBe(200);
    });

    it("the count is the table, not the process: a second instance sees the first one's rows", async () => {
      w = await rworld(make);
      for (let i = 0; i < 20; i++) expect((await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' }))).status).toBe(200);
      for (let i = 0; i < 10; i++) expect((await w.callOn2(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' }))).status).toBe(200);
      expect((await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' }))).status).toBe(429);
      expect((await w.callOn2(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' }))).status).toBe(429);
    });

    it('simultaneous requests never exceed the limit; a request that finds the user lock taken gets 429 at once (no waiting)', async () => {
      w = await rworld(make);
      const rs = await Promise.all(Array.from({ length: 40 }, () => w.callOn2(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' }))));
      const okN = rs.filter((r) => r.status === 200).length;
      const limited = rs.filter((r) => r.status === 429);
      expect(okN + limited.length).toBe(40);
      expect(okN).toBeGreaterThanOrEqual(1);
      expect(okN).toBeLessThanOrEqual(30);
      if (!w.fx.concurrent) expect(okN).toBe(30); // one after the other: exactly the limit
      for (const r of limited) { expect(body(r).error.code).toBe('RATE_LIMITED'); expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1); noValue(r, await phoneOf('ct_yuna')); }
      expect(await rows()).toHaveLength(okN); // every value handed out has exactly one row
    });

    it('10 emergency reveals an hour per user; normal reveals are not counted against that, and an hour later it is free again', async () => {
      w = await rworld(make);
      for (let i = 0; i < 10; i++) {
        w.clock.now = new Date(T0.getTime() + i * 61_000); // under 30 a minute
        expect([i, (await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE', reason: `case ${i}` }))).status]).toEqual([i, 200]);
      }
      w.clock.now = new Date(T0.getTime() + 11 * 61_000);
      const r = await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE', reason: 'one more' }));
      expect(r.status).toBe(429);
      expect(body(r).error.code).toBe('RATE_LIMITED');
      expect(body(r).error.details.retryAfterSec).toBe(3600 - 11 * 61); // the first emergency row leaves the hour window
      noValue(r, await phoneOf('ct_yuna'));
      expect((await w.call(MINJAE, ...reveal('ct_dohyun', { channel: 'PHONE' }))).status).toBe(200); // NORMAL (Responder of Hanbit)
      w.clock.now = new Date(T0.getTime() + 3600_001);
      expect((await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE', reason: 'later' }))).status).toBe(200);
    });
  });

  describe('GET /contact-reveals (review list)', () => {
    async function seedLog(): Promise<void> {
      w.clock.now = new Date(T0.getTime());
      await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' })); // Mirae, NORMAL, Haeun
      w.clock.now = new Date(T0.getTime() + 60_000);
      await w.call(MINJAE, ...reveal('ct_dohyun', { channel: 'EMAIL', reason: 'billing' })); // Hanbit, NORMAL, Minjae
      w.clock.now = new Date(T0.getTime() + 120_000);
      await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE', reason: 'SEV-1 no answer' })); // Mirae, EMERGENCY, Minjae
      w.clock.now = new Date(T0.getTime() + 180_000);
    }
    const ids = (r: ApiResponse) => body(r).items.map((i: { contact: { id: string }; mode: string }) => `${i.contact.id}:${i.mode}`);

    it('ADMIN: every customer, newest first, items as the contract says and never a value', async () => {
      w = await rworld(make);
      await seedLog();
      const r = await w.call(MINJAE, 'GET', '/contact-reveals');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(ids(r)).toEqual(['ct_yuna:EMERGENCY', 'ct_dohyun:NORMAL', 'ct_yuna:NORMAL']);
      expect(body(r).nextCursor).toBeNull();
      expect(body(r).items[0]).toEqual({
        id: expect.any(String), at: new Date(T0.getTime() + 120_000).toISOString(), mode: 'EMERGENCY', actor: { id: 'usr_minjae', name: 'Minjae Lee', kind: 'STAFF' }, contact: { id: 'ct_yuna', name: 'Yuna Seo' },
        org: { customer: { id: 'cus_mirae', name: 'Mirae Pay', slug: 'mirae' } }, channel: 'PHONE', reason: 'SEV-1 no answer', notified: [{ contactId: 'ct_haeun', name: 'Haeun Kim' }], notifyStatus: 'RECORDED',
      });
      noValue(r, await phoneOf('ct_yuna'), await phoneOf('ct_dohyun'), 'ct_yuna@example.test', 'ct_dohyun@example.test');
    });

    it('OPERATOR: only the customers they are a Responder of; another customer in `customer` is the 404', async () => {
      w = await rworld(make);
      await seedLog();
      const r = await w.call(HAEUN, 'GET', '/contact-reveals');
      expect(ids(r)).toEqual(['ct_yuna:EMERGENCY', 'ct_yuna:NORMAL']);
      expect((await w.call(HAEUN, 'GET', '/contact-reveals', { query: { customer: 'mirae' } })).status).toBe(200);
      const other = await w.call(HAEUN, 'GET', '/contact-reveals', { query: { customer: 'hanbit' } });
      const unknown = await w.call(HAEUN, 'GET', '/contact-reveals', { query: { customer: 'nope' } });
      expect([other.status, unknown.status]).toEqual([404, 404]);
      expect({ ...body(other).error, requestId: '' }).toEqual({ ...body(unknown).error, requestId: '' });
      expect((await w.call(MINJAE, 'GET', '/contact-reveals', { query: { customer: 'hanbit' } })).status).toBe(200);
    });

    it('VIEWER (also a Responder) 403 ROLE_REQUIRED; portal user 404 whatever their stored role; signed out 401', async () => {
      w = await rworld(make);
      await seedLog();
      for (const who of [USERS.viewer, JUNHO]) {
        const r = await w.call(who, 'GET', '/contact-reveals');
        expect([r.status, body(r).error.code]).toEqual([403, 'ROLE_REQUIRED']);
      }
      const portalAdmin: AuthContext = { ...USERS.yuna, role: 'ADMIN' };
      expect((await w.call(USERS.yuna, 'GET', '/contact-reveals')).status).toBe(404);
      expect((await w.call(portalAdmin, 'GET', '/contact-reveals')).status).toBe(404);
      expect((await w.call(null, 'GET', '/contact-reveals')).status).toBe(401);
    });

    it('ADMIN narrowed to one customer sees only that customer', async () => {
      w = await rworld(make);
      await seedLog();
      expect(ids(await w.call(HANBIT_ONLY, 'GET', '/contact-reveals'))).toEqual(['ct_dohyun:NORMAL']);
      expect((await w.call(HANBIT_ONLY, 'GET', '/contact-reveals', { query: { customer: 'mirae' } })).status).toBe(404);
    });

    it('filters: mode, actorUserId, contactId, from / to; a bad filter is a 400', async () => {
      w = await rworld(make);
      await seedLog();
      expect(ids(await w.call(MINJAE, 'GET', '/contact-reveals', { query: { mode: 'EMERGENCY' } }))).toEqual(['ct_yuna:EMERGENCY']);
      expect(ids(await w.call(MINJAE, 'GET', '/contact-reveals', { query: { actorUserId: 'usr_haeun' } }))).toEqual(['ct_yuna:NORMAL']);
      expect(ids(await w.call(MINJAE, 'GET', '/contact-reveals', { query: { contactId: 'ct_dohyun' } }))).toEqual(['ct_dohyun:NORMAL']);
      expect(ids(await w.call(MINJAE, 'GET', '/contact-reveals', { query: { from: new Date(T0.getTime() + 30_000).toISOString(), to: new Date(T0.getTime() + 90_000).toISOString() } }))).toEqual(['ct_dohyun:NORMAL']);
      for (const query of [{ mode: 'X' }, { from: 'yesterday' }, { to: '2026-11-09' }, { limit: '0' }, { cursor: 'zzz' }]) {
        expect([query, (await w.call(MINJAE, 'GET', '/contact-reveals', { query })).status]).toEqual([query, 400]);
      }
    });

    it('cursor pagination walks the rows once, newest first', async () => {
      w = await rworld(make);
      await seedLog();
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const r = await w.call(MINJAE, 'GET', '/contact-reveals', { query: { limit: '1', cursor } });
        expect(body(r).items.length).toBeLessThanOrEqual(1);
        seen.push(...ids(r));
        cursor = body(r).nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(seen).toEqual(['ct_yuna:EMERGENCY', 'ct_dohyun:NORMAL', 'ct_yuna:NORMAL']);
    });
  });

  describe('review follow-ups (security review of 1e5cb65)', () => {
    it('inactive contact: the same 404 as an unknown id, NORMAL and EMERGENCY, nothing logged', async () => {
      w = await rworld(make);
      const unknown = await w.call(HAEUN, ...reveal('ct_nope', { channel: 'PHONE' }));
      await w.fx.patchContact('ct_yuna', { active: false });
      for (const [who, b] of [[HAEUN, { channel: 'PHONE' }], [MINJAE, { channel: 'PHONE', reason: 'urgent' }], [USERS.yuna, { channel: 'PHONE' }]] as const) {
        const r = await w.call(who, ...reveal('ct_yuna', b));
        expect([who.userId, r.status]).toEqual([who.userId, 404]);
        expect({ ...body(r).error, requestId: '' }).toEqual({ ...body(unknown).error, requestId: '' });
      }
      expect(await rows()).toHaveLength(0);
    });

    it('recipients are INTERNAL and active only: a customer person as step-1 target is skipped (other admins instead); the revealed contact and the caller are never told', async () => {
      w = await rworld(make, { mirae: 'customerPerson' });
      await w.call(MINJAE, ...reveal('ct_seojun', { channel: 'PHONE', reason: 'urgent' }));
      expect((await rows())[0]!.notifiedContactIds).toEqual(['ct_root']); // not ct_yuna, not the caller ct_minjae
    });

    it('nobody to tell: notifiedContactIds is empty and the list says NO_RECIPIENT (not "fine"); NORMAL rows say NOT_APPLICABLE', async () => {
      w = await rworld(make, { mirae: 'none', rootRole: 'OPERATOR' }); // Minjae is the only ADMIN
      await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE', reason: 'nobody else' }));
      await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'EMAIL' }));
      expect((await rows())[0]!.notifiedContactIds).toEqual([]);
      const items = body(await w.call(MINJAE, 'GET', '/contact-reveals')).items as Array<{ mode: string; notifyStatus: string; notified: unknown[] }>;
      expect(items.map((i) => [i.mode, i.notifyStatus, i.notified.length])).toEqual([['NORMAL', 'NOT_APPLICABLE', 0], ['EMERGENCY', 'NO_RECIPIENT', 0]]);
    });

    it('refused attempts (403, 422 emergency without reason, 429) are logged with requestId, userId, contactId, code; never the value or the reason text', async () => {
      w = await rworld(make);
      await w.call(HAEUN, ...reveal('ct_sora', { channel: 'PHONE', reason: 'secret-reason-text' }));
      await w.call(MINJAE, ...reveal('ct_yuna', { channel: 'PHONE' }));
      for (let i = 0; i < 30; i++) await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE' }));
      const last = await w.call(HAEUN, ...reveal('ct_yuna', { channel: 'PHONE', reason: 'secret-reason-text' }));
      expect(last.status).toBe(429);
      const got = w.logs.filter((l) => l.msg === 'contact.reveal.refused');
      expect(got.map((l) => [l.data!.userId, l.data!.contactId, l.data!.status, l.data!.code])).toEqual([
        ['usr_haeun', 'ct_sora', 403, 'NOT_A_RESPONDER'], ['usr_minjae', 'ct_yuna', 422, 'EMERGENCY_REASON_REQUIRED'], ['usr_haeun', 'ct_yuna', 429, 'RATE_LIMITED']]);
      for (const l of got) expect(typeof l.data!.requestId).toBe('string');
      const dump = JSON.stringify(w.logs);
      for (const v of [await phoneOf('ct_sora'), await phoneOf('ct_yuna'), 'secret-reason-text', 'ct_yuna@example.test']) expect(dump).not.toContain(v);
    });

    it('a portal reveal is recorded and listed as a portal actor, not as a staff VIEWER', async () => {
      w = await rworld(make);
      await w.call(USERS.yuna, ...reveal('ct_seojun', { channel: 'EMAIL' }));
      expect((await rows())[0]).toMatchObject({ actorUserId: 'usr_yuna', actorRole: 'PORTAL' });
      const items = body(await w.call(MINJAE, 'GET', '/contact-reveals')).items;
      expect(items[0].actor).toEqual({ id: 'usr_yuna', name: 'Yuna Seo', kind: 'PORTAL' });
    });

    it('an unknown auth kind is refused (fail closed)', async () => {
      w = await rworld(make);
      const odd = { userId: 'usr_root', kind: 'SERVICE', customerIds: '*', role: 'ADMIN' } as unknown as AuthContext;
      expect((await w.call(odd, ...reveal('ct_yuna', { channel: 'PHONE', reason: 'x' }))).status).toBe(401);
      expect(revealStanding({ ...ROOT, kind: 'SERVICE' } as unknown as AuthContext, false, 'CUSTOMER')).toEqual({ denied: 'NOT_A_RESPONDER' });
    });
  });

  describe('canReveal / revealRequiresReason on Responders', () => {
    const flags = async (auth: AuthContext, customer: string) => {
      const r = body(await w.call(auth, 'GET', `/customers/${customer}/responders`));
      const pick = (x: { contactId: string; canReveal: boolean; revealRequiresReason: boolean }) => [x.contactId, x.canReveal, x.revealRequiresReason];
      return { staff: r.staff.map(pick), people: r.people.map(pick) };
    };
    it('Responder: true/false; ADMIN who is not: people true/true, staff false/false; other staff and a VIEWER Responder: false/false', async () => {
      w = await rworld(make);
      const t = (ids: string[], a: boolean, b: boolean) => ids.map((id) => [id, a, b]);
      const mirae = await flags(HAEUN, 'cus_mirae');
      expect(mirae.staff).toEqual(expect.arrayContaining(t(['ct_haeun', 'ct_junho'], true, false)));
      expect(mirae.people).toEqual(expect.arrayContaining(t(['ct_yuna', 'ct_seojun'], true, false)));
      const admin = await flags(MINJAE, 'cus_mirae');
      expect(admin.people).toEqual(expect.arrayContaining(t(['ct_yuna', 'ct_seojun'], true, true)));
      expect(admin.staff).toEqual(expect.arrayContaining(t(['ct_haeun', 'ct_junho'], false, false)));
      const hanbitAdmin = await flags(MINJAE, 'cus_hanbit');
      expect(hanbitAdmin.people).toEqual(expect.arrayContaining(t(['ct_dohyun'], true, false)));
      const op = await flags(HAEUN, 'cus_hanbit');
      for (const x of [...op.staff, ...op.people]) expect(x.slice(1)).toEqual([false, false]);
      const viewer = await flags(JUNHO, 'cus_mirae');
      for (const x of [...viewer.staff, ...viewer.people]) expect(x.slice(1)).toEqual([false, false]);
      const nobody = await flags(USERS.viewer, 'cus_mirae');
      for (const x of [...nobody.staff, ...nobody.people]) expect(x.slice(1)).toEqual([false, false]);
    });
    it('what the list promises is what the endpoint does', async () => {
      w = await rworld(make);
      for (const [who, customer] of [[HAEUN, 'cus_mirae'], [MINJAE, 'cus_mirae'], [JUNHO, 'cus_mirae'], [HAEUN, 'cus_hanbit'], [ROOT, 'cus_hanbit']] as const) {
        const list = body(await w.call(who, 'GET', `/customers/${customer}/responders`));
        for (const x of [...list.staff, ...list.people] as Array<{ contactId: string; canReveal: boolean; revealRequiresReason: boolean }>) {
          const r = await w.call(who, ...reveal(x.contactId, { channel: 'EMAIL' }));
          const got = r.status === 200 ? 'NORMAL' : body(r).error.code === 'EMERGENCY_REASON_REQUIRED' ? 'EMERGENCY' : 'NO';
          expect([who.userId, customer, x.contactId, got]).toEqual([who.userId, customer, x.contactId, !x.canReveal ? 'NO' : x.revealRequiresReason ? 'EMERGENCY' : 'NORMAL']);
        }
      }
    });
  });
}
