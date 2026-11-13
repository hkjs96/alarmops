/**
 * Contract suite of the console API's store (ApiRepository), through the real HTTP-shaped handlers (`createApi`):
 * the SAME tests run against MemoryApiStore (test/contract.memory.test.ts) and against the SQL store
 * (packages/store-sql/test/contract.api.test.ts). Tenant isolation, 404 parity, If-Match, idempotency, undo.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { IDEMPOTENCY_MAX_PER_USER, type TickRepository } from '@alarmops/core';
import { CSim } from '../../../core/test/contract/tickContract.js';
import type { MakeFixture, StoreFixture } from '../../../core/test/contract/fixture.js';
import { PATTERNS, T0, at, closedGroup, seedWorld } from '../../../core/test/world.js';
import { createApi, InMemoryCommandPublisher, MemoryApiStore, type ApiRepository, type ApiRequest, type ApiResponse, type AuthContext } from '../../src/index.js';
import { USERS, body, wire } from '../helpers.js';

type Repo = TickRepository & ApiRepository;
export type MakeApiFixture = MakeFixture<Repo>;

export interface CWorld {
  fx: StoreFixture<Repo>;
  sim: CSim;
  commands: InMemoryCommandPublisher;
  call: (auth: AuthContext | null, method: ApiRequest['method'], path: string, opts?: { query?: Record<string, string | undefined>; body?: unknown; headers?: Record<string, string>; requestId?: string }) => Promise<ApiResponse>;
  ids: { mirae: string; hanbit: string; unmapped: string };
  version(id: string): Promise<string>;
  snapshot(): Promise<string>;
}

/** The world of test/helpers.ts (two customers + one unmapped account, one open incident each), built through the fixture. */
export async function cworld(make: MakeApiFixture, extra: (s: MemoryApiStore) => void = () => undefined): Promise<CWorld> {
  const seed = seedWorld(new MemoryApiStore()) as MemoryApiStore;
  for (const [id, name, contactId, customerId] of [['usr_haeun', 'Haeun Kim', 'ct_haeun', null], ['usr_minjae', 'Minjae Lee', 'ct_minjae', null], ['usr_viewer', 'Viewer', null, null], ['usr_yuna', 'Yuna Seo', 'ct_yuna', 'cus_mirae'], ['usr_dohyun', 'Dohyun Han', 'ct_dohyun', 'cus_hanbit']] as const) {
    seed.users.set(id, { id, name, contactId, customerId });
  }
  seed.configs.push(PATTERNS.templateStandard(), PATTERNS.customerRotation());
  seed.contactScopes.push({ contactId: 'ct_seojun', customerId: 'cus_mirae', scopeType: 'SERVICE', scopeId: 'svc_pay', role: 'NOTIFY' });
  seed.resources.set('res_web1', { id: 'res_web1', name: 'web-1', customerId: 'cus_mirae', serviceId: 'svc_pay' });
  seed.resources.set('res_shop', { id: 'res_shop', name: 'shop-db', customerId: 'cus_hanbit', serviceId: 'svc_web' });
  seed.verifiedSlack.add('cus_mirae');
  closedGroup(seed, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_m1', title: 'payments-api 5xx high' }, { id: 'al_m2' }] });
  closedGroup(seed, { customerId: 'cus_hanbit', severity: 'SEV_3', at: T0, alerts: [{ id: 'al_h1', title: 'shop-db connections high' }] });
  closedGroup(seed, { customerId: null, at: T0, alerts: [{ id: 'al_u1', title: 'unknown account disk' }] });
  extra(seed);
  const fx = await make(seed);
  const sim = new CSim(fx);
  await sim.tick();
  const incs = await fx.incidents();
  const by = (customerId: string | null): string => incs.find((i) => i.customerId === customerId)!.id;
  const commands = new InMemoryCommandPublisher();
  const api = createApi({ repo: fx.repo, now: () => sim.now, commands });
  let seq = 0;
  return {
    fx, sim, commands, ids: { mirae: by('cus_mirae'), hanbit: by('cus_hanbit'), unmapped: by(null) },
    call: (auth, method, path, opts = {}) => api.handle({ method, path, auth, query: opts.query, body: opts.body, headers: opts.headers, requestId: opts.requestId ?? `req_${++seq}` }),
    version: async (id) => String((await fx.incidents()).find((i) => i.id === id)!.version),
    snapshot: async () => JSON.stringify([await fx.incidents(), (await fx.jobs()).map((j) => [j.idempotencyKey, j.status]), (await fx.audits()).length]),
  };
}

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Not found.', details: {}, requestId: 'req_same' } };

export function apiContract(make: MakeApiFixture): void {
  let w: CWorld;
  const open = async (extra?: (s: MemoryApiStore) => void): Promise<CWorld> => (w = await cworld(make, extra));
  afterEach(async () => { await w?.fx.close(); });

  describe('tenant isolation', () => {
    it('scope tree: staff see every customer with counts; a portal user sees only its own customer and no trace of the others', async () => {
      await open();
      const staff = body(await w.call(USERS.haeun, 'GET', '/scope-tree')).customers;
      expect(staff.map((c: any) => [c.slug, c.openIncidents, c.mine])).toEqual([['hanbit', 1, false], ['mirae', 1, true]]);
      expect(staff[1].projects.map((p: any) => [p.slug, p.openIncidents, p.services.map((s: any) => s.slug)])).toEqual([['core', 1, ['payments-api']], ['data-platform', 0, []]]);
      const r = await w.call(USERS.yuna, 'GET', '/scope-tree');
      expect(body(r).customers.map((c: any) => c.id)).toEqual(['cus_mirae']);
      const text = JSON.stringify(r.body);
      for (const leak of ['hanbit', 'Hanbit', 'cus_hanbit', 'svc_web', '999999999999']) expect(text).not.toContain(leak);
      const nobody: AuthContext = { userId: 'usr_x', kind: 'CUSTOMER', customerIds: [], role: 'VIEWER' };
      expect(body(await w.call(nobody, 'GET', '/scope-tree'))).toEqual({ customers: [] });
      expect(body(await w.call({ ...nobody, customerIds: '*' }, 'GET', '/scope-tree'))).toEqual({ customers: [] });
    });

    it('a project-scoped user sees only that subtree and only its incidents', async () => {
      await open();
      const data: AuthContext = { ...USERS.yuna, subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_data' }] };
      const tree = body(await w.call(data, 'GET', '/scope-tree')).customers;
      expect(tree[0].projects.map((p: any) => p.slug)).toEqual(['data-platform']);
      expect(tree[0].openIncidents).toBe(0);
      expect(body(await w.call(data, 'GET', '/incidents')).items).toEqual([]);
      expect((await w.call(data, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(404);
      const core: AuthContext = { ...USERS.yuna, subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_core' }] };
      expect(body(await w.call(core, 'GET', '/incidents')).items.map((i: any) => i.id)).toEqual([w.ids.mirae]);
      const svc: AuthContext = { ...USERS.yuna, subScopes: [{ customerId: 'cus_mirae', serviceId: 'svc_pay', projectId: 'prj_data' }] }; // a pair that does not belong together grants nothing
      expect(body(await w.call(svc, 'GET', '/incidents')).items).toEqual([]);
    });

    const cases: Array<[string, (ids: CWorld['ids']) => [string, Record<string, string>?], () => [string, Record<string, string>?]]> = [
      ['incident by id', (i) => [`/incidents/${i.hanbit}`], () => ['/incidents/inc-000000000000-20261109030000']],
      ['incident timeline', (i) => [`/incidents/${i.hanbit}/timeline`], () => ['/incidents/inc-nope/timeline']],
      ['incident notifications', (i) => [`/incidents/${i.hanbit}/notifications`], () => ['/incidents/inc-nope/notifications']],
      ['unmapped-account incident', (i) => [`/incidents/${i.unmapped}`], () => ['/incidents/inc-nope']],
      ['list by customer slug', () => ['/incidents', { customer: 'hanbit' }], () => ['/incidents', { customer: 'no-such-customer' }]],
      ['list by service slug', () => ['/incidents', { customer: 'hanbit', project: 'shop', service: 'web' }], () => ['/incidents', { customer: 'mirae', project: 'core', service: 'nope' }]],
      ['list by customerId', () => ['/incidents', { customerId: 'cus_hanbit' }], () => ['/incidents', { customerId: 'cus_nope' }]],
      ['customer paging', () => ['/customers/cus_hanbit/paging'], () => ['/customers/cus_nope/paging']],
      ['paging path by service', () => ['/oncall/paging-path', { serviceId: 'svc_web' }], () => ['/oncall/paging-path', { serviceId: 'svc_nope' }]],
      ['paging path by resource', () => ['/oncall/paging-path', { resourceId: 'res_shop' }], () => ['/oncall/paging-path', { resourceId: 'res_nope' }]],
    ];
    it('404 parity: another tenant’s thing and a thing that does not exist are the same bytes (10 reads, portal user)', async () => {
      await open();
      for (const [what, foreign, missing] of cases) {
        const [fp, fq] = foreign(w.ids);
        const [mp, mq] = missing();
        const a = await w.call(USERS.yuna, 'GET', fp, { query: fq, requestId: 'req_same' });
        const b = await w.call(USERS.yuna, 'GET', mp, { query: mq, requestId: 'req_same' });
        expect(a.status, what).toBe(404);
        expect(a.body, what).toEqual(NOT_FOUND);
        expect(wire(a), what).toBe(wire(b));
      }
    });

    it('staff limited to some customers get the same 404 for the others and for unmapped accounts', async () => {
      await open();
      const limited: AuthContext = { ...USERS.haeun, customerIds: ['cus_mirae'] };
      const a = await w.call(limited, 'GET', `/incidents/${w.ids.hanbit}`, { requestId: 'req_same' });
      const b = await w.call(limited, 'GET', '/incidents/inc-nope', { requestId: 'req_same' });
      const u = await w.call(limited, 'GET', `/incidents/${w.ids.unmapped}`, { requestId: 'req_same' });
      expect(wire(a)).toBe(wire(b));
      expect(wire(u)).toBe(wire(b));
      const list = body(await w.call(limited, 'GET', '/incidents'));
      expect(list.items.map((i: any) => i.id)).toEqual([w.ids.mirae]);
      expect(list.unmapped).toEqual([]);
      expect(list.counts.open).toBe(1);
    });

    it('writes on another tenant’s incident: 404 with the same bytes, and nothing is changed', async () => {
      await open();
      const before = await w.snapshot();
      for (const action of ['ack', 'resolve', 'escalate']) {
        const a = await w.call(USERS.yuna, 'POST', `/incidents/${w.ids.hanbit}/${action}`, { headers: { 'If-Match': await w.version(w.ids.hanbit) }, requestId: 'req_same', body: {} });
        const b = await w.call(USERS.yuna, 'POST', `/incidents/inc-nope/${action}`, { headers: { 'If-Match': await w.version(w.ids.hanbit) }, requestId: 'req_same', body: {} });
        expect(a.status).toBe(404);
        expect(wire(a)).toBe(wire(b));
      }
      const limited = { ...USERS.haeun, customerIds: ['cus_mirae'] };
      const r = body(await w.call(limited, 'POST', '/incidents/bulk', { body: { action: 'resolve', preview: false, items: [{ id: w.ids.hanbit, version: 1 }, { id: 'inc-nope', version: 1 }] } }));
      expect(r.conflicts).toEqual([{ id: w.ids.hanbit, code: 'NOT_FOUND' }, { id: 'inc-nope', code: 'NOT_FOUND' }]);
      expect(await w.snapshot()).toBe(before);
    });

    it('paging settings of another customer: the same 404 as a made-up customer; a service of another customer in the path too', async () => {
      await open();
      const steps = { style: 'CUSTOM', plan: 'URGENT', repeatCount: 0, steps: [{ atMin: 0, targetType: 'PERSON', targetId: 'ct_yuna', channels: ['VOICE'] }] };
      const a = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging-overrides/SERVICE/svc_web', { headers: { 'If-Match': '0' }, body: steps, requestId: 'r' });
      const b = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging-overrides/SERVICE/svc_nope', { headers: { 'If-Match': '0' }, body: steps, requestId: 'r' });
      expect(a.status).toBe(404);
      expect(wire(a)).toBe(wire(b));
      expect((await w.fx.repo.pagingContext('cus_hanbit')).configs.map((c) => c.id)).toEqual(['pc_cus_hanbit_CUSTOMER']);
      expect((await w.fx.repo.pagingContext('cus_mirae')).configs.map((c) => c.id)).toEqual(['pc_cus_mirae_CUSTOMER']);
    });
  });

  describe('incident list and detail', () => {
    it('list: newest first, cursor pages without gaps or repeats, counts on the same basis; counts.open + outside.open = the badge', async () => {
      await open();
      for (let m = 1; m <= 5; m++) {
        w.sim.now = at(m);
        await w.sim.group({ customerId: null, awsAccountId: `90000000000${m}`, at: at(m), alerts: [{ id: `al_x${m}`, title: `disk ${m}` }] });
        await w.sim.tick();
      }
      const all = body(await w.call(USERS.haeun, 'GET', '/incidents'));
      expect(all.items).toHaveLength(8);
      expect(all.counts).toMatchObject({ open: 8, acknowledged: 0, resolved24h: 0, muted: 0 });
      expect(all.counts.triggered + all.counts.escalated).toBe(8);
      expect(all.unmapped.map((u: any) => u.awsAccountId).sort()).toEqual(['900000000001', '900000000002', '900000000003', '900000000004', '900000000005', '999999999999']);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { limit: '3', cursor } }));
        seen.push(...r.items.map((i: any) => i.id));
        cursor = r.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(seen).toEqual(all.items.map((i: any) => i.id));
      expect(new Set(seen).size).toBe(8);
      const times = all.items.map((i: any) => i.triggeredAt);
      expect(times).toEqual([...times].sort().reverse());

      for (const q of [{ customer: 'mirae' }, { customer: 'hanbit', project: 'shop' }, { mine: '1' }, { customerId: 'cus_hanbit' }]) {
        const r = body(await w.call(USERS.haeun, 'GET', '/incidents', { query: q }));
        expect(r.counts.open + r.outside.open, JSON.stringify(q)).toBe(8);
      }
      expect(body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { severity: 'SEV_3' } })).items.map((i: any) => i.id)).toEqual([w.ids.hanbit]);
      expect(body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { q: 'PAYMENTS-api' } })).items.map((i: any) => i.id)).toEqual([w.ids.mirae]);
      expect(body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { q: '100%_' } })).items).toEqual([]); // not a pattern
      const portal = body(await w.call(USERS.yuna, 'GET', '/incidents'));
      expect(portal.items.map((i: any) => i.id)).toEqual([w.ids.mirae]);
      expect(portal.unmapped).toEqual([]);
      expect(portal.counts.open).toBe(1);
    });

    it('status filter and counts follow ack / resolve; a maintenance window shows as muted', async () => {
      await open();
      await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': await w.version(w.ids.mirae) } });
      await w.call(USERS.minjae, 'POST', `/incidents/${w.ids.unmapped}/resolve`, { headers: { 'If-Match': await w.version(w.ids.unmapped) }, body: {} });
      await w.fx.addWindow({ id: 'mw_h', customerId: 'cus_hanbit', scopeType: 'CUSTOMER', scopeId: 'cus_hanbit', startsAt: at(-5), endsAt: at(60) });
      const r = body(await w.call(USERS.haeun, 'GET', '/incidents'));
      expect(r.counts).toMatchObject({ open: 1, acknowledged: 1, resolved24h: 1, muted: 1 });
      expect(body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { status: 'ACKNOWLEDGED' } })).items.map((i: any) => i.id)).toEqual([w.ids.mirae]);
      expect(body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { status: 'RESOLVED' } })).items.map((i: any) => i.id)).toEqual([w.ids.unmapped]);
      expect(body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { status: 'active' } })).items.map((i: any) => i.id).sort()).toEqual([w.ids.hanbit, w.ids.mirae].sort());
    });

    it('detail, timeline and notification log; both logs are paged by cursor in the order things happened', async () => {
      await open();
      await w.sim.run(3);
      const d = await w.call(USERS.haeun, 'GET', `/incidents/${w.ids.mirae}`);
      expect(d.headers.etag).toBe(`"${await w.version(w.ids.mirae)}"`);
      expect(body(d).alerts.map((a: any) => [a.id, a.status, a.eventCount]).sort()).toEqual([['al_m1', 'FIRING', 1], ['al_m2', 'FIRING', 1]]);
      const t1 = body(await w.call(USERS.viewer, 'GET', `/incidents/${w.ids.mirae}/timeline`, { query: { limit: '2' } }));
      expect(t1.items.map((e: any) => e.kind)).toEqual(['TRIGGERED', 'NOTE']);
      const t2 = body(await w.call(USERS.viewer, 'GET', `/incidents/${w.ids.mirae}/timeline`, { query: { limit: '2', cursor: t1.nextCursor } }));
      expect(t2.items.map((e: any) => e.kind)).toEqual(['NOTIFIED', 'ESCALATED']);
      expect(t2.nextCursor).toBeNull();
      const n1 = body(await w.call(USERS.viewer, 'GET', `/incidents/${w.ids.mirae}/notifications`, { query: { limit: '1' } }));
      expect(n1.items.map((l: any) => [l.channel, l.status, l.targetSummary, l.escalationStep, l.reason])).toEqual([['SLACK_BOT', 'SENT', 'Customer Slack channel', 0, null]]);
      const n2 = body(await w.call(USERS.viewer, 'GET', `/incidents/${w.ids.mirae}/notifications`, { query: { limit: '1', cursor: n1.nextCursor } }));
      expect(n2.items.map((l: any) => [l.channel, l.status, l.targetSummary, l.escalationStep])).toEqual([['SMS', 'SENT', 'Haeun Kim', 1]]);
      expect(n2.nextCursor).toBeNull();
    });
  });

  describe('If-Match', () => {
    it('ack: missing → 400, stale → 409 VERSION_CONFLICT with nothing changed, current → 200; member alerts are acknowledged; audit row', async () => {
      await open();
      const id = w.ids.mirae;
      expect((await w.call(USERS.haeun, 'POST', `/incidents/${id}/ack`)).status).toBe(400);
      const before = await w.snapshot();
      const stale = await w.call(USERS.haeun, 'POST', `/incidents/${id}/ack`, { headers: { 'If-Match': '0' } });
      expect(stale.status).toBe(409);
      expect(body(stale).error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 1 } });
      expect(await w.snapshot()).toBe(before);
      const r = await w.call(USERS.haeun, 'POST', `/incidents/${id}/ack`, { headers: { 'if-match': '"1"' } });
      expect(r.status).toBe(200);
      expect(body(r).incident).toMatchObject({ id, status: 'ACKNOWLEDGED', version: 2, acknowledgedBy: { contactId: 'usr_haeun', name: 'Haeun Kim' } });
      expect(body(r).incident.alerts.every((a: any) => a.status === 'ACKNOWLEDGED')).toBe(true);
      expect((await w.fx.audits()).at(-1)).toMatchObject({ action: 'incident.ack', actorId: 'usr_haeun', targetId: id, customerId: 'cus_mirae' });
      const again = await w.call(USERS.haeun, 'POST', `/incidents/${id}/ack`, { headers: { 'If-Match': '2' } });
      expect([again.status, body(again).error.code]).toEqual([409, 'INVALID_TRANSITION']);
      await w.sim.run(15);
      expect(w.sim.sms.sent).toHaveLength(0); // ack stopped the ladder
    });

    it('an ack pressed on a list older than the last escalation does not apply; two people acting on the same version: one wins', async () => {
      await open();
      const seenVersion = await w.version(w.ids.mirae);
      await w.sim.run(2); // the SMS step fired meanwhile
      const late = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': seenVersion } });
      expect(late.status).toBe(409);
      const v = await w.version(w.ids.hanbit);
      const [a, b] = await Promise.all([
        w.call(USERS.haeun, 'POST', `/incidents/${w.ids.hanbit}/ack`, { headers: { 'If-Match': v } }),
        w.call(USERS.minjae, 'POST', `/incidents/${w.ids.hanbit}/resolve`, { headers: { 'If-Match': v }, body: {} }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    });

    it('call order: PUT needs If-Match; stale → 409 and nothing saved; current → version + 1; the first PUT of a customer creates with If-Match 0', async () => {
      await open();
      const steps = [{ atMin: 0, targetType: 'ROTATION', targetId: 'rot_night', channels: ['SLACK_DM'] }, { atMin: 10, targetType: 'PERSON', targetId: 'ct_yuna', channels: ['VOICE'] }];
      const input = { style: 'CUSTOM', plan: 'STANDARD', steps, repeatCount: 2 };
      expect((await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { body: input })).status).toBe(400);
      const stale = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { body: input, headers: { 'If-Match': '7' } });
      expect(stale.status).toBe(409);
      expect(body(stale).error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 1 } });
      expect((await w.fx.repo.pagingContext('cus_mirae')).configs[0]!.steps).toHaveLength(4);
      const okRes = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { body: input, headers: { 'If-Match': '1' } });
      expect(okRes.status).toBe(200);
      expect(body(okRes)).toMatchObject({ version: 2, edited: true, style: 'CUSTOM', repeatCount: 2, steps, sentence: 'Immediately, Slack DM Haeun Kim. At 10 min, call Yuna Seo. Then repeat 2 times.' });
      expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/paging'))).toMatchObject({ version: 2, repeatCount: 2, steps });
      expect((await w.fx.audits()).at(-1)).toMatchObject({ action: 'paging.update', actorId: 'usr_minjae', customerId: 'cus_mirae', targetType: 'PagingConfig' });
      expect((await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { body: input, headers: { 'If-Match': '1' } })).status).toBe(409);
      // the saved order is what the next incident uses; the open one keeps its frozen order
      w.sim.now = at(1);
      await w.sim.group({ customerId: 'cus_mirae', severity: 'SEV_1', at: at(1), alerts: [{ id: 'al_new', severity: 'SEV_1' }] });
      await w.sim.tick();
      const fresh = (await w.fx.incidents()).find((i) => i.severity === 'SEV_1')!;
      expect(await w.sim.timeline(fresh.id)).toEqual(['1 SLACK_DM Haeun Kim']);
      expect((await w.sim.timeline(w.ids.mirae))[0]).toBe('0 SLACK_BOT scope');
    });

    it('overrides: create with If-Match 0, delete with the version; versions continue after delete + create (N-3)', async () => {
      await open();
      const path = '/customers/cus_mirae/paging-overrides/SERVICE/svc_pay';
      const steps = { style: 'CUSTOM', plan: 'STANDARD', steps: [{ atMin: 0, targetType: 'PERSON', targetId: 'ct_haeun', channels: ['SMS'] }] };
      const put = (v: string) => w.call(USERS.minjae, 'PUT', path, { headers: { 'If-Match': v }, body: steps });
      const created = await put('0');
      expect([created.status, body(created).version]).toEqual([201, 1]);
      expect((await put('0')).status).toBe(409);
      const tree = body(await w.call(USERS.haeun, 'GET', '/scope-tree')).customers.find((c: any) => c.slug === 'mirae');
      expect(tree.projects[0].services[0].ownSteps).toBe(true);
      expect(body(await w.call(USERS.minjae, 'GET', '/oncall/paging-path', { query: { serviceId: 'svc_pay' } }))).toMatchObject({ own: true });
      expect((await w.call(USERS.minjae, 'DELETE', path, { headers: { 'If-Match': '9' } })).status).toBe(409);
      expect((await w.call(USERS.minjae, 'DELETE', path, { headers: { 'If-Match': '1' } })).status).toBe(200);
      expect(body(await w.call(USERS.minjae, 'GET', '/oncall/paging-path', { query: { serviceId: 'svc_pay' } }))).toMatchObject({ own: false, inheritedFrom: { level: 'CUSTOMER', id: 'cus_mirae' } });
      expect((await put('1')).status).toBe(409); // the editor that still holds version 1: nothing to replace
      const again = await put('0');
      expect([again.status, body(again).version]).toEqual([201, 2]);
      expect((await put('1')).status).toBe(409);
      expect(body(await put('2')).version).toBe(3);
      expect((await w.fx.audits()).map((a) => a.action).filter((a) => a.startsWith('paging'))).toHaveLength(4);
    });

    it('paging path: by resource and by slugs; who each step reaches now; notify-only people of the path', async () => {
      await open();
      const byRes = body(await w.call(USERS.haeun, 'GET', '/oncall/paging-path', { query: { resourceId: 'res_web1' } }));
      const bySlug = body(await w.call(USERS.haeun, 'GET', '/oncall/paging-path', { query: { customer: 'mirae', project: 'core', service: 'payments-api' } }));
      expect(JSON.stringify(byRes.steps)).toBe(JSON.stringify(bySlug.steps));
      expect(byRes).toMatchObject({ own: false, inheritedFrom: { level: 'CUSTOMER', id: 'cus_mirae' } });
      expect(JSON.stringify(byRes)).toContain('Seojun Bae'); // ContactScope NOTIFY on the service
      expect(JSON.stringify(body(await w.call(USERS.haeun, 'GET', '/oncall/paging-path', { query: { customer: 'hanbit' } })))).not.toContain('Seojun');
    });
  });

  describe('undo', () => {
    it('the same person within 5 minutes, once; another person’s use is a 404 and leaves the token usable; paging continues', async () => {
      await open();
      await w.sim.run(2);
      w.sim.now = at(2, 30);
      const ack = body(await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': await w.version(w.ids.mirae) } }));
      expect((await w.call(USERS.minjae, 'POST', '/incidents/bulk/undo', { body: { undoToken: ack.undoToken } })).status).toBe(404);
      w.sim.now = at(5);
      const undo = await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: ack.undoToken } });
      expect(body(undo)).toEqual({ restored: [w.ids.mirae], skipped: [] });
      expect((await w.fx.incidents()).find((i) => i.id === w.ids.mirae)).toMatchObject({ status: 'TRIGGERED', acknowledgedAt: null, acknowledgedBy: null, escalationStep: 2 });
      expect(await w.fx.alertAcked('al_m1')).toBe(false);
      await w.sim.run(12);
      expect(await w.sim.timeline(w.ids.mirae)).toEqual(['0 SLACK_BOT scope', '2 SMS Haeun Kim', '7 VOICE Haeun Kim', '12 VOICE Haeun Kim', '12 VOICE Junho Park', '12 VOICE Yuna Seo']);
      expect((await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: ack.undoToken } })).status).toBe(404);
      expect((await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: 'undo_never_issued' } })).status).toBe(404);
    });

    it('expired after 5 minutes; skipped when the incident changed in between; a bulk undo restores every item', async () => {
      await open();
      const a = body(await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': '1' } }));
      w.sim.now = at(5, 1);
      expect((await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: a.undoToken } })).status).toBe(404);
      const b = body(await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.hanbit}/ack`, { headers: { 'If-Match': await w.version(w.ids.hanbit) } }));
      await w.call(USERS.minjae, 'POST', `/incidents/${w.ids.hanbit}/resolve`, { headers: { 'If-Match': await w.version(w.ids.hanbit) }, body: {} });
      expect(body(await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: b.undoToken } }))).toEqual({ restored: [], skipped: [{ id: w.ids.hanbit, code: 'VERSION_CONFLICT' }] });
      const run = body(await w.call(USERS.haeun, 'POST', '/incidents/bulk', { body: { action: 'ack', preview: false, items: [{ id: w.ids.unmapped, version: Number(await w.version(w.ids.unmapped)) }, { id: 'inc-nope', version: 1 }] } }));
      expect(run.done).toEqual([w.ids.unmapped]);
      expect(body(await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: run.undoToken } })).restored).toEqual([w.ids.unmapped]);
      expect((await w.fx.incidents()).find((i) => i.id === w.ids.unmapped)!.status).toBe('TRIGGERED');
    });
  });

  describe('security review SQL: input hygiene, fail-closed writes, housekeeping', () => {
    const cur = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
    const bad = async (r: Promise<ApiResponse>, label: string): Promise<void> => {
      const res = await r;
      expect([res.status, body(res).error?.code], label).toEqual([400, 'VALIDATION_FAILED']);
    };

    it('R-5: NUL bytes, malformed cursors and malformed ids are a 400 before the store is asked — never a 500; the same for an id that exists, one of another customer and one that does not exist', async () => {
      await open();
      const before = await w.snapshot();
      const NUL = String.fromCharCode(0);
      const calls: Array<[string, Promise<ApiResponse>]> = [
        ['q = NUL', w.call(USERS.yuna, 'GET', '/incidents', { query: { q: NUL } })],
        ['q = a NUL b', w.call(USERS.yuna, 'GET', '/incidents', { query: { q: `a${NUL}b` } })],
        ['cursor t garbage', w.call(USERS.yuna, 'GET', '/incidents', { query: { cursor: cur({ t: 'garbage', id: 'x' }) } })],
        ['cursor t sql', w.call(USERS.yuna, 'GET', '/incidents', { query: { cursor: cur({ t: "2026'; select pg_sleep(3)--", id: 'x' }) } })],
        ['cursor t not an instant', w.call(USERS.yuna, 'GET', '/incidents', { query: { cursor: cur({ t: '2026-13-45T99:00:00.000Z', id: 'x' }) } })],
        ['cursor t date only', w.call(USERS.yuna, 'GET', '/incidents', { query: { cursor: cur({ t: '2026-11-09', id: 'x' }) } })],
        ['cursor id NUL', w.call(USERS.yuna, 'GET', '/incidents', { query: { cursor: cur({ t: T0.toISOString(), id: `a${NUL}` }) } })],
        ['cursor id too long', w.call(USERS.yuna, 'GET', '/incidents', { query: { cursor: cur({ t: T0.toISOString(), id: 'x'.repeat(201) }) } })],
        ['cursor not json', w.call(USERS.yuna, 'GET', '/incidents', { query: { cursor: '!!!' } })],
        ['cursor wrong shape', w.call(USERS.yuna, 'GET', '/incidents', { query: { cursor: cur([1, 2]) } })],
        ['timeline cursor', w.call(USERS.yuna, 'GET', `/incidents/${w.ids.mirae}/timeline`, { query: { cursor: cur({ t: 'x', id: `e${NUL}` }) } })],
        ['notifications cursor', w.call(USERS.haeun, 'GET', `/incidents/${w.ids.mirae}/notifications`, { query: { cursor: cur({ t: T0.toISOString(), id: `l${NUL}` }) } })],
        ['path own id + NUL', w.call(USERS.yuna, 'GET', `/incidents/${w.ids.mirae}%00`)],
        ['path other customer id + NUL', w.call(USERS.yuna, 'GET', `/incidents/${w.ids.hanbit}%00`)],
        ['path unknown id + NUL', w.call(USERS.yuna, 'GET', '/incidents/inc%00x')],
        ['path timeline', w.call(USERS.yuna, 'GET', '/incidents/inc%00x/timeline')],
        ['path notifications', w.call(USERS.haeun, 'GET', '/incidents/inc%00x/notifications')],
        ['path newline', w.call(USERS.yuna, 'GET', '/incidents/inc%0Ax')],
        ['path too long', w.call(USERS.yuna, 'GET', `/incidents/${'x'.repeat(201)}`)],
        ['path bad escape', w.call(USERS.yuna, 'GET', '/incidents/%E0%A4%A')],
        ['customer path', w.call(USERS.haeun, 'GET', '/customers/cus_mirae%00/paging')],
        ['ack path', w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}%00/ack`, { headers: { 'If-Match': '1' } })],
        ['body id', w.call(USERS.haeun, 'POST', '/incidents/bulk', { body: { action: 'ack', preview: false, items: [{ id: `${w.ids.mirae}${NUL}`, version: 1 }] } })],
        ['body nested text', w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/resolve`, { headers: { 'If-Match': '1' }, body: { kind: 'OTHER', note: `done${NUL}` } })],
        ['body key', w.call(USERS.haeun, 'POST', '/incidents/bulk', { body: { action: 'ack', [`x${NUL}`]: 1, items: [] } })],
        ['undo token', w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: `undo_${NUL}` } })],
        ['idempotency key header', w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': '1', 'Idempotency-Key': `k${NUL}` } })],
        ['assignee filter', w.call(USERS.haeun, 'GET', '/incidents', { query: { assignee: `ct_${NUL}` } })],
      ];
      for (const [label, r] of calls) await bad(r, label);
      // the three "id + NUL" answers are the same bytes: nothing about existence leaks
      const same = await Promise.all([w.ids.mirae, w.ids.hanbit, 'inc-nope'].map((id) => w.call(USERS.yuna, 'GET', `/incidents/${id}%00`, { requestId: 'req_same' })));
      expect(new Set(same.map((r) => JSON.stringify(r))).size).toBe(1);
      expect(await w.snapshot()).toBe(before);
      // well-formed input still works: a valid cursor of an unknown row, a search with SQL-looking text
      const page = await w.call(USERS.haeun, 'GET', '/incidents', { query: { cursor: cur({ t: at(-1).toISOString(), id: 'inc-nope' }) } });
      expect(page.status).toBe(200);
      expect((await w.call(USERS.haeun, 'GET', '/incidents', { query: { q: "x'); DROP TABLE \"Incident\";--" } })).status).toBe(200);
      expect((await w.call(USERS.yuna, 'GET', `/incidents/${w.ids.hanbit}`)).status).toBe(404);
    });

    it('R-6: deletePagingConfig needs the audited customer — null or another customer deletes nothing; savePagingConfig refuses a config without one', async () => {
      await open();
      const { configs } = await w.fx.repo.pagingContext('cus_hanbit');
      const cfg = configs[0]!;
      const audit = (customerId: string | null) => ({ at: w.sim.now, customerId, actorType: 'USER' as const, actorId: 'usr_haeun', action: 'paging.delete', targetType: 'PagingConfig', targetId: cfg.id });
      expect(await w.fx.repo.deletePagingConfig(cfg.id, cfg.version, audit(null))).toBe('CONFLICT');
      expect(await w.fx.repo.deletePagingConfig(cfg.id, cfg.version, audit(undefined as unknown as null))).toBe('CONFLICT');
      expect(await w.fx.repo.deletePagingConfig(cfg.id, cfg.version, audit(''))).toBe('CONFLICT');
      expect(await w.fx.repo.deletePagingConfig(cfg.id, cfg.version, audit('cus_mirae'))).toBe('CONFLICT');
      expect((await w.fx.repo.pagingContext('cus_hanbit')).configs.map((c) => c.id)).toContain(cfg.id);
      expect((await w.fx.audits()).filter((a) => a.action === 'paging.delete')).toHaveLength(0);
      await expect(w.fx.repo.savePagingConfig({ ...cfg, customerId: null as unknown as string }, cfg.version, audit(null))).rejects.toThrow(/customerId/);
      await expect(w.fx.repo.savePagingConfig(cfg, cfg.version, audit('cus_mirae'))).rejects.toThrow(/customerId/);
      expect((await w.fx.repo.pagingContext('cus_hanbit')).configs.find((c) => c.id === cfg.id)!.version).toBe(cfg.version);
      expect(await w.fx.repo.deletePagingConfig(cfg.id, cfg.version, audit('cus_hanbit'))).toBe('OK');
      expect((await w.fx.repo.pagingContext('cus_hanbit')).configs.map((c) => c.id)).not.toContain(cfg.id);
    });

    it('R-7: the undo token never reaches the idempotency store; a replay has none; the first token still works once', async () => {
      await open();
      const stored: string[] = [];
      const put = w.fx.repo.putIdempotent.bind(w.fx.repo);
      w.fx.repo.putIdempotent = async (key, entry, exp, cap) => { stored.push(JSON.stringify(entry)); return put(key, entry, exp, cap); };
      const opts = { headers: { 'If-Match': '1', 'Idempotency-Key': 'k-undo' } };
      const first = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, opts);
      const bulk = await w.call(USERS.haeun, 'POST', '/incidents/bulk', { headers: { 'Idempotency-Key': 'k-bulk' }, body: { action: 'ack', preview: false, items: [{ id: w.ids.hanbit, version: 1 }] } });
      const tokens = [body(first).undoToken, body(bulk).undoToken] as string[];
      expect(tokens.every((t) => /^undo_.{20,}/.test(t))).toBe(true);
      expect(stored).toHaveLength(2);
      for (const text of stored) { expect(text).not.toContain('undo_'); for (const t of tokens) expect(text).not.toContain(t); }
      const replay = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, opts);
      expect(replay.status).toBe(200);
      expect('undoToken' in body(replay)).toBe(false);
      expect(body(replay).incident.id).toBe(w.ids.mirae);
      const undo = await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: tokens[0] } });
      expect(body(undo).restored).toEqual([w.ids.mirae]);
      expect((await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: tokens[0] } })).status).toBe(404);
    });

    it('R-7: the tick removes expired Idempotency-Key entries and undo records of EVERY user (not only of users who write again), and old tick claims — never live ones', async () => {
      await open();
      const entry = (n: number) => ({ fingerprint: `fp${n}`, res: { status: 200, headers: {}, body: { n } } });
      const cap = (owner: string) => ({ owner, maxPerOwner: IDEMPOTENCY_MAX_PER_USER });
      const soon = new Date(w.sim.now.getTime() + 60_000);
      const later = new Date(w.sim.now.getTime() + 3 * 86_400_000);
      for (let i = 0; i < 4; i++) await w.fx.repo.putIdempotent(`u1:${i}`, entry(i), soon, cap('usr_gone'));
      await w.fx.repo.putIdempotent('u2:keep', entry(9), later, cap('usr_haeun'));
      const item = { id: w.ids.mirae, versionAfter: 2, prev: { status: 'TRIGGERED' as const, acknowledgedAt: null, acknowledgedBy: null, mttaSec: null } };
      await w.fx.repo.saveUndo({ token: 'undo_old', userId: 'usr_gone', action: 'ack', expiresAt: soon, items: [item] });
      await w.fx.repo.saveUndo({ token: 'undo_live', userId: 'usr_haeun', action: 'ack', expiresAt: later, items: [item] });
      // nothing has expired yet: a purge removes nothing
      expect(await w.fx.repo.purgeExpired()).toBe(0);
      // two days and a bit later the tick runs; usr_gone never writes again
      w.sim.now = at(2 * 24 * 60 + 10);
      expect(await w.fx.repo.claimTick('2026-11-11T03:09Z', w.sim.now)).toBe(true);
      await w.sim.tick(); // claims 03:10 and purges
      const peek = new Date(T0.getTime()); // "now" for the read: before every expiry, so only deletion can hide a row
      expect(await Promise.all([0, 1, 2, 3].map((i) => w.fx.repo.getIdempotent(`u1:${i}`, peek)))).toEqual([null, null, null, null]);
      expect(await w.fx.repo.getIdempotent('u2:keep', peek)).toEqual(entry(9));
      expect(await w.fx.repo.takeUndo('undo_old')).toBeNull();
      expect((await w.fx.repo.takeUndo('undo_live'))?.userId).toBe('usr_haeun');
      // the minute of the first tick (T0, two days ago) is gone and could be claimed again; today's minutes are still held
      expect(await w.fx.repo.claimTick('2026-11-11T03:09Z', w.sim.now)).toBe(false);
      expect(await w.fx.repo.claimTick('2026-11-11T03:10Z', w.sim.now)).toBe(false);
      expect(await w.fx.repo.claimTick('2026-11-09T03:00Z', w.sim.now)).toBe(true);
    });
  });

  describe('Idempotency-Key', () => {
    it('the same key and request replays the first response and does not act twice; the same key with another request is 422', async () => {
      await open();
      const opts = { headers: { 'If-Match': '1', 'Idempotency-Key': 'k-1' } };
      const first = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, opts);
      expect(first.status).toBe(200);
      const audits = (await w.fx.audits()).length;
      const replay = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, opts);
      expect(replay.status).toBe(200);
      // without the key this would be 409 INVALID_TRANSITION. R-7: the replay is the first response WITHOUT the undo token.
      const { undoToken, ...rest } = body(first);
      expect(undoToken).toMatch(/^undo_/);
      expect(JSON.stringify(replay.body)).toBe(JSON.stringify(rest));
      expect(JSON.stringify(replay.body)).not.toContain('undo_');
      expect((await w.fx.audits()).length).toBe(audits);
      const other = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.hanbit}/ack`, { headers: { 'If-Match': '1', 'Idempotency-Key': 'k-1' } });
      expect([other.status, body(other).error.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
      expect((await w.fx.incidents()).find((i) => i.id === w.ids.hanbit)!.status).toBe('TRIGGERED');
      // another user's identical key is another key
      const mine = await w.call(USERS.minjae, 'POST', `/incidents/${w.ids.hanbit}/ack`, { headers: { 'If-Match': '1', 'Idempotency-Key': 'k-1' } });
      expect(mine.status).toBe(200);
    });

    it('entries expire after 24 hours (the request then runs again)', async () => {
      await open();
      const send = () => w.call(USERS.haeun, 'POST', '/incidents/bulk', { headers: { 'Idempotency-Key': 'day' }, body: { action: 'ack', preview: false, items: [{ id: w.ids.mirae, version: 1 }] } });
      expect(body(await send()).done).toEqual([w.ids.mirae]);
      w.sim.now = at(23 * 60 + 59);
      expect(body(await send()).done).toEqual([w.ids.mirae]); // replayed
      w.sim.now = at(24 * 60 + 1);
      expect(body(await send()).done).toEqual([]); // ran again: the incident is acknowledged now, version moved
    });

    it(`a user holds at most ${IDEMPOTENCY_MAX_PER_USER} entries: the oldest are dropped, other users are not touched, a recent key still replays`, async () => {
      await open();
      const entry = (n: number) => ({ fingerprint: `fp${n}`, res: { status: 200, headers: { 'x-n': String(n) }, body: { n, list: [1, 2, { a: null }] } } });
      const exp = new Date(w.sim.now.getTime() + 86_400_000);
      const cap = (owner: string) => ({ owner, maxPerOwner: IDEMPOTENCY_MAX_PER_USER });
      await w.fx.repo.putIdempotent('minjae:a', entry(-1), exp, cap('usr_minjae'));
      for (let i = 0; i < IDEMPOTENCY_MAX_PER_USER + 30; i++) await w.fx.repo.putIdempotent(`haeun:${i}`, entry(i), exp, cap('usr_haeun'));
      const live = async (owner: string, ids: Array<number | string>) => (await Promise.all(ids.map((i) => w.fx.repo.getIdempotent(`${owner}:${i}`, w.sim.now)))).filter(Boolean).length;
      expect(await live('haeun', Array.from({ length: IDEMPOTENCY_MAX_PER_USER + 30 }, (_, i) => i))).toBe(IDEMPOTENCY_MAX_PER_USER);
      expect(await w.fx.repo.getIdempotent('haeun:29', w.sim.now)).toBeNull(); // the 30 oldest are gone
      expect(await w.fx.repo.getIdempotent('haeun:30', w.sim.now)).toEqual(entry(30));
      expect(await w.fx.repo.getIdempotent('minjae:a', w.sim.now)).toEqual(entry(-1));
      // storing an existing key again makes it the newest and does not grow the set
      await w.fx.repo.putIdempotent('haeun:30', entry(300), exp, cap('usr_haeun'));
      await w.fx.repo.putIdempotent('haeun:new', entry(999), exp, cap('usr_haeun'));
      expect(await w.fx.repo.getIdempotent('haeun:30', w.sim.now)).toEqual(entry(300));
      expect(await w.fx.repo.getIdempotent('haeun:31', w.sim.now)).toBeNull();
      // expired entries of the owner are removed by the next put (store clock), and are never returned
      const short = new Date(w.sim.now.getTime() + 60_000);
      await w.fx.repo.putIdempotent('minjae:short', entry(5), short, cap('usr_minjae'));
      expect(await w.fx.repo.getIdempotent('minjae:short', new Date(short.getTime() - 1))).toEqual(entry(5));
      expect(await w.fx.repo.getIdempotent('minjae:short', short)).toBeNull();
      // a tiny cap keeps only the newest ones
      for (let i = 0; i < 5; i++) await w.fx.repo.putIdempotent(`viewer:${i}`, entry(i), exp, { owner: 'usr_viewer', maxPerOwner: 2 });
      expect(await live('viewer', [0, 1, 2, 3, 4])).toBe(2);
      expect(await w.fx.repo.getIdempotent('viewer:4', w.sim.now)).toEqual(entry(4));
    });
  });

  describe('directory lookups', () => {
    it('responder customers, contact of a user, user directory, rotation owner, verified Slack channel', async () => {
      await open();
      expect((await w.fx.repo.responderCustomerIds('usr_haeun')).sort()).toEqual(['cus_mirae']);
      expect((await w.fx.repo.responderCustomerIds('usr_minjae')).sort()).toEqual(['cus_hanbit']);
      expect(await w.fx.repo.responderCustomerIds('usr_viewer')).toEqual([]);
      expect(await w.fx.repo.contactIdForUser('usr_yuna')).toBe('ct_yuna');
      expect(await w.fx.repo.contactIdForUser('usr_nobody')).toBeNull();
      const dir = await w.fx.repo.userDirectory(['usr_haeun', 'usr_yuna', 'usr_viewer', 'usr_nobody']);
      expect([...dir].sort()).toEqual([['usr_haeun', { name: 'Haeun Kim', kind: 'INTERNAL', customerId: null }], ['usr_viewer', { name: 'Viewer', kind: 'INTERNAL', customerId: null }], ['usr_yuna', { name: 'Yuna Seo', kind: 'CUSTOMER', customerId: 'cus_mirae' }]]);
      expect(await w.fx.repo.rotationOwner('rot_hanbit')).toEqual({ scope: 'CUSTOMER', customerId: 'cus_hanbit' });
      expect(await w.fx.repo.rotationOwner('rot_night')).toEqual({ scope: 'MSP', customerId: null });
      expect(await w.fx.repo.rotationOwner('rot_nope')).toBeNull();
      expect(await w.fx.repo.slackChannelVerified('cus_mirae')).toBe(true);
      expect(await w.fx.repo.slackChannelVerified('cus_hanbit')).toBe(false);
      expect(await w.fx.repo.openIncidentCounts({ customerIds: ['cus_mirae'], unmapped: false, subScopes: [] })).toEqual([{ customerId: 'cus_mirae', projectId: 'prj_core', serviceId: 'svc_pay', open: 1 }]);
      expect(await w.fx.repo.findResource({ customerIds: ['cus_mirae'], unmapped: false, subScopes: [] }, 'res_shop')).toBeNull();
      expect(await w.fx.repo.findResource({ customerIds: ['cus_mirae'], unmapped: false, subScopes: [] }, 'res_web1')).toEqual({ id: 'res_web1', name: 'web-1', customerId: 'cus_mirae', projectId: 'prj_core', serviceId: 'svc_pay' });
      expect(await w.fx.repo.findResource({ customerIds: ['cus_mirae'], unmapped: false, subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_data' }] }, 'res_web1')).toBeNull();
    });
  });

  describe('customer status and offboarding (D-42, D-43)', () => {
    const im = (v: number | string) => ({ 'if-match': String(v) });
    const patch = (who: AuthContext | null, status: string, extra: Record<string, unknown> = {}, v: number | string = 0, cid = 'cus_mirae') =>
      w.call(who, 'PATCH', `/customers/${cid}/status`, { headers: im(v), body: { status, reason: 'contract ended', ...extra } });
    const nameOf = async (): Promise<string> => body(await w.call(USERS.minjae, 'GET', '/scope-tree')).customers.find((c: any) => c.id === 'cus_mirae').name;

    it('GET status returns {status, statusChangedAt, version} with the version as ETag; ADMIN only, portal users and unknown ids get the 404', async () => {
      await open();
      const r = await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/status');
      expect(r.status).toBe(200);
      expect(body(r)).toEqual({ status: 'ACTIVE', statusChangedAt: null, version: 0 });
      expect(r.headers.etag).toBe('"0"');
      expect((await w.call(USERS.haeun, 'GET', '/customers/cus_mirae/status')).status).toBe(403);
      expect((await w.call(USERS.yuna, 'GET', '/customers/cus_mirae/status')).status).toBe(404);
      expect((await w.call(USERS.minjae, 'GET', '/customers/cus_nope/status')).status).toBe(404);
      expect((await w.call(null, 'GET', '/customers/cus_mirae/status')).status).toBe(401);
    });

    it('GET /scope-tree carries each customer status for every staff role (not ADMIN-only) and follows a status change', async () => {
      await open();
      const statuses = async (who: AuthContext) => Object.fromEntries(body(await w.call(who, 'GET', '/scope-tree')).customers.map((c: any) => [c.id, c.status]));
      expect(await statuses(USERS.haeun)).toMatchObject({ cus_mirae: 'ACTIVE', cus_hanbit: 'ACTIVE' });
      expect((await patch(USERS.minjae, 'SUSPENDED')).status).toBe(200);
      expect(await statuses(USERS.haeun)).toMatchObject({ cus_mirae: 'SUSPENDED', cus_hanbit: 'ACTIVE' });
      expect((await patch(USERS.minjae, 'TERMINATED', { confirmName: await nameOf() }, 1)).status).toBe(200);
      expect(await statuses(USERS.minjae)).toMatchObject({ cus_mirae: 'TERMINATED', cus_hanbit: 'ACTIVE' });
    });

    it('PATCH: ADMIN only; portal never; needs If-Match and a reason; unknown status is 400', async () => {
      await open();
      expect((await patch(USERS.haeun, 'SUSPENDED')).status).toBe(403);
      expect((await patch(USERS.viewer, 'SUSPENDED')).status).toBe(403);
      expect((await patch(USERS.yuna, 'SUSPENDED')).status).toBe(404);
      expect((await patch(USERS.dohyun, 'SUSPENDED')).status).toBe(404);
      expect((await w.call(USERS.minjae, 'PATCH', '/customers/cus_mirae/status', { body: { status: 'SUSPENDED', reason: 'x' } })).status).toBe(400);
      expect((await w.call(USERS.minjae, 'PATCH', '/customers/cus_mirae/status', { headers: im(0), body: { status: 'SUSPENDED' } })).status).toBe(400);
      expect((await w.call(USERS.minjae, 'PATCH', '/customers/cus_mirae/status', { headers: im(0), body: { status: 'SUSPENDED', reason: '  ' } })).status).toBe(400);
      expect((await patch(USERS.minjae, 'GONE')).status).toBe(400);
      expect((await patch(USERS.minjae, 'SUSPENDED', {}, 0, 'cus_nope')).status).toBe(404);
      expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/status')).status).toBe('ACTIVE');
      expect(w.commands.sent).toEqual([]);
    });

    it('SUSPENDED and back: version moves, statusChangedAt set, audit written, stale If-Match is 409, same status is a no-op 200', async () => {
      await open();
      const r = await patch(USERS.minjae, 'SUSPENDED');
      expect(r.status).toBe(200);
      expect(body(r)).toMatchObject({ status: 'SUSPENDED', version: 1 });
      expect(body(r).statusChangedAt).toEqual(expect.any(String));
      expect(r.headers.etag).toBe('"1"');
      expect(w.commands.sent).toEqual([]); // suspension leaves the customer's AWS alone
      const audits = (await w.fx.audits()).filter((a) => a.targetType === 'CustomerStatus');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ customerId: 'cus_mirae', actorId: 'usr_minjae', after: { status: 'SUSPENDED' } });
      const stale = await patch(USERS.minjae, 'ACTIVE', {}, 0);
      expect(stale.status).toBe(409);
      expect(body(stale).error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 1 } });
      const same = await patch(USERS.minjae, 'SUSPENDED', {}, 1);
      expect(same.status).toBe(200);
      expect(body(same)).toMatchObject({ status: 'SUSPENDED', version: 1 });
      expect((await w.fx.audits()).filter((a) => a.targetType === 'CustomerStatus')).toHaveLength(1);
      const back = await patch(USERS.minjae, 'ACTIVE', {}, 1);
      expect(body(back)).toMatchObject({ status: 'ACTIVE', version: 2 });
      expect(await w.fx.repo.sessionPrincipal('usr_yuna')).not.toBeNull();
    });

    it('a suspended customer\'s portal user has no session; other customers are untouched', async () => {
      await open();
      await patch(USERS.minjae, 'SUSPENDED');
      expect(await w.fx.repo.sessionPrincipal('usr_yuna')).toBeNull();
      expect(await w.fx.repo.customerStatus('cus_mirae')).toBe('SUSPENDED');
      expect(await w.fx.repo.customerStatus('cus_hanbit')).toBe('ACTIVE');
      expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_hanbit/status'))).toMatchObject({ status: 'ACTIVE', version: 0 });
    });

    it('TERMINATED needs confirmName == customer name (400 otherwise, nothing written)', async () => {
      await open();
      const name = await nameOf();
      for (const extra of [{}, { confirmName: '' }, { confirmName: name.toLowerCase() + '!' }, { confirmName: `${name}x` }]) {
        const r = await patch(USERS.minjae, 'TERMINATED', extra);
        expect(r.status).toBe(400);
        expect(body(r).error.details.fields[0].field).toBe('confirmName');
      }
      expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/status'))).toMatchObject({ status: 'ACTIVE', version: 0 });
      expect((await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/offboarding')).status).toBe(404);
      expect(w.commands.sent).toEqual([]);
    });

    it('TERMINATED: one transaction creates the checklist, one OFFBOARD_ACCOUNT per CloudAccount of THAT customer; irreversible', async () => {
      await open();
      const name = await nameOf();
      const r = await patch(USERS.minjae, 'TERMINATED', { confirmName: name });
      expect(r.status).toBe(200);
      const out = body(r);
      expect(out).toMatchObject({ status: 'TERMINATED', version: 1, commandsSent: 1 });
      expect(out.offboardingId).toEqual(expect.any(String));
      expect(w.commands.sent).toHaveLength(1);
      expect(w.commands.sent[0]).toMatchObject({ schemaVersion: 1, type: 'OFFBOARD_ACCOUNT', customerId: 'cus_mirae', requestedBy: { type: 'USER', id: 'usr_minjae' }, payload: { offboardingId: out.offboardingId } });
      expect(w.commands.sent[0]!.cloudAccountId).toContain('111111111111'); // never the other customer's account
      expect(w.commands.sent[0]!.commandId).toEqual(expect.any(String));

      const o = body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/offboarding'));
      expect(o.steps.map((s: any) => [s.key, s.state])).toEqual([['PAGING_STOPPED', 'DONE'], ['ALARMS_DELETED', 'PENDING'], ['CUSTOMER_STACK_REMOVED', 'MANUAL'], ['ACCOUNTS_DISABLED', 'MANUAL'], ['BUS_ALLOWLIST_REMOVED', 'MANUAL']]);
      expect(o.residual).toEqual({ count: 0 });
      expect(o.completedAt).toBeNull();

      const back = await patch(USERS.minjae, 'ACTIVE', {}, 1);
      expect(back.status).toBe(409);
      expect(body(back).error.code).toBe('CUSTOMER_TERMINATED');
      expect((await patch(USERS.minjae, 'SUSPENDED', {}, 1)).status).toBe(409);
      // same status again: no new checklist, no audit row; ALARMS_DELETED is still PENDING so the SAME command is sent again (engine dedupes by commandId)
      const again = await patch(USERS.minjae, 'TERMINATED', { confirmName: name }, 1);
      expect(again.status).toBe(200);
      expect(body(again)).toMatchObject({ status: 'TERMINATED', version: 1, offboardingId: out.offboardingId, commandsSent: 1 });
      expect(w.commands.sent).toHaveLength(2);
      expect(w.commands.sent[1]!.commandId).toBe(w.commands.sent[0]!.commandId);
      expect((await w.fx.audits()).filter((a) => a.targetType === 'CustomerStatus')).toHaveLength(1);
      // staff keep seeing it; the portal user has no session
      expect(await w.fx.repo.sessionPrincipal('usr_yuna')).toBeNull();
      expect((await w.call(USERS.haeun, 'GET', '/customers/cus_mirae/offboarding')).status).toBe(403);
      expect((await w.call(USERS.yuna, 'GET', '/customers/cus_mirae/offboarding')).status).toBe(404);
      expect((await w.call(USERS.minjae, 'GET', '/customers/cus_hanbit/offboarding')).status).toBe(404);
    });

    it('without a command queue a termination is refused before any write (503)', async () => {
      await open();
      const api = createApi({ repo: w.fx.repo, now: () => T0 });
      const r = await api.handle({ method: 'PATCH', path: '/customers/cus_mirae/status', auth: USERS.minjae, headers: im(0), body: { status: 'TERMINATED', reason: 'x', confirmName: await nameOf() }, requestId: 'r1' });
      expect(r.status).toBe(503);
      expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/status')).status).toBe('ACTIVE');
    });

    it('a failed publish does not undo the termination: it is reported and the ALARMS_DELETED step becomes MANUAL', async () => {
      await open();
      w.commands.failFor = new Set(['111111111111', 'ca_111111111111']);
      const r = await patch(USERS.minjae, 'TERMINATED', { confirmName: await nameOf() });
      expect(r.status).toBe(200);
      expect(body(r)).toMatchObject({ status: 'TERMINATED', commandsSent: 0 });
      expect(body(r).commandsFailed).toHaveLength(1);
      const o = body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/offboarding'));
      expect(o.steps.find((s: any) => s.key === 'ALARMS_DELETED')).toMatchObject({ state: 'MANUAL', detail: expect.stringContaining('COMMAND_PUBLISH_FAILED') });
    });

    it('repeating TERMINATED re-sends the commands while ALARMS_DELETED is PENDING or its publish failed; closing a failed step needs a human detail', async () => {
      await open();
      const name = await nameOf();
      w.commands.failFor = new Set(['111111111111', 'ca_111111111111']);
      await patch(USERS.minjae, 'TERMINATED', { confirmName: name });
      expect(w.commands.sent).toHaveLength(0);
      w.commands.failFor.clear();
      const again = await patch(USERS.minjae, 'TERMINATED', { confirmName: name }, 1);
      expect(again.status).toBe(200);
      expect(body(again)).toMatchObject({ status: 'TERMINATED', version: 1, commandsSent: 1 });
      expect(w.commands.sent).toHaveLength(1);
      const id1 = w.commands.sent[0]!.commandId;
      // the step is still MANUAL (publish failure marker): a repeat sends the same deterministic command again
      await patch(USERS.minjae, 'TERMINATED', { confirmName: name }, 1);
      expect(w.commands.sent.at(-1)!.commandId).toBe(id1);
      // the marker text is appended, never replacing earlier detail
      await w.fx.repo.recordOffboardPublishFailure('cus_mirae', ['x1'], T0);
      const d = body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/offboarding')).steps.find((s: any) => s.key === 'ALARMS_DELETED').detail as string;
      expect(d).toContain('COMMAND_PUBLISH_FAILED: 111111111111'.slice(0, 22));
      expect(d).toContain('COMMAND_PUBLISH_FAILED: x1');
      const mark = (detail?: string) => w.call(USERS.minjae, 'PATCH', '/customers/cus_mirae/offboarding', { body: { key: 'ALARMS_DELETED', state: 'DONE', ...(detail ? { detail } : {}) } });
      expect((await mark()).status).toBe(400);
      expect((await mark('   ')).status).toBe(400);
      const ok = await mark('checked CloudWatch, no ManagedBy=AlarmOps alarms left');
      expect(ok.status).toBe(200);
      const audit = (await w.fx.audits()).find((a) => a.targetType === 'CustomerOffboarding' && a.targetId === 'ALARMS_DELETED')!;
      expect(JSON.stringify(audit.before)).toContain('COMMAND_PUBLISH_FAILED');
    });

    it('a status that already equals the target when the write happens (changed outside the API) is a no-op, not an error', async () => {
      await open();
      await w.fx.setCustomerStatus('cus_mirae', 'SUSPENDED');
      const audit = { at: T0, customerId: 'cus_mirae', actorType: 'USER' as const, actorId: 'usr_minjae', action: 'x', targetType: 'CustomerStatus', targetId: 'cus_mirae' };
      expect(await w.fx.repo.changeCustomerStatus('cus_mirae', 0, 'SUSPENDED', null, audit)).toBe('NOOP');
      expect((await w.fx.audits()).filter((a) => a.targetType === 'CustomerStatus')).toHaveLength(0);
    });

    it('offboarding PATCH: marks MANUAL steps DONE, never overwrites DONE, ALARMS_DELETED only from MANUAL', async () => {
      await open();
      await patch(USERS.minjae, 'TERMINATED', { confirmName: await nameOf() });
      const mark = (key: string, who: AuthContext | null = USERS.minjae, extra: Record<string, unknown> = {}) => w.call(who, 'PATCH', '/customers/cus_mirae/offboarding', { body: { key, state: 'DONE', ...extra } });
      expect((await mark('CUSTOMER_STACK_REMOVED', USERS.haeun)).status).toBe(403);
      expect((await mark('CUSTOMER_STACK_REMOVED', USERS.yuna)).status).toBe(404);
      expect((await w.call(USERS.minjae, 'PATCH', '/customers/cus_mirae/offboarding', { body: { key: 'NOPE', state: 'DONE' } })).status).toBe(400);
      expect((await w.call(USERS.minjae, 'PATCH', '/customers/cus_mirae/offboarding', { body: { key: 'ACCOUNTS_DISABLED', state: 'PENDING' } })).status).toBe(400);
      const alarms = await mark('ALARMS_DELETED'); // still PENDING: the engine owns it
      expect(alarms.status).toBe(409);
      expect(body(alarms).error.code).toBe('STEP_NOT_MANUAL');
      const r = await mark('CUSTOMER_STACK_REMOVED', USERS.minjae, { detail: 'stack deleted by customer' });
      expect(r.status).toBe(200);
      expect(body(r).steps.find((s: any) => s.key === 'CUSTOMER_STACK_REMOVED')).toMatchObject({ state: 'DONE', byUserId: 'usr_minjae', detail: 'stack deleted by customer' });
      const again = await mark('CUSTOMER_STACK_REMOVED', USERS.minjae, { detail: 'overwrite attempt' });
      expect(again.status).toBe(200);
      expect(body(again).steps.find((s: any) => s.key === 'CUSTOMER_STACK_REMOVED').detail).toBe('stack deleted by customer');
      await mark('ACCOUNTS_DISABLED');
      await mark('BUS_ALLOWLIST_REMOVED');
      expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/offboarding')).completedAt).toBeNull(); // ALARMS_DELETED is still PENDING
      expect((await w.fx.audits()).filter((a) => a.targetType === 'CustomerOffboarding')).toHaveLength(3);
    });

    it('offboarding GET shows the residual events (count, lastEventAt) from OffboardResidual', async () => {
      await open();
      await patch(USERS.minjae, 'TERMINATED', { confirmName: await nameOf() });
      await w.fx.addResidual('cus_mirae', 'aws:111111111111', 3, new Date('2026-11-10T01:02:03.000Z'));
      await w.fx.addResidual('cus_mirae', 'integration:x', 2, new Date('2026-11-11T01:02:03.000Z'));
      expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/offboarding')).residual).toEqual({ lastEventAt: '2026-11-11T01:02:03.000Z', count: 5 });
    });

    it('incidents carry pagingSuppressed (list and detail); null when the customer was ACTIVE', async () => {
      await open((s) => { s.customers.set('cus_mirae', { ...s.customers.get('cus_mirae')!, status: 'SUSPENDED' }); });
      const list = body(await w.call(USERS.haeun, 'GET', '/incidents'));
      expect(list.items.find((i: any) => i.id === w.ids.mirae).pagingSuppressed).toBe('CUSTOMER_SUSPENDED');
      expect(list.items.find((i: any) => i.id === w.ids.hanbit).pagingSuppressed).toBeNull();
      expect(body(await w.call(USERS.haeun, 'GET', `/incidents/${w.ids.mirae}`)).pagingSuppressed).toBe('CUSTOMER_SUSPENDED');
      expect(body(await w.call(USERS.haeun, 'GET', `/incidents/${w.ids.hanbit}`)).pagingSuppressed).toBeNull();
    });

    it('there is no status door besides PATCH /customers/{id}/status', async () => {
      await open();
      expect((await w.call(USERS.minjae, 'PATCH', '/customers/cus_mirae', { body: { status: 'TERMINATED' } })).status).toBe(404);
      expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/status')).status).toBe('ACTIVE');
    });
  });
}
