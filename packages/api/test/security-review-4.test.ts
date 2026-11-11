/**
 * Regression tests for the fourth security review (API side).
 * R-23 — `normalizeAuth` copies lists by index and checks the COPY; R-18 follow-up — an entry with both ids;
 * R-20 — who reads the provider's error text (STORE_PROVIDER_TEXT).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { copyPlainArray, inScope, nodeVisible, normalizeAuth, scopeOf, serializerFor, type AuthContext } from '../src/index.js';
import { USERS, body, world } from './helpers.js';

const proto = Object.prototype as unknown as Record<string, unknown>;
afterEach(() => { for (const k of ['projectId', 'serviceId', 'customerId', '0', 'length']) delete proto[k]; delete (Array.prototype as unknown as Record<string, unknown>)['1']; });

const withIter = <T,>(arr: T[], it: () => Iterator<unknown>): T[] => { (arr as unknown as Record<symbol, unknown>)[Symbol.iterator] = it; return arr; };
/* eslint-disable @typescript-eslint/no-explicit-any */
class Sub extends Array<unknown> { [Symbol.iterator](): any { return [][Symbol.iterator](); /* yields nothing */ } }
/** An index whose first read gives `a` and every later read gives `b`. */
const flip = (a: unknown, b: unknown): unknown[] => { let n = 0; const arr: unknown[] = []; Object.defineProperty(arr, 0, { get: () => (n++ === 0 ? a : b), enumerable: true, configurable: true }); return arr; };
const N = { customerId: 'cus_mirae', projectId: 'prj_data' };

/** Lists that show one thing to a check and another to a copy (the reviewer's v4/api.mts, and more). */
const HOSTILE_IDS: Array<[string, () => unknown]> = [
  ['own Symbol.iterator yields cus_hanbit', () => withIter(['cus_mirae'], function* () { yield 'cus_hanbit'; })],
  ['own Symbol.iterator yields an extra id', () => withIter(['cus_mirae'], function* () { yield 'cus_mirae'; yield 'cus_hanbit'; })],
  ['Proxy(array): iterator → cus_hanbit', () => new Proxy(['cus_mirae'], { get: (t, k, r) => (k === Symbol.iterator ? function* () { yield 'cus_hanbit'; } : Reflect.get(t, k, r)) })],
  ['Proxy(array): transparent', () => new Proxy(['cus_mirae'], {})],
  ['Proxy(array): every() → true', () => new Proxy(['cus_hanbit', 7], { get: (t, k, r) => (k === 'every' ? () => true : Reflect.get(t, k, r)) })],
  ['index getter: cus_mirae first, cus_hanbit afterwards', () => flip('cus_mirae', 'cus_hanbit')],
  ['index getter that always answers cus_mirae', () => flip('cus_mirae', 'cus_mirae')],
  ['Array subclass', () => { const s = new Sub(); Array.prototype.push.call(s, 'cus_mirae'); return s; }],
  ['Array subclass with every() overridden', () => { class E extends Array<unknown> {} (E.prototype as any).every = () => true; const e = new E(); Array.prototype.push.call(e, 'cus_hanbit', 7); return e; }],
  ['prototype swapped to a look-alike', () => Object.setPrototypeOf(['cus_mirae'], Object.create(Array.prototype, { [Symbol.iterator]: { value: function* () { yield 'cus_hanbit'; } } }) as object)],
  ['hole', () => { const a: unknown[] = ['cus_mirae']; a.length = 2; return a; }],
  ['hole filled from Array.prototype', () => { (Array.prototype as unknown as Record<string, unknown>)['1'] = 'cus_hanbit'; const a: unknown[] = ['cus_mirae']; a.length = 2; return a; }],
  ['extra own key', () => Object.assign(['cus_mirae'], { also: 'cus_hanbit' })],
  ['array-like object', () => ({ 0: 'cus_mirae', length: 1 })],
  ['Set', () => new Set(['cus_mirae'])],
  ['arguments object', () => (function (..._a: unknown[]) { return arguments; })('cus_mirae')], // eslint-disable-line prefer-rest-params
  ['typed array', () => new Uint8Array([1])],
  ['nested array', () => [['cus_mirae']]],
  ['String objects', () => [new String('cus_mirae')]],
];

