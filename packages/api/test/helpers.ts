import { Sim, T0, at, closedGroup, PATTERNS, seedWorld } from '../../core/test/world.js';
import { createApi, MemoryApiStore, type ApiRequest, type ApiResponse, type AuthContext } from '../src/index.js';

export { T0, at, closedGroup, PATTERNS };

export const USERS = {
  /** MSP operator, responder for Mirae Pay only. */
  haeun: { userId: 'usr_haeun', name: 'Haeun Kim', kind: 'INTERNAL', customerIds: '*', role: 'OPERATOR' },
  /** MSP admin, responder for Hanbit only. */
  minjae: { userId: 'usr_minjae', name: 'Minjae Lee', kind: 'INTERNAL', customerIds: '*', role: 'ADMIN' },
  viewer: { userId: 'usr_viewer', name: 'Viewer', kind: 'INTERNAL', customerIds: '*', role: 'VIEWER' },
  /** Portal user of Mirae Pay. */
  yuna: { userId: 'usr_yuna', name: 'Yuna Seo', kind: 'CUSTOMER', customerIds: ['cus_mirae'], role: 'VIEWER' },
  /** Portal user of Hanbit. */
  dohyun: { userId: 'usr_dohyun', name: 'Dohyun Han', kind: 'CUSTOMER', customerIds: ['cus_hanbit'], role: 'VIEWER' },
} satisfies Record<string, AuthContext>;

export interface World {
  store: MemoryApiStore;
  sim: Sim;
  call: (auth: AuthContext | null, method: ApiRequest['method'], path: string, opts?: { query?: Record<string, string | undefined>; body?: unknown; headers?: Record<string, string>; requestId?: string }) => Promise<ApiResponse>;
  /** Incident ids by short name. */
  ids: { mirae: string; hanbit: string; unmapped: string };
}

/**
 * Two customers with one open incident each plus one from an unmapped AWS account, opened by a real tick at T0.
 * Mirae Pay uses the Standard template on the shared rotation; Hanbit uses its own rotation (Urgent).
 */
export async function world(): Promise<World> {
  const store = seedWorld(new MemoryApiStore()) as MemoryApiStore;
  for (const [id, name, contactId] of [['usr_haeun', 'Haeun Kim', 'ct_haeun'], ['usr_minjae', 'Minjae Lee', 'ct_minjae'], ['usr_viewer', 'Viewer', null], ['usr_yuna', 'Yuna Seo', 'ct_yuna'], ['usr_dohyun', 'Dohyun Han', 'ct_dohyun']] as const) {
    store.users.set(id, { id, name, contactId });
  }
  store.configs.push(PATTERNS.templateStandard(), PATTERNS.customerRotation());
  store.contactScopes.push({ contactId: 'ct_seojun', customerId: 'cus_mirae', scopeType: 'SERVICE', scopeId: 'svc_pay', role: 'NOTIFY' });
  store.resources.set('res_web1', { id: 'res_web1', name: 'web-1', customerId: 'cus_mirae', serviceId: 'svc_pay' });
  store.resources.set('res_shop', { id: 'res_shop', name: 'shop-db', customerId: 'cus_hanbit', serviceId: 'svc_web' });
  store.verifiedSlack.add('cus_mirae');
  const sim = new Sim(store);
  closedGroup(store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_m1', title: 'payments-api 5xx high' }, { id: 'al_m2' }] });
  closedGroup(store, { customerId: 'cus_hanbit', severity: 'SEV_3', at: T0, alerts: [{ id: 'al_h1', title: 'shop-db connections high' }] });
  closedGroup(store, { customerId: null, at: T0, alerts: [{ id: 'al_u1', title: 'unknown account disk' }] });
  await sim.tick();
  const by = (customerId: string | null) => [...store.incidents.values()].find((i) => i.customerId === customerId)!.id;
  const api = createApi({ repo: store, now: () => sim.now });
  let seq = 0;
  return {
    store, sim, ids: { mirae: by('cus_mirae'), hanbit: by('cus_hanbit'), unmapped: by(null) },
    call: (auth, method, path, opts = {}) => api.handle({ method, path, auth, query: opts.query, body: opts.body, headers: opts.headers, requestId: opts.requestId ?? `req_${++seq}` }),
  };
}

export const version = (w: World, id: string): string => String(w.store.incidents.get(id)!.version);
export const body = <T = any>(r: ApiResponse): T => r.body as T;
/** Bytes a client would receive: status line, headers, JSON body. */
export const wire = (r: ApiResponse): string => JSON.stringify([r.status, Object.entries(r.headers).sort(), r.body]);
