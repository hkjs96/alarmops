import { describe, expect, it } from 'vitest';
import { ROUTES, type AuthContext } from '../src/index.js';
import { USERS, body, wire, world, version } from './helpers.js';

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Not found.', details: {}, requestId: 'req_same' } };

describe('GET /scope-tree — the response is the isolation (security R-1)', () => {
  it('MSP staff: every customer, counts, call health, own steps, mine', async () => {
    const w = await world();
    w.store.configs.push({ ...w.store.configs[0]!, id: 'pc_prj_data', scopeType: 'PROJECT', scopeId: 'prj_data' });
    w.store.contacts.get('ct_dohyun')!.phoneVerifiedAt = null; // Hanbit's first step now calls an unverified phone
    const r = await w.call(USERS.haeun, 'GET', '/scope-tree');
    expect(r.status).toBe(200);
    expect(body(r)).toEqual({ customers: [
      { id: 'cus_hanbit', slug: 'hanbit', name: 'Hanbit Retail', mine: false, openIncidents: 1, callHealth: 'AT_RISK', projects: [
        { id: 'prj_shop', slug: 'shop', name: 'Shop', openIncidents: 1, ownSteps: false, services: [{ id: 'svc_web', slug: 'web', name: 'Web', openIncidents: 1, ownSteps: false }] }] },
      { id: 'cus_mirae', slug: 'mirae', name: 'Mirae Pay', mine: true, openIncidents: 1, callHealth: 'OK', projects: [
        { id: 'prj_core', slug: 'core', name: 'Core', openIncidents: 1, ownSteps: false, services: [{ id: 'svc_pay', slug: 'payments-api', name: 'Payments API', openIncidents: 1, ownSteps: false }] },
        { id: 'prj_data', slug: 'data-platform', name: 'Data platform', openIncidents: 0, ownSteps: true, services: [] }] },
    ] });
  });

  it('portal user: own customer only, callHealth fixed to OK, mine false, no trace of the other customer or unmapped accounts', async () => {
    const w = await world();
    w.store.rotations.get('rot_night')!.members = []; // Mirae is really UNREACHABLE now — the portal must not learn that
    const r = await w.call(USERS.yuna, 'GET', '/scope-tree');
    const tree = body(r).customers;
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ id: 'cus_mirae', callHealth: 'OK', mine: false, openIncidents: 1 });
    const text = JSON.stringify(r.body);
    for (const leak of ['hanbit', 'Hanbit', 'cus_hanbit', 'svc_web', '999999999999', 'UNREACHABLE', 'AT_RISK']) expect(text).not.toContain(leak);
    expect(body(await w.call(USERS.haeun, 'GET', '/scope-tree')).customers.find((c: any) => c.id === 'cus_mirae').callHealth).not.toBe('OK');
  });

  it('counts are computed inside the caller’s range; a user with no customers gets an empty tree (known-bugs 8-4)', async () => {
    const w = await world();
    const nobody: AuthContext = { userId: 'usr_x', kind: 'CUSTOMER', customerIds: [], role: 'VIEWER' };
    expect(body(await w.call(nobody, 'GET', '/scope-tree'))).toEqual({ customers: [] });
    // '*' is never honoured for a customer user, and a malformed context fails closed.
    expect(body(await w.call({ ...nobody, customerIds: '*' }, 'GET', '/scope-tree'))).toEqual({ customers: [] });
    expect(body(await w.call({ ...nobody, customerIds: undefined as never }, 'GET', '/incidents')).items).toEqual([]);
    const limited: AuthContext = { ...USERS.viewer, customerIds: ['cus_hanbit'] };
    expect(body(await w.call(limited, 'GET', '/scope-tree')).customers.map((c: any) => c.slug)).toEqual(['hanbit']);
  });

  it('project/service-scoped user sees only that subtree, and only its incidents', async () => {
    const w = await world();
    const data: AuthContext = { ...USERS.yuna, subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_data' }] };
    const tree = body(await w.call(data, 'GET', '/scope-tree')).customers;
    expect(tree[0].projects.map((p: any) => p.slug)).toEqual(['data-platform']);
    expect(tree[0].openIncidents).toBe(0); // the open incident is in Core › Payments API
    expect(body(await w.call(data, 'GET', '/incidents')).items).toEqual([]);
    expect((await w.call(data, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(404);
    expect((await w.call(data, 'GET', '/incidents', { query: { customer: 'mirae', project: 'core' } })).status).toBe(404);
  });

  it('ETag differs per caller; If-None-Match → 304; changes after an ack; onlyProblems filters', async () => {
    const w = await world();
    const a = await w.call(USERS.haeun, 'GET', '/scope-tree');
    const b = await w.call(USERS.viewer, 'GET', '/scope-tree');
    const c = await w.call(USERS.yuna, 'GET', '/scope-tree');
    expect(new Set([a.headers.etag, b.headers.etag, c.headers.etag]).size).toBe(3);
    const again = await w.call(USERS.haeun, 'GET', '/scope-tree', { headers: { 'If-None-Match': a.headers.etag! } });
    expect(again.status).toBe(304);
    expect(again.body).toBeUndefined();
    // another user's tag never validates
    expect((await w.call(USERS.yuna, 'GET', '/scope-tree', { headers: { 'If-None-Match': a.headers.etag! } })).status).toBe(200);
    await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': version(w, w.ids.mirae) } });
    const after = await w.call(USERS.haeun, 'GET', '/scope-tree', { headers: { 'If-None-Match': a.headers.etag! } });
    expect(after.status).toBe(200);
    expect(body(after).customers.find((x: any) => x.slug === 'mirae').openIncidents).toBe(0);
    expect(body(await w.call(USERS.haeun, 'GET', '/scope-tree', { query: { onlyProblems: 'true' } })).customers.map((x: any) => x.slug)).toEqual(['hanbit']);
  });
});

describe('404 parity: unknown and out-of-scope are the same bytes, never 403 (API-CONTRACT §2 gate test)', () => {
  // [what, request for something that exists but belongs to another tenant, the same request for something that does not exist]
  const cases: Array<[string, (ids: { mirae: string; hanbit: string; unmapped: string }) => [string, Record<string, string>?], () => [string, Record<string, string>?]]> = [
    ['incident by id', (i) => [`/incidents/${i.hanbit}`], () => ['/incidents/inc-000000000000-20261109030000']],
    ['incident timeline', (i) => [`/incidents/${i.hanbit}/timeline`], () => ['/incidents/inc-nope/timeline']],
    ['incident notifications', (i) => [`/incidents/${i.hanbit}/notifications`], () => ['/incidents/inc-nope/notifications']],
    ['unmapped-account incident', (i) => [`/incidents/${i.unmapped}`], () => ['/incidents/inc-nope']],
    ['list by customer slug', () => ['/incidents', { customer: 'hanbit' }], () => ['/incidents', { customer: 'no-such-customer' }]],
    ['list by project slug', () => ['/incidents', { customer: 'hanbit', project: 'shop' }], () => ['/incidents', { customer: 'mirae', project: 'nope' }]],
    ['list by service slug', () => ['/incidents', { customer: 'hanbit', project: 'shop', service: 'web' }], () => ['/incidents', { customer: 'mirae', project: 'core', service: 'nope' }]],
    ['list by customerId', () => ['/incidents', { customerId: 'cus_hanbit' }], () => ['/incidents', { customerId: 'cus_nope' }]],
    ['customer paging', () => ['/customers/cus_hanbit/paging'], () => ['/customers/cus_nope/paging']],
    ['paging path by service', () => ['/oncall/paging-path', { serviceId: 'svc_web' }], () => ['/oncall/paging-path', { serviceId: 'svc_nope' }]],
    ['paging path by slugs', () => ['/oncall/paging-path', { customer: 'hanbit' }], () => ['/oncall/paging-path', { customer: 'nope' }]],
    ['paging path by resource', () => ['/oncall/paging-path', { resourceId: 'res_shop' }], () => ['/oncall/paging-path', { resourceId: 'res_nope' }]],
  ];

  it.each(cases)('portal user · %s', async (_what, foreign, missing) => {
    const w = await world();
    const [fp, fq] = foreign(w.ids);
    const [mp, mq] = missing();
    const a = await w.call(USERS.yuna, 'GET', fp, { query: fq, requestId: 'req_same' });
    const b = await w.call(USERS.yuna, 'GET', mp, { query: mq, requestId: 'req_same' });
    expect(a.status).toBe(404);
    expect(a.body).toEqual(NOT_FOUND);
    expect(wire(a)).toBe(wire(b)); // status, header set and body, byte for byte
    // and only requestId differs between two requests
    const c = await w.call(USERS.yuna, 'GET', fp, { query: fq, requestId: 'req_other' });
    expect(JSON.stringify(c.body).replace('req_other', 'req_same')).toBe(JSON.stringify(a.body));
  });

  it('MSP staff limited to some customers get the same 404 for the others', async () => {
    const w = await world();
    const limited: AuthContext = { ...USERS.haeun, customerIds: ['cus_mirae'] };
    const a = await w.call(limited, 'GET', `/incidents/${w.ids.hanbit}`, { requestId: 'req_same' });
    const b = await w.call(limited, 'GET', '/incidents/inc-nope', { requestId: 'req_same' });
    const u = await w.call(limited, 'GET', `/incidents/${w.ids.unmapped}`, { requestId: 'req_same' });
    expect(wire(a)).toBe(wire(b));
    expect(wire(u)).toBe(wire(b));
    expect(a.body).toEqual(NOT_FOUND);
  });

  it('writes on another tenant’s incident: 404 with the same bytes, whatever the role, header or body', async () => {
    const w = await world();
    const before = JSON.stringify([...w.store.incidents.values()]);
    for (const action of ['ack', 'resolve', 'escalate']) {
      const a = await w.call(USERS.yuna, 'POST', `/incidents/${w.ids.hanbit}/${action}`, { headers: { 'If-Match': version(w, w.ids.hanbit) }, requestId: 'req_same' });
      const b = await w.call(USERS.yuna, 'POST', `/incidents/inc-nope/${action}`, { headers: { 'If-Match': '1' }, requestId: 'req_same' });
      expect(wire(a)).toBe(wire(b));
      expect(a.status).toBe(404);
      const stale = await w.call(USERS.yuna, 'POST', `/incidents/${w.ids.hanbit}/${action}`, { headers: { 'If-Match': '999' }, requestId: 'req_same' });
      expect(wire(stale)).toBe(wire(b)); // no 409 that would confirm the incident exists
    }
    // …while on her OWN incident the portal user gets 403 (visible target, role too low) — the only place 403 exists.
    const own = await w.call(USERS.yuna, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': version(w, w.ids.mirae) } });
    expect(own.status).toBe(403);
    expect(body(own).error.code).toBe('ROLE_REQUIRED');
    for (const [method, path] of [['PUT', '/customers/cus_hanbit/paging'], ['PUT', '/customers/cus_hanbit/paging-overrides/SERVICE/svc_web'], ['DELETE', '/customers/cus_hanbit/paging-overrides/SERVICE/svc_web']] as const) {
      const a = await w.call(USERS.yuna, method, path, { headers: { 'If-Match': '1' }, body: {}, requestId: 'req_same' });
      const b = await w.call(USERS.yuna, method, path.replace('cus_hanbit', 'cus_nope'), { headers: { 'If-Match': '1' }, body: {}, requestId: 'req_same' });
      expect(a.status).toBe(404);
      expect(wire(a)).toBe(wire(b));
    }
    expect(JSON.stringify([...w.store.incidents.values()])).toBe(before);
    expect(w.store.audits).toHaveLength(0);
  });

  it('known-bugs 8-3: every route answers a portal user 404 (or 400 before any lookup) for another tenant’s ids — never 200/403/409', async () => {
    const w = await world();
    const fill: Record<string, string> = { ':id': w.ids.hanbit, ':scopeType': 'SERVICE', ':scopeId': 'svc_web' };
    const tested: string[] = [];
    for (const r of ROUTES) {
      if (!r.pattern.some((p) => p.startsWith(':'))) continue;
      const path = '/' + r.pattern.map((p) => (p === ':id' && r.pattern[0] === 'customers' ? 'cus_hanbit' : fill[p] ?? p)).join('/');
      const res = await w.call(USERS.yuna, r.method, path, { headers: { 'If-Match': '1' }, body: {} });
      expect(res.status, `${r.method} ${path}`).toBe(404);
      tested.push(`${r.method} ${path}`);
    }
    expect(tested).toHaveLength(10);
    // the scope tree is the only source of slugs/ids: nothing of Hanbit's is in any list response either
    for (const path of ['/scope-tree', '/incidents']) expect(JSON.stringify((await w.call(USERS.yuna, 'GET', path)).body)).not.toMatch(/hanbit|Hanbit|svc_web|shop/);
  });

  it('scoped reads go through the scoped repository call only (the scope is inside the query, not a comparison afterwards)', async () => {
    const w = await world();
    w.store.reads.length = 0;
    await w.call(USERS.yuna, 'GET', `/incidents/${w.ids.hanbit}`);
    await w.call(USERS.yuna, 'GET', '/incidents/inc-nope');
    expect(w.store.reads).toEqual(['findIncident', 'findIncident']); // identical work for both
  });

  it('no session → 401 on every route; unknown routes and the disabled alert ack → 404', async () => {
    const w = await world();
    for (const r of ROUTES) expect((await w.call(null, r.method, '/' + r.pattern.join('/'))).status).toBe(401);
    expect((await w.call(USERS.minjae, 'POST', '/alerts/al_m1/ack')).status).toBe(404);
    expect((await w.call(USERS.minjae, 'GET', '/nope')).status).toBe(404);
  });
});

describe('unmapped-account data is internal only (security R-2)', () => {
  it('MSP staff see the incident, the banner and the account id; portal users get nothing, [] and 0', async () => {
    const w = await world();
    const staff = body(await w.call(USERS.haeun, 'GET', '/incidents'));
    expect(staff.items.map((i: any) => i.id).sort()).toEqual([w.ids.hanbit, w.ids.mirae, w.ids.unmapped].sort());
    expect(staff.unmapped).toEqual([{ awsAccountId: '999999999999', alertCount: 1 }]);
    expect(staff.items.find((i: any) => i.unmapped)).toMatchObject({ org: { customer: null, project: null, service: null }, awsAccountIds: ['999999999999'], escalation: { state: 'NEVER_ESCALATING' } });

    for (const q of [{}, { mine: '1' }, { unmapped: 'true' }, { customer: 'mirae' }]) {
      const portal = body(await w.call(USERS.yuna, 'GET', '/incidents', { query: q }));
      expect(portal.unmapped).toEqual([]);
      expect(portal.outside?.unmapped ?? 0).toBe(0);
      expect(portal.items.every((i: any) => i.org.customer.id === 'cus_mirae' && i.awsAccountIds.length === 0)).toBe(true);
      expect(JSON.stringify(portal)).not.toContain('999999999999');
    }
    expect(body(await w.call(USERS.yuna, 'GET', '/incidents', { query: { unmapped: 'true' } })).items).toEqual([]);
    expect((await w.call(USERS.yuna, 'GET', `/incidents/${w.ids.unmapped}`)).status).toBe(404);
    expect(body(await w.call(USERS.haeun, 'GET', `/incidents/${w.ids.unmapped}`))).toMatchObject({ unmapped: true, assignmentSnapshot: null });
  });

  it('unmapped incidents are listed without a scope filter and with mine=1, not under a customer filter', async () => {
    const w = await world();
    const ids = async (q: Record<string, string>) => body(await w.call(USERS.haeun, 'GET', '/incidents', { query: q })).items.map((i: any) => i.id).sort();
    expect(await ids({ mine: '1' })).toEqual([w.ids.mirae, w.ids.unmapped].sort());
    expect(await ids({ customer: 'mirae' })).toEqual([w.ids.mirae]);
    expect(await ids({ unmapped: 'true' })).toEqual([w.ids.unmapped]);
  });
});

describe('counts and "Outside this view" (D-34, known-bugs 9-5)', () => {
  it('invariant: counts.open + outside.open = the badge (unfiltered counts.open), for every scope filter', async () => {
    const w = await world();
    const badge = body(await w.call(USERS.haeun, 'GET', '/incidents')).counts.open;
    expect(badge).toBe(3);
    expect(body(await w.call(USERS.haeun, 'GET', '/incidents')).outside).toBeNull();
    for (const q of [{ customer: 'mirae' }, { customer: 'mirae', project: 'core' }, { customer: 'mirae', project: 'data-platform' }, { customer: 'hanbit', project: 'shop', service: 'web' }, { mine: '1' }, { customerId: 'cus_hanbit' }]) {
      const r = body(await w.call(USERS.haeun, 'GET', '/incidents', { query: q }));
      expect(r.counts.open + r.outside.open, JSON.stringify(q)).toBe(badge);
      expect(r.items.filter((i: any) => i.status === 'TRIGGERED')).toHaveLength(r.counts.open);
    }
    expect(body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { customer: 'mirae' } })).outside).toEqual({ open: 2, unmapped: 1, acknowledged: 0 });
    expect(body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { mine: '1' } })).outside).toEqual({ open: 1, unmapped: 0, acknowledged: 0 });
  });

  it('status, severity and search do not change `outside`; counts follow the non-status filters', async () => {
    const w = await world();
    await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.hanbit}/ack`, { headers: { 'If-Match': version(w, w.ids.hanbit) } });
    const base = body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { customer: 'mirae' } }));
    expect(base.outside).toEqual({ open: 1, unmapped: 1, acknowledged: 1 });
    for (const q of [{ status: 'RESOLVED' }, { severity: 'SEV_5' }, { q: 'zzz' }]) {
      const r = body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { customer: 'mirae', ...q } }));
      expect(r.outside).toEqual(base.outside);
    }
    const sev = body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { severity: 'SEV_3' } }));
    expect(sev.counts).toMatchObject({ open: 0, acknowledged: 1, triggered: 0 });
    expect(sev.items.map((i: any) => i.id)).toEqual([w.ids.hanbit]);
    // status does not change the tiles
    expect(body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { status: 'ACKNOWLEDGED' } })).counts).toMatchObject({ open: 2, acknowledged: 1 });
  });

  it('portal users: outside and counts never include another tenant or unmapped accounts', async () => {
    const w = await world();
    const all = body(await w.call(USERS.yuna, 'GET', '/incidents'));
    expect(all.counts.open).toBe(1);
    expect(all.outside).toBeNull();
    const core = body(await w.call(USERS.yuna, 'GET', '/incidents', { query: { customer: 'mirae', project: 'data-platform' } }));
    expect(core.items).toEqual([]);
    expect(core.outside).toEqual({ open: 1, unmapped: 0, acknowledged: 0 }); // her own incident in Core — not Hanbit's, not the unmapped one
    const mine = body(await w.call(USERS.yuna, 'GET', '/incidents', { query: { mine: '1' } }));
    expect(mine.counts.open + mine.outside.open).toBe(1);
  });

  it('mine is computed from the session; ids sent by the client are ignored; customer beats mine', async () => {
    const w = await world();
    const mine = body(await w.call(USERS.minjae, 'GET', '/incidents', { query: { mine: '1', userId: 'usr_haeun', contactId: 'ct_haeun' } }));
    expect(mine.items.map((i: any) => i.org.customer?.slug ?? '-').sort()).toEqual(['-', 'hanbit']);
    const both = body(await w.call(USERS.minjae, 'GET', '/incidents', { query: { mine: '1', customer: 'mirae' } }));
    expect(both.items.map((i: any) => i.org.customer.slug)).toEqual(['mirae']);
  });
});

describe('list query rules (§2)', () => {
  it('project needs customer, service needs project, slugs are validated → 400; empty parameters are ignored (9-6)', async () => {
    const w = await world();
    const bad = async (q: Record<string, string>) => {
      const r = await w.call(USERS.haeun, 'GET', '/incidents', { query: q });
      expect(r.status, JSON.stringify(q)).toBe(400);
      expect(body(r).error.code).toBe('VALIDATION_FAILED');
      return body(r).error.details.fields.map((f: any) => f.field);
    };
    expect(await bad({ project: 'core' })).toEqual(['project']);
    expect(await bad({ customer: 'mirae', service: 'payments-api' })).toEqual(['service']);
    expect(await bad({ customer: 'Mirae Pay' })).toEqual(['customer']);
    expect(await bad({ customer: '../etc' })).toEqual(['customer']);
    await bad({ status: 'open' });
    await bad({ severity: 'critical' });
    await bad({ limit: '0' });
    await bad({ cursor: 'not-a-cursor' });
    await bad({ assignee: 'usr_haeun' });
    const r = await w.call(USERS.haeun, 'GET', '/incidents', { query: { customer: '', project: '', status: '', severity: '', mine: '' } });
    expect(r.status).toBe(200);
    expect(body(r).items).toHaveLength(3);
    expect(body(r).outside).toBeNull();
  });

  it('cursor pagination walks every row once, newest first, sorted on the server (9-1, 9-2)', async () => {
    const w = await world();
    const { closedGroup, at } = await import('./helpers.js');
    for (let m = 1; m <= 7; m++) {
      w.sim.now = at(m * 400); // > 6h apart → each opens a new incident on the same axis
      closedGroup(w.store, { customerId: 'cus_hanbit', severity: 'SEV_3', at: w.sim.now, alerts: [{ id: `al_x${m}` }] });
      await w.sim.tick(['group']);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { limit: '3', cursor } }));
      expect(r.items.length).toBeLessThanOrEqual(3);
      seen.push(...r.items.map((i: any) => `${i.triggeredAt}|${i.id}`));
      cursor = r.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
    expect([...seen].sort().reverse()).toEqual(seen);
    expect(body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { limit: '9999' } })).items).toHaveLength(10);
  });

  it('list item carries what the console needs: org slugs, key, assignee, escalation progress, version', async () => {
    const w = await world();
    const item = body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { customer: 'mirae' } })).items[0];
    expect(item).toMatchObject({
      number: 1, key: expect.stringMatching(/^INC-20261109-0300-[0-9A-F]{4}$/), title: 'payments-api 5xx high', severity: 'SEV_2', status: 'TRIGGERED', escalated: false,
      org: { customer: { id: 'cus_mirae', name: 'Mirae Pay', slug: 'mirae' }, project: { slug: 'core' }, service: { slug: 'payments-api' } },
      unmapped: false, awsAccountIds: ['111111111111'], source: 'CLOUDWATCH', memberCount: 2,
      assignee: { contactId: 'ct_haeun', name: 'Haeun Kim' },
      escalation: { state: 'PAGING', step: 0, totalSteps: 4, repeat: 0, repeatCount: 1, nextAt: '2026-11-09T03:02:00.000Z', nextLabel: 'Step 2 · SMS Haeun Kim', mutedByMaintenance: false },
      triggeredAt: '2026-11-09T03:00:00.000Z', acknowledgedAt: null, version: 1,
    });
    const mine = body(await w.call(USERS.haeun, 'GET', '/incidents', { query: { assignee: 'me' } }));
    expect(mine.items.map((i: any) => i.id)).toEqual([w.ids.mirae]);
    expect(body(await w.call(USERS.viewer, 'GET', '/incidents', { query: { assignee: 'me' } })).items).toEqual([]);
  });
});
