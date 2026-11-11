/**
 * Lane fairness on a store, by numbers — the scenarios of test/real-engine.ts (security reviews 4 and 5), driven
 * through the store contract fixture so the SAME runs go against MemoryTickStore and the SQL store.
 * Real `runTick`, fake provider, fake timers (timeout 10 s, one tick a minute, budget 45 s). The store's clock is
 * the simulated time; store calls themselves are real I/O on the SQL side and take no simulated time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryTickStore, groupId, groupKey, runTick, type NotificationJob, type OutboundMessage, type SendResult, type TickRepository } from '../../src/index.js';
import type { MakeFixture, StoreFixture } from './fixture.js';

export const T0 = new Date('2026-11-09T03:00:00Z');
export const at = (min: number, sec = 0): Date => new Date(T0.getTime() + min * 60_000 + sec * 1000);
const MIN = 60_000;
const SEND_TIMEOUT = 10_000;
const SAME_TICK = 45_000;
const LIMIT = 60_000;
const V = new Date('2026-10-01T00:00:00Z');
const clock = (): Date => new Date(Date.now());
/** The real event loop, taken before any test fakes the timers: store I/O needs it to make progress. */
const realImmediate = setImmediate;
const realTurn = (): Promise<void> => new Promise((r) => realImmediate(r));

type Lane = 'VOICE' | 'SMS' | 'EMAIL' | 'SLACK_DM';

/** Wait until the store has nothing in flight and nothing runnable is left. */
async function quiet(fx: StoreFixture): Promise<void> {
  for (let calm = 0; calm < 2;) {
    await vi.advanceTimersByTimeAsync(0);
    await realTurn();
    calm = fx.busy() ? 0 : calm + 1;
  }
}

/** Let a promise finish on the fake clock: wait for the store, then jump to the next timer, repeat. */
export async function settle<T>(fx: StoreFixture, p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; !done; i++) {
    await quiet(fx);
    if (done) break;
    if (i > 200_000) throw new Error('the tick does not finish');
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
  }
  return p;
}

interface World { fx: StoreFixture; inject(i: number, count: number, when: Date, tag: string, opts?: { ownContact?: boolean }): Promise<string[]> }

/** `n` tenants, one person and one open incident each (opened by the engine); pages are injected into the outbox. */
async function world(make: MakeFixture, n: number, lane: Lane, sev: (i: number) => string = () => 'SEV_1'): Promise<World> {
  vi.setSystemTime(T0);
  const seed = new MemoryTickStore();
  seed.slackChannels.set('msp', ['C_MSP']);
  const person = (id: string, customerId: string, name: string, k: number) => ({ id, kind: 'CUSTOMER' as const, customerId, name, active: true, phone: `+8210555${String(k).padStart(5, '0')}`, email: `${id}@example.test`, slackUserId: `U${id}`, phoneVerifiedAt: V, emailVerifiedAt: V, slackVerifiedAt: V });
  for (let i = 0; i < n; i++) {
    const cid = `cus_t${i}`; const p = `ct_t${i}`; const acct = `40000000${String(i).padStart(4, '0')}`;
    seed.customers.set(cid, { id: cid, name: `T${i}`, slug: `t${i}` });
    seed.accounts.set(acct, { awsAccountId: acct, customerId: cid, serviceId: null });
    seed.contacts.set(p, person(p, cid, `P${i}`, i));
    seed.responders.push({ customerId: cid, contactId: p, role: 'PAGEABLE' });
    seed.configs.push({ id: `pc_${cid}`, customerId: cid, scopeType: 'CUSTOMER', scopeId: cid, style: 'CUSTOM', plan: 'STANDARD', edited: false, repeatCount: 0, version: 1, steps: [{ index: 0, atMin: 0, targetType: 'PERSON', targetId: p, channels: [lane] }] });
    const severity = sev(i) as 'SEV_1';
    const key = groupKey({ customerId: cid, awsAccountId: acct, severity });
    const openedAt = new Date(T0.getTime() - 40_000);
    const gid = groupId(key, openedAt);
    seed.groups.set(gid, { id: gid, groupKey: key, customerId: cid, severity, status: 'CLOSED', openedAt, groupWaitSec: 30, closeAt: new Date(T0.getTime() - 10_000), closedAt: new Date(T0.getTime() - 10_000), pauseUntil: null, staleAfter: new Date(T0.getTime() + 300_000), deliveredAt: null, version: 1 });
    seed.members.set(gid, [{ alertId: `al_${i}`, fingerprint: `fp:al_${i}`, severity, title: `al_${i} high`, awsAccountId: acct, resourceType: 'EC2', source: 'CLOUDWATCH', decision: 'NOTIFY', episodeOpen: true, eventCount: 1 }]);
    seed.episodes.set(`al_${i}`, true);
  }
  const fx = await settleBoot(make(seed));
  fx.setClock(clock);
  await settle(fx, runTick({ scheduledAt: T0, jobs: ['group', 'escalation'] }, { repo: fx.repo, senders: {}, now: clock }));
  const bases = new Map<number, NotificationJob>();
  for (const j of await settle(fx, fx.jobs())) {
    const m = /^cus_t(\d+)$/.exec(j.customerId ?? '');
    if (!m) continue;
    if (!bases.has(Number(m[1]))) bases.set(Number(m[1]), j);
    await settle(fx, fx.patchJob(j.idempotencyKey, { status: 'SENT' }));
  }
  if (bases.size !== n) throw new Error(`expected a template page for ${n} tenants, got ${bases.size}`);
  let people = 0;
  const inject: World['inject'] = async (i, count, when, tag, opts = {}) => {
    const b = bases.get(i)!;
    const keys: string[] = [];
    for (let k = 0; k < count; k++) {
      const key = `${b.idempotencyKey}#${tag}${k}`;
      const over: Partial<NotificationJob> = {};
      if (opts.ownContact) {
        const id = `ct_t${i}_${tag}${k}`;
        await settle(fx, fx.addContact(person(id, b.customerId!, `P${i}-${tag}${k}`, 1000 + people++)));
        Object.assign(over, { contactId: id, targetRef: id, contactName: `P${i}-${tag}${k}` });
      }
      await settle(fx, fx.putJob({ ...structuredClone(b), ...over, id: `job_${i}_${tag}${k}`, idempotencyKey: key, nextAttemptAt: when, dueAt: when, createdAt: when, status: 'QUEUED', attempts: 0, claimSeq: 0, lastError: null, providerMessageId: null }));
      keys.push(key);
    }
    return keys;
  };
  return { fx, inject };
}

