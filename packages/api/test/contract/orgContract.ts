/**
 * Contract suite of the onboarding wizard routes (hkjs96/alarmops#69): GET /customers, GET/PATCH /customers/{id},
 * GET/POST /customers/{id}/projects, PATCH /projects/{id}, GET/POST /projects/{id}/services, PATCH /services/{id} —
 * the SAME tests against MemoryApiStore and the SQL store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthContext, MemoryApiStore } from '../../src/index.js';
import { USERS, body, wire } from '../helpers.js';
import { cworld, type CWorld, type MakeApiFixture } from './apiContract.js';

const HANBIT_ADMIN: AuthContext = { userId: 'usr_hb', name: 'Hanbit Admin', kind: 'INTERNAL', customerIds: ['cus_hanbit'], role: 'ADMIN' };

export function orgContract(make: MakeApiFixture): void {
  let w: CWorld;
  const open = async (): Promise<CWorld> => (w = await cworld(make, (s: MemoryApiStore) => { s.loginDomains.set('cus_hanbit', ['hanbit.example']); }));
  afterEach(async () => { await w?.fx.close(); });
  const admin = USERS.minjae;
  const call = (who: AuthContext | null, method: 'GET' | 'POST' | 'PATCH', path: string, b?: unknown) => w.call(who, method, path, b === undefined ? {} : { body: b });
  const names = async (path: string) => (body(await call(admin, 'GET', path)).items as any[]).map((x) => x.name);

  describe('customers', () => {
    it('GET /customers: staff see the customers of their range with status and login domains; portal users have no such route', async () => {
      await open();
      const items = body(await call(admin, 'GET', '/customers')).items as any[];
      expect(items.map((c) => [c.id, c.status]).sort()).toEqual([['cus_hanbit', 'ACTIVE'], ['cus_mirae', 'ACTIVE']]);
      expect(items.find((c) => c.id === 'cus_hanbit')).toMatchObject({ name: 'Hanbit Retail', slug: 'hanbit', loginDomains: ['hanbit.example'] });
      await w.fx.setCustomerStatus('cus_hanbit', 'SUSPENDED');
      expect((body(await call(admin, 'GET', '/customers')).items as any[]).find((c) => c.id === 'cus_hanbit').status).toBe('SUSPENDED');
      expect((body(await call(HANBIT_ADMIN, 'GET', '/customers')).items as any[]).map((c) => c.id)).toEqual(['cus_hanbit']);
      expect((await call(USERS.viewer, 'GET', '/customers')).status).toBe(200);
      expect((await call(USERS.yuna, 'GET', '/customers')).status).toBe(404);
      expect((await call(null, 'GET', '/customers')).status).toBe(401);
    });

    it('GET /customers/{id}: unknown and out-of-scope ids are the same 404 (bytes)', async () => {
      await open();
      expect(body(await call(admin, 'GET', '/customers/cus_mirae'))).toMatchObject({ id: 'cus_mirae', slug: 'mirae', status: 'ACTIVE' });
      const a = await w.call(HANBIT_ADMIN, 'GET', '/customers/cus_mirae', { requestId: 'r' });
      const b = await w.call(HANBIT_ADMIN, 'GET', '/customers/cus_nope', { requestId: 'r' });
      expect(a.status).toBe(404);
      expect(wire(a)).toBe(wire(b));
      expect((await call(USERS.yuna, 'GET', '/customers/cus_mirae')).status).toBe(404);
    });

    it('PATCH /customers/{id}: name and loginDomains, audited; the same validation as POST; never status or slug', async () => {
      await open();
      const r = await call(admin, 'PATCH', '/customers/cus_mirae', { name: 'Mirae Pay Co', loginDomains: ['Mirae.Example', 'mirae.co.kr'] });
      expect(r.status).toBe(200);
      expect(body(r)).toMatchObject({ name: 'Mirae Pay Co', slug: 'mirae', status: 'ACTIVE', loginDomains: ['mirae.example', 'mirae.co.kr'] });
      expect(body(await call(admin, 'GET', '/customers/cus_mirae')).name).toBe('Mirae Pay Co');
      const a = (await w.fx.audits()).filter((x) => x.action === 'customer.update');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ customerId: 'cus_mirae', targetId: 'cus_mirae', actorId: 'usr_minjae', before: { name: 'Mirae Pay' }, after: { name: 'Mirae Pay Co' } });
      // nothing differs: no write, no audit
      await call(admin, 'PATCH', '/customers/cus_mirae', { name: 'Mirae Pay Co' });
      expect((await w.fx.audits()).filter((x) => x.action === 'customer.update')).toHaveLength(1);
      for (const [b, status] of [[{ status: 'SUSPENDED' }, 400], [{ slug: 'x' }, 400], [{}, 400], [{ name: '' }, 400], [{ name: 'x'.repeat(81) }, 400], [{ loginDomains: ['not a domain'] }, 400],
        [{ loginDomains: 'a.example' }, 400], [{ loginDomains: ['gmail.com'] }, 422], [{ loginDomains: ['mail.naver.com'] }, 422]] as const) {
        expect([b, (await call(admin, 'PATCH', '/customers/cus_mirae', b)).status]).toEqual([b, status]);
      }
      expect(body(await call(admin, 'GET', '/customers/cus_mirae')).status).toBe('ACTIVE');
    });

    it('PATCH conflicts: another customer\'s name (any case) and login domain are 409 and change nothing; an own domain stays fine', async () => {
      await open();
      expect((await call(admin, 'PATCH', '/customers/cus_mirae', { name: 'HANBIT RETAIL' })).status).toBe(409);
      expect((await call(admin, 'PATCH', '/customers/cus_mirae', { loginDomains: ['hanbit.example'] })).status).toBe(409);
      expect((await call(admin, 'PATCH', '/customers/cus_hanbit', { loginDomains: ['hanbit.example', 'hanbit.co.kr'] })).status).toBe(200);
      expect(body(await call(admin, 'GET', '/customers/cus_mirae')).loginDomains).toEqual([]);
    });

    it('PATCH roles: OPERATOR 403, staff narrowed to another customer 404, portal 404; a TERMINATED customer 409', async () => {
      await open();
      expect((await call(USERS.haeun, 'PATCH', '/customers/cus_mirae', { name: 'X' })).status).toBe(403);
      expect((await call(HANBIT_ADMIN, 'PATCH', '/customers/cus_mirae', { name: 'X' })).status).toBe(404);
      expect((await call(HANBIT_ADMIN, 'PATCH', '/customers/cus_hanbit', { name: 'Hanbit Two' })).status).toBe(200);
      expect((await call(USERS.yuna, 'PATCH', '/customers/cus_mirae', { name: 'X' })).status).toBe(404);
      expect((await call(admin, 'PATCH', '/customers/cus_nope', { name: 'X' })).status).toBe(404);
      await w.fx.setCustomerStatus('cus_mirae', 'TERMINATED');
      expect((await call(admin, 'PATCH', '/customers/cus_mirae', { name: 'X' })).status).toBe(409);
    });
  });

  describe('projects and services', () => {
    it('creates projects: slug from the name (Korean-only → project, project-2), listed with serviceCount, audited', async () => {
      await open();
      const before = await names('/customers/cus_mirae/projects');
      const r = await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Billing API' });
      expect(r.status).toBe(201);
      expect(body(r)).toMatchObject({ customerId: 'cus_mirae', name: 'Billing API', slug: 'billing-api', serviceCount: 0 });
      const k1 = body(await call(admin, 'POST', '/customers/cus_mirae/projects', { name: '결제' }));
      const k2 = body(await call(admin, 'POST', '/customers/cus_mirae/projects', { name: '정산' }));
      expect([k1.slug, k2.slug]).toEqual(['project', 'project-2']);
      const list = body(await call(admin, 'GET', '/customers/cus_mirae/projects')).items as any[];
      expect(list.map((p) => p.name)).toHaveLength(before.length + 3);
      expect(list.find((p) => p.slug === 'core').serviceCount).toBe(1);
      const a = (await w.fx.audits()).filter((x) => x.action === 'project.create');
      expect(a).toHaveLength(3);
      expect(a[0]).toMatchObject({ customerId: 'cus_mirae', targetId: body(r).id, actorId: 'usr_minjae', after: { name: 'Billing API', slug: 'billing-api' } });
    });

    it('name unique per customer (any case) → 409; explicit slug: reserved/format 400, taken 409; the same name in another customer is fine', async () => {
      await open();
      await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Billing' });
      for (const n of ['Billing', 'BILLING', ' billing ']) expect([n, (await call(admin, 'POST', '/customers/cus_mirae/projects', { name: n })).status]).toEqual([n, 409]);
      expect((await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Other', slug: 'billing' })).status).toBe(409);
      expect((await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Other', slug: 'settings' })).status).toBe(400);
      expect((await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Other', slug: 'Bad Slug' })).status).toBe(400);
      expect((await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Other', status: 'x' })).status).toBe(400);
      expect((await call(admin, 'POST', '/customers/cus_mirae/projects', { name: '' })).status).toBe(400);
      expect((await call(admin, 'POST', '/customers/cus_hanbit/projects', { name: 'Billing' })).status).toBe(201);
      expect((await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Reserved', slug: 'new' })).status).toBe(400);
      expect(await names('/customers/cus_mirae/projects')).not.toContain('Other');
    });

    it('PATCH /projects/{id} renames (slug stays), name conflicts 409, slug in the body 400', async () => {
      await open();
      const p = body(await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Alpha' }));
      expect(body(await call(admin, 'PATCH', `/projects/${p.id}`, { name: 'Alpha Two' }))).toMatchObject({ name: 'Alpha Two', slug: 'alpha' });
      await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Beta' });
      expect((await call(admin, 'PATCH', `/projects/${p.id}`, { name: 'beta' })).status).toBe(409);
      expect((await call(admin, 'PATCH', `/projects/${p.id}`, { slug: 'zzz' })).status).toBe(400);
      expect((await call(admin, 'PATCH', `/projects/${p.id}`, { name: 'Alpha Two' })).status).toBe(200);
      expect((await w.fx.audits()).filter((x) => x.action === 'project.update')).toHaveLength(1);
    });

    it('creates and lists services of a project; name unique per project, the same name in another project is fine; slug from the name', async () => {
      await open();
      const p = body(await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Gamma' }));
      const q = body(await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Delta' }));
      const s = await call(admin, 'POST', `/projects/${p.id}/services`, { name: 'Web Front' });
      expect(s.status).toBe(201);
      expect(body(s)).toMatchObject({ customerId: 'cus_mirae', projectId: p.id, name: 'Web Front', slug: 'web-front' });
      expect((await call(admin, 'POST', `/projects/${p.id}/services`, { name: 'web front' })).status).toBe(409);
      expect((await call(admin, 'POST', `/projects/${p.id}/services`, { name: 'Other', slug: 'web-front' })).status).toBe(409);
      expect((await call(admin, 'POST', `/projects/${q.id}/services`, { name: 'Web Front' })).status).toBe(201);
      expect(body(await call(admin, 'POST', `/projects/${p.id}/services`, { name: '검색' })).slug).toBe('service');
      expect(await names(`/projects/${p.id}/services`)).toEqual(['Web Front', '검색'].sort());
      expect((await names('/customers/cus_mirae/projects')).length).toBeGreaterThan(0);
      expect(body(await call(admin, 'GET', '/customers/cus_mirae/projects')).items.find((x: any) => x.id === p.id).serviceCount).toBe(2);
      const r = await call(admin, 'PATCH', `/services/${body(s).id}`, { name: 'Web Frontend' });
      expect(body(r)).toMatchObject({ name: 'Web Frontend', slug: 'web-front' });
      expect((await call(admin, 'PATCH', `/services/${body(s).id}`, { name: '검색' })).status).toBe(409);
      expect((await w.fx.audits()).filter((x) => x.action.startsWith('service.')).map((x) => x.action)).toEqual(['service.create', 'service.create', 'service.create', 'service.update']);
    });

    it('tenant isolation: another customer\'s project / service / customer ids are the same 404 as unknown ones (reads and writes), for narrowed staff and portal users', async () => {
      await open();
      const own = body(await call(HANBIT_ADMIN, 'POST', '/customers/cus_hanbit/projects', { name: 'Mine' }));
      for (const [who, method, path, b] of [
        [HANBIT_ADMIN, 'GET', '/customers/cus_mirae/projects'], [HANBIT_ADMIN, 'POST', '/customers/cus_mirae/projects', { name: 'X' }],
        [HANBIT_ADMIN, 'GET', '/projects/prj_core/services'], [HANBIT_ADMIN, 'POST', '/projects/prj_core/services', { name: 'X' }], [HANBIT_ADMIN, 'PATCH', '/projects/prj_core', { name: 'X' }],
        [HANBIT_ADMIN, 'PATCH', '/services/svc_pay', { name: 'X' }],
        [USERS.yuna, 'GET', '/customers/cus_mirae/projects'], [USERS.yuna, 'POST', '/customers/cus_mirae/projects', { name: 'X' }], [USERS.yuna, 'GET', '/projects/prj_core/services'],
        [USERS.yuna, 'PATCH', '/services/svc_pay', { name: 'X' }], [USERS.dohyun, 'POST', '/projects/prj_core/services', { name: 'X' }],
      ] as const) {
        const a = await w.call(who, method, path, { body: b, requestId: 'r' });
        const missing = await w.call(who, method, path.replace('cus_mirae', 'cus_nope').replace('prj_core', 'prj_nope').replace('svc_pay', 'svc_nope'), { body: b, requestId: 'r' });
        expect([method, path, a.status]).toEqual([method, path, 404]);
        expect(wire(a)).toBe(wire(missing));
      }
      expect((await call(HANBIT_ADMIN, 'POST', `/projects/${own.id}/services`, { name: 'Svc' })).status).toBe(201);
      expect(await names('/customers/cus_mirae/projects')).not.toContain('X');
    });

    it('roles: OPERATOR/VIEWER read but cannot write (403); a TERMINATED customer takes no change (409)', async () => {
      await open();
      expect((await call(USERS.haeun, 'GET', '/customers/cus_mirae/projects')).status).toBe(200);
      expect((await call(USERS.haeun, 'GET', '/projects/prj_core/services')).status).toBe(200);
      expect((await call(USERS.haeun, 'POST', '/customers/cus_mirae/projects', { name: 'X' })).status).toBe(403);
      expect((await call(USERS.viewer, 'POST', '/projects/prj_core/services', { name: 'X' })).status).toBe(403);
      expect((await call(USERS.haeun, 'PATCH', '/projects/prj_core', { name: 'X' })).status).toBe(403);
      expect((await call(null, 'GET', '/customers/cus_mirae/projects')).status).toBe(401);
      await w.fx.setCustomerStatus('cus_mirae', 'TERMINATED');
      expect((await call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'X' })).status).toBe(409);
      expect((await call(admin, 'POST', '/projects/prj_core/services', { name: 'X' })).status).toBe(409);
      expect((await call(admin, 'GET', '/customers/cus_mirae/projects')).status).toBe(200);
    });

    it('parallel creates of one project name: exactly one 201', async () => {
      await open();
      const rs = await Promise.all(Array.from({ length: 5 }, () => call(admin, 'POST', '/customers/cus_mirae/projects', { name: 'Racer' })));
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
      expect((await names('/customers/cus_mirae/projects')).filter((n) => n === 'Racer')).toHaveLength(1);
    });
  });
}
