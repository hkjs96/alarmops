/**
 * Regression tests for the security review of feat/tick-escalation — API side
 * (B-1, R-1 PUT caps, R-4…R-8, Q-1 portal serializer, N-3). The engine side is in packages/core/test/security-review.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { MAX_ALL_RESPONDERS, MAX_SENDS_PER_CYCLE, MAX_SENDS_PER_HOUR, PORTAL_SHOWS_STAFF_NAMES } from '@alarmops/core';
import { ApiError, requireRole, serializerFor, type ApiResponse, type AuthContext } from '../src/index.js';
import { USERS, at, body, closedGroup, version, wire, world, type World } from './helpers.js';

const strip = (r: ApiResponse): string => wire({ ...r, body: (r.body as any)?.error ? { error: { ...(r.body as any).error, requestId: '' } } : r.body });
const V = new Date('2026-10-01T00:00:00Z');
const addStaff = (w: World, customerId: string, n: number) => {
  for (let i = 0; i < n; i++) {
    w.store.contacts.set(`ct_s${i}`, { id: `ct_s${i}`, kind: 'INTERNAL', customerId: null, name: `Staff ${i}`, active: true, phone: `+8210555000${i}`, phoneVerifiedAt: V });
    w.store.responders.push({ customerId, contactId: `ct_s${i}`, role: 'PAGEABLE' });
  }
};
const cfgVersion = (w: World, customerId: string) => String(w.store.configs.find((c) => c.customerId === customerId && c.scopeType === 'CUSTOMER')!.version);

describe('B-1: role resolution fails closed', () => {
  it('a kind this code does not know is not a session: 401 everywhere, whatever role is stored', async () => {
    const w = await world();
    for (const kind of ['PORTAL', 'customer', '', undefined, null, 1]) {
      const who = { userId: 'usr_x', kind, customerIds: ['cus_mirae'], role: 'ADMIN' } as unknown as AuthContext;
      for (const [m, p] of [['GET', '/scope-tree'], ['GET', `/incidents/${w.ids.mirae}`], ['POST', `/incidents/${w.ids.mirae}/ack`], ['GET', '/customers/cus_mirae/paging'], ['PUT', '/customers/cus_mirae/paging']] as const) {
        const r = await w.call(who, m, p, { headers: { 'If-Match': '1' }, body: {} });
        expect(r.status, `${String(kind)} ${m} ${p}`).toBe(401);
        expect(body(r).error.code).toBe('UNAUTHENTICATED');
      }
    }
    expect(w.store.incidents.get(w.ids.mirae)!.status).toBe('TRIGGERED');
    expect(w.store.audits).toHaveLength(0);
  });

  it('requireRole itself: only INTERNAL carries its stored role; anything else is VIEWER', () => {
    const base = { userId: 'u', customerIds: ['cus_mirae'], role: 'ADMIN' };
    expect(() => requireRole({ ...base, kind: 'INTERNAL' } as AuthContext, 'ADMIN')).not.toThrow();
    for (const kind of ['CUSTOMER', 'PORTAL', undefined]) {
      expect(() => requireRole({ ...base, kind } as unknown as AuthContext, 'OPERATOR'), String(kind)).toThrow(ApiError);
      expect(() => requireRole({ ...base, kind } as unknown as AuthContext, 'VIEWER')).not.toThrow();
    }
    // a role that is not a role (incl. inherited object keys) is no role
    for (const role of ['constructor', 'toString', 'admin', undefined]) expect(() => requireRole({ ...base, kind: 'INTERNAL', role } as unknown as AuthContext, 'VIEWER'), String(role)).toThrow(ApiError);
    // and the serializer picks the internal view for INTERNAL only
    expect(serializerFor({ kind: 'INTERNAL' }).internal).toBe(true);
    for (const kind of ['CUSTOMER', 'PORTAL', undefined]) expect(serializerFor({ kind } as never).internal).toBe(false);
  });

  it('the AuthContext shape is checked at the router: malformed userId, customerIds or subScopes → 401', async () => {
    const w = await world();
    const bad: unknown[] = [
      { ...USERS.haeun, userId: '' }, { ...USERS.haeun, userId: 7 }, { ...USERS.haeun, customerIds: 'cus_mirae' }, { ...USERS.haeun, customerIds: [1] }, { ...USERS.haeun, customerIds: undefined },
      { ...USERS.haeun, subScopes: 'x' }, { ...USERS.haeun, subScopes: [{ projectId: 'prj_core' }] }, { ...USERS.haeun, subScopes: [{ customerId: 'cus_mirae', serviceId: 5 }] }, { ...USERS.haeun, name: {} }, 'usr_haeun', [],
    ];
    for (const auth of bad) expect((await w.call(auth as AuthContext, 'GET', '/incidents')).status, JSON.stringify(auth)).toBe(401);
    // a missing role is still a session: reads work, writes are 403
    const noRole = { ...USERS.haeun, role: undefined } as unknown as AuthContext;
    expect((await w.call(noRole, 'GET', '/incidents')).status).toBe(200);
    expect((await w.call(noRole, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': '1' } })).status).toBe(403);
  });
});

describe('R-1: PUT /customers/{id}/paging refuses call orders that send too much', () => {
  const everyChannel = ['SLACK_CHANNEL', 'SLACK_DM', 'SMS', 'VOICE', 'EMAIL'];
  const put = (w: World, steps: unknown[], repeatCount: number) =>
    w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': cfgVersion(w, 'cus_mirae') }, body: { style: 'CUSTOM', plan: 'STANDARD', steps, repeatCount } });

  it('the review’s reproduction (33 responders × 5 channels × 12 steps at minute 0 × 5 repeats) is rejected and nothing is saved', async () => {
    const w = await world();
    addStaff(w, 'cus_mirae', 30);
    const before = structuredClone(w.store.configs);
    const r = await put(w, Array.from({ length: 12 }, () => ({ atMin: 0, targetType: 'ALL_RESPONDERS', channels: everyChannel })), 5);
    expect(r.status).toBe(400); // twelve steps at the same minute
    expect(body(r).error.details.fields[0]).toEqual({ field: 'steps[1].atMin', message: 'Each step must start later than the step before it.' });
    const spaced = await put(w, Array.from({ length: 12 }, (_, i) => ({ atMin: i, targetType: 'ALL_RESPONDERS', channels: everyChannel })), 5);
    expect(spaced.status).toBe(422);
    expect(body(spaced).error).toMatchObject({ code: 'RESPONDER_LIMIT_EXCEEDED', details: { responders: 33, limit: MAX_ALL_RESPONDERS, field: 'steps[0].targetType' } });
    expect(body(spaced).error.message).toContain('at most 20 people');
    expect(w.store.configs).toEqual(before);
    expect(w.store.audits).toHaveLength(0);
  });

  it('per cycle and per hour caps, with the numbers in the error', async () => {
    const w = await world(); // Mirae has 3 pageable responders
    const perCycle = await put(w, Array.from({ length: 12 }, (_, i) => ({ atMin: i * 10, targetType: 'ALL_RESPONDERS', channels: everyChannel })), 0);
    expect(perCycle.status).toBe(422);
    expect(body(perCycle).error).toMatchObject({ code: 'SEND_CAP_EXCEEDED', details: { perCycle: 156, limits: { perCycle: MAX_SENDS_PER_CYCLE, perHour: MAX_SENDS_PER_HOUR } } });
    expect(body(perCycle).error.message).toBe('This call order would send 156 notifications per incident in one pass of the steps (limit 60). Use fewer steps, channels or repeats, or page fewer people per step.');
    // one pass is fine (36) but five quick repeats are not (180 in an hour)
    const tight = Array.from({ length: 12 }, (_, i) => ({ atMin: i, targetType: 'PERSON', targetId: 'ct_haeun', channels: ['SMS', 'VOICE', 'EMAIL'] }));
    const perHour = await put(w, tight, 5);
    expect(body(perHour).error).toMatchObject({ code: 'SEND_CAP_EXCEEDED', details: { perCycle: 36, perHour: 180 } });
    expect(body(perHour).error.message).toContain('180 notifications per incident within one hour, repeats included (limit 120)');
    expect((await put(w, tight, 1)).status).toBe(200); // 72 in the hour
  });

  it('every template the console offers stays inside the caps with the largest allowed Responders group', async () => {
    const w = await world();
    addStaff(w, 'cus_mirae', MAX_ALL_RESPONDERS - 3);
    for (const [style, extra] of [['ALL_AT_ONCE', {}], ['SHARED_ROTATION', { sharedRotationId: 'rot_night' }]] as const) {
      for (const plan of ['STANDARD', 'URGENT', 'QUIET']) {
        const r = await w.call(USERS.minjae, 'PUT', '/customers/cus_mirae/paging', { headers: { 'If-Match': cfgVersion(w, 'cus_mirae') }, body: { style, plan, ...extra } });
        expect(r.status, `${style} ${plan}`).toBe(200);
      }
    }
  });
});

describe('R-5: Idempotency-Key replays only the same request for the same, current authorization', () => {
  it('after the caller’s range or role changed, nothing is replayed: the request is authorised again', async () => {
    const w = await world();
    const opts = { headers: { 'If-Match': '1', 'Idempotency-Key': 'k1' } };
    const first = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, opts);
    expect(first.status).toBe(200);
    const withoutToken = (r: typeof first) => { const { undoToken: _t, ...rest } = body(r); return { ...r, body: rest }; }; // R-7 (review SQL): never stored, so not replayed
    expect(await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, opts)).toEqual(withoutToken(first));
    // same user id, now a portal viewer of another customer
    const moved: AuthContext = { ...USERS.haeun, kind: 'CUSTOMER', customerIds: ['cus_hanbit'], role: 'VIEWER' };
    const r = await w.call(moved, 'POST', `/incidents/${w.ids.mirae}/ack`, opts);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/undoToken|payments/);
    // same range, role lowered
    expect((await w.call({ ...USERS.haeun, role: 'VIEWER' }, 'POST', `/incidents/${w.ids.mirae}/ack`, opts)).status).toBe(403);
    // narrowed to a project the incident is not in
    expect((await w.call({ ...USERS.haeun, subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_data' }] }, 'POST', `/incidents/${w.ids.mirae}/ack`, opts)).status).toBe(404);
    expect(w.store.audits.filter((a) => a.action === 'incident.ack')).toHaveLength(1);
  });

  it('the key is bound to method + path + If-Match + body: reuse for another request is 422 and does not run', async () => {
    const w = await world();
    const k = { 'Idempotency-Key': 'kb' };
    // (a preview is never stored — N-19 — so the binding is shown with two real requests)
    const preview = await w.call(USERS.haeun, 'POST', '/incidents/bulk', { headers: k, body: { action: 'resolve', preview: false, items: [{ id: w.ids.mirae, version: 1 }] } });
    expect(preview.status).toBe(200);
    const exec = await w.call(USERS.haeun, 'POST', '/incidents/bulk', { headers: k, body: { action: 'resolve', preview: false, items: [{ id: w.ids.hanbit, version: 1 }] } });
    expect(exec.status).toBe(422);
    expect(body(exec).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(w.store.incidents.get(w.ids.hanbit)!.status).toBe('TRIGGERED');
    // same body, keys in another order, and the /api/v1 prefix: the same request
    const again = await w.call(USERS.haeun, 'POST', '/api/v1/incidents/bulk', { headers: k, body: { items: [{ version: 1, id: w.ids.mirae }], preview: false, action: 'resolve' } });
    { const { undoToken: _t, ...rest } = body(preview); expect(again).toEqual({ ...preview, body: rest }); } // R-7 (review SQL)
    // another If-Match is another request
    const a = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.hanbit}/ack`, { headers: { 'If-Match': '1', 'Idempotency-Key': 'ka' } });
    expect(a.status).toBe(200);
    expect((await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.hanbit}/ack`, { headers: { 'If-Match': '2', 'Idempotency-Key': 'ka' } })).status).toBe(422);
  });

  it('failed requests are not stored (a viewer cannot fill the store) and are simply evaluated again', async () => {
    const w = await world();
    for (let i = 0; i < 50; i++) await w.call(USERS.yuna, 'POST', '/incidents/nope/ack', { headers: { 'If-Match': '1', 'Idempotency-Key': `x${i}` } });
    expect(w.store.idempotent.size).toBe(0);
    const a = await w.call(USERS.yuna, 'POST', `/incidents/${w.ids.hanbit}/ack`, { headers: { 'If-Match': '1', 'Idempotency-Key': 'z' }, requestId: 'req_A' });
    const b = await w.call(USERS.yuna, 'POST', `/incidents/${w.ids.hanbit}/ack`, { headers: { 'If-Match': '1', 'Idempotency-Key': 'z' }, requestId: 'req_B' });
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(body(b).error.requestId).toBe('req_B');
  });
});

describe('R-6: a project/service-scoped ADMIN has no customer-level call order', () => {
  const sub = (s: { projectId?: string; serviceId?: string }): AuthContext => ({ ...USERS.minjae, customerIds: ['cus_mirae'], subScopes: [{ customerId: 'cus_mirae', ...s }] });
  const steps = { style: 'CUSTOM', plan: 'STANDARD', steps: [{ atMin: 0, targetType: 'PERSON', targetId: 'ct_haeun', channels: ['SMS'] }] };

  it('GET and PUT /customers/{id}/paging are the same 404 as an unknown customer — whatever the headers or body', async () => {
    const w = await world();
    const before = structuredClone(w.store.configs);
    for (const who of [sub({ projectId: 'prj_data' }), sub({ serviceId: 'svc_pay' })]) {
      for (const [m, opts] of [['GET', {}], ['PUT', { headers: { 'If-Match': cfgVersion(w, 'cus_mirae') }, body: steps }], ['PUT', {}], ['PUT', { headers: { 'If-Match': '999' }, body: {} }]] as const) {
        const real = await w.call(who, m, '/customers/cus_mirae/paging', opts as never);
        const fake = await w.call(who, m, '/customers/cus_nope/paging', opts as never);
        expect(real.status).toBe(404);
        expect(strip(real)).toBe(strip(fake));
      }
    }
    expect(w.store.configs).toEqual(before);
    // a whole-customer grant next to a narrower one is still the whole customer
    const both: AuthContext = { ...USERS.minjae, customerIds: ['cus_mirae'], subScopes: [{ customerId: 'cus_mirae' }, { customerId: 'cus_mirae', projectId: 'prj_data' }] };
    expect((await w.call(both, 'GET', '/customers/cus_mirae/paging')).status).toBe(200);
  });

  it('overrides: only inside the own subtree; the visible parent project of a granted service is not editable', async () => {
    const w = await world();
    const h = { headers: { 'If-Match': '0' }, body: steps };
    const project = sub({ projectId: 'prj_data' });
    expect((await w.call(project, 'PUT', '/customers/cus_mirae/paging-overrides/PROJECT/prj_data', h)).status).toBe(201);
    for (const path of ['PROJECT/prj_core', 'SERVICE/svc_pay']) {
      const real = await w.call(project, 'PUT', `/customers/cus_mirae/paging-overrides/${path}`, h);
      const fake = await w.call(project, 'PUT', `/customers/cus_mirae/paging-overrides/${path.split('/')[0]}/nope`, h);
      expect(real.status).toBe(404);
      expect(strip(real)).toBe(strip(fake));
    }
    const service = sub({ serviceId: 'svc_pay' });
    expect((await w.call(service, 'PUT', '/customers/cus_mirae/paging-overrides/SERVICE/svc_pay', h)).status).toBe(201);
    const parent = await w.call(service, 'PUT', '/customers/cus_mirae/paging-overrides/PROJECT/prj_core', h);
    expect(strip(parent)).toBe(strip(await w.call(service, 'PUT', '/customers/cus_mirae/paging-overrides/PROJECT/nope', h)));
    expect((await w.call(service, 'DELETE', '/customers/cus_mirae/paging-overrides/PROJECT/prj_data', { headers: { 'If-Match': '1' } })).status).toBe(404);
    expect(w.store.configs.filter((c) => c.scopeType !== 'CUSTOMER').map((c) => c.scopeId).sort()).toEqual(['prj_data', 'svc_pay']);
  });

  it('/oncall/paging-path for narrowed staff: own subtree yes, the customer level and the parent no', async () => {
    const w = await world();
    const service = sub({ serviceId: 'svc_pay' });
    expect((await w.call(service, 'GET', '/oncall/paging-path', { query: { serviceId: 'svc_pay' } })).status).toBe(200);
    const fake = await w.call(service, 'GET', '/oncall/paging-path', { query: { customerId: 'cus_nope' } });
    for (const query of [{ customerId: 'cus_mirae' }, { projectId: 'prj_core' }, { customer: 'mirae' }, { projectId: 'prj_data' }]) {
      const r = await w.call(service, 'GET', '/oncall/paging-path', { query });
      expect(r.status, JSON.stringify(query)).toBe(404);
      expect(strip(r)).toBe(strip(fake));
    }
  });
});

describe('R-7: manual Escalate', () => {
  const escalate = (w: World, id: string, who: AuthContext = USERS.haeun) => w.call(who, 'POST', `/incidents/${id}/escalate`, { headers: { 'If-Match': version(w, id) } });
  const windowFor = (w: World) => w.store.windows.push({ id: 'mw1', customerId: 'cus_mirae', scopeType: 'CUSTOMER', scopeId: 'cus_mirae', startsAt: at(0), endsAt: at(600) });

  it('respects a maintenance mute — except SEV-1', async () => {
    const w = await world();
    w.sim.now = at(1);
    closedGroup(w.store, { customerId: 'cus_mirae', severity: 'SEV_1', at: at(1), alerts: [{ id: 'al_s1', title: 'payments down' }] });
    await w.sim.tick();
    const sev1 = [...w.store.incidents.values()].find((i) => i.severity === 'SEV_1')!.id;
    windowFor(w);
    await w.sim.run(5);
    const jobs = w.store.jobList(w.ids.mirae).length;
    const r = await escalate(w, w.ids.mirae); // SEV-2
    expect(r.status).toBe(409);
    expect(body(r).error).toMatchObject({ code: 'MUTED_BY_MAINTENANCE', details: { mutedUntil: at(600).toISOString() } });
    expect(body(r).error.message).toContain('muted by a maintenance window until 2026-11-09T13:00:00.000Z');
    expect(w.store.jobList(w.ids.mirae)).toHaveLength(jobs);
    expect(w.store.incidents.get(w.ids.mirae)!.escalationStep).toBe(1);
    expect(w.store.audits.filter((a) => a.action === 'incident.escalate')).toHaveLength(0);
    const s = await escalate(w, sev1);
    expect(s.status).toBe(200);
    expect(w.store.audits.filter((a) => a.action === 'incident.escalate')).toEqual([expect.objectContaining({ targetId: sev1, actorId: 'usr_haeun', after: expect.objectContaining({ manual: true }) })]);
  });

  it('one manual step per 60 s per incident (whoever presses): 429 with retryAfterSec; every accepted one is audited', async () => {
    const w = await world();
    const id = w.ids.mirae;
    w.sim.now = at(0, 30);
    expect((await escalate(w, id)).status).toBe(200);
    w.sim.now = at(0, 40);
    for (const who of [USERS.haeun, USERS.minjae]) {
      const r = await escalate(w, id, who);
      expect(r.status).toBe(429);
      expect(body(r).error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSec: 50 } });
    }
    w.sim.now = at(1, 29);
    expect((await escalate(w, id)).status).toBe(429);
    expect(w.store.incidents.get(id)!.escalationStep).toBe(2);
    w.sim.now = at(1, 30);
    expect((await escalate(w, id)).status).toBe(200);
    expect(w.store.incidents.get(id)!.escalationStep).toBe(3);
    expect(w.store.audits.filter((a) => a.action === 'incident.escalate').map((a) => a.after)).toEqual([{ step: 1, repeat: 0, manual: true }, { step: 2, repeat: 0, manual: true }]);
    // the other incident has its own clock
    expect((await escalate(w, w.ids.hanbit, USERS.minjae)).status).toBe(200);
  });

  it('the review’s run: 20 presses within a minute fire one step, not the rest of the ladder', async () => {
    const w = await world();
    await w.sim.run(5);
    const before = w.store.jobList(w.ids.mirae).length;
    let accepted = 0;
    for (let i = 0; i < 20; i++) if ((await escalate(w, w.ids.mirae)).status === 200) accepted++;
    expect(accepted).toBe(1);
    expect(w.store.jobList(w.ids.mirae)).toHaveLength(before + 1);
  });
});

describe('R-8: Undo of an ack restores the pages the ack cancelled', () => {
  it('a page that was retrying when the ack came goes out after the undo — once; earlier steps are not paged again', async () => {
    const w = await world();
    w.sim.sms.failNext(1);
    await w.sim.run(2); // step 2 (SMS) fired at minute 2, first attempt failed → waiting for its retry
    expect(w.store.jobList(w.ids.mirae).map((j) => [j.stepIndex, j.channel, j.status])).toEqual([[0, 'SLACK_BOT', 'SENT'], [1, 'SMS', 'QUEUED']]);
    const a = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': version(w, w.ids.mirae) } });
    w.sim.now = at(3);
    await w.sim.tick();
    expect(w.store.jobList(w.ids.mirae)[1]).toMatchObject({ status: 'SKIPPED', lastError: 'acknowledged' });
    const u = await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: body(a).undoToken } });
    expect(body(u)).toEqual({ restored: [w.ids.mirae], skipped: [] });
    expect(w.store.jobList(w.ids.mirae)[1]).toMatchObject({ status: 'QUEUED', attempts: 1, nextAttemptAt: at(3), lastError: null });
    await w.sim.run(6);
    expect(w.sim.sms.sent.map((m) => [m.contactId, m.purpose])).toEqual([['ct_haeun', 'ESCALATION']]);
    expect(w.store.jobList(w.ids.mirae)[1]).toMatchObject({ status: 'SENT', attempts: 2 });
    expect(w.sim.slack.sent.filter((m) => m.incidentId === w.ids.mirae)).toHaveLength(1); // step 1 was not sent again
    // the schedule did not move: step 3 (call at minute 7) is still counted from the last page
    expect(w.store.incidents.get(w.ids.mirae)).toMatchObject({ status: 'TRIGGERED', escalationStep: 2, nextEscalationAt: at(7) });
    await w.sim.run(7);
    expect(w.sim.voice.sent.filter((m) => m.incidentId === w.ids.mirae)).toHaveLength(1);
  });

  it('only the current step’s ack-cancelled pages come back: delivered, failed, otherwise-skipped and earlier-step pages stay as they are', async () => {
    const w = await world();
    await w.sim.run(2);
    const a = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': version(w, w.ids.mirae) } });
    const [first, second] = w.store.jobList(w.ids.mirae);
    Object.assign(w.store.jobs.get(first!.idempotencyKey)!, { status: 'SKIPPED', lastError: 'acknowledged' }); // an earlier step
    w.store.jobs.set('x1', { ...second!, id: 'job_x1', idempotencyKey: 'x1', status: 'SKIPPED', lastError: 'muted_by_maintenance' });
    w.store.jobs.set('x2', { ...second!, id: 'job_x2', idempotencyKey: 'x2', status: 'FAILED', lastError: 'gave up' });
    await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: body(a).undoToken } });
    expect(w.store.jobList(w.ids.mirae).map((j) => j.status)).toEqual(['SKIPPED', 'SENT', 'SKIPPED', 'FAILED']);
    await w.sim.run(4);
    expect(w.sim.sms.sent).toHaveLength(1);
  });
});

describe('Q-1: what a portal (customer) user receives', () => {
  const INTERNAL_IDS = /ct_haeun|ct_junho|ct_minjae|ct_yuna|usr_|rot_night|MSP night desk|pc_cus|pagingConfigId|contactId|targetId|sharedRotationId|providerMessageId|C_MSP|C_MIRAE|slack-\d|sms-\d/;
  const STAFF_NAMES = /Haeun|Junho|Minjae/;
  /** Every incident response Yuna (portal user of Mirae Pay) can get, after pages, a failed SMS, an ack and an undo by staff. */
  const everything = async (w: World): Promise<Record<string, any>> => {
    w.store.contacts.get('ct_yuna')!.phoneVerifiedAt = null; // step 4 calls everyone → her call is skipped (timeline line)
    w.sim.sms.failNext(1, { retryable: false, error: 'vendor: number +82100008995 rejected (acct AC123, key sk_live_x)' });
    await w.sim.run(13);
    const a = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': version(w, w.ids.mirae) } });
    await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: body(a).undoToken } });
    await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': version(w, w.ids.mirae) } });
    const get = async (p: string, q?: Record<string, string>) => body(await w.call(USERS.yuna, 'GET', p, { query: q }));
    return {
      list: await get('/incidents'), detail: await get(`/incidents/${w.ids.mirae}`),
      timeline: await get(`/incidents/${w.ids.mirae}/timeline`), notifications: await get(`/incidents/${w.ids.mirae}/notifications`),
    };
  };

  it('the default is the safe one', () => expect(PORTAL_SHOWS_STAFF_NAMES).toBe(false));

  it('PORTAL_SHOWS_STAFF_NAMES = false: no internal identifier, no staff name — "MSP on-call"; her own colleague keeps the name', async () => {
    const w = await world();
    const all = await everything(w);
    const text = JSON.stringify(all);
    expect(text).not.toMatch(INTERNAL_IDS);
    expect(text).not.toMatch(STAFF_NAMES);
    expect(text).not.toMatch(/\+82|sk_live|AC123|rejected|vendor/);
    const d = all.detail;
    expect(d.assignee).toEqual({ name: 'MSP on-call' });
    expect(d.acknowledgedBy).toEqual({ name: 'MSP on-call' });
    expect(all.list.items[0]).toMatchObject({ assignee: { name: 'MSP on-call' }, acknowledgedBy: { name: 'MSP on-call' }, awsAccountIds: [] });
    expect(d.assignmentSnapshot).toEqual({
      capturedAt: '2026-11-09T03:00:00.000Z', planLabel: 'Shared MSP rotation · Standard', level: 'CUSTOMER', repeatCount: 1,
      steps: [
        { index: 0, atMin: 0, targetType: 'ROTATION', resolved: [{ name: 'MSP on-call' }], channels: ['SLACK_CHANNEL'] },
        { index: 1, atMin: 2, targetType: 'ROTATION', resolved: [{ name: 'MSP on-call' }], channels: ['SMS'] },
        { index: 2, atMin: 7, targetType: 'ROTATION', resolved: [{ name: 'MSP on-call' }], channels: ['VOICE'] },
        { index: 3, atMin: 12, targetType: 'ALL_RESPONDERS', resolved: [{ name: 'MSP on-call' }, { name: 'Yuna Seo' }], channels: ['VOICE'], label: 'everyone in Responders (3)' },
      ],
    });
    expect(d.paged.map((p: any) => p.label)).toEqual([
      'Paged step 1: Slack MSP on-call.', 'No acknowledgement → step 2: SMS MSP on-call.', 'No acknowledgement → step 3: call MSP on-call.', 'No acknowledgement → step 4: call MSP on-call, Yuna Seo.',
    ]);
    expect(all.timeline.items.map((e: any) => [e.kind, e.actorType, e.actorId, e.message])).toEqual([
      ['TRIGGERED', 'SYSTEM', null, 'Incident opened with 2 alerts: payments-api 5xx high'],
      ['NOTE', 'SYSTEM', null, 'Paging steps at open: MSP on-call → MSP on-call → MSP on-call → everyone in Responders (3)'],
      ['NOTIFIED', 'SYSTEM', null, 'Paged step 1: Slack MSP on-call.'],
      ['ESCALATED', 'SYSTEM', null, 'No acknowledgement → step 2: SMS MSP on-call.'],
      ['ESCALATED', 'SYSTEM', null, 'No acknowledgement → step 3: call MSP on-call.'],
      ['ESCALATED', 'SYSTEM', null, 'No acknowledgement → step 4: call MSP on-call, Yuna Seo.'],
      ['NOTE', 'SYSTEM', null, 'Step 4: call to Yuna Seo was not sent — the phone number is not verified.'],
      ['ACKED', 'USER', null, 'Acknowledged by MSP on-call. Paging stopped.'],
      ['NOTE', 'USER', null, 'Acknowledgement undone by MSP on-call. Paging continues.'],
      ['ACKED', 'USER', null, 'Acknowledged by MSP on-call. Paging stopped.'],
    ]);
    // R-4: the delivery log for her — a reason code, no provider words, no message ids, no channel ownership
    expect(all.notifications.items.map((l: any) => [l.channel, l.status, l.targetSummary, l.reason])).toEqual([
      ['SLACK_BOT', 'SENT', 'Slack channel', null], ['SMS', 'FAILED', 'MSP on-call', 'PROVIDER_REJECTED'], ['VOICE', 'SENT', 'MSP on-call', null],
      ['VOICE', 'SENT', 'MSP on-call', null], ['VOICE', 'SENT', 'MSP on-call', null],
    ]);
    expect(Object.keys(all.notifications.items[1]).sort()).toEqual(['at', 'attempt', 'channel', 'escalationStep', 'id', 'reason', 'status', 'targetSummary']);
  });

  it('PORTAL_SHOWS_STAFF_NAMES = true: staff by name, still not a single internal identifier or rotation name', async () => {
    const w = await world({ config: { portalShowsStaffNames: true } });
    const all = await everything(w);
    const text = JSON.stringify(all);
    expect(text).not.toMatch(INTERNAL_IDS);
    expect(text).not.toMatch(/MSP on-call/);
    expect(all.detail.assignee).toEqual({ name: 'Haeun Kim' });
    expect(all.detail.acknowledgedBy).toEqual({ name: 'Haeun Kim' });
    expect(all.detail.assignmentSnapshot.steps[3]).toEqual({ index: 3, atMin: 12, targetType: 'ALL_RESPONDERS', resolved: [{ name: 'Haeun Kim' }, { name: 'Junho Park' }, { name: 'Yuna Seo' }], channels: ['VOICE'], label: 'everyone in Responders (3)' });
    expect(all.timeline.items.map((e: any) => e.message)).toEqual(expect.arrayContaining([
      'Paging steps at open: Haeun Kim → Haeun Kim → Haeun Kim → everyone in Responders (3)',
      'No acknowledgement → step 4: call Haeun Kim, Junho Park, Yuna Seo.', 'Acknowledged by Haeun Kim. Paging stopped.', 'Acknowledgement undone by Haeun Kim. Paging continues.',
    ]));
    expect(all.timeline.items.every((e: any) => e.actorId === null)).toBe(true);
    expect(all.notifications.items.map((l: any) => l.targetSummary)).toEqual(['Slack channel', 'Haeun Kim', 'Haeun Kim', 'Haeun Kim', 'Junho Park']);
  });

  it('staff still get everything (ids, the internal sentences, provider detail — sanitised)', async () => {
    const w = await world();
    await everything(w);
    const d = body(await w.call(USERS.viewer, 'GET', `/incidents/${w.ids.mirae}`));
    expect(d.assignee).toEqual({ contactId: 'ct_haeun', name: 'Haeun Kim', via: 'rotation' });
    expect(d.acknowledgedBy).toEqual({ contactId: 'usr_haeun', name: 'Haeun Kim' });
    expect(d.assignmentSnapshot).toMatchObject({ pagingConfigId: 'pc_cus_mirae_CUSTOMER', steps: expect.arrayContaining([expect.objectContaining({ targetId: 'rot_night', label: 'MSP night desk' })]) });
    const t = body(await w.call(USERS.viewer, 'GET', `/incidents/${w.ids.mirae}/timeline`));
    expect(t.items.find((e: any) => e.kind === 'ACKED')).toMatchObject({ actorId: 'usr_haeun', message: 'Acknowledged by Haeun Kim. Paging stopped.' });
    expect(t.items.find((e: any) => /not verified/.test(e.message)).message).toBe('Step 4/4: Call to Yuna Seo was not sent — the phone number is not verified.');
    // provider text is for OPERATOR and ADMIN (review 2, R-13); an internal VIEWER gets the reason code only
    const v = body(await w.call(USERS.viewer, 'GET', `/incidents/${w.ids.mirae}/notifications`));
    expect(v.items[1]).toMatchObject({ channel: 'SMS', status: 'FAILED', reason: 'PROVIDER_REJECTED', error: null });
    expect(JSON.stringify(v)).not.toMatch(/vendor|rejected \(/);
    // review 4 (R-20, STORE_PROVIDER_TEXT default false): an OPERATOR gets the reason code only as well; the masked
    // excerpt is for ADMIN. (With the switch on, OPERATOR reads the text: security-review-4.test.ts.)
    const o = body(await w.call(USERS.haeun, 'GET', `/incidents/${w.ids.mirae}/notifications`));
    expect(o.items[1]).toMatchObject({ channel: 'SMS', status: 'FAILED', targetSummary: 'Haeun Kim', reason: 'PROVIDER_REJECTED', error: null, providerMessageId: null });
    expect(JSON.stringify(o)).not.toMatch(/vendor|rejected \(/);
    const n = body(await w.call(USERS.minjae, 'GET', `/incidents/${w.ids.mirae}/notifications`));
    expect(n.items[1]).toMatchObject({ channel: 'SMS', status: 'FAILED', targetSummary: 'Haeun Kim', reason: 'PROVIDER_REJECTED', error: 'vendor: number [number] rejected ([secret], [secret])', providerMessageId: null });
    expect(n.items[0]).toMatchObject({ targetSummary: 'Customer Slack channel', providerMessageId: expect.stringMatching(/^slack-\d$/) });
    expect(JSON.stringify(n)).not.toMatch(/82100008995|sk_live|AC123|C_MIRAE|C_MSP/); // not even staff get the raw provider text or a channel id
  });

  it('a customer without its own Slack channel is not told that the MSP default channel was used', async () => {
    const w = await world();
    w.store.configs.push({ id: 'pc_h_slack', customerId: 'cus_hanbit', scopeType: 'SERVICE', scopeId: 'svc_web', style: 'CUSTOM', plan: 'QUIET', edited: true, repeatCount: 0, version: 1, steps: [{ index: 0, atMin: 0, targetType: 'PERSON', targetId: 'ct_dohyun', channels: ['SLACK_CHANNEL'] }] });
    w.sim.now = at(1);
    closedGroup(w.store, { customerId: 'cus_hanbit', severity: 'SEV_2', at: at(1), alerts: [{ id: 'al_h2' }] });
    await w.sim.tick();
    const id = [...w.store.incidents.values()].find((i) => i.customerId === 'cus_hanbit' && i.severity === 'SEV_2')!.id;
    expect(w.sim.slack.sent.find((m) => m.incidentId === id)!.to).toBe('C_MSP');
    const portal = body(await w.call(USERS.dohyun, 'GET', `/incidents/${id}/notifications`));
    expect(portal.items.map((l: any) => l.targetSummary)).toEqual(['Slack channel']);
    expect(JSON.stringify(portal)).not.toMatch(/MSP|C_/);
    expect(body(await w.call(USERS.viewer, 'GET', `/incidents/${id}/notifications`)).items[0].targetSummary).toBe('MSP Slack channel');
  });

  it('/oncall/paging-path does not exist for portal users: the one 404, whatever they ask for', async () => {
    const w = await world();
    const unknownRoute = await w.call(USERS.yuna, 'GET', '/nope');
    for (const query of [{ customerId: 'cus_mirae' }, { serviceId: 'svc_pay' }, { customer: 'mirae' }, { q: 'pay' }, { resourceId: 'res_web1' }, { customerId: 'cus_hanbit' }, {}, { customer: 'NOT A SLUG' }]) {
      for (const who of [USERS.yuna, { ...USERS.yuna, role: 'ADMIN' as const }]) {
        const r = await w.call(who, 'GET', '/oncall/paging-path', { query });
        expect(r.status, JSON.stringify(query)).toBe(404);
        expect(strip(r)).toBe(strip(unknownRoute));
      }
    }
    expect((await w.call(USERS.viewer, 'GET', '/oncall/paging-path', { query: { customerId: 'cus_mirae' } })).status).toBe(200);
    // the call order itself was never theirs to read
    expect((await w.call(USERS.yuna, 'GET', '/customers/cus_mirae/paging')).status).toBe(403);
  });
});

describe('N-3: versions continue after an override is deleted and created again', () => {
  it('an If-Match from before the delete never matches the new row', async () => {
    const w = await world();
    const path = '/customers/cus_mirae/paging-overrides/SERVICE/svc_pay';
    const steps = { style: 'CUSTOM', plan: 'STANDARD', steps: [{ atMin: 0, targetType: 'PERSON', targetId: 'ct_haeun', channels: ['SMS'] }] };
    const put = (v: string) => w.call(USERS.minjae, 'PUT', path, { headers: { 'If-Match': v }, body: steps });
    expect(body(await put('0')).version).toBe(1);
    expect((await w.call(USERS.minjae, 'DELETE', path, { headers: { 'If-Match': '1' } })).status).toBe(200);
    expect((await put('1')).status).toBe(409); // the editor that still holds version 1: nothing to replace
    const again = await put('0');
    expect([again.status, body(again).version]).toEqual([201, 2]);
    expect((await put('1')).status).toBe(409); // before the fix this matched the re-created row
    expect(body(await put('2')).version).toBe(3);
  });
});