/** `make` may do store I/O; under fake timers that needs the real loop only (no timers are involved). */
async function settleBoot<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  while (!done) { await vi.advanceTimersByTimeAsync(0); await realTurn(); }
  return p;
}

interface Run { reached: Map<string, Date>; okCount: Map<string, number>; calls: number; maxBurst: number; maxTickMs: number; degraded: number; ticks: number; errors: string[] }

/** One tick per simulated minute m = 1 … `to`, `runners` runners at once (each its own repository). */
async function drive(fx: StoreFixture, to: number, fate: (m: OutboundMessage) => 'OK' | 'HANG', stop: (r: Run) => boolean, runners = 1): Promise<Run> {
  const run: Run = { reached: new Map(), okCount: new Map(), calls: 0, maxBurst: 0, maxTickMs: 0, degraded: 0, ticks: 0, errors: [] };
  const burst = new Map<number, number>();
  const sender = { send(m: OutboundMessage): Promise<SendResult> {
    run.calls++;
    if (fate(m) === 'HANG') {
      const b = (burst.get(Date.now()) ?? 0) + 1; burst.set(Date.now(), b); run.maxBurst = Math.max(run.maxBurst, b);
      return new Promise(() => undefined);
    }
    if (!run.reached.has(m.idempotencyKey)) run.reached.set(m.idempotencyKey, clock());
    run.okCount.set(m.idempotencyKey, (run.okCount.get(m.idempotencyKey) ?? 0) + 1);
    return Promise.resolve({ ok: true, providerMessageId: 'ok' });
  } };
  const senders = { VOICE: sender, SMS: sender, EMAIL: sender, SLACK: sender };
  const repos: TickRepository[] = [fx.repo, ...Array.from({ length: runners - 1 }, () => fx.secondRunner())];
  for (let m = 1; m <= to && !stop(run); m++) {
    const wait = at(m).getTime() - Date.now();
    if (wait > 0) await vi.advanceTimersByTimeAsync(wait);
    if (runners > 1) await settle(fx, fx.clearTickClaims());
    const t0 = Date.now();
    // several runners: each stands for its own minute key, as if the minute guard had failed
    const results = await settle(fx, Promise.all(repos.map((repo, i) => runTick({ scheduledAt: new Date(at(m).getTime() + i * 3_600_000), jobs: ['notify'] }, { repo, senders, now: clock, sendTimeoutMs: SEND_TIMEOUT }))));
    run.maxTickMs = Math.max(run.maxTickMs, Date.now() - t0); run.ticks++;
    for (const r of results) if (!('skipped' in r)) for (const x of r.errors) run.errors.push(`${x.phase}:${x.id}:${x.message}`);
    const hb = (await settle(fx, fx.repo.readHeartbeats())).find((h) => h.name === 'notify');
    if (hb?.lastStatus === 'DEGRADED') run.degraded++;
  }
  return run;
}

const dups = (r: Run): number => [...r.okCount.values()].filter((n) => n > 1).length;

