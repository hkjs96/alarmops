/** Regression tests for the second security review (API side): R-13 viewer, R-15, R-16, N-15, N-19, Retry-After, R-12 read side. */
import { afterEach, describe, expect, it } from 'vitest';
import { IDEMPOTENCY_MAX_PER_USER } from '@alarmops/core';
import { effectiveRole, loadApiConfig, normalizeAuth, requireRole, serializerFor, type AuthContext } from '../src/index.js';
import { USERS, body, world } from './helpers.js';

describe('R-16: the AuthContext is rebuilt from own, primitive fields on a null prototype', () => {
  const proto = Object.prototype as unknown as Record<string, unknown>;
  afterEach(() => { for (const k of ['role', 'kind', 'customerIds', 'userId', 'subScopes']) delete proto[k]; });

  it('array / object / String-object roles are no role (was: ADMIN through key coercion)', async () => {
    const w = await world();
    for (const role of [['ADMIN'], { toString: () => 'ADMIN' }, new String('ADMIN'), 2, true, 'admin', 'ADMIN ']) {
      const auth = { ...USERS.minjae, role } as unknown as AuthContext;
      expect(effectiveRole(normalizeAuth(auth)!), String(role)).toBeNull();
      const r = await w.call(auth, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': '1' } });
      expect(r.status, String(role)).toBe(403);
      // reads still work as the scope allows
      expect((await w.call(auth, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(200);
    }
    expect(w.store.incidents.get(w.ids.mirae)!.status).toBe('TRIGGERED');
  });

  it('a polluted Object.prototype gives nothing: no role, no kind, no customers', async () => {
    const w = await world();
    proto.role = 'ADMIN';
    const noRole = { userId: 'usr_x', kind: 'INTERNAL', customerIds: '*' } as unknown as AuthContext;
    expect((await w.call(noRole, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': '1' } })).status).toBe(403); // was 200
    expect(() => requireRole(noRole, 'VIEWER')).toThrow();
    proto.kind = 'INTERNAL';
    proto.customerIds = '*';
    expect(normalizeAuth({ userId: 'usr_x' })).toBeNull(); // was: the whole range from `{ userId }` alone
    expect((await w.call({ userId: 'usr_x' } as never, 'GET', '/incidents')).status).toBe(401);
    proto.subScopes = [{ customerId: 'cus_mirae' }];
    expect(normalizeAuth(USERS.yuna)!.subScopes).toBeUndefined();
  });

  it('the context handlers work with is a frozen null-prototype copy; getters are not read', () => {
    const src = { ...USERS.haeun, customerIds: ['cus_mirae'], subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_core' }] };
    const a = normalizeAuth(src)!;
    expect(Object.getPrototypeOf(a)).toBeNull();
    expect(Object.isFrozen(a)).toBe(true);
    src.customerIds.push('cus_hanbit');
    (src as { role: string }).role = 'ADMIN';
    expect(a.customerIds).toEqual(['cus_mirae']);
    expect(a.role).toBe('OPERATOR');
    expect(Object.getPrototypeOf(a.subScopes![0])).toBeNull();
    const sneaky = Object.defineProperty({ userId: 'u', kind: 'INTERNAL', customerIds: '*' }, 'role', { get: () => 'ADMIN', enumerable: true });
    expect(effectiveRole(normalizeAuth(sneaky)!)).toBeNull();
    for (const bad of [{ ...USERS.haeun, userId: new String('u') }, { ...USERS.haeun, kind: ['INTERNAL'] }, { ...USERS.haeun, customerIds: [new String('cus_mirae')] }, { ...USERS.haeun, customerIds: new String('*') }, [], null, 'x']) {
      expect(normalizeAuth(bad)).toBeNull();
    }
  });
});

describe('N-15: a sub-scope for a customer the user does not have is 401, not “see the whole customer”', () => {
  it('wrong case, another tenant, and "*" for a portal user', async () => {
    const w = await world();
    const base = { userId: 'usr_p', kind: 'INTERNAL', role: 'ADMIN', customerIds: ['cus_mirae'] } as const;
    for (const subScopes of [[{ customerId: 'CUS_MIRAE', projectId: 'prj_core' }], [{ customerId: 'cus_hanbit', projectId: 'prj_shop' }], [{ customerId: 'cus_mirae', projectId: 'prj_core' }, { customerId: 'cus_nope' }]]) {
      const r = await w.call({ ...base, subScopes } as AuthContext, 'GET', '/incidents');
      expect(r.status, JSON.stringify(subScopes)).toBe(401);
      expect(body(r).error.code).toBe('UNAUTHENTICATED');
    }
    expect((await w.call({ ...base, subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_core' }] } as AuthContext, 'GET', '/incidents')).status).toBe(200);
    // staff with the full range may be narrowed to any customer
    expect((await w.call({ ...base, customerIds: '*', subScopes: [{ customerId: 'cus_hanbit', projectId: 'prj_shop' }] } as AuthContext, 'GET', '/incidents')).status).toBe(200);
    expect(normalizeAuth({ userId: 'u', kind: 'CUSTOMER', customerIds: '*', subScopes: [{ customerId: 'cus_mirae' }] })).toBeNull();
  });
});

describe('R-15: PORTAL_SHOWS_STAFF_NAMES is on only for the boolean true', () => {
  it("config 'false' (an env string), 1, 'true' and {} keep the alias; true shows names", async () => {
    for (const v of ['false', 'true', 1, {}, null, undefined, false]) {
      const w = await world({ config: { portalShowsStaffNames: v as never } });
      const d = body(await w.call(USERS.yuna, 'GET', `/incidents/${w.ids.mirae}`));
      expect(d.assignee, String(v)).toEqual({ name: 'MSP on-call' });
      expect(JSON.stringify(d), String(v)).not.toContain('Haeun');
    }
    const w = await world({ config: { portalShowsStaffNames: true } });
    expect(body(await w.call(USERS.yuna, 'GET', `/incidents/${w.ids.mirae}`)).assignee).toEqual({ name: 'Haeun Kim' });
    expect(serializerFor({ kind: 'CUSTOMER' }, { portalShowsStaffNames: 'false' as never }).assignee({ contactId: 'c', name: 'Haeun Kim', via: 'x', kind: 'INTERNAL' })).toEqual({ name: 'MSP on-call' });
  });

  it('loadApiConfig parses env strings', () => {
    expect(loadApiConfig({ PORTAL_SHOWS_STAFF_NAMES: 'false' })).toEqual({ config: { portalShowsStaffNames: false }, warnings: [] });
    expect(loadApiConfig({ PORTAL_SHOWS_STAFF_NAMES: 'true' }).config).toEqual({ portalShowsStaffNames: true });
    expect(loadApiConfig({ PORTAL_SHOWS_STAFF_NAMES: 'yes please' })).toMatchObject({ config: { portalShowsStaffNames: false }, warnings: [expect.stringContaining('PORTAL_SHOWS_STAFF_NAMES')] });
    expect(loadApiConfig()).toEqual({ config: { portalShowsStaffNames: false }, warnings: [] });
  });
});

describe('N-19: the idempotency store is bounded per user and holds no previews', () => {
  it('500 previews with 500 keys store nothing; the same key then works for the real request', async () => {
    const w = await world();
    const items = [{ id: w.ids.mirae, version: 1 }];
    for (let i = 0; i < 500; i++) {
      const r = await w.call(USERS.haeun, 'POST', '/incidents/bulk', { headers: { 'Idempotency-Key': `p${i}` }, body: { action: 'ack', preview: true, items } });
      expect(r.status).toBe(200);
    }
    expect(w.store.idempotent.size).toBe(0); // was 500 entries of ~10 KB
    const run = await w.call(USERS.haeun, 'POST', '/incidents/bulk', { headers: { 'Idempotency-Key': 'p0' }, body: { action: 'ack', preview: false, items } });
    expect(body(run).done).toEqual([w.ids.mirae]);
    expect(w.store.idempotent.size).toBe(1);
  });

  it(`a user holds at most ${IDEMPOTENCY_MAX_PER_USER} entries: the oldest is dropped, other users are not touched, a recent key still replays`, async () => {
    const w = await world();
    const send = (user: AuthContext, key: string) => w.call(user, 'POST', '/incidents/bulk', { headers: { 'Idempotency-Key': key }, body: { action: 'ack', preview: false, items: [{ id: 'inc-nope', version: 1 }] } });
    await send(USERS.minjae, 'other');
    for (let i = 0; i < IDEMPOTENCY_MAX_PER_USER + 50; i++) expect((await send(USERS.haeun, `k${i}`)).status).toBe(200);
    const owners = [...w.store.idempotent.values()].map((v) => v.owner);
    expect(owners.filter((o) => o === 'usr_haeun')).toHaveLength(IDEMPOTENCY_MAX_PER_USER);
    expect(owners.filter((o) => o === 'usr_minjae')).toHaveLength(1);
    const before = w.store.reads.length;
    await send(USERS.haeun, `k${IDEMPOTENCY_MAX_PER_USER + 49}`); // newest: replayed, the handler does not run
    expect(w.store.reads.length).toBe(before);
    await send(USERS.haeun, 'k0'); // oldest: gone, runs again (and is itself guarded by versions)
    expect(w.store.reads.length).toBeGreaterThan(before);
    expect([...w.store.idempotent.values()].filter((v) => v.owner === 'usr_haeun')).toHaveLength(IDEMPOTENCY_MAX_PER_USER);
  });
});

describe('RATE_LIMITED carries Retry-After', () => {
  it('second manual escalate inside the gap: 429, Retry-After header = details.retryAfterSec', async () => {
    const w = await world();
    const first = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/escalate`, { headers: { 'If-Match': '1' } });
    expect(first.status).toBe(200);
    const again = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/escalate`, { headers: { 'If-Match': first.headers.etag!.replace(/"/g, '') } });
    expect(again.status).toBe(429);
    expect(body(again).error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSec: 60 } });
    expect(again.headers['retry-after']).toBe('60');
    // the one 404 never carries it
    expect((await w.call(USERS.haeun, 'POST', '/incidents/nope/escalate', { headers: { 'If-Match': '1' } })).headers['retry-after']).toBeUndefined();
  });
});

describe('R-12 (read side): the saved order is re-checked against today’s responders', () => {
  it('GET /customers/{id}/paging reports sendCap; adding responders flips `exceeded` without a PUT', async () => {
    const w = await world();
    const put = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': '1' }, body: { style: 'CUSTOM', plan: 'STANDARD', repeatCount: 0, steps: [{ atMin: 0, targetType: 'ALL_RESPONDERS', channels: ['SMS', 'VOICE'] }] } });
    expect(put.status).toBe(200);
    expect(body(put).sendCap).toEqual({ perCycle: 6, perHour: 6, limits: { perCycle: 60, perHour: 120, allResponders: 20 }, exceeded: null });
    for (let i = 0; i < 40; i++) {
      w.store.contacts.set(`ct_n${i}`, { id: `ct_n${i}`, kind: 'INTERNAL', customerId: null, name: `N${i}`, active: true, phone: `+82105550${i}`, phoneVerifiedAt: new Date('2026-10-01T00:00:00Z') });
      w.store.responders.push({ customerId: 'cus_mirae', contactId: `ct_n${i}`, role: 'PAGEABLE' });
    }
    const get = body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/paging'));
    expect(get.sendCap.exceeded).toBe('RESPONDER_LIMIT_EXCEEDED');
    // and the same steps can no longer be saved
    const again = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': String(get.version) }, body: { style: 'CUSTOM', plan: 'STANDARD', repeatCount: 0, steps: get.steps } });
    expect(again.status).toBe(422);
    expect(body(again).error.code).toBe('RESPONDER_LIMIT_EXCEEDED');
  });
});

describe('N-13 / R-12 notes for portal users carry no names or ids', () => {
  it('DEFERRED_MAINTENANCE and SEND_CAP_CLAMPED are fixed sentences', async () => {
    const w = await world();
    w.store.events.push(
      { id: 'ev_d', incidentId: w.ids.mirae, customerId: 'cus_mirae', at: w.sim.now, kind: 'NOTE', actorType: 'SYSTEM', actorId: null, message: 'Step 2/4: SMS to Haeun Kim is held by a maintenance window until …', data: { note: 'DEFERRED_MAINTENANCE', contactId: 'ct_haeun' } },
      { id: 'ev_c', incidentId: w.ids.mirae, customerId: 'cus_mirae', at: w.sim.now, kind: 'NOTE', actorType: 'SYSTEM', actorId: null, message: 'Send limit applied: … pc_cus_mirae', data: { note: 'SEND_CAP_CLAMPED' } },
    );
    const t = body(await w.call(USERS.yuna, 'GET', `/incidents/${w.ids.mirae}/timeline`));
    const msgs = t.items.map((e: { message: string }) => e.message);
    expect(msgs).toEqual(expect.arrayContaining(['A page is held until the maintenance window ends.', 'A send limit was applied to the paging steps of this incident.']));
    expect(JSON.stringify(t)).not.toMatch(/Haeun|ct_haeun|pc_cus/);
  });
});
