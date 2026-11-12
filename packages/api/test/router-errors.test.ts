/** An unexpected error is logged as its tag (name + pg code), never its raw message, and answered with a generic 500. */
import { expect, it } from 'vitest';
import { authFromPrincipal, createApi, MemoryApiStore } from '../src/index.js';
import { USERS } from './helpers.js';
import { seedWorld } from '../../core/test/world.js';

it('500 INTERNAL: neither the log nor the body carries the raw message', async () => {
  const repo = seedWorld(new MemoryApiStore()) as MemoryApiStore;
  const secret = 'relation "Contact" row (phone)=(+821012345678) postgres://u:pw@db';
  repo.respondersState = async () => { throw Object.assign(new Error(secret), { code: '42P01' }); };
  const logs: unknown[] = [];
  const api = createApi({ repo, log: (...a) => { logs.push(a); } });
  const res = await api.handle({ method: 'GET', path: '/customers/cus_mirae/responders', auth: USERS.minjae, requestId: 'req_1' });
  expect(res.status).toBe(500);
  const text = JSON.stringify(res.body) + JSON.stringify(logs);
  expect(text).not.toContain('postgres://');
  expect(text).not.toContain('+821012345678');
  expect(logs).toEqual([['error', 'unhandled', { requestId: 'req_1', path: '/customers/cus_mirae/responders', error: 'Error code=42P01' }]]);
});

it('GET /me with an AuthContext from authFromPrincipal does not look the principal up a second time', async () => {
  const repo = seedWorld(new MemoryApiStore()) as MemoryApiStore;
  repo.users.set('usr_minjae', { id: 'usr_minjae', name: 'Minjae Lee', contactId: 'ct_minjae', email: 'minjae@example.test', role: 'ADMIN', customerId: null });
  const auth = authFromPrincipal((await repo.sessionPrincipal('usr_minjae'))!);
  let lookups = 0;
  repo.sessionPrincipal = async () => { lookups++; return null; };
  const res = await createApi({ repo }).handle({ method: 'GET', path: '/me', auth, requestId: 'req_2' });
  expect(res.body).toEqual({ id: 'usr_minjae', name: 'Minjae Lee', email: 'minjae@example.test', role: 'ADMIN', kind: 'INTERNAL' });
  expect(lookups).toBe(0);
});
