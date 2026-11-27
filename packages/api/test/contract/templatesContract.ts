/**
 * Contract suite of /responder-templates (list, create, preview, save) — the same tests against MemoryApiStore
 * (test/contract.memory.test.ts) and the SQL store (packages/store-sql/test/contract.api.test.ts).
 *
 * World: template "Infra core" = Haeun + Junho, used by Mirae Pay and Hanbit Retail.
 *  - Mirae: Haeun and Junho come from the template; a PROJECT call order has a PERSON step naming Junho (step 1).
 *  - Hanbit: Haeun from the template; Junho and Minjae were added directly.
 *  - Terminated Dohyun-Corp style customer: "Old Co" uses the template but is TERMINATED (left out).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TickRepository } from '@alarmops/core';
import type { MakeFixture, StoreFixture } from '../../../core/test/contract/fixture.js';
import { config, seedWorld, step, T0 } from '../../../core/test/world.js';
import { createApi, MemoryApiStore, type ApiRepository, type ApiRequest, type ApiResponse, type AuthContext } from '../../src/index.js';
import { USERS, body } from '../helpers.js';

type Repo = TickRepository & ApiRepository;
interface TWorld {
  fx: StoreFixture<Repo>;
  call: (auth: AuthContext | null, method: ApiRequest['method'], path: string, opts?: { query?: Record<string, string | undefined>; body?: unknown; headers?: Record<string, string> }) => Promise<ApiResponse>;
}

const T = 'rt_infra';
async function tworld(make: MakeFixture<Repo>, customize?: (seed: MemoryApiStore) => void): Promise<TWorld> {
  const seed = seedWorld(new MemoryApiStore()) as MemoryApiStore;
  seed.users.set('usr_minjae', { id: 'usr_minjae', name: 'Minjae Lee', contactId: 'ct_minjae', email: 'usr_minjae@example.test', role: 'ADMIN', customerId: null });
  seed.users.set('usr_haeun', { id: 'usr_haeun', name: 'Haeun Kim', contactId: 'ct_haeun', email: 'usr_haeun@example.test', role: 'OPERATOR', customerId: null });
  seed.templates.set(T, { id: T, name: 'Infra core', version: 0, updatedBy: 'usr_haeun', updatedAt: new Date('2026-11-01T00:00:00Z'), members: ['ct_haeun', 'ct_junho'] });
  seed.customers.set('cus_old', { id: 'cus_old', name: 'Old Co', slug: 'old', status: 'TERMINATED' });
  for (const c of ['cus_mirae', 'cus_hanbit', 'cus_old']) seed.customerTemplate.set(c, T);
  const tpl = { source: 'TEMPLATE' as const, templateId: T, templateName: 'Infra core' };
  seed.responderSource.set('cus_mirae|ct_haeun', tpl);
  seed.responderSource.set('cus_mirae|ct_junho', tpl);
  // Hanbit: Haeun from the template, Junho added directly (Minjae is a direct row of the seed)
  seed.responders.push({ customerId: 'cus_hanbit', contactId: 'ct_haeun', role: 'PAGEABLE', order: 10 }, { customerId: 'cus_hanbit', contactId: 'ct_junho', role: 'PAGEABLE', order: 11 },
    { customerId: 'cus_old', contactId: 'ct_haeun', role: 'PAGEABLE', order: 0 }, { customerId: 'cus_old', contactId: 'ct_junho', role: 'PAGEABLE', order: 1 });
  seed.responderSource.set('cus_hanbit|ct_haeun', tpl);
  seed.responderSource.set('cus_old|ct_haeun', tpl);
  seed.responderSource.set('cus_old|ct_junho', tpl);
  seed.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_junho', ['SMS'])], { scopeType: 'PROJECT', scopeId: 'prj_core', style: 'CUSTOM' }));
  customize?.(seed);
  const fx = await make(seed);
  fx.setClock(() => T0);
  const api = createApi({ repo: fx.repo, now: () => T0 });
  let seq = 0;
  return { fx, call: (auth, method, path, o = {}) => api.handle({ method, path, auth, query: o.query, body: o.body, headers: o.headers, requestId: `req_${++seq}` }) };
}

const ADMIN = USERS.minjae;
const im = (v: number | string) => ({ 'if-match': String(v) });
const IDS = (xs: Array<{ contactId: string }>) => xs.map((x) => x.contactId).sort();

export function templatesContract(make: MakeFixture<Repo>): void {
  let w: TWorld;
  afterEach(async () => { await w?.fx.close(); });

  const preview = (members: string[], auth: AuthContext = ADMIN) => w.call(auth, 'POST', `/responder-templates/${T}/preview`, { body: { members } });
  const save = async (members: string[], version = 0, extra: Record<string, unknown> = {}) => {
    const p = body(await preview(members));
    return w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: { members, previewHash: p.previewHash, ...extra }, headers: im(version) });
  };
  const respondersOf = async (cid: string) => body(await w.call(ADMIN, 'GET', `/customers/${cid}/responders`));

  describe('GET /customers/{id}/responders carries the customer template (#178)', () => {
    it('templateId and templateName are the customer\'s template, whether or not any member came in DIRECT; null when none', async () => {
      w = await tworld(make, (seed) => { seed.customers.set('cus_bare', { id: 'cus_bare', name: 'Bare Co', slug: 'bare' }); });
      // Hanbit: Junho was added directly, Haeun comes from the template
      expect(await respondersOf('cus_hanbit')).toMatchObject({ templateId: T, templateName: 'Infra core' });
      expect((await respondersOf('cus_hanbit')).staff.map((s: any) => s.source).sort()).toContain('DIRECT');
      const bare = await respondersOf('cus_bare');
      expect([bare.templateId, bare.templateName]).toEqual([null, null]);
      await fixtureRename('Infra core 2');
      expect(await respondersOf('cus_mirae')).toMatchObject({ templateId: T, templateName: 'Infra core 2' });
    });

    it('a customer with a template but no member rows still names it', async () => {
      w = await tworld(make, (seed) => {
        seed.customers.set('cus_empty', { id: 'cus_empty', name: 'Empty Co', slug: 'empty' });
        seed.customerTemplate.set('cus_empty', T);
      });
      const r = await respondersOf('cus_empty');
      expect([r.staff.length, r.templateId, r.templateName]).toEqual([0, T, 'Infra core']);
    });
  });

  const fixtureRename = async (name: string) => {
    const members = ['ct_haeun', 'ct_junho'];
    const p = body(await w.call(ADMIN, 'POST', `/responder-templates/${T}/preview`, { body: { name, members } }));
    const r = await w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: { name, members, previewHash: p.previewHash }, headers: im(0) });
    expect(r.status).toBe(200);
  };

  describe('a member deactivated since it was added (#176)', () => {
    const inactiveJunho = (seed: MemoryApiStore): void => { seed.contacts.set('ct_junho', { ...seed.contacts.get('ct_junho')!, active: false }); };
    it('a rename-only PATCH succeeds (name only, or the same member list sent back); only newly added people must be active staff', async () => {
      w = await tworld(make, inactiveJunho);
      const rename = async (extra: Record<string, unknown>, version: number, name: string) => {
        const p = await w.call(ADMIN, 'POST', `/responder-templates/${T}/preview`, { body: { name, ...extra } });
        expect(p.status).toBe(200);
        return w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: { name, ...extra, previewHash: body(p).previewHash }, headers: im(version) });
      };
      const a = await rename({}, 0, 'Infra core v2');
      expect([a.status, body(a).name]).toEqual([200, 'Infra core v2']);
      const b = await rename({ members: ['ct_haeun', 'ct_junho'] }, 1, 'Infra core v3');
      expect([b.status, body(b).name]).toEqual([200, 'Infra core v3']);
      // a newly added person is still checked
      const c = await w.call(ADMIN, 'POST', `/responder-templates/${T}/preview`, { body: { members: ['ct_haeun', 'ct_junho', 'ct_nobody'] } });
      expect([c.status, body(c).error.code]).toEqual([400, 'VALIDATION_FAILED']);
    });
  });

  describe('GET /responder-templates', () => {
    it('any MSP staff role reads; members and customers (terminated left out), no contact values', async () => {
      w = await tworld(make);
      for (const auth of [USERS.viewer, USERS.haeun, ADMIN]) {
        const r = await w.call(auth, 'GET', '/responder-templates');
        expect(r.status).toBe(200);
        const [t] = body(r);
        expect(body(r)).toHaveLength(1);
        expect(t).toMatchObject({ id: T, name: 'Infra core', version: 0, updatedByName: 'Haeun Kim' });
        expect(IDS(t.members)).toEqual(['ct_haeun', 'ct_junho']);
        expect(t.customers.map((c: any) => c.id)).toEqual(['cus_hanbit', 'cus_mirae']);
      }
      expect(JSON.stringify(body(await w.call(ADMIN, 'GET', '/responder-templates')))).not.toContain('@example.test');
    });

    it('portal users get the one 404, anonymous 401, narrowed staff 403', async () => {
      w = await tworld(make);
      for (const [method, path] of [['GET', '/responder-templates'], ['POST', '/responder-templates'], ['PATCH', `/responder-templates/${T}`], ['POST', `/responder-templates/${T}/preview`]] as const) {
        expect((await w.call(USERS.yuna, method, path, { body: {}, headers: im(0) })).status).toBe(404);
        expect((await w.call(null, method, path, { body: {}, headers: im(0) })).status).toBe(401);
        const narrowed = await w.call({ ...ADMIN, customerIds: ['cus_mirae'] }, method, path, { body: {}, headers: im(0) });
        expect(narrowed.status).toBe(403);
        expect(body(narrowed).error.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('POST /responder-templates', () => {
    it('creates (201, version 0, ETag, no customers) and audits; staff only, unique name', async () => {
      w = await tworld(make);
      const r = await w.call(ADMIN, 'POST', '/responder-templates', { body: { name: '  Night desk ', members: ['ct_minjae', 'ct_haeun'] } });
      expect(r.status).toBe(201);
      expect(r.headers.etag).toBe('"0"');
      expect(body(r)).toMatchObject({ name: 'Night desk', version: 0, customers: [], updatedByName: 'Minjae Lee' });
      expect(IDS(body(r).members)).toEqual(['ct_haeun', 'ct_minjae']);
      expect(body(await w.call(ADMIN, 'GET', '/responder-templates')).map((t: any) => t.name)).toEqual(['Infra core', 'Night desk']);
      const a = (await w.fx.audits()).filter((x) => x.action === 'responder_template.create');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ customerId: null, actorId: 'usr_minjae', targetType: 'ResponderTemplate', targetId: body(r).id });
      expect((await w.call(ADMIN, 'POST', '/responder-templates', { body: { name: 'Infra core', members: ['ct_haeun'] } })).status).toBe(409);
    });

    it('role: VIEWER and OPERATOR 403; validation 400 (customer people, unknown ids and inactive staff all the same message)', async () => {
      w = await tworld(make);
      const ok = { name: 'X', members: ['ct_haeun'] };
      for (const auth of [USERS.viewer, USERS.haeun]) {
        const r = await w.call(auth, 'POST', '/responder-templates', { body: ok });
        expect([r.status, body(r).error.code]).toEqual([403, 'ROLE_REQUIRED']);
      }
      const msgs = new Set<string>();
      for (const members of [['ct_yuna'], ['ct_nobody'], ['ct_haeun', 'ct_dohyun']]) {
        const r = await w.call(ADMIN, 'POST', '/responder-templates', { body: { name: 'X', members } });
        expect(r.status).toBe(400);
        expect(body(r).error.details.fields[0].field).toBe('members');
        msgs.add(body(r).error.message);
      }
      expect(msgs.size).toBe(1);
      await w.fx.patchContact('ct_junho', { active: false });
      expect((await w.call(ADMIN, 'POST', '/responder-templates', { body: { name: 'X', members: ['ct_junho'] } })).status).toBe(400);
      for (const bad of [{ name: '', members: ['ct_haeun'] }, { name: 'x'.repeat(81), members: ['ct_haeun'] }, { name: 'X', members: [] }, { name: 'X', members: ['ct_haeun', 'ct_haeun'] }, { name: 'X' }, { name: 'X', members: 'ct_haeun' }, { name: 'X', members: ['ct_haeun'], customerIds: [] }]) {
        expect((await w.call(ADMIN, 'POST', '/responder-templates', { body: bad })).status).toBe(400);
      }
      expect((await w.call(ADMIN, 'POST', '/responder-templates', { body: ['x'] })).status).toBe(400);
      expect((await w.fx.audits()).filter((x) => x.action === 'responder_template.create')).toHaveLength(0);
    });
  });

  describe('POST /responder-templates/{id}/preview', () => {
    it('effects per customer (JOINS / LEAVES / STEP_NAMES / STAYS_DIRECT / ALREADY_DIRECT), terminated customers left out, nothing written', async () => {
      w = await tworld(make);
      const r = await preview(['ct_haeun', 'ct_minjae']); // Junho leaves, Minjae joins
      expect(r.status).toBe(200);
      const b = body(r);
      expect(b).toMatchObject({ templateId: T, version: 0, totals: { customers: 2, affected: 1, joins: 1, leaves: 1, warnings: 1 } });
      expect(b.previewHash).toMatch(/^[0-9a-f]{64}$/);
      expect(b.customers.map((c: any) => c.id)).toEqual(['cus_hanbit', 'cus_mirae']);
      expect(b.customers[0].effects.map((e: any) => [e.kind, e.contactId])).toEqual([['STAYS_DIRECT', 'ct_junho'], ['ALREADY_DIRECT', 'ct_minjae']]);
      expect(b.customers[1].effects.map((e: any) => [e.kind, e.contactId, e.name, e.stepIndex])).toEqual([
        ['JOINS', 'ct_minjae', 'Minjae Lee', undefined], ['LEAVES', 'ct_junho', 'Junho Park', undefined], ['STEP_NAMES', 'ct_junho', 'Junho Park', 1]]);
      expect(JSON.stringify(b)).not.toContain('cus_old');
      // read-only: nothing changed, nothing audited, not even a version
      expect(IDS((await respondersOf('cus_mirae')).staff)).toEqual(['ct_haeun', 'ct_junho']);
      expect((await w.fx.audits()).filter((x) => x.targetType === 'ResponderTemplate')).toHaveLength(0);
      expect(body(await w.call(ADMIN, 'GET', '/responder-templates'))[0].version).toBe(0);
    });

    it('a rename alone has no customer effects; the hash covers the proposal; needs ADMIN, a body, an existing template', async () => {
      w = await tworld(make);
      const rename = body(await w.call(ADMIN, 'POST', `/responder-templates/${T}/preview`, { body: { name: 'Infra' } }));
      expect(rename.totals).toMatchObject({ customers: 2, affected: 0 });
      const same = body(await preview(['ct_haeun', 'ct_junho']));
      const other = body(await preview(['ct_haeun']));
      expect(new Set([rename.previewHash, same.previewHash, other.previewHash]).size).toBe(3);
      expect(body(await preview(['ct_haeun'])).previewHash).toBe(other.previewHash); // deterministic
      for (const auth of [USERS.viewer, USERS.haeun]) expect((await preview(['ct_haeun'], auth)).status).toBe(403);
      expect((await w.call(ADMIN, 'POST', `/responder-templates/${T}/preview`, { body: {} })).status).toBe(400);
      expect((await w.call(ADMIN, 'POST', `/responder-templates/${T}/preview`, { body: { members: ['ct_yuna'] } })).status).toBe(400);
      expect((await w.call(ADMIN, 'POST', '/responder-templates/rt_nope/preview', { body: { members: ['ct_haeun'] } })).status).toBe(404);
      // a viewer learns nothing about an unknown id either: 404 comes before the role check, like Responders
      expect((await w.call(USERS.viewer, 'POST', '/responder-templates/rt_nope/preview', { body: { members: ['ct_haeun'] } })).status).toBe(404);
    });
  });

  describe('PATCH /responder-templates/{id}', () => {
    it('applies: members replaced, customers\' template rows added and removed, direct rows kept, version +1, ETag', async () => {
      w = await tworld(make);
      const r = await save(['ct_haeun', 'ct_minjae']);
      expect(r.status).toBe(200);
      expect(r.headers.etag).toBe('"1"');
      expect(body(r)).toMatchObject({ id: T, version: 1, affected: 1, updatedByName: 'Minjae Lee' });
      expect(IDS(body(r).members)).toEqual(['ct_haeun', 'ct_minjae']);
      const mirae = await respondersOf('cus_mirae');
      expect(mirae.staff.map((s: any) => [s.contactId, s.source, s.templateName])).toEqual([['ct_haeun', 'TEMPLATE', 'Infra core'], ['ct_minjae', 'TEMPLATE', 'Infra core']]);
      // the step that names Junho is untouched (a warning in the preview, not a block)
      const hanbit = await respondersOf('cus_hanbit');
      expect(hanbit.staff.map((s: any) => [s.contactId, s.source]).sort()).toEqual([['ct_haeun', 'TEMPLATE'], ['ct_junho', 'DIRECT'], ['ct_minjae', 'DIRECT']]);
      // Responders versions do not move (contract)
      expect([mirae.version, hanbit.version]).toEqual([0, 0]);
      // the terminated customer is not touched
      const t = (await w.fx.repo.listResponderTemplates())[0]!;
      expect(t.customers.map((c) => c.id)).toEqual(['cus_hanbit', 'cus_mirae']);
    });

    it('audit: one MSP-level row + one row per changed customer (ids only, tenant-scoped); BulkChange TEMPLATE_UPDATE', async () => {
      w = await tworld(make);
      await save(['ct_haeun', 'ct_minjae']);
      const rows = (await w.fx.audits()).filter((a) => a.targetType === 'ResponderTemplate');
      const msp = rows.filter((a) => a.customerId === null);
      expect(msp).toHaveLength(1);
      expect(msp[0]).toMatchObject({ action: 'responder_template.update', actorId: 'usr_minjae', targetId: T });
      expect(msp[0]!.after).toMatchObject({ version: 1, added: ['ct_minjae'], removed: ['ct_junho'] });
      const per = rows.filter((a) => a.customerId !== null);
      expect(per.map((a) => [a.customerId, a.action, a.after])).toEqual([['cus_mirae', 'responder_template.apply', { added: ['ct_minjae'], removed: ['ct_junho'] }]]);
      expect((await w.fx.audits()).filter((a) => a.targetType === 'Responders')).toHaveLength(0);
      expect(JSON.stringify(rows)).not.toContain('@example.test');
      const repo = w.fx.repo as unknown as MemoryApiStore;
      if (w.fx.kind === 'memory') {
        expect(repo.bulkChanges).toHaveLength(1);
        expect(repo.bulkChanges[0]).toMatchObject({ kind: 'TEMPLATE_UPDATE', actorId: 'usr_minjae', params: { templateId: T, added: ['ct_minjae'], removed: ['ct_junho'] } });
      } else {
        const rowsBc = await (w.fx as unknown as { sql: { query: (q: string) => Promise<Array<Record<string, any>>> } }).sql.query(`SELECT "kind", "actorId", "params", "previewHash" FROM "BulkChange"`);
        expect(rowsBc).toHaveLength(1);
        expect(rowsBc[0]).toMatchObject({ kind: 'TEMPLATE_UPDATE', actorId: 'usr_minjae', params: { templateId: T, added: ['ct_minjae'], removed: ['ct_junho'] } });
        expect(rowsBc[0]!.previewHash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('rename only: version +1, nobody\'s list changes; unchanged proposal is a 200 no-op without a write', async () => {
      w = await tworld(make);
      const p = body(await w.call(ADMIN, 'POST', `/responder-templates/${T}/preview`, { body: { name: 'Infra' } }));
      const r = await w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: { name: 'Infra', previewHash: p.previewHash }, headers: im(0) });
      expect([r.status, body(r).version, body(r).affected, body(r).name]).toEqual([200, 1, 0, 'Infra']);
      expect((await respondersOf('cus_mirae')).staff.map((s: any) => s.templateName)).toEqual(['Infra', 'Infra']);
      const before = (await w.fx.audits()).length;
      const noop = await w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: { name: 'Infra', members: ['ct_junho', 'ct_haeun'], previewHash: p.previewHash }, headers: im(1) });
      expect([noop.status, body(noop).version, body(noop).affected]).toEqual([200, 1, 0]);
      expect((await w.fx.audits()).length).toBe(before);
    });

    it('If-Match: missing 400, stale 409 VERSION_CONFLICT with currentVersion; nothing written', async () => {
      w = await tworld(make);
      const p = body(await preview(['ct_haeun']));
      const patch = (headers: Record<string, string>) => w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: { members: ['ct_haeun'], previewHash: p.previewHash }, headers });
      expect((await patch({})).status).toBe(400);
      expect((await patch(im('x'))).status).toBe(400);
      const stale = await patch(im(5));
      expect([stale.status, body(stale).error.code, body(stale).error.details.currentVersion]).toEqual([409, 'VERSION_CONFLICT', 0]);
      expect((await patch(im(0))).status).toBe(200);
      const again = await patch(im(0)); // two admins saved from the same version: the second one loses
      expect([again.status, body(again).error.code, body(again).error.details.currentVersion]).toEqual([409, 'VERSION_CONFLICT', 1]);
      expect((await w.fx.audits()).filter((a) => a.action === 'responder_template.update')).toHaveLength(1);
    });

    it('previewHash: required (400), a hash of another proposal or a changed customer list is 409 PREVIEW_STALE and nothing is written', async () => {
      w = await tworld(make);
      const patch = (members: string[], previewHash: unknown) => w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: { members, previewHash }, headers: im(0) });
      expect((await patch(['ct_haeun'], undefined)).status).toBe(400);
      expect((await patch(['ct_haeun'], 'nope')).status).toBe(400);
      const forOther = body(await preview(['ct_haeun', 'ct_minjae'])).previewHash;
      const wrong = await patch(['ct_haeun'], forOther);
      expect([wrong.status, body(wrong).error.code]).toEqual([409, 'PREVIEW_STALE']);
      // preview, then a Responders write changes what the save would do → stale
      const p = body(await preview(['ct_haeun', 'ct_minjae'])).previewHash;
      await w.call(ADMIN, 'POST', '/customers/cus_mirae/responders', { body: { contactId: 'ct_minjae' }, headers: im(0) });
      const stale = await patch(['ct_haeun', 'ct_minjae'], p);
      expect([stale.status, body(stale).error.code, body(stale).error.details.currentVersion]).toEqual([409, 'PREVIEW_STALE', 0]);
      expect(IDS((await respondersOf('cus_hanbit')).staff)).toEqual(['ct_haeun', 'ct_junho', 'ct_minjae']);
      expect(body(await w.call(ADMIN, 'GET', '/responder-templates'))[0].version).toBe(0);
      expect((await w.fx.audits()).filter((a) => a.targetType === 'ResponderTemplate')).toHaveLength(0);
      // with a fresh preview it goes through
      const fresh = body(await preview(['ct_haeun', 'ct_minjae'])).previewHash;
      expect((await patch(['ct_haeun', 'ct_minjae'], fresh)).status).toBe(200);
    });

    it('role: VIEWER and OPERATOR 403 (after the 404 for unknown templates); unknown template 404; unknown fields and bad members 400; duplicate name 409', async () => {
      w = await tworld(make);
      const p = body(await preview(['ct_haeun'])).previewHash;
      for (const auth of [USERS.viewer, USERS.haeun]) {
        const r = await w.call(auth, 'PATCH', `/responder-templates/${T}`, { body: { members: ['ct_haeun'], previewHash: p }, headers: im(0) });
        expect([r.status, body(r).error.code]).toEqual([403, 'ROLE_REQUIRED']);
      }
      expect((await w.call(USERS.viewer, 'PATCH', '/responder-templates/rt_nope', { body: {}, headers: im(0) })).status).toBe(404);
      expect((await w.call(ADMIN, 'PATCH', '/responder-templates/rt_nope', { body: { members: ['ct_haeun'], previewHash: p }, headers: im(0) })).status).toBe(404);
      const patch = (b: unknown) => w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: b, headers: im(0) });
      expect((await patch({ members: ['ct_haeun'], previewHash: p, customerId: 'cus_mirae' })).status).toBe(400);
      expect((await patch({ members: ['ct_yuna'], previewHash: p })).status).toBe(400);
      expect((await patch({ members: [], previewHash: p })).status).toBe(400);
      expect((await patch({ previewHash: p })).status).toBe(400);
      expect((await patch({ members: ['ct_haeun'], previewHash: p })).status).toBe(200);
      await w.call(ADMIN, 'POST', '/responder-templates', { body: { name: 'Night', members: ['ct_haeun'] } });
      const q1 = body(await w.call(ADMIN, 'POST', `/responder-templates/${T}/preview`, { body: { name: 'Night' } })).previewHash;
      const dup = await w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: { name: 'Night', previewHash: q1 }, headers: im(1) });
      expect([dup.status, body(dup).error.code]).toEqual([409, 'ALREADY_EXISTS']);
    });

    it('tenant isolation: only the customers that use the template change; a customer person cannot be smuggled in; other customers\' lists and audit stay untouched', async () => {
      w = await tworld(make, (seed) => { seed.customerTemplate.delete('cus_hanbit'); });
      const before = JSON.stringify(await respondersOf('cus_hanbit'));
      expect((await save(['ct_haeun', 'ct_minjae'])).status).toBe(200);
      expect(JSON.stringify(await respondersOf('cus_hanbit'))).toBe(before);
      expect((await w.fx.audits()).filter((a) => a.customerId === 'cus_hanbit')).toHaveLength(0);
      expect(body(await preview(['ct_haeun'])).customers.map((c: any) => c.id)).toEqual(['cus_mirae']);
      // a customer's person id in members: the same 400 as an unknown id
      const p = body(await preview(['ct_haeun'])).previewHash;
      const r = await w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: { members: ['ct_haeun', 'ct_dohyun'], previewHash: p }, headers: im(1) });
      expect(r.status).toBe(400);
      expect(IDS((await respondersOf('cus_mirae')).people)).toEqual(['ct_seojun', 'ct_yuna']);
    });
  });

  // ───────────────────────────── D-64: attach / detach / switch and the blocking rules ─────────────────────────────

  const N = 'rt_night';
  /** A second template, a customer without a template ("Fresh Co"), and "Solo Co": only template people, ALL_RESPONDERS by SMS, so removing them cuts it off. */
  const d64 = (seed: MemoryApiStore): void => {
    seed.templates.set(N, { id: N, name: 'Night desk', version: 0, updatedBy: 'usr_haeun', updatedAt: new Date('2026-11-02T00:00:00Z'), members: ['ct_haeun', 'ct_minjae'] });
    seed.customers.set('cus_fresh', { id: 'cus_fresh', name: 'Fresh Co', slug: 'fresh' });
    seed.customers.set('cus_solo', { id: 'cus_solo', name: 'Solo Co', slug: 'solo' });
    seed.customerTemplate.set('cus_solo', T);
    const tpl = { source: 'TEMPLATE' as const, templateId: T, templateName: 'Infra core' };
    seed.responders.push({ customerId: 'cus_solo', contactId: 'ct_haeun', role: 'PAGEABLE', order: 0 }, { customerId: 'cus_solo', contactId: 'ct_junho', role: 'PAGEABLE', order: 1 });
    seed.responderSource.set('cus_solo|ct_haeun', tpl);
    seed.responderSource.set('cus_solo|ct_junho', tpl);
    seed.configs.push(config('cus_solo', [step(0, 0, 'ALL_RESPONDERS', null, ['SMS'])]));
    // Minjae has no verified phone: joining does not make Solo Co reachable
    seed.contacts.set('ct_minjae', { ...seed.contacts.get('ct_minjae')!, phoneVerifiedAt: null });
  };
  const cpath = (cid: string) => `/customers/${cid}/responders/template`;
  const cpreview = (cid: string, templateId: string | null, auth: AuthContext = ADMIN) => w.call(auth, 'POST', `${cpath(cid)}/preview`, { body: { templateId } });
  const put = async (cid: string, templateId: string | null, version?: number, extra: Record<string, unknown> = {}) => {
    const p = body(await cpreview(cid, templateId));
    return w.call(ADMIN, 'PUT', cpath(cid), { body: { templateId, previewHash: p.previewHash, ...extra }, headers: version === undefined ? {} : im(version) });
  };
  const rows = async (cid: string) => (await respondersOf(cid)).staff.map((s: any) => [s.contactId, s.source, s.templateId ?? null]).sort();

  describe('D-64 attach / detach / switch a customer\'s template', () => {
    it('attach: the template people join as TEMPLATE rows (appended), the Responders version +1, one customer audit row with ids only', async () => {
      w = await tworld(make, d64);
      const pr = await cpreview('cus_fresh', T);
      expect(pr.status).toBe(200);
      expect(body(pr)).toMatchObject({ customerId: 'cus_fresh', version: 0, from: null, to: { id: T, name: 'Infra core' }, totals: { joins: 2, leaves: 0, warnings: 0 }, blocking: [] });
      expect(body(pr).effects.map((e: any) => [e.kind, e.contactId])).toEqual([['JOINS', 'ct_haeun'], ['JOINS', 'ct_junho']]);
      expect((await w.fx.audits()).filter((a) => a.customerId === 'cus_fresh')).toHaveLength(0); // the preview wrote nothing
      const r = await put('cus_fresh', T, 0);
      expect(r.status).toBe(200);
      expect(r.headers.etag).toBe('"1"');
      expect(body(r)).toEqual({ customerId: 'cus_fresh', templateId: T, version: 1, joins: 2, leaves: 0 });
      expect(await rows('cus_fresh')).toEqual([['ct_haeun', 'TEMPLATE', T], ['ct_junho', 'TEMPLATE', T]]);
      const got = await respondersOf('cus_fresh');
      expect([got.templateId, got.version]).toEqual([T, 1]);
      expect(body(await w.call(ADMIN, 'GET', '/responder-templates'))[0].customers.map((c: any) => c.id)).toContain('cus_fresh');
      const a = (await w.fx.audits()).filter((x) => x.customerId === 'cus_fresh');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ action: 'responders.template.attach', actorId: 'usr_minjae', targetType: 'Responders', before: { templateId: null }, after: { templateId: T, added: ['ct_haeun', 'ct_junho'], removed: [] } });
      expect(JSON.stringify(a)).not.toContain('@example.test');
    });

    it('detach: only the rows of that template go; DIRECT rows stay (STAYS_DIRECT), other customers do not move', async () => {
      w = await tworld(make, d64);
      const others = JSON.stringify(await respondersOf('cus_mirae'));
      const pr = body(await cpreview('cus_hanbit', null));
      expect(pr).toMatchObject({ from: { id: T }, to: null, totals: { joins: 0, leaves: 1 } });
      expect(pr.effects.map((e: any) => [e.kind, e.contactId])).toEqual([['LEAVES', 'ct_haeun'], ['STAYS_DIRECT', 'ct_junho']]);
      const r = await put('cus_hanbit', null, 0);
      expect([r.status, body(r)]).toEqual([200, { customerId: 'cus_hanbit', templateId: null, version: 1, joins: 0, leaves: 1 }]);
      expect(await rows('cus_hanbit')).toEqual([['ct_junho', 'DIRECT', null], ['ct_minjae', 'DIRECT', null]]);
      expect((await respondersOf('cus_hanbit')).templateId).toBeNull();
      expect(JSON.stringify(await respondersOf('cus_mirae'))).toBe(others);
      expect((await w.fx.audits()).find((a) => a.action === 'responders.template.detach')).toMatchObject({ customerId: 'cus_hanbit', before: { templateId: T }, after: { templateId: null, added: [], removed: ['ct_haeun'] } });
      expect(body(await w.call(ADMIN, 'GET', '/responder-templates'))[0].customers.map((c: any) => c.id)).not.toContain('cus_hanbit');
    });

    it('attach over a DIRECT row: the person stays DIRECT (ALREADY_DIRECT) and no second row appears', async () => {
      w = await tworld(make, d64);
      await put('cus_hanbit', null, 0);
      const pr = body(await cpreview('cus_hanbit', N)); // Night = Haeun + Minjae; Minjae is a direct row
      expect(pr.effects.map((e: any) => [e.kind, e.contactId])).toEqual([['JOINS', 'ct_haeun'], ['ALREADY_DIRECT', 'ct_minjae']]);
      expect((await put('cus_hanbit', N, 1)).status).toBe(200);
      expect(await rows('cus_hanbit')).toEqual([['ct_haeun', 'TEMPLATE', N], ['ct_junho', 'DIRECT', null], ['ct_minjae', 'DIRECT', null]]);
    });

    it('switch = detach + attach in one write: people in both keep their row (moved to the new template), the others leave or join; STEP_NAMES warns', async () => {
      w = await tworld(make, d64);
      const pr = body(await cpreview('cus_mirae', N)); // from Infra core (Haeun, Junho) to Night (Haeun, Minjae)
      expect(pr).toMatchObject({ from: { id: T }, to: { id: N }, totals: { joins: 1, leaves: 1, warnings: 1 } });
      expect(pr.effects.map((e: any) => [e.kind, e.contactId, e.stepIndex])).toEqual([['JOINS', 'ct_minjae', undefined], ['LEAVES', 'ct_junho', undefined], ['STEP_NAMES', 'ct_junho', 1]]);
      const r = await put('cus_mirae', N, 0);
      expect([r.status, body(r).version]).toEqual([200, 1]);
      expect(await rows('cus_mirae')).toEqual([['ct_haeun', 'TEMPLATE', N], ['ct_minjae', 'TEMPLATE', N]]);
      expect((await respondersOf('cus_mirae')).people.map((p: any) => p.contactId).sort()).toEqual(['ct_seojun', 'ct_yuna']); // the customer's own people are untouched
      expect((await w.fx.audits()).find((a) => a.action === 'responders.template.switch')).toMatchObject({ customerId: 'cus_mirae', before: { templateId: T }, after: { templateId: N, added: ['ct_minjae'], removed: ['ct_junho'] } });
      // switching back works the same way
      expect((await put('cus_mirae', T, 1)).status).toBe(200);
      expect(await rows('cus_mirae')).toEqual([['ct_haeun', 'TEMPLATE', T], ['ct_junho', 'TEMPLATE', T]]);
    });

    it('same template again (or none to none) is a 200 without a write: no audit, no version', async () => {
      w = await tworld(make, d64);
      const n = (await w.fx.audits()).length;
      const same = await put('cus_mirae', T, 0);
      expect([same.status, body(same)]).toEqual([200, { customerId: 'cus_mirae', templateId: T, version: 0, joins: 0, leaves: 0 }]);
      const none = await put('cus_fresh', null, 0);
      expect([none.status, body(none).version]).toEqual([200, 0]);
      expect((await w.fx.audits()).length).toBe(n);
    });

    it('If-Match: missing 400, stale 409 VERSION_CONFLICT with currentVersion; previewHash: missing 400, another change\'s hash or a changed list 409 PREVIEW_STALE; nothing written', async () => {
      w = await tworld(make, d64);
      const p = body(await cpreview('cus_fresh', T)).previewHash;
      const call = (hash: unknown, headers: Record<string, string>) => w.call(ADMIN, 'PUT', cpath('cus_fresh'), { body: { templateId: T, previewHash: hash }, headers });
      expect((await call(p, {})).status).toBe(400);
      expect((await call(undefined, im(0))).status).toBe(400);
      expect((await call('nope', im(0))).status).toBe(400);
      const stale = await call(p, im(3));
      expect([stale.status, body(stale).error.code, body(stale).error.details.currentVersion]).toEqual([409, 'VERSION_CONFLICT', 0]);
      const other = await call(body(await cpreview('cus_fresh', N)).previewHash, im(0));
      expect([other.status, body(other).error.code]).toEqual([409, 'PREVIEW_STALE']);
      // preview, then the customer gets Junho as a direct row: what the save would do changed
      await w.call(ADMIN, 'POST', '/customers/cus_fresh/responders', { body: { contactId: 'ct_junho' }, headers: im(0) });
      const changed = await call(p, im(1));
      expect([changed.status, body(changed).error.code]).toEqual([409, 'PREVIEW_STALE']);
      expect((await respondersOf('cus_fresh')).templateId).toBeNull();
      expect((await w.fx.audits()).filter((a) => a.customerId === 'cus_fresh' && a.action.startsWith('responders.template'))).toHaveLength(0);
      expect((await put('cus_fresh', T, 1)).status).toBe(200); // a fresh preview goes through (Junho stays DIRECT)
      expect(await rows('cus_fresh')).toEqual([['ct_haeun', 'TEMPLATE', T], ['ct_junho', 'DIRECT', null]]);
    });

    it('TERMINATED customer: 409 CUSTOMER_TERMINATED on preview and save, nothing changes', async () => {
      w = await tworld(make, d64);
      const r = await cpreview('cus_old', null);
      expect([r.status, body(r).error.code]).toEqual([409, 'CUSTOMER_TERMINATED']);
      const s = await w.call(ADMIN, 'PUT', cpath('cus_old'), { body: { templateId: null, previewHash: 'a'.repeat(64) }, headers: im(0) });
      expect([s.status, body(s).error.code]).toEqual([409, 'CUSTOMER_TERMINATED']);
      expect((await w.fx.audits()).filter((a) => a.customerId === 'cus_old')).toHaveLength(0);
      expect((await respondersOf('cus_old')).templateId).toBe(T);
    });

    it('who may: portal 404, anonymous 401, narrowed staff 403 FORBIDDEN, VIEWER/OPERATOR 403 ROLE_REQUIRED (after the 404 for unknown customers); another tenant\'s portal user gets 404', async () => {
      w = await tworld(make, d64);
      for (const [method, path] of [['POST', `${cpath('cus_mirae')}/preview`], ['PUT', cpath('cus_mirae')]] as const) {
        const b = { templateId: null, previewHash: 'a'.repeat(64) };
        for (const auth of [USERS.yuna, USERS.dohyun]) expect((await w.call(auth, method, path, { body: b, headers: im(0) })).status).toBe(404);
        expect((await w.call(null, method, path, { body: b, headers: im(0) })).status).toBe(401);
        const narrowed = await w.call({ ...ADMIN, customerIds: ['cus_mirae'] }, method, path, { body: b, headers: im(0) });
        expect([narrowed.status, body(narrowed).error.code]).toEqual([403, 'FORBIDDEN']);
        for (const auth of [USERS.viewer, USERS.haeun]) {
          const r = await w.call(auth, method, path, { body: b, headers: im(0) });
          expect([r.status, body(r).error.code]).toEqual([403, 'ROLE_REQUIRED']);
          expect((await w.call(auth, method, path.replace('cus_mirae', 'cus_nope'), { body: b, headers: im(0) })).status).toBe(404);
        }
      }
      expect((await w.fx.audits()).filter((a) => a.action.startsWith('responders.template'))).toHaveLength(0);
      expect((await respondersOf('cus_mirae')).templateId).toBe(T);
    });

    it('body: templateId is required (null is a value), unknown template and unknown fields are 400, other tenants stay untouched', async () => {
      w = await tworld(make, d64);
      for (const b of [{}, { templateId: 5 }, { templateId: '' }, { templateId: 'rt_nope' }, { templateId: T, customerId: 'cus_hanbit' }, ['x']]) {
        expect((await w.call(ADMIN, 'POST', `${cpath('cus_fresh')}/preview`, { body: b })).status).toBe(400);
      }
      const before = JSON.stringify(await respondersOf('cus_hanbit'));
      const p = body(await cpreview('cus_fresh', T)).previewHash;
      expect((await w.call(ADMIN, 'PUT', cpath('cus_fresh'), { body: { templateId: T, previewHash: p, customerId: 'cus_hanbit' }, headers: im(0) })).status).toBe(400);
      expect((await put('cus_fresh', T, 0)).status).toBe(200);
      expect(JSON.stringify(await respondersOf('cus_hanbit'))).toBe(before);
      expect((await w.fx.audits()).filter((a) => a.action.startsWith('responders.template')).every((a) => a.customerId === 'cus_fresh')).toBe(true);
    });
  });

  describe('D-64 changes that cut a customer off are refused (no override)', () => {
    const patchBody = async (members: string[]) => ({ members, previewHash: body(await preview(members)).previewHash });

    it('the PATCH preview reports it in blocking; the PATCH is 409 WOULD_BE_UNREACHABLE with the customer ids, even with ?confirmUnreachable=true; nothing is written', async () => {
      w = await tworld(make, d64);
      const pr = body(await preview(['ct_minjae'])); // everybody leaves, Minjae (unverified phone) joins
      expect(pr.blocking).toEqual([{ customerId: 'cus_solo', reason: 'UNREACHABLE' }]); // Mirae and Hanbit have no call order yet: already UNREACHABLE, not made so
      expect(body(await preview(['ct_haeun', 'ct_junho', 'ct_minjae'])).blocking).toEqual([]);
      for (const query of [undefined, { confirmUnreachable: 'true' }]) {
        const r = await w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: await patchBody(['ct_minjae']), headers: im(0), query });
        expect([r.status, body(r).error.code, body(r).error.details.customerIds]).toEqual([409, 'WOULD_BE_UNREACHABLE', ['cus_solo']]);
      }
      expect(IDS((await respondersOf('cus_solo')).staff)).toEqual(['ct_haeun', 'ct_junho']);
      expect(body(await w.call(ADMIN, 'GET', '/responder-templates'))[0].version).toBe(0);
      expect((await w.fx.audits()).filter((a) => a.targetType === 'ResponderTemplate')).toHaveLength(0);
      // a change that leaves a reachable person is fine
      const fine = await w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: await patchBody(['ct_haeun', 'ct_minjae']), headers: im(0) });
      expect(fine.status).toBe(200);
    });

    it('detach is refused the same way; a switch that keeps a reachable person is allowed', async () => {
      w = await tworld(make, d64);
      expect(body(await cpreview('cus_solo', null)).blocking).toEqual([{ customerId: 'cus_solo', reason: 'UNREACHABLE' }]);
      const detach = await put('cus_solo', null, 0);
      expect([detach.status, body(detach).error.code, body(detach).error.details.customerIds]).toEqual([409, 'WOULD_BE_UNREACHABLE', ['cus_solo']]);
      const sw = await put('cus_solo', N, 0); // Night = Haeun (stays) + Minjae: Haeun keeps the line open
      expect(sw.status).toBe(200);
      expect((await respondersOf('cus_solo')).templateId).toBe(N);
    });

    it('switch to a template whose people cannot be reached is refused and writes nothing', async () => {
      w = await tworld(make, (seed) => { d64(seed); seed.templates.set('rt_minjae', { id: 'rt_minjae', name: 'Only Minjae', version: 0, updatedBy: null, updatedAt: new Date('2026-11-03T00:00:00Z'), members: ['ct_minjae'] }); });
      expect(body(await cpreview('cus_solo', 'rt_minjae')).blocking).toEqual([{ customerId: 'cus_solo', reason: 'UNREACHABLE' }]);
      const r = await put('cus_solo', 'rt_minjae', 0);
      expect([r.status, body(r).error.code]).toEqual([409, 'WOULD_BE_UNREACHABLE']);
      expect(await rows('cus_solo')).toEqual([['ct_haeun', 'TEMPLATE', T], ['ct_junho', 'TEMPLATE', T]]);
      expect((await respondersOf('cus_solo')).version).toBe(0);
      expect((await w.fx.audits()).filter((a) => a.customerId === 'cus_solo')).toHaveLength(0);
    });

    it('D-38: a change that newly pushes ALL_RESPONDERS over 20 people is refused 422 RESPONDER_LIMIT_EXCEEDED (also in blocking)', async () => {
      const crowd = Array.from({ length: 21 }, (_, i) => `ct_crowd${i}`);
      w = await tworld(make, (seed) => {
        d64(seed);
        for (const id of crowd) seed.contacts.set(id, { ...seed.contacts.get('ct_haeun')!, id, name: `Crowd ${id}`, email: `${id}@example.test`, phone: '+821000000099', slackUserId: `U_${id}` });
        seed.templates.set('rt_crowd', { id: 'rt_crowd', name: 'Crowd', version: 0, updatedBy: null, updatedAt: new Date('2026-11-03T00:00:00Z'), members: crowd });
        seed.configs.push(config('cus_fresh', [step(0, 0, 'ALL_RESPONDERS', null, ['SMS'])]));
        seed.responders.push({ customerId: 'cus_fresh', contactId: 'ct_haeun', role: 'PAGEABLE', order: 0 });
      });
      expect(body(await cpreview('cus_fresh', 'rt_crowd')).blocking).toEqual([{ customerId: 'cus_fresh', reason: 'RESPONDER_LIMIT_EXCEEDED' }]);
      const r = await put('cus_fresh', 'rt_crowd', 0);
      expect([r.status, body(r).error.code, body(r).error.details.customerIds]).toEqual([422, 'RESPONDER_LIMIT_EXCEEDED', ['cus_fresh']]);
      expect(IDS((await respondersOf('cus_fresh')).staff)).toEqual(['ct_haeun']);
    });

    it('a busy database (deadlock, serialization failure) is a retryable 503 BUSY with Retry-After, on PATCH and on attach/detach', async () => {
      w = await tworld(make, d64);
      const a = await put('cus_fresh', T, 0);
      const p = await save(['ct_haeun']);
      expect([a.status, p.status]).toEqual([200, 200]); // sanity: both work before the stores report "busy"
      const repo = w.fx.repo as unknown as { setCustomerTemplate: () => Promise<unknown>; updateResponderTemplate: () => Promise<unknown> };
      repo.setCustomerTemplate = async () => 'BUSY';
      repo.updateResponderTemplate = async () => 'BUSY';
      const a2 = await put('cus_hanbit', null, 0);
      const p2 = await w.call(ADMIN, 'PATCH', `/responder-templates/${T}`, { body: { members: ['ct_haeun', 'ct_minjae'], previewHash: body(await preview(['ct_haeun', 'ct_minjae'])).previewHash }, headers: im(1) });
      for (const r of [a2, p2]) expect([r.status, body(r).error.code, r.headers['retry-after']]).toEqual([503, 'BUSY', '1']);
    });
  });
}
