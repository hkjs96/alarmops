/** n tenants (`cus_t0` …), one open SEV-1 incident each on one channel; pages are injected straight into the outbox. */
import { runTick, type MemoryTickStore, type NotificationJob, type StepChannel } from '../src/index.js';
import { T0, closedGroup, config, seedWorld, step } from './world.js';

const V = new Date('2026-10-01T00:00:00Z');

/** Adds the tenants and opens their incidents. Returns each tenant's template page (already marked SENT). */
export async function seedTenants(store: MemoryTickStore, n: number, channel: (i: number) => StepChannel, now: () => Date): Promise<Map<number, NotificationJob>> {
  for (let i = 0; i < n; i++) {
    const cid = `cus_t${i}`; const p = `ct_t${i}`; const acct = `40000000${String(i).padStart(4, '0')}`;
    store.customers.set(cid, { id: cid, name: `T${i}`, slug: `t${i}` });
    store.accounts.set(acct, { awsAccountId: acct, customerId: cid, serviceId: null });
    store.contacts.set(p, { id: p, kind: 'CUSTOMER', customerId: cid, name: `P${i}`, active: true, phone: `+82105550${String(i).padStart(4, '0')}`, email: `${p}@example.test`, slackUserId: `U${p}`, phoneVerifiedAt: V, emailVerifiedAt: V, slackVerifiedAt: V });
    store.responders.push({ customerId: cid, contactId: p, role: 'PAGEABLE' });
    store.configs.push(config(cid, [step(0, 0, 'PERSON', p, [channel(i)])], { repeatCount: 0 }));
    closedGroup(store, { customerId: cid, awsAccountId: acct, severity: 'SEV_1', at: T0, alerts: [{ id: `al_${i}` }] });
  }
  await runTick({ scheduledAt: T0, jobs: ['group', 'escalation'] }, { repo: store, senders: {}, now });
  const base = new Map<number, NotificationJob>();
  for (let i = 0; i < n; i++) {
    const inc = [...store.incidents.values()].find((x) => x.customerId === `cus_t${i}`)!;
    const b = store.jobList(inc.id)[0]!;
    base.set(i, structuredClone(b));
    b.status = 'SENT'; // callers inject their own pages
  }
  return base;
}

/** Stand-alone variant for tests that drive `runTick` themselves (store clock = Date.now, so fake timers move it). */
export async function tenants(n: number, channel: (i: number) => StepChannel) {
  const store = seedWorld();
  const now = (): Date => new Date(Date.now());
  store.clock = now;
  const base = await seedTenants(store, n, channel, now);
  store.ticks.clear();
  const inject = (i: number, count: number, tag = 'x'): void => {
    const b = base.get(i)!;
    const when = now();
    for (let k = 0; k < count; k++) {
      const key = `${b.idempotencyKey}#${tag}_${k}`;
      store.jobs.set(key, { ...structuredClone(b), id: `job_${i}_${tag}_${k}`, idempotencyKey: key, nextAttemptAt: when, dueAt: when, createdAt: when, status: 'QUEUED', attempts: 0, claimSeq: 0, lastError: null });
    }
  };
  return { store, inject };
}
