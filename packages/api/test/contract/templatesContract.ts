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
}
