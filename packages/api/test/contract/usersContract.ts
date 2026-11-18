/**
 * Contract suite of the users API and the sign-in store methods (hkjs96/alarmops#69, D-55): /users, enrolPortalUserByDomain,
 * bindGoogleSub, touchLastLogin — the SAME tests against MemoryApiStore and the SQL store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryApiStore, AuthContext } from '../../src/index.js';
import { USERS, body } from '../helpers.js';
import { cworld, type CWorld, type MakeApiFixture } from './apiContract.js';

const NARROW: AuthContext = { userId: 'usr_hb', name: 'Hanbit Admin', kind: 'INTERNAL', customerIds: ['cus_hanbit'], role: 'ADMIN' };
/** An ADMIN session that has no row in the store (used to act on the only stored admin). */
const GHOST: AuthContext = { userId: 'usr_ghost', name: 'Ghost', kind: 'INTERNAL', customerIds: '*', role: 'ADMIN' };
const T = new Date('2026-11-18T01:00:00Z');

export function usersContract(make: MakeApiFixture): void {
  let w: CWorld;
  const open = async (): Promise<CWorld> => (w = await cworld(make, (s: MemoryApiStore) => {
    s.users.get('usr_minjae')!.role = 'ADMIN'; // the one stored all-range ADMIN
    s.users.get('usr_minjae')!.email = 'minjae@msp.example';
    s.users.get('usr_yuna')!.email = 'yuna@mirae.example';
    s.loginDomains.set('cus_mirae', ['mirae.example', 'shared.example']);
    s.loginDomains.set('cus_hanbit', ['hanbit.example', 'shared.example']);
  }));
  afterEach(async () => { await w?.fx.close(); });
  const admin = USERS.minjae;
  const list = async (query: Record<string, string> = {}, who: AuthContext = admin) => body(await w.call(who, 'GET', '/users', { query })).items as any[];
  const mk = async (b: Record<string, unknown>, who: AuthContext = admin) => w.call(who, 'POST', '/users', { body: b });
  const repo = () => w.fx.repo;

  describe('GET /users', () => {
    it('ADMIN with the all-customer range lists users with a masked e-mail; nothing else about the address leaves', async () => {
      await open();
      const r = await w.call(admin, 'GET', '/users');
      expect(r.status).toBe(200);
      const items = body(r).items as any[];
      expect(items.map((u) => u.id)).toContain('usr_yuna');
      const yuna = items.find((u) => u.id === 'usr_yuna');
      expect(yuna).toMatchObject({ kind: 'CUSTOMER', customerId: 'cus_mirae', role: 'VIEWER', status: 'ACTIVE', emailMasked: 'y•••@mirae.example', googleBound: false, lastLoginAt: null });
      expect(JSON.stringify(r.body)).not.toContain('yuna@mirae.example');
      expect((await list({ kind: 'CUSTOMER' })).map((u) => u.id).sort()).toEqual(['usr_dohyun', 'usr_yuna']);
      expect((await list({ customerId: 'cus_hanbit' })).map((u) => u.id)).toEqual(['usr_dohyun']);
      expect((await list({ q: 'Minjae' })).map((u) => u.id)).toEqual(['usr_minjae']);
      expect((await list({ q: 'mirae.example' })).map((u) => u.id)).toEqual(['usr_yuna']);
      expect((await w.call(admin, 'GET', '/users', { query: { kind: 'X' } })).status).toBe(400);
    });

    it('roles: other staff 403, staff narrowed to some customers 403, portal user 404, no session 401', async () => {
      await open();
      expect((await w.call(USERS.haeun, 'GET', '/users')).status).toBe(403);
      expect((await w.call(USERS.viewer, 'GET', '/users/usr_yuna')).status).toBe(403);
      expect((await w.call(NARROW, 'GET', '/users')).status).toBe(403);
      expect((await w.call(USERS.yuna, 'GET', '/users')).status).toBe(404);
      expect((await w.call(USERS.yuna, 'POST', '/users', { body: {} })).status).toBe(404);
      expect((await w.call(null, 'GET', '/users')).status).toBe(401);
    });

    it('GET /users/{id}: one user; unknown id 404', async () => {
      await open();
      expect(body(await w.call(admin, 'GET', '/users/usr_dohyun'))).toMatchObject({ id: 'usr_dohyun', customerId: 'cus_hanbit' });
      expect((await w.call(admin, 'GET', '/users/usr_nobody')).status).toBe(404);
    });
  });

  describe('POST /users', () => {
    it('creates MSP staff (any of the three roles) and a portal user bound to one customer (VIEWER); e-mail is stored lower-case and unique; audited without the address', async () => {
      await open();
      const s = await mk({ email: '  New.Staff@MSP.Example ', name: 'New Staff', kind: 'INTERNAL', role: 'OPERATOR' });
      expect(s.status).toBe(201);
      expect(body(s)).toMatchObject({ kind: 'INTERNAL', customerId: null, role: 'OPERATOR', status: 'ACTIVE', emailMasked: 'n•••@msp.example' });
      const p = await mk({ email: 'Pat@Mirae.Example', name: 'Pat', kind: 'CUSTOMER', customerId: 'cus_mirae' });
      expect(p.status).toBe(201);
      expect(body(p)).toMatchObject({ kind: 'CUSTOMER', customerId: 'cus_mirae', role: 'VIEWER' });
      for (const e of ['new.staff@msp.example', 'NEW.STAFF@msp.example', 'pat@mirae.example']) {
        const d = await mk({ email: e, name: 'Dup', kind: 'INTERNAL', role: 'VIEWER' });
        expect([e, d.status, body(d).error.code]).toEqual([e, 409, 'ALREADY_EXISTS']);
      }
      expect((await list({ q: 'new.staff@msp.example' })).length).toBe(1);
      const audits = (await w.fx.audits()).filter((a) => a.action === 'user.create');
      expect(audits.map((a) => [a.actorId, a.targetId, a.customerId])).toEqual([['usr_minjae', body(s).id, null], ['usr_minjae', body(p).id, 'cus_mirae']]);
      expect(JSON.stringify(audits)).not.toMatch(/@/);
    });

    it('validates: unknown keys, e-mail, name, kind, role, customer rules', async () => {
      await open();
      const bad: Array<Record<string, unknown>> = [
        { email: 'a@x.example', name: 'A', kind: 'INTERNAL', role: 'ADMIN', status: 'ACTIVE' }, { email: 'nope', name: 'A', kind: 'INTERNAL', role: 'ADMIN' },
        { email: 'a@x.example', name: '', kind: 'INTERNAL', role: 'ADMIN' }, { email: 'a@x.example', name: 'A', kind: 'OTHER', role: 'ADMIN' },
        { email: 'a@x.example', name: 'A', kind: 'INTERNAL' }, { email: 'a@x.example', name: 'A', kind: 'INTERNAL', role: 'ROOT' },
        { email: 'a@x.example', name: 'A', kind: 'INTERNAL', role: 'ADMIN', customerId: 'cus_mirae' },
        { email: 'a@x.example', name: 'A', kind: 'CUSTOMER' }, { email: 'a@x.example', name: 'A', kind: 'CUSTOMER', customerId: 'cus_mirae', role: 'ADMIN' },
        { email: 'a@x.example', name: 'A', kind: 'CUSTOMER', customerId: 'cus_nope' },
      ];
      for (const b of bad) { const r = await mk(b); expect([b, r.status]).toEqual([b, 400]); }
      expect((await w.call(admin, 'POST', '/users', { body: 'text' })).status).toBe(400);
      expect((await list()).length).toBe(5);
    });

    it('a TERMINATED customer takes no new portal user; OPERATOR 403; Idempotency-Key replays the first answer (one user, one audit row)', async () => {
      await open();
      await w.fx.setCustomerStatus('cus_hanbit', 'TERMINATED');
      expect((await mk({ email: 'x@hanbit.example', name: 'X', kind: 'CUSTOMER', customerId: 'cus_hanbit' })).status).toBe(400);
      expect((await mk({ email: 'x@msp.example', name: 'X', kind: 'INTERNAL', role: 'VIEWER' }, USERS.haeun)).status).toBe(403);
      const b = { email: 'idem@msp.example', name: 'Idem', kind: 'INTERNAL', role: 'VIEWER' };
      const a1 = await w.call(admin, 'POST', '/users', { body: b, headers: { 'idempotency-key': 'k1' } });
      const a2 = await w.call(admin, 'POST', '/users', { body: b, headers: { 'idempotency-key': 'k1' } });
      expect([a1.status, a2.status, body(a2).id]).toEqual([201, 201, body(a1).id]);
      expect((await w.fx.audits()).filter((a) => a.action === 'user.create').length).toBe(1);
    });

    it('parallel creates of one e-mail: exactly one 201, the rest 409', async () => {
      await open();
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => mk({ email: i % 2 ? 'Race@msp.example' : 'race@msp.example', name: `R${i}`, kind: 'INTERNAL', role: 'VIEWER' })));
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
      expect((await list({ q: 'race@msp.example' })).length).toBe(1);
    });
  });

  describe('PATCH /users/{id}', () => {
    it('changes role, disables and activates; audited with before/after and no address; a no-op writes nothing', async () => {
      await open();
      const u = body(await mk({ email: 'op@msp.example', name: 'Op', kind: 'INTERNAL', role: 'OPERATOR' }));
      const r1 = await w.call(admin, 'PATCH', `/users/${u.id}`, { body: { role: 'ADMIN' } });
      expect(body(r1)).toMatchObject({ role: 'ADMIN', status: 'ACTIVE' });
      const r2 = await w.call(admin, 'PATCH', `/users/${u.id}`, { body: { status: 'DISABLED' } });
      expect(body(r2).status).toBe('DISABLED');
      const r3 = await w.call(admin, 'PATCH', `/users/${u.id}`, { body: { status: 'ACTIVE', role: 'VIEWER' } });
      expect(body(r3)).toMatchObject({ status: 'ACTIVE', role: 'VIEWER' });
      const n = (await w.fx.audits()).length;
      expect(body(await w.call(admin, 'PATCH', `/users/${u.id}`, { body: { role: 'VIEWER' } })).role).toBe('VIEWER');
      expect((await w.fx.audits()).length).toBe(n);
      const ups = (await w.fx.audits()).filter((a) => a.action === 'user.update');
      expect(ups.length).toBe(3);
      expect(ups[0]).toMatchObject({ actorType: 'USER', actorId: 'usr_minjae', targetId: u.id, before: { role: 'OPERATOR' }, after: { role: 'ADMIN' } });
      expect(JSON.stringify(ups)).not.toMatch(/@/);
      // a disabled user has no session
      await w.call(admin, 'PATCH', `/users/${u.id}`, { body: { status: 'DISABLED' } });
      expect(await repo().sessionPrincipal(u.id)).toBeNull();
    });

    it('portal users: always VIEWER; the customer range moves only to an existing customer (and not with a linked contact)', async () => {
      await open();
      const p = body(await mk({ email: 'pat@mirae.example', name: 'Pat', kind: 'CUSTOMER', customerId: 'cus_mirae' }));
      expect((await w.call(admin, 'PATCH', `/users/${p.id}`, { body: { role: 'ADMIN' } })).status).toBe(400);
      expect(body(await w.call(admin, 'PATCH', `/users/${p.id}`, { body: { customerId: 'cus_hanbit' } })).customerId).toBe('cus_hanbit');
      expect((await w.call(admin, 'PATCH', `/users/${p.id}`, { body: { customerId: 'cus_nope' } })).status).toBe(400);
      expect((await w.call(admin, 'PATCH', '/users/usr_yuna', { body: { customerId: 'cus_hanbit' } })).status).toBe(409); // linked to the contact of Mirae
      const s = body(await mk({ email: 'staff@msp.example', name: 'S', kind: 'INTERNAL', role: 'VIEWER' }));
      expect((await w.call(admin, 'PATCH', `/users/${s.id}`, { body: { customerId: 'cus_mirae' } })).status).toBe(400);
    });

    it('validation: unknown keys, empty body, bad values; unknown user 404; other staff 403, portal 404', async () => {
      await open();
      for (const b of [{}, { email: 'x@y.example' }, { role: 'ROOT' }, { status: 'PENDING' }, { clearGoogleSub: false }, { customerId: 5 }]) {
        expect([b, (await w.call(admin, 'PATCH', '/users/usr_haeun', { body: b })).status]).toEqual([b, 400]);
      }
      expect((await w.call(admin, 'PATCH', '/users/usr_nobody', { body: { role: 'VIEWER' } })).status).toBe(404);
      expect((await w.call(USERS.haeun, 'PATCH', '/users/usr_haeun', { body: { role: 'ADMIN' } })).status).toBe(403);
      expect((await w.call(USERS.yuna, 'PATCH', '/users/usr_haeun', { body: { role: 'ADMIN' } })).status).toBe(404);
    });

    it('nobody changes their own role, disables themselves or resets their own Google binding (403); setting what is already set is fine', async () => {
      await open();
      const b = body(await mk({ email: 'b@msp.example', name: 'B', kind: 'INTERNAL', role: 'ADMIN' }));
      const asB: AuthContext = { userId: b.id, name: 'B', kind: 'INTERNAL', customerIds: '*', role: 'ADMIN' };
      for (const x of [{ role: 'VIEWER' }, { status: 'DISABLED' }]) expect([x, (await w.call(asB, 'PATCH', `/users/${b.id}`, { body: x })).status]).toEqual([x, 403]);
      expect((await w.call(asB, 'PATCH', `/users/${b.id}`, { body: { role: 'ADMIN' } })).status).toBe(200);
      expect(body(await w.call(admin, 'GET', `/users/${b.id}`))).toMatchObject({ role: 'ADMIN', status: 'ACTIVE' });
    });

    it('the last ACTIVE all-range ADMIN is never demoted or disabled (409 LAST_ADMIN, nothing changes); with a second ADMIN it is allowed', async () => {
      await open();
      for (const x of [{ role: 'OPERATOR' }, { status: 'DISABLED' }]) {
        const r = await w.call(GHOST, 'PATCH', '/users/usr_minjae', { body: x });
        expect([x, r.status, body(r).error.code]).toEqual([x, 409, 'LAST_ADMIN']);
      }
      expect(body(await w.call(admin, 'GET', '/users/usr_minjae'))).toMatchObject({ role: 'ADMIN', status: 'ACTIVE' });
      const b = body(await mk({ email: 'b@msp.example', name: 'B', kind: 'INTERNAL', role: 'ADMIN' }));
      expect((await w.call(GHOST, 'PATCH', '/users/usr_minjae', { body: { role: 'OPERATOR' } })).status).toBe(200);
      expect((await w.call(GHOST, 'PATCH', `/users/${b.id}`, { body: { status: 'DISABLED' } })).status).toBe(409);
      // a DISABLED or PENDING admin does not count as an admin to keep
      expect((await w.call(GHOST, 'PATCH', `/users/${b.id}`, { body: { role: 'VIEWER' } })).status).toBe(409);
    });

    it('two ADMINs demoting each other at the same moment: exactly one succeeds, one ADMIN is left', async () => {
      await open();
      const b = body(await mk({ email: 'b@msp.example', name: 'B', kind: 'INTERNAL', role: 'ADMIN' }));
      const rs = await Promise.all([w.call(GHOST, 'PATCH', '/users/usr_minjae', { body: { status: 'DISABLED' } }), w.call(GHOST, 'PATCH', `/users/${b.id}`, { body: { role: 'VIEWER' } })]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      const admins = (await list({ role: 'ADMIN', status: 'ACTIVE', kind: 'INTERNAL' }));
      expect(admins.length).toBe(1);
    });

    it('clearGoogleSub: an ADMIN resets another user\'s Google binding (audited); the next sign-in binds again', async () => {
      await open();
      expect(await repo().bindGoogleSub('usr_haeun', 'sub-old', T)).toBe('bound');
      expect(body(await w.call(admin, 'GET', '/users/usr_haeun')).googleBound).toBe(true);
      expect(JSON.stringify((await w.call(admin, 'GET', '/users/usr_haeun')).body)).not.toContain('sub-old');
      const r = await w.call(admin, 'PATCH', '/users/usr_haeun', { body: { clearGoogleSub: true } });
      expect(body(r).googleBound).toBe(false);
      const a = (await w.fx.audits()).filter((x) => x.action === 'user.update').at(-1)!;
      expect(a).toMatchObject({ actorId: 'usr_minjae', targetId: 'usr_haeun', before: { googleBound: true }, after: { googleBound: false } });
      expect(await repo().bindGoogleSub('usr_haeun', 'sub-new', T)).toBe('bound');
      expect((await w.call(admin, 'PATCH', '/users/usr_minjae', { body: { clearGoogleSub: true } })).status).toBe(200); // nothing bound: no-op, fine
    });
  });

  describe('enrolPortalUserByDomain (D-55 b)', () => {
    it('one ACTIVE customer owns the domain: creates a CUSTOMER / VIEWER / ACTIVE user with a system audit row; the second call returns the same user', async () => {
      await open();
      const r = await repo().enrolPortalUserByDomain('Newbie@Mirae.Example', T);
      expect(r).toMatchObject({ created: true, user: { kind: 'CUSTOMER', customerId: 'cus_mirae', role: 'VIEWER', status: 'ACTIVE', email: 'newbie@mirae.example', name: 'newbie' } });
      const again = await repo().enrolPortalUserByDomain('newbie@mirae.example', T);
      expect(again).toMatchObject({ created: false, user: { id: (r as any).user.id } });
      const au = (await w.fx.audits()).filter((a) => a.action === 'user.enrol_domain');
      expect(au).toHaveLength(1);
      expect(au[0]).toMatchObject({ actorType: 'SYSTEM', actorId: null, customerId: 'cus_mirae', targetId: (r as any).user.id, after: { reason: 'LOGIN_DOMAIN' } });
      expect(JSON.stringify(au)).not.toMatch(/@/);
      expect(await repo().sessionPrincipal((r as any).user.id)).toMatchObject({ customerId: 'cus_mirae', role: 'VIEWER' });
    });

    it('returns an existing portal user of that customer (also a pre-registered one) and creates nothing', async () => {
      await open();
      const r = await repo().enrolPortalUserByDomain('yuna@mirae.example', T);
      expect(r).toMatchObject({ created: false, user: { id: 'usr_yuna' } });
      expect((await list()).length).toBe(5);
    });

    it('refuses and creates nothing: unknown domain, two customers, inactive customer, free mail, staff e-mail, another customer\'s user, malformed', async () => {
      await open();
      await repo().createUser({ email: 'dual@mirae.example', name: 'Dual', customerId: 'cus_hanbit', role: 'VIEWER', status: 'ACTIVE' }, { at: T, actorType: 'USER', actorId: 'x', action: 'user.create', targetType: 'User', before: null, after: null });
      await repo().createUser({ email: 'chief@mirae.example', name: 'Chief', customerId: null, role: 'ADMIN', status: 'ACTIVE' }, { at: T, actorType: 'USER', actorId: 'x', action: 'user.create', targetType: 'User', before: null, after: null });
      const n = (await list()).length;
      const refused = async (e: string) => (await repo().enrolPortalUserByDomain(e, T) as any).refused;
      expect(await refused('a@unknown.example')).toBe('DOMAIN_UNKNOWN');
      expect(await refused('a@shared.example')).toBe('AMBIGUOUS');
      expect(await refused('a@gmail.com')).toBe('FREE_MAIL');
      expect(await refused('a@mail.naver.com')).toBe('FREE_MAIL');
      expect(await refused('chief@mirae.example')).toBe('STAFF_EMAIL');
      expect(await refused('dual@mirae.example')).toBe('OTHER_CUSTOMER');
      expect(await refused('not an email')).toBe('INVALID_EMAIL');
      await w.fx.setCustomerStatus('cus_hanbit', 'SUSPENDED');
      expect(await refused('a@hanbit.example')).toBe('CUSTOMER_INACTIVE');
      expect((await list()).length).toBe(n);
      expect((await w.fx.audits()).filter((a) => a.action === 'user.enrol_domain')).toHaveLength(0);
    });

    it('an existing DISABLED or PENDING user is refused (USER_INACTIVE), nothing is created or changed; ACTIVE again -> returned', async () => {
      await open();
      await w.call(admin, 'PATCH', '/users/usr_yuna', { body: { status: 'DISABLED' } });
      expect(await repo().enrolPortalUserByDomain('yuna@mirae.example', T)).toEqual({ refused: 'USER_INACTIVE' });
      expect(await repo().createUser({ email: 'pend@mirae.example', name: 'Pend', customerId: 'cus_mirae', role: 'VIEWER', status: 'PENDING' }, { at: T, actorType: 'USER', actorId: 'x', action: 'user.create', targetType: 'User', before: null, after: null })).toMatchObject({ status: 'PENDING' });
      expect(await repo().enrolPortalUserByDomain('Pend@mirae.example', T)).toEqual({ refused: 'USER_INACTIVE' });
      expect(body(await w.call(admin, 'GET', '/users/usr_yuna')).status).toBe('DISABLED');
      expect((await list({ q: 'pend@mirae.example' }))[0].status).toBe('PENDING');
      expect((await w.fx.audits()).filter((a) => a.action === 'user.enrol_domain')).toHaveLength(0);
      await w.call(admin, 'PATCH', '/users/usr_yuna', { body: { status: 'ACTIVE' } });
      expect(await repo().enrolPortalUserByDomain('yuna@mirae.example', T)).toMatchObject({ created: false, user: { id: 'usr_yuna', status: 'ACTIVE' } });
    });

    it('parallel first sign-ins of one address: one user, one audit row, everybody gets the same user', async () => {
      await open();
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? repo() : w.fx.secondRunner()).enrolPortalUserByDomain(i % 3 ? 'Race@mirae.example' : 'race@MIRAE.example', T)));
      const ids = new Set(rs.map((r: any) => r.user.id));
      expect(ids.size).toBe(1);
      expect(rs.filter((r: any) => r.created)).toHaveLength(1);
      expect((await list({ q: 'race@mirae.example' })).length).toBe(1);
      expect((await w.fx.audits()).filter((a) => a.action === 'user.enrol_domain')).toHaveLength(1);
    });
  });

  describe('bindGoogleSub and touchLastLogin', () => {
    it('bound the first time (audited), ok for the same account, mismatch for another (nothing changes, audited with a reason code, no e-mail)', async () => {
      await open();
      expect(await repo().bindGoogleSub('usr_yuna', 'g-1', T)).toBe('bound');
      expect(await repo().bindGoogleSub('usr_yuna', 'g-1', T)).toBe('ok');
      expect(await repo().bindGoogleSub('usr_yuna', 'g-2', T)).toBe('mismatch');
      expect(await repo().bindGoogleSub('usr_yuna', 'g-1', T)).toBe('ok');
      expect(await repo().bindGoogleSub('usr_nobody', 'g-1', T)).toBe('NOT_FOUND');
      const au = (await w.fx.audits()).filter((a) => a.action.startsWith('user.google_'));
      expect(au.map((a) => [a.action, (a.after as any).reason, a.actorType, a.targetId, a.customerId])).toEqual([
        ['user.google_bind', 'FIRST_SIGN_IN', 'SYSTEM', 'usr_yuna', 'cus_mirae'], ['user.google_mismatch', 'GOOGLE_SUB_MISMATCH', 'SYSTEM', 'usr_yuna', 'cus_mirae']]);
      expect(JSON.stringify(au)).not.toMatch(/@|g-1|g-2/);
    });

    it('one Google account cannot be bound to two users', async () => {
      await open();
      expect(await repo().bindGoogleSub('usr_yuna', 'g-1', T)).toBe('bound');
      expect(await repo().bindGoogleSub('usr_dohyun', 'g-1', T)).toBe('mismatch');
      expect(body(await w.call(admin, 'GET', '/users/usr_dohyun')).googleBound).toBe(false);
      expect((await w.fx.audits()).filter((a) => a.action === 'user.google_mismatch').map((a) => (a.after as any).reason)).toEqual(['GOOGLE_SUB_IN_USE']);
    });

    it('two different accounts binding at the same moment: exactly one wins', async () => {
      await open();
      const rs = await Promise.all(['g-a', 'g-b', 'g-a', 'g-b'].map((s, i) => (i % 2 ? repo() : w.fx.secondRunner()).bindGoogleSub('usr_haeun', s, T)));
      expect(rs.filter((r) => r === 'bound')).toHaveLength(1);
      expect(rs.filter((r) => r === 'mismatch')).toHaveLength(2);
      expect(rs.filter((r) => r === 'ok')).toHaveLength(1);
    });

    it('rejects an empty or control-character sub', async () => {
      await open();
      await expect(repo().bindGoogleSub('usr_yuna', '', T)).rejects.toThrow();
      await expect(repo().bindGoogleSub('usr_yuna', 'a\u0000b', T)).rejects.toThrow();
    });

    it('touchLastLogin sets lastLoginAt (no audit row); unknown id is a no-op', async () => {
      await open();
      const n = (await w.fx.audits()).length;
      await repo().touchLastLogin('usr_yuna', T);
      await repo().touchLastLogin('usr_nobody', T);
      expect((await list()).find((u) => u.id === 'usr_yuna').lastLoginAt).toBe(T.toISOString());
      expect((await w.fx.audits()).length).toBe(n);
    });
  });
}
