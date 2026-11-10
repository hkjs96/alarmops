import { describe, expect, it } from 'vitest';
import { USERS, at, body, closedGroup, world } from './helpers.js';

const std = { style: 'SHARED_ROTATION', plan: 'STANDARD', sharedRotationId: 'rot_night', repeatCount: 1 };

describe('GET/PUT /customers/{id}/paging (D-30, If-Match)', () => {
  it('GET: the customer’s own steps, sentence with real names, overrides; ADMIN only', async () => {
    const w = await world();
    const r = await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/paging');
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe('"1"');
    expect(body(r)).toMatchObject({
      id: 'pc_cus_mirae_CUSTOMER', customerId: 'cus_mirae', scopeType: 'CUSTOMER', scopeId: 'cus_mirae', style: 'SHARED_ROTATION', plan: 'STANDARD', edited: false, sharedRotationId: 'rot_night',
      repeatCount: 1, version: 1, overrides: [],
      sentence: 'Immediately, Slack Haeun Kim. At 2 min, SMS Haeun Kim. At 7 min, call Haeun Kim. At 12 min, call Haeun Kim, Junho Park and Yuna Seo. Then repeat once.',
    });
    expect(body(r).steps[3]).toEqual({ atMin: 12, targetType: 'ALL_RESPONDERS', channels: ['VOICE'] });
    for (const who of [USERS.haeun, USERS.viewer, USERS.yuna]) expect(body(await w.call(who, 'GET', '/customers/cus_mirae/paging')).error.code).toBe('ROLE_REQUIRED');
  });

  it('PUT needs If-Match; a stale version is 409 and nothing is saved; a current one bumps the version', async () => {
    const w = await world();
    const steps = [{ atMin: 0, targetType: 'ROTATION', targetId: 'rot_night', channels: ['SLACK_DM'] }, { atMin: 10, targetType: 'PERSON', targetId: 'ct_yuna', channels: ['VOICE'] }];
    const input = { style: 'CUSTOM', plan: 'STANDARD', steps, repeatCount: 2 };
    expect((await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { body: input })).status).toBe(400);
    const stale = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { body: input, headers: { 'If-Match': '7' } });
    expect(stale.status).toBe(409);
    expect(body(stale).error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 1 } });
    expect(w.store.configs.find((c) => c.customerId === 'cus_mirae')!.steps).toHaveLength(4);

    const okRes = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { body: input, headers: { 'If-Match': '1' } });
    expect(okRes.status).toBe(200);
    expect(body(okRes)).toMatchObject({ version: 2, edited: true, style: 'CUSTOM', repeatCount: 2, steps,
      sentence: 'Immediately, Slack DM Haeun Kim. At 10 min, call Yuna Seo. Then repeat 2 times.' });
    expect(w.store.audits.at(-1)).toMatchObject({ action: 'paging.update', actorId: 'usr_minjae', customerId: 'cus_mirae', targetType: 'PagingConfig' });
    // the second editor who started from version 1 loses, visibly (§8.8)
    expect((await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { body: input, headers: { 'If-Match': '1' } })).status).toBe(409);
    for (const who of [USERS.haeun, USERS.yuna]) expect((await w.call(who, 'PUT', '/customers/cus_mirae/paging', { body: input, headers: { 'If-Match': '2' } })).status).toBe(403);
  });

  it('a saved change applies to incidents opened afterwards; an open incident keeps its frozen order (R3-1)', async () => {
    const w = await world();
    await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': '1' }, body: { style: 'ALL_AT_ONCE', plan: 'URGENT', repeatCount: 0 } });
    await w.sim.run(3);
    expect(w.sim.timeline(w.ids.mirae)).toEqual(['0 SLACK_BOT scope', '2 SMS Haeun Kim']);
    w.sim.now = at(3);
    closedGroup(w.store, { customerId: 'cus_mirae', severity: 'SEV_1', at: at(4), alerts: [{ id: 'al_new' }] });
    await w.sim.run(4);
    const fresh = [...w.store.incidents.values()].find((i) => i.severity === 'SEV_1')!;
    expect(w.sim.timeline(fresh.id)).toEqual(['4 VOICE Haeun Kim', '4 VOICE Junho Park', '4 VOICE Yuna Seo']);
  });

  it('sending only the plan rebuilds the steps from the template (edited=false); editing them marks edited', async () => {
    const w = await world();
    const quiet = body(await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': '1' }, body: { ...std, plan: 'QUIET' } }));
    expect(quiet).toMatchObject({ plan: 'QUIET', edited: false, version: 2 });
    expect(quiet.steps).toEqual([{ atMin: 0, targetType: 'ROTATION', targetId: 'rot_night', channels: ['SLACK_CHANNEL'] }, { atMin: 15, targetType: 'ALL_RESPONDERS', channels: ['SLACK_CHANNEL'] }]);
    const same = body(await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': '2' }, body: { ...std, plan: 'QUIET', steps: quiet.steps } }));
    expect(same.edited).toBe(false);
    const changed = body(await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': '3' }, body: { ...std, plan: 'QUIET', steps: [{ ...quiet.steps[0], atMin: 1 }, quiet.steps[1]] } }));
    expect(changed.edited).toBe(true);
    const all = body(await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': '4' }, body: { style: 'ALL_AT_ONCE', plan: 'URGENT' } }));
    expect(all).toMatchObject({ repeatCount: 1, steps: [{ atMin: 0, targetType: 'ALL_RESPONDERS', channels: ['VOICE'] }] }); // D-20 default
    const own = body(await w.call(USERS.minjae, 'PUT', '/customers/cus_hanbit/paging', { headers: { 'If-Match': '1' }, body: { style: 'CUSTOMER_ROTATION', plan: 'STANDARD' } }));
    expect(own.steps[0]).toMatchObject({ targetType: 'ROTATION', targetId: 'rot_hanbit' });
  });

  it('tenant rules for step targets: another customer’s person or rotation → 422 CROSS_CUSTOMER, notify-only → 422 NOT_PAGEABLE', async () => {
    const w = await world();
    const put = (steps: unknown[]) => w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': '1' }, body: { style: 'CUSTOM', plan: 'STANDARD', steps, repeatCount: 1 } });
    const one = (targetType: string, targetId?: string) => [{ atMin: 0, targetType, ...(targetId ? { targetId } : {}), channels: ['SMS'] }];
    const cross = await put(one('PERSON', 'ct_dohyun'));
    expect([cross.status, body(cross).error.code]).toEqual([422, 'CROSS_CUSTOMER']);
    expect(JSON.stringify(cross.body)).not.toMatch(/Dohyun|hanbit/i); // the error does not describe the other tenant's person
    const rot = await put(one('ROTATION', 'rot_hanbit'));
    expect([rot.status, body(rot).error.code]).toEqual([422, 'CROSS_CUSTOMER']);
    const notify = await put(one('PERSON', 'ct_seojun'));
    expect([notify.status, body(notify).error.code]).toEqual([422, 'NOT_PAGEABLE']);
    expect((await put(one('PERSON', 'ct_nope'))).status).toBe(400);
    expect((await put(one('ROTATION', 'rot_nope'))).status).toBe(400);
    expect((await put(one('PERSON', 'ct_yuna'))).status).toBe(200); // own customer person, pageable
    expect(w.store.configs.filter((c) => c.customerId === 'cus_mirae')).toHaveLength(1);
  });

  it('validation: step shape, order, channels, repeatCount', async () => {
    const w = await world();
    const fields = async (b: object) => {
      const r = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': '1' }, body: { style: 'CUSTOM', plan: 'STANDARD', repeatCount: 1, ...b } });
      expect(r.status).toBe(400);
      return body(r).error.details.fields.map((f: any) => f.field);
    };
    const s = (o: object) => ({ atMin: 0, targetType: 'ALL_RESPONDERS', channels: ['SMS'], ...o });
    expect(await fields({ style: 'TEAM' })).toEqual(['style']);
    expect(await fields({ repeatCount: 9, steps: [s({})] })).toEqual(['repeatCount']);
    expect(await fields({ steps: [] })).toEqual(['steps']);
    expect(await fields({})).toEqual(['steps']); // custom steps cannot be generated
    expect(await fields({ steps: [s({ atMin: 5 }), s({ atMin: 2 })] })).toEqual(['steps[1].atMin']);
    expect(await fields({ steps: [s({ channels: ['PAGER'] })] })).toEqual(['steps[0].channels']);
    expect(await fields({ steps: [s({ channels: [] })] })).toEqual(['steps[0].channels']);
    expect(await fields({ steps: [s({ targetType: 'TEAM' })] })).toEqual(['steps[0].targetType']);
    expect(await fields({ steps: [s({ targetType: 'PERSON' })] })).toEqual(['steps[0].targetId']);
    expect(await fields({ steps: [s({ targetId: 'ct_haeun' })] })).toEqual(['steps[0].targetId']);
    expect(await fields({ steps: [s({ atMin: -1 })] })).toEqual(['steps[0].atMin']);
  });

  it('a customer without steps: GET says version 0 and "nobody is paged"; the first PUT creates with If-Match 0', async () => {
    const w = await world();
    w.store.configs.splice(0);
    const g = body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/paging'));
    expect(g).toMatchObject({ id: null, version: 0, steps: [], sentence: 'Nobody is paged: no paging steps are configured.' });
    expect((await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': '3' }, body: std })).status).toBe(409);
    const created = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': '0' }, body: std });
    expect(created.status).toBe(201);
    expect(body(created)).toMatchObject({ version: 1, edited: false });
    expect((await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': '0' }, body: std })).status).toBe(409);
  });
});

describe('paging overrides (service › project › customer, first existing wins)', () => {
  const svcSteps = { style: 'CUSTOM', plan: 'URGENT', repeatCount: 0, steps: [{ atMin: 0, targetType: 'PERSON', targetId: 'ct_yuna', channels: ['VOICE'] }] };

  it('PUT creates the override, the tree shows ownSteps, new incidents of that service use it, DELETE goes back to inheriting', async () => {
    const w = await world();
    const path = '/customers/cus_mirae/paging-overrides/SERVICE/svc_pay';
    const created = await w.call(USERS.minjae, 'PUT', path, { headers: { 'If-Match': '0' }, body: svcSteps });
    expect(created.status).toBe(201);
    expect(body(created)).toMatchObject({ scopeType: 'SERVICE', scopeId: 'svc_pay', version: 1, sentence: 'Immediately, call Yuna Seo.' });
    const tree = body(await w.call(USERS.haeun, 'GET', '/scope-tree')).customers.find((c: any) => c.slug === 'mirae');
    expect(tree.projects[0].services[0].ownSteps).toBe(true);
    expect(tree.projects[0].ownSteps).toBe(false);
    expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/paging')).overrides).toEqual([expect.objectContaining({ scopeType: 'SERVICE', scopeId: 'svc_pay', name: 'Payments API', version: 1 })]);

    closedGroup(w.store, { customerId: 'cus_mirae', severity: 'SEV_1', at: at(1), alerts: [{ id: 'al_new' }] });
    await w.sim.run(1);
    const fresh = [...w.store.incidents.values()].find((i) => i.severity === 'SEV_1')!;
    expect(fresh.assignmentSnapshot).toMatchObject({ level: 'SERVICE', pagingConfigId: 'pc_service_svc_pay' });
    expect(w.sim.timeline(fresh.id)).toEqual(['1 VOICE Yuna Seo']);

    expect((await w.call(USERS.minjae, 'DELETE', path)).status).toBe(400);
    expect((await w.call(USERS.minjae, 'DELETE', path, { headers: { 'If-Match': '9' } })).status).toBe(409);
    expect((await w.call(USERS.haeun, 'DELETE', path, { headers: { 'If-Match': '1' } })).status).toBe(403);
    expect((await w.call(USERS.minjae, 'DELETE', path, { headers: { 'If-Match': '1' } })).status).toBe(200);
    expect(body(await w.call(USERS.minjae, 'GET', '/oncall/paging-path', { query: { serviceId: 'svc_pay' } }))).toMatchObject({ own: false, inheritedFrom: { level: 'CUSTOMER', id: 'cus_mirae' } });
    expect((await w.call(USERS.minjae, 'DELETE', path, { headers: { 'If-Match': '1' } })).status).toBe(404);
  });

  it('the project/service must belong to the customer in the path: another customer’s id is the same 404 as a made-up one', async () => {
    const w = await world();
    const a = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging-overrides/SERVICE/svc_web', { headers: { 'If-Match': '0' }, body: svcSteps, requestId: 'r' });
    const b = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging-overrides/SERVICE/svc_nope', { headers: { 'If-Match': '0' }, body: svcSteps, requestId: 'r' });
    expect(a.status).toBe(404);
    expect(a).toEqual(b);
    expect((await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging-overrides/ACCOUNT/x', { headers: { 'If-Match': '0' }, body: svcSteps })).status).toBe(400);
    expect(w.store.configs).toHaveLength(2);
  });
});

describe('GET /oncall/paging-path — "who gets paged for…" (same function as the tick)', () => {
  it('by serviceId: path, the level the steps come from, who each step reaches now, notify-only people', async () => {
    const w = await world();
    const r = body(await w.call(USERS.viewer, 'GET', '/oncall/paging-path', { query: { serviceId: 'svc_pay' } }));
    expect(r).toMatchObject({
      path: [{ level: 'SERVICE', id: 'svc_pay', name: 'Payments API' }, { level: 'PROJECT', id: 'prj_core', name: 'Core' }, { level: 'CUSTOMER', id: 'cus_mirae', name: 'Mirae Pay' }],
      customer: { id: 'cus_mirae', name: 'Mirae Pay' }, inheritedFrom: { level: 'CUSTOMER', id: 'cus_mirae', name: 'Mirae Pay' }, own: false,
      style: 'SHARED_ROTATION', plan: 'STANDARD', edited: false, pagingConfigId: 'pc_cus_mirae_CUSTOMER', version: 1, sharedRotationId: 'rot_night', repeatCount: 1, stopAtMin: 12,
      customerNotified: [{ contactId: 'ct_seojun', name: 'Seojun Bae', scope: { level: 'SERVICE', id: 'svc_pay', name: 'Payments API' } }],
    });
    expect(r.steps[0]).toEqual({ atMin: 0, targetType: 'ROTATION', targetId: 'rot_night', nowIds: ['ct_haeun'], names: ['Haeun Kim'], channels: ['SLACK_CHANNEL'], targetName: 'MSP night desk' });
    expect(r.steps[3].names).toEqual(['Haeun Kim', 'Junho Park', 'Yuna Seo']);
    // what the path says is what the tick froze for the incident opened at the same time
    const snap = w.store.incidents.get(w.ids.mirae)!.assignmentSnapshot!;
    expect(r.steps.map((s: any) => s.nowIds)).toEqual(snap.steps.map((s) => s.resolved.map((p) => p.contactId)));
  });

  it('by slugs (customer / project / service), by resource, by name search', async () => {
    const w = await world();
    const get = async (query: Record<string, string>) => body(await w.call(USERS.haeun, 'GET', '/oncall/paging-path', { query }));
    expect((await get({ customer: 'mirae' })).path.map((p: any) => p.level)).toEqual(['CUSTOMER']);
    expect(await get({ customer: 'mirae' })).toMatchObject({ own: true });
    expect((await get({ customer: 'mirae', project: 'data-platform' })).path.map((p: any) => p.level)).toEqual(['PROJECT', 'CUSTOMER']);
    expect((await get({ customer: 'hanbit', project: 'shop', service: 'web' })).steps[0]).toMatchObject({ targetName: 'Hanbit on-call', names: ['Dohyun Han'] });
    expect((await get({ resourceId: 'res_web1' })).path[0]).toEqual({ level: 'RESOURCE', id: 'res_web1', name: 'web-1' });
    expect((await get({ q: 'pay' })).path[0]).toMatchObject({ level: 'SERVICE', id: 'svc_pay' });
    const many = await get({ q: '' + 'sh' });
    expect(many.path[0]).toMatchObject({ level: 'PROJECT', id: 'prj_shop' });
    expect((await get({ q: 'zzz' })).candidates).toEqual([]);
    w.store.services.set('svc_pay2', { id: 'svc_pay2', customerId: 'cus_hanbit', projectId: 'prj_shop', name: 'Payments gateway', slug: 'payments-gateway' });
    expect((await get({ q: 'Pay' })).candidates.map((c: any) => [c.level, c.id, c.customer.name])).toEqual([['SERVICE', 'svc_pay', 'Mirae Pay'], ['SERVICE', 'svc_pay2', 'Hanbit Retail']]);
    expect((await w.call(USERS.haeun, 'GET', '/oncall/paging-path')).status).toBe(400);
    expect((await w.call(USERS.haeun, 'GET', '/oncall/paging-path', { query: { project: 'core' } })).status).toBe(400);
  });

  it('search candidates stay inside the caller’s customers', async () => {
    const w = await world();
    w.store.services.set('svc_pay2', { id: 'svc_pay2', customerId: 'cus_hanbit', projectId: 'prj_shop', name: 'Payments gateway', slug: 'payments-gateway' });
    const r = body(await w.call(USERS.yuna, 'GET', '/oncall/paging-path', { query: { q: 'pay' } }));
    expect(r.path[0]).toMatchObject({ id: 'svc_pay' }); // one match for her: the other customer's service is not a candidate
    expect(body(await w.call(USERS.yuna, 'GET', '/oncall/paging-path', { query: { q: 'shop' } })).candidates).toEqual([]);
  });

  it('known-bugs 7-3 / 7-5: nothing configured up the chain is "nobody is paged", never "inherited"', async () => {
    const w = await world();
    w.store.configs.splice(0);
    const r = body(await w.call(USERS.haeun, 'GET', '/oncall/paging-path', { query: { serviceId: 'svc_pay' } }));
    expect(r).toMatchObject({ inheritedFrom: null, own: false, pagingConfigId: null, steps: [], warning: 'NO_CALL_ORDER', sentence: 'Nobody is paged: no call order is configured for this customer.' });
    // a step that reaches nobody is flagged too
    w.store.configs.push({ id: 'pc_x', customerId: 'cus_mirae', scopeType: 'CUSTOMER', scopeId: 'cus_mirae', style: 'CUSTOM', plan: 'STANDARD', edited: true, repeatCount: 1, version: 1,
      steps: [{ index: 0, atMin: 0, targetType: 'ROTATION', targetId: 'rot_night', channels: ['SMS'] }] });
    w.store.rotations.get('rot_night')!.members = [];
    expect(body(await w.call(USERS.haeun, 'GET', '/oncall/paging-path', { query: { serviceId: 'svc_pay' } }))).toMatchObject({ warning: 'NOBODY_REACHABLE', sentence: 'Immediately, SMS nobody (no reachable responder). Then repeat once.' });
  });
});