describe('R-23: customerIds — the list that is checked is the list that is used', () => {
  it.each(HOSTILE_IDS)('%s → 401, and never another customer’s incident (was: cus_hanbit read with 200)', async (_n, make) => {
    const auth = { ...USERS.yuna, customerIds: make() } as unknown as AuthContext;
    expect(normalizeAuth(auth)).toBeNull();
    const w = await world();
    for (const id of [w.ids.hanbit, w.ids.mirae]) expect((await w.call({ ...USERS.yuna, customerIds: make() } as unknown as AuthContext, 'GET', `/incidents/${id}`)).status).toBe(401);
    expect((await w.call({ ...USERS.yuna, customerIds: make() } as unknown as AuthContext, 'GET', '/incidents')).status).toBe(401);
  });

  it('plain arrays still work: literal, frozen, JSON.parse, Array.from, sealed; the result is a frozen copy', async () => {
    const w = await world();
    for (const ids of [['cus_mirae'], Object.freeze(['cus_mirae']), JSON.parse('["cus_mirae"]') as string[], Array.from(new Set(['cus_mirae'])), Object.seal(['cus_mirae'])]) {
      const a = normalizeAuth({ ...USERS.yuna, customerIds: ids })!;
      expect(a.customerIds).toEqual(['cus_mirae']);
      expect(a.customerIds).not.toBe(ids);
      expect(Object.isFrozen(a.customerIds)).toBe(true);
      expect((await w.call({ ...USERS.yuna, customerIds: ids } as AuthContext, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(200);
      expect((await w.call({ ...USERS.yuna, customerIds: ids } as AuthContext, 'GET', `/incidents/${w.ids.hanbit}`)).status).toBe(404);
    }
    const mine = ['cus_mirae'];
    const a = normalizeAuth({ ...USERS.yuna, customerIds: mine })!;
    mine[0] = 'cus_hanbit'; mine.push('cus_hanbit');
    expect(a.customerIds).toEqual(['cus_mirae']); // changing the adapter's list afterwards changes nothing
    expect(normalizeAuth({ ...USERS.yuna, customerIds: [] })!.customerIds).toEqual([]);
  });

  it('a session object that is a Proxy is refused as a whole', () => {
    expect(normalizeAuth(new Proxy({ ...USERS.yuna }, {}))).toBeNull();
    expect(normalizeAuth(new Proxy({ ...USERS.minjae }, { get: (t, k, r) => (k === 'customerIds' ? '*' : Reflect.get(t, k, r)) }))).toBeNull();
  });

  it('copyPlainArray never calls the input’s iterator, methods or getters', () => {
    let touched = 0;
    const spy = (): never => { touched++; throw new Error('touched'); };
    const arr = ['a', 'b'];
    for (const k of ['every', 'map', 'slice', 'forEach', 'includes', 'toString', 'toJSON']) Object.defineProperty(arr, k, { value: spy, enumerable: false });
    expect(copyPlainArray(arr)).toBeNull(); // extra own keys
    expect(copyPlainArray(withIter(['a'], spy))).toBeNull();
    expect(copyPlainArray(new Proxy(['a'], { get: spy, ownKeys: spy, getOwnPropertyDescriptor: spy, getPrototypeOf: spy, has: spy }))).toBeNull();
    const getter: unknown[] = []; Object.defineProperty(getter, 0, { get: spy, enumerable: true });
    expect(copyPlainArray(getter)).toBeNull();
    expect(touched).toBe(0);
    expect(copyPlainArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('property: 600 random hostile lists — the result is null, or exactly the honest list; an id of another tenant never gets in', () => {
    // mulberry32
    let seed = 0x5eed4;
    const rnd = (): number => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const OWN = ['cus_mirae', 'cus_a', 'cus_b'];
    const OTHER = ['cus_hanbit', 'cus_x', '*'];
    let accepted = 0; let refused = 0;
    for (let i = 0; i < 600; i++) {
      const honest = Array.from({ length: Math.floor(rnd() * 4) }, () => pick(OWN));
      const evil = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(OTHER));
      const base = [...honest];
      const kind = Math.floor(rnd() * 10);
      let input: unknown;
      let plain = false;
      if (kind === 0) { input = base; plain = true; }
      else if (kind === 1) { input = Object.freeze(base); plain = true; }
      else if (kind === 2) input = withIter(base, function* () { yield* evil; });
      else if (kind === 3) input = new Proxy(base, { get: (t, k, r) => (k === Symbol.iterator ? function* () { yield* evil; } : typeof k === 'string' && /^\d+$/.test(k) && rnd() < 0.5 ? pick(evil) : Reflect.get(t, k, r)) });
      else if (kind === 4) { const a: unknown[] = []; honest.forEach((h, x) => { let n = 0; Object.defineProperty(a, x, { get: () => (n++ === 0 ? h : pick(evil)), enumerable: true, configurable: true }); }); input = a; plain = honest.length === 0; }
      else if (kind === 5) { class S extends Array<unknown> { [Symbol.iterator](): any { return evil[Symbol.iterator](); } } const s = new S(); Array.prototype.push.apply(s, base); input = s; }
      else if (kind === 6) input = Object.assign(base, { [pick(['extra', 'every', 'map', 'includes'])]: () => true });
      else if (kind === 7) { base.length = base.length + 1; input = base; }
      else if (kind === 8) input = new Proxy(base, { ownKeys: (t) => Reflect.ownKeys(t), getOwnPropertyDescriptor: (t, k) => (rnd() < 0.5 ? Reflect.getOwnPropertyDescriptor(t, k) : { value: pick(evil), writable: true, enumerable: true, configurable: true }) });
      else input = { ...honest, length: honest.length };
      const got = normalizeAuth({ userId: 'u', kind: 'CUSTOMER', customerIds: input });
      if (got === null) { refused++; expect(plain, `case ${i} kind ${kind}`).toBe(false); continue; }
      accepted++;
      expect(plain, `case ${i} kind ${kind} was accepted`).toBe(true);
      expect(got.customerIds, `case ${i} kind ${kind}`).toEqual(honest);
      for (const id of got.customerIds as readonly string[]) expect(OTHER).not.toContain(id);
    }
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(300);
  });
});

describe('R-23: subScopes — the list and every entry are copied before they are checked', () => {
  const HOSTILE_SUBS: Array<[string, () => unknown]> = [
    ['own Symbol.iterator yields nothing', () => withIter([{ ...N }], function* () { /* nothing */ })],
    ['own Symbol.iterator yields a whole-customer entry', () => withIter([{ ...N }], function* () { yield { customerId: 'cus_mirae' }; })],
    ['Array subclass whose iterator yields nothing', () => { const s = new Sub(); Array.prototype.push.call(s, { ...N }); return s; }],
    ['Proxy(array) answering length 0', () => new Proxy([{ ...N }], { get: (t, k, r) => (k === 'length' ? 0 : k === Symbol.iterator ? function* () { /* nothing */ } : Reflect.get(t, k, r)) })],
    ['Proxy(array), transparent', () => new Proxy([{ ...N }], {})],
    ['Proxy entry: ownKeys hides projectId, has → false', () => [new Proxy({ ...N }, { ownKeys: () => ['customerId'], has: (_t, k) => k === 'customerId', getOwnPropertyDescriptor: (t, k) => (k === 'projectId' ? undefined : Reflect.getOwnPropertyDescriptor(t, k)) })]],
    ['Proxy entry: transparent', () => [new Proxy({ ...N }, {})]],
    ['Proxy entry: projectId answers once', () => { let n = 0; return [new Proxy({ ...N }, { getOwnPropertyDescriptor: (t, k) => (k === 'projectId' && n++ > 0 ? undefined : Reflect.getOwnPropertyDescriptor(t, k)) })]; }],
    ['index getter: narrowed entry first, whole customer afterwards', () => flip({ ...N }, { customerId: 'cus_mirae' })],
    ['entry of a class', () => [Object.assign(new (class Entry {})(), N)]],
    ['entry is a Map', () => [new Map(Object.entries(N))]],
    ['hole', () => { const a: unknown[] = [{ ...N }]; a.length = 2; return a; }],
    ['array-like', () => ({ 0: { ...N }, length: 1 })],
    ['Set', () => new Set([{ ...N }])],
  ];
  it.each(HOSTILE_SUBS)('%s → 401 (was: the whole customer)', async (_n, make) => {
    expect(normalizeAuth({ ...USERS.yuna, subScopes: make() })).toBeNull();
    const w = await world(); // the Mirae incident is in prj_core, outside the narrowing to prj_data
    expect((await w.call({ ...USERS.yuna, subScopes: make() } as unknown as AuthContext, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(401);
    expect((await w.call({ ...USERS.minjae, customerIds: ['cus_mirae'], subScopes: make() } as unknown as AuthContext, 'GET', '/customers/mirae/paging')).status).toBe(401);
  });

  it('plain entries still narrow; a null-prototype entry is fine; the copy is frozen and detached', async () => {
    const w = await world();
    const entry = { ...N };
    const a = normalizeAuth({ ...USERS.yuna, subScopes: [entry, Object.assign(Object.create(null) as object, { customerId: 'cus_mirae', serviceId: 'svc_pay' })] })!;
    expect(a.subScopes).toEqual([{ customerId: 'cus_mirae', projectId: 'prj_data' }, { customerId: 'cus_mirae', serviceId: 'svc_pay' }]);
    entry.projectId = 'prj_core';
    expect(a.subScopes![0]!.projectId).toBe('prj_data');
    expect(Object.isFrozen(a.subScopes)).toBe(true);
    expect((await w.call({ ...USERS.yuna, subScopes: [{ ...N }] } as AuthContext, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(404);
    expect((await w.call({ ...USERS.yuna, subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_core' }] } as AuthContext, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(200);
  });
});

describe('R-23 (같이 볼 것): an entry with BOTH projectId and serviceId means that service in that project', () => {
  it('a pair that does not belong together grants nothing (was: the service alone, in another project)', async () => {
    const w = await world(); // the Mirae incident is in prj_core / svc_pay
    const wrong = { ...USERS.yuna, subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_data', serviceId: 'svc_pay' }] } as AuthContext;
    const right = { ...USERS.yuna, subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_core', serviceId: 'svc_pay' }] } as AuthContext;
    expect((await w.call(wrong, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(404); // was 200
    expect((await w.call(right, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(200);
    const e = { customerId: 'cus_mirae', projectId: 'prj_core', serviceId: 'svc_pay' };
    expect(inScope(scopeOf(normalizeAuth(wrong)!), e)).toBe(false);
    expect(inScope(scopeOf(normalizeAuth(right)!), e)).toBe(true);
    const projectOf = (id: string): string | undefined => (id === 'svc_pay' ? 'prj_core' : undefined);
    for (const node of [{ customerId: 'cus_mirae', projectId: 'prj_core', serviceId: 'svc_pay' }, { customerId: 'cus_mirae', projectId: 'prj_core' }, { customerId: 'cus_mirae', projectId: 'prj_data' }]) {
      expect(nodeVisible(scopeOf(normalizeAuth(wrong)!), node, projectOf)).toBe(false);
    }
    expect(nodeVisible(scopeOf(normalizeAuth(right)!), { customerId: 'cus_mirae', projectId: 'prj_core', serviceId: 'svc_pay' }, projectOf)).toBe(true);
  });
});

describe('R-20: who reads the provider’s error text (STORE_PROVIDER_TEXT, default false)', () => {
  const sms = (r: Awaited<ReturnType<World['call']>>): { error: string | null; reason: string } => body(r).items.find((x: { channel: string; status: string }) => x.channel === 'SMS' && x.status === 'FAILED');
  type World = Awaited<ReturnType<typeof world>>;
  /** A FAILED SMS row with 301 characters of (already masked) provider text — what a row stored with the switch ON looks like. */
  const failedSms = (w: World): void => {
    const like = w.store.logs.find((l) => l.incidentId === w.ids.mirae)!;
    w.store.logs.push({ ...like, id: 'log_failed_sms', channel: 'SMS', status: 'FAILED', targetSummary: 'Haeun Kim', targetKind: 'STAFF', providerMessageId: null, errorCode: 'PROVIDER_REJECTED', error: `vendor said [number] ${'x'.repeat(280)}` });
  };

  it('default: ADMIN gets a masked excerpt of at most 120 characters; OPERATOR, VIEWER and the portal get the reason code only', async () => {
    const w = await world();
    const path = `/incidents/${w.ids.mirae}/notifications`;
    // a row as it would look had it been stored while the switch was on: 300 masked characters
    failedSms(w);
    const admin = sms(await w.call(USERS.minjae, 'GET', path));
    expect(admin.reason).toBe('PROVIDER_REJECTED');
    expect(admin.error).toHaveLength(120);
    expect(admin.error!.startsWith('vendor said [number] ')).toBe(true);
    for (const u of [USERS.haeun, USERS.viewer]) expect(sms(await w.call(u, 'GET', path))).toMatchObject({ reason: 'PROVIDER_REJECTED', error: null });
    const portal = body(await w.call(USERS.yuna, 'GET', path));
    expect(JSON.stringify(portal)).not.toMatch(/vendor|"error"/);
  });

  it('switched on (boolean true only): OPERATOR and ADMIN read the masked text, VIEWER still does not', async () => {
    const w = await world({ config: { storeProviderText: true } });
    const path = `/incidents/${w.ids.mirae}/notifications`;
    failedSms(w);
    expect(sms(await w.call(USERS.haeun, 'GET', path)).error).toHaveLength(301);
    expect(sms(await w.call(USERS.minjae, 'GET', path)).error).toHaveLength(301);
    expect(sms(await w.call(USERS.viewer, 'GET', path)).error).toBeNull();
    for (const v of ['true', 1, 'yes', {}, null, undefined]) {
      const off = await world({ config: { storeProviderText: v as never } });
      failedSms(off);
      expect(sms(await off.call(USERS.haeun, 'GET', `/incidents/${off.ids.mirae}/notifications`)).error, String(v)).toBeNull();
    }
    const l = { id: 'l', at: new Date(), customerId: null, incidentId: 'i', jobId: 'j', channel: 'SMS', status: 'FAILED', targetSummary: 't', targetKind: 'STAFF', contactId: null, escalationStep: 0, attempt: 1, providerMessageId: null, error: 'e'.repeat(200), errorCode: 'TIMEOUT', warnings: [] } as never;
    expect((serializerFor({ kind: 'INTERNAL', role: 'OPERATOR' }).notification(l) as { error: unknown }).error).toBeNull();
    expect((serializerFor({ kind: 'INTERNAL', role: 'ADMIN' }).notification(l) as { error: string }).error).toHaveLength(120);
    expect((serializerFor({ kind: 'INTERNAL', role: 'OPERATOR' }, { portalShowsStaffNames: false, storeProviderText: 'true' as never }).notification(l) as { error: unknown }).error).toBeNull();
  });
});
