/** Regression tests for the third security review (API side): R-18 — a subScopes entry is exact, or the session is refused. */
import { afterEach, describe, expect, it } from 'vitest';
import { customerWide, inScope, normalizeAuth, scopeOf, type AuthContext } from '../src/index.js';
import { USERS, world } from './helpers.js';

const proto = Object.prototype as unknown as Record<string, unknown>;
afterEach(() => { for (const k of ['projectId', 'serviceId', 'customerId']) delete proto[k]; });

class Narrowed {
  constructor(readonly customerId: string, private readonly p: string) {}
  get projectId(): string { return this.p; }
}
const accessor = (customerId: string, key: 'projectId' | 'serviceId', value: string): object =>
  Object.defineProperty({ customerId }, key, { get: () => value, enumerable: true });

/** Every way the reviewer (and we) could make a narrowing key look absent, or carry something that is not an id. */
const BAD_ENTRIES: Array<[string, () => unknown]> = [
  ['class getter', () => new Narrowed('cus_mirae', 'prj_data')],
  ['inherited projectId', () => Object.assign(Object.create({ projectId: 'prj_data' }) as object, { customerId: 'cus_mirae' })],
  ['inherited serviceId', () => Object.assign(Object.create({ serviceId: 'svc_pay' }) as object, { customerId: 'cus_mirae' })],
  ['defineProperty accessor (projectId)', () => accessor('cus_mirae', 'projectId', 'prj_data')],
  ['defineProperty accessor (serviceId)', () => accessor('cus_mirae', 'serviceId', 'svc_pay')],
  ['accessor customerId', () => Object.defineProperty({ projectId: 'prj_data' }, 'customerId', { get: () => 'cus_mirae', enumerable: true })],
  ['inherited customerId', () => Object.assign(Object.create({ customerId: 'cus_mirae' }) as object, { projectId: 'prj_data' })],
  ['projectId: undefined', () => ({ customerId: 'cus_mirae', projectId: undefined })],
  ['projectId: null', () => ({ customerId: 'cus_mirae', projectId: null })],
  ['projectId: ""', () => ({ customerId: 'cus_mirae', projectId: '' })],
  ['projectId: number', () => ({ customerId: 'cus_mirae', projectId: 7 })],
  ['projectId: array', () => ({ customerId: 'cus_mirae', projectId: ['prj_data'] })],
  ['projectId: String object', () => ({ customerId: 'cus_mirae', projectId: new String('prj_data') })],
  ['serviceId: object', () => ({ customerId: 'cus_mirae', serviceId: { toString: () => 'svc_pay' } })],
  ['typo project_id', () => ({ customerId: 'cus_mirae', project_id: 'prj_data' })],
  ['typo projectID', () => ({ customerId: 'cus_mirae', projectID: 'prj_data' })],
  ['extra key', () => ({ customerId: 'cus_mirae', projectId: 'prj_data', level: 'PROJECT' })],
  ['symbol key', () => ({ customerId: 'cus_mirae', [Symbol('projectId')]: 'prj_data' })],
  ['non-enumerable extra key', () => Object.defineProperty({ customerId: 'cus_mirae' }, 'scope', { value: 'prj_data', enumerable: false })],
  ['Proxy hiding its keys', () => new Proxy({ customerId: 'cus_mirae', projectId: 'prj_data' }, { getOwnPropertyDescriptor: (t, k) => (k === 'projectId' ? undefined : Reflect.getOwnPropertyDescriptor(t, k)) })],
  ['array entry', () => ['cus_mirae', 'prj_data']],
  ['string entry', () => 'cus_mirae'],
  ['null entry', () => null],
];