export function lanesContract(make: MakeFixture, opts: { lanes?: Lane[] } = {}): void {
  let fx: StoreFixture | undefined;
  beforeEach(() => { vi.useFakeTimers(); fx = undefined; });
  afterEach(async () => { vi.clearAllTimers(); vi.useRealTimers(); await fx?.close(); });

  /** S4 of the reviews: `h` customers whose calls hang stand ahead of healthy tenant A's single SEV-1 page. */
  const S4 = async (lane: Lane, h: number, depth: number, maxTicks = 4, runners = 1) => {
    const w = await world(make, h + 1, lane);
    fx = w.fx;
    for (let i = 0; i < h; i++) await w.inject(i, depth, at(0, 30), 'bad');
    const [a] = await w.inject(h, 1, at(0, 59), 'good');
    const r = await drive(w.fx, maxTicks, (m) => (m.customerId === `cus_t${h}` ? 'OK' : 'HANG'), (x) => x.reached.has(a!), runners);
    return { r, delayMs: r.reached.has(a!) ? r.reached.get(a!)!.getTime() - at(1).getTime() : Infinity, a: a! };
  };

  describe('lanes: customers whose calls hang stand in front of a healthy customer’s SEV-1 page', () => {
    const CASES: Array<[number, number]> = [[6, 5], [5, 20], [12, 20], [24, 20]];
    for (const lane of opts.lanes ?? ['VOICE', 'SMS']) {
      it.each(CASES)(`${lane}: %i hanging customers × %i pages → the healthy page is at the provider in the same tick, ⌊H÷5⌋ × 10 s in`, async (h, depth) => {
        const { r, delayMs } = await S4(lane, h, depth);
        expect(delayMs).toBeLessThanOrEqual(Math.floor(h / 5) * 10_000 + 100);
        expect(delayMs).toBeLessThanOrEqual(SAME_TICK);
        expect(r.ticks).toBe(1);
        expect(dups(r)).toBe(0);
        expect(r.maxBurst).toBeLessThanOrEqual(5);
        expect(r.maxTickMs).toBeLessThanOrEqual(LIMIT);
        expect(r.errors).toEqual([]);
      });
    }

    it('R-24: 25 and 40 hanging customers × 20 pages → at most one tick slip', async () => {
      for (const h of [25, 40]) {
        const { r, delayMs } = await S4('SMS', h, 20, 4);
        expect(delayMs, `${h}`).toBeLessThanOrEqual(MIN + SAME_TICK);
        expect(dups(r), `${h}`).toBe(0);
        expect(r.errors, `${h}`).toEqual([]);
        await fx?.close(); fx = undefined;
      }
    });

    it('three runners draining at once with 6 hanging customers × 5 pages: the healthy page goes out once, in the same tick; nothing is sent twice', async () => {
      const { r, delayMs } = await S4('VOICE', 6, 5, 2, 3);
      expect(delayMs).toBeLessThanOrEqual(SAME_TICK);
      expect(dups(r)).toBe(0);
      expect(r.errors).toEqual([]);
    });

    it('a healthy provider and three runners: 3 customers × 15 pages are all delivered exactly once (jobs, provider calls and SENT logs agree)', async () => {
      const w = await world(make, 3, 'SMS');
      fx = w.fx;
      const keys: string[] = [];
      for (let t = 0; t < 3; t++) keys.push(...await w.inject(t, 15, at(0, 30), 'x'));
      const r = await drive(w.fx, 2, () => 'OK', () => false, 3);
      expect([...r.okCount.values()].reduce((a, b) => a + b, 0)).toBe(45);
      expect(dups(r)).toBe(0);
      const jobs = await settle(w.fx, w.fx.jobs());
      expect(keys.every((k) => jobs.find((j) => j.idempotencyKey === k)?.status === 'SENT')).toBe(true);
      expect((await settle(w.fx, w.fx.logs())).filter((l) => l.status === 'SENT')).toHaveLength(45);
    });

    it('a dead provider: 2 customers × 20 pages, nothing answers → at most 6 calls a tick, DEGRADED every tick, no attempt lost or counted twice', async () => {
      const w = await world(make, 2, 'VOICE');
      fx = w.fx;
      await w.inject(0, 20, at(0, 30), 'x'); await w.inject(1, 20, at(0, 30), 'x');
      const r = await drive(w.fx, 3, () => 'HANG', () => false);
      expect(r.reached.size).toBe(0);
      expect(r.calls).toBeLessThanOrEqual(18);
      expect(r.maxBurst).toBe(2);
      expect(r.degraded).toBe(3);
      const jobs = (await settle(w.fx, w.fx.jobs())).filter((j) => j.idempotencyKey.includes('#x'));
      expect(jobs.reduce((a, j) => a + j.attempts, 0)).toBe(r.calls); // every provider call is one counted attempt
      expect(jobs.every((j) => j.status === 'QUEUED')).toBe(true);
      expect(r.maxTickMs).toBeLessThanOrEqual(LIMIT);
    });
  });
}