describe('R-18: a subScopes entry whose projectId / serviceId is not an own string data property is refused, never dropped', () => {
  it.each(BAD_ENTRIES)('%s → 401 (was: the whole customer)', async (_name, make) => {
    for (const base of [{ ...USERS.yuna }, { ...USERS.minjae, customerIds: ['cus_mirae'] }]) {
      const auth = { ...base, subScopes: [make()] } as unknown as AuthContext;
      expect(normalizeAuth(auth)).toBeNull();
      const w = await world();
      expect((await w.call(auth, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(401);
      expect((await w.call(auth, 'GET', '/incidents')).status).toBe(401);
    }
  });

  it('one bad entry refuses the session even next to good ones; holes in the list too', () => {
    const good = { customerId: 'cus_mirae', projectId: 'prj_core' };
    expect(normalizeAuth({ ...USERS.yuna, subScopes: [good, new Narrowed('cus_mirae', 'prj_data')] })).toBeNull();
    // eslint-disable-next-line no-sparse-arrays
    expect(normalizeAuth({ ...USERS.yuna, subScopes: [good, , good] })).toBeNull();
    expect(normalizeAuth({ ...USERS.yuna, subScopes: [good] })!.subScopes).toEqual([good]);
  });

  it('a polluted Object.prototype.projectId refuses narrowed sessions instead of changing them', () => {
    proto.projectId = 'prj_core';
    expect(normalizeAuth({ ...USERS.yuna, subScopes: [{ customerId: 'cus_mirae' }] })).toBeNull();
    expect(normalizeAuth({ ...USERS.yuna, subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_data' }] })!.subScopes![0]).toMatchObject({ projectId: 'prj_data' });
  });

  it('the reviewer’s reproduction: a portal user narrowed to prj_data through a getter does not read prj_core', async () => {
    const w = await world(); // the Mirae incident is in prj_core / svc_pay
    const plain = { ...USERS.yuna, subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_data' }] } as AuthContext;
    expect((await w.call(plain, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(404);
    for (const entry of [new Narrowed('cus_mirae', 'prj_data'), Object.assign(Object.create({ projectId: 'prj_data' }) as object, { customerId: 'cus_mirae' }), accessor('cus_mirae', 'projectId', 'prj_data')]) {
      const auth = { ...USERS.yuna, subScopes: [entry] } as unknown as AuthContext;
      expect((await w.call(auth, 'GET', `/incidents/${w.ids.mirae}`)).status).toBe(401); // was 200
      const admin = { ...USERS.minjae, customerIds: ['cus_mirae'], subScopes: [entry] } as unknown as AuthContext;
      expect((await w.call(admin, 'GET', '/customers/mirae/paging')).status).toBe(401); // was 200: the customer-level call order
    }
  });
});

describe('R-18 property: normalisation never widens the scope', () => {
  /** mulberry32 */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const CUSTOMERS = ['cus_mirae', 'cus_hanbit'];
  const PROJECTS = ['prj_core', 'prj_data', 'prj_shop'];
  const SERVICES = ['svc_pay', 'svc_web'];
  const ENTITIES = CUSTOMERS.flatMap((customerId) => [null, ...PROJECTS].flatMap((projectId) => [null, ...SERVICES].map((serviceId) => ({ customerId, projectId, serviceId }))));
  const KEYS = ['customerId', 'projectId', 'serviceId'] as const;

  /** What the adapter MEANT: every way of reading the entry — plain access finds getters and inherited values. */
  const meant = (x: unknown): { customerId: unknown; projectId: unknown; serviceId: unknown; extra: boolean } | null => {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
    const o = x as Record<string, unknown>;
    return { customerId: o.customerId, projectId: o.projectId, serviceId: o.serviceId, extra: Reflect.ownKeys(o).some((k) => typeof k !== 'string' || !KEYS.includes(k as never)) };
  };

  function randomEntry(r: () => number): unknown {
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const value = (ids: readonly string[]): unknown => {
      const k = r();
      return k < 0.7 ? pick(ids) : k < 0.76 ? undefined : k < 0.8 ? null : k < 0.84 ? '' : k < 0.88 ? 5 : k < 0.92 ? [pick(ids)] : k < 0.96 ? new String(pick(ids)) : pick(ids).toUpperCase();
    };
    const protoObj: Record<string, unknown> = {};
    const o: Record<string, unknown> = r() < 0.2 ? (Object.create(protoObj) as Record<string, unknown>) : {};
    const put = (key: string, v: unknown): void => {
      const how = r();
      if (how < 0.7) o[key] = v;
      else if (how < 0.8) Object.defineProperty(o, key, { get: () => v, enumerable: r() < 0.5, configurable: true });
      else if (how < 0.9) protoObj[key] = v; // only visible when o inherits from protoObj
      else Object.defineProperty(o, key, { value: v, enumerable: false });
    };
    if (r() < 0.97) put('customerId', value(CUSTOMERS));
    if (r() < 0.6) put('projectId', value(PROJECTS));
    if (r() < 0.4) put('serviceId', value(SERVICES));
    if (r() < 0.08) put(pick(['project_id', 'projectID', 'service', 'level', 'scope']), pick(PROJECTS));
    return o;
  }

  it('2,000 random sessions: accepted → every entry is kept exactly as meant, and nothing outside the meant scope is visible', () => {
    let accepted = 0; let refused = 0; let narrowedAccepted = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed);
      const kind = r() < 0.5 ? 'CUSTOMER' : 'INTERNAL';
      const customerIds: string[] | '*' = kind === 'INTERNAL' && r() < 0.3 ? '*' : CUSTOMERS.filter(() => r() < 0.7);
      const raw = Array.from({ length: Math.floor(r() * 4) }, () => randomEntry(r));
      const auth = normalizeAuth({ userId: 'usr_p', kind, customerIds, role: 'ADMIN', subScopes: raw });
      if (!auth) { refused++; continue; }
      accepted++;
      const out = auth.subScopes ?? [];
      // 1. no entry was dropped, no field was dropped, nothing was added
      expect(out, `seed ${seed}`).toHaveLength(raw.length);
      raw.forEach((x, i) => {
        const m = meant(x)!;
        expect(m.extra, `seed ${seed}`).toBe(false);
        for (const k of KEYS) {
          expect(out[i]![k], `seed ${seed} entry ${i} ${k}`).toBe(m[k]);
          expect(k in out[i]!, `seed ${seed} entry ${i} has ${k}`).toBe(k in (x as object));
          if (m[k] !== undefined) expect(typeof m[k]).toBe('string');
        }
      });
      // 2. what is visible is visible under the meant narrowing too (computed directly from the raw entries)
      const scope = scopeOf(auth);
      const meantList = raw.map((x) => meant(x)!);
      if (meantList.some((m) => m.projectId || m.serviceId)) narrowedAccepted++;
      for (const e of ENTITIES) {
        const has = customerIds === '*' || customerIds.includes(e.customerId);
        const subs = meantList.filter((m) => m.customerId === e.customerId);
        const allowed = has && (subs.length === 0 || subs.some((m) => (m.serviceId ? m.serviceId === e.serviceId : m.projectId ? m.projectId === e.projectId : true)));
        if (inScope(scope, e)) expect(allowed, `seed ${seed} ${JSON.stringify(e)}`).toBe(true);
        if (customerWide(scope, e.customerId)) expect(has && (subs.length === 0 || subs.some((m) => !m.projectId && !m.serviceId)), `seed ${seed} customer-wide ${e.customerId}`).toBe(true);
      }
    }
    // the generator really produces both outcomes
    expect(accepted).toBeGreaterThan(200);
    expect(refused).toBeGreaterThan(200);
    expect(narrowedAccepted).toBeGreaterThan(50);
  });
});
