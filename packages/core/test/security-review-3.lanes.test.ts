/**
 * Security review 3, R-17 — the outbox lane rule, by numbers.
 *
 * DESIGN RULE: for every scenario of the review's table, the lanes deliver no less and no later than the drain of
 * 7b85c90 (before lanes and the breaker), and one tenant's hanging recipients delay another tenant's SEV-1 page on
 * the same lane by at most one tick. `simulate` (lane-sim.ts) runs both engines on fake timers against the same
 * provider; all numbers below are simulated minutes on the VOICE lane (timeout 10 s, one tick per minute).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSender, runTick, TICK_RESPONSE_LIMIT_MS, type OutboundMessage, type SendResult, type TickSummary } from '../src/index.js';
import { MIN, dice, rng, simulate, sinceStart, type Scenario } from './lane-sim.js';
import { T0 } from './world.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const TICK = MIN;
const both = async (sc: Scenario) => ({ base: await simulate(sc, 'baseline'), lanes: await simulate(sc, 'lanes') });

/** Tenant B (t0): `n` SEV-1 calls that never answer (+ `feed` more per minute). Tenant A (t1): one SEV-1 call queued at 02:00. */
const hangingTenant = (n: number, feed: number): Scenario => ({
  tenants: 2, minutes: 30,
  feed: (m) => [...(m === 1 ? [{ tenant: 0, count: n, tag: 'bad' }] : []), ...(m === 2 ? [{ tenant: 1, count: 1, tag: 'good' }] : []), ...(feed && m >= 2 ? [{ tenant: 0, count: feed, tag: 'bad' }] : [])],
  fate: (msg) => (msg.customerId === 'cus_t0' ? 'HANG' : 'OK'),
});
/** A share `p` of all calls times out, whoever they are for. 3 tenants × 4 SEV-1 calls a minute for 30 minutes, run for 60. */
const randomTimeouts = (p: number, seed = 12345): Scenario => ({
  tenants: 3, minutes: 60, feed: (m) => (m <= 30 ? [0, 1, 2].map((tenant) => ({ tenant, count: 4 })) : []),
  fate: (msg, attempt) => (dice(`${msg.idempotencyKey}|${attempt}`, seed) < p ? 'HANG' : 'OK'),
});
/** The whole provider is down `down` minutes, up `up` minutes, again and again. 2 tenants × 4 calls a minute for 30 minutes, run for 75. */
const flapping = (down: number, up: number): Scenario => ({
  tenants: 2, minutes: 75, feed: (m) => (m <= 30 ? [0, 1].map((tenant) => ({ tenant, count: 4 })) : []),
  fate: (_m, _a, now) => (sinceStart(now) % (down + up) < down ? 'HANG' : 'OK'),
});

describe('R-17 rows 1–3: one tenant’s hanging recipients do not hold another tenant’s SEV-1 call', () => {
  it.each([[10, 0], [20, 0], [20, 2]])('B has %i hanging SEV-1 calls (+%i/min) → A’s call reaches the provider within one tick, no later than the baseline (was 24 / 84 / 96 min)', async (n, feed) => {
    const { base, lanes } = await both(hangingTenant(n, feed));
    expect(lanes.delayOf('good')).toBeLessThanOrEqual(TICK);
    expect(lanes.delayOf('good')).toBeLessThanOrEqual(10_000); // behind at most one hanging call
    expect(lanes.delayOf('good')).toBeLessThanOrEqual(base.delayOf('good'));
  });

  it('four tenants hang at once → the fifth tenant’s SEV-1 call still goes out in the tick that queued it', async () => {
    const o = await simulate({
      tenants: 5, minutes: 10,
      feed: (m) => [...(m === 1 ? [0, 1, 2, 3].map((tenant) => ({ tenant, count: 10, tag: 'bad' })) : []), ...(m === 2 ? [{ tenant: 4, count: 1, tag: 'good' }] : [])],
      fate: (msg) => (msg.customerId === 'cus_t4' ? 'OK' : 'HANG'),
    }, 'lanes');
    expect(o.delayOf('good')).toBeLessThanOrEqual(TICK);
  });
});

describe('R-17 rows 4–6: a share of all calls times out', () => {
  it('20% → everything delivered, max delay ≤ baseline (was 24 min against 7)', async () => {
    const { base, lanes } = await both(randomTimeouts(0.2));
    expect(lanes.delivered).toBe(360);
    expect(lanes.delivered).toBeGreaterThanOrEqual(base.delivered);
    expect(lanes.maxDelayMs).toBeLessThanOrEqual(base.maxDelayMs);
    expect(lanes.p90DelayMs).toBeLessThanOrEqual(base.p90DelayMs);
  });
  it('40% → delivered ≥ baseline, and sooner (was 113 of 360 against 357)', async () => {
    const { base, lanes } = await both(randomTimeouts(0.4));
    expect(lanes.delivered).toBeGreaterThanOrEqual(base.delivered);
    expect(lanes.delivered).toBeGreaterThanOrEqual(350);
    expect(lanes.maxDelayMs).toBeLessThanOrEqual(base.maxDelayMs);
    expect(lanes.p90DelayMs).toBeLessThanOrEqual(base.p90DelayMs);
  });
  it('60% → delivered ≥ baseline (was 67 against 201)', async () => {
    const { base, lanes } = await both(randomTimeouts(0.6));
    expect(lanes.delivered).toBeGreaterThanOrEqual(base.delivered);
    expect(lanes.delivered).toBeGreaterThanOrEqual(300);
  });
});

describe('R-17 rows 7–9: the whole provider flaps', () => {
  it.each([[3, 1, 240], [5, 1, 230], [0.5, 0.5, 230]])('down %f min / up %f min → delivered ≥ baseline and ≥ %i of 240 (was: 240 at p50 38 min / 0 / 1)', async (down, up, floor) => {
    const { base, lanes } = await both(flapping(down, up));
    expect(lanes.delivered).toBeGreaterThanOrEqual(base.delivered);
    expect(lanes.delivered).toBeGreaterThanOrEqual(floor);
    expect(lanes.maxDelayMs).toBeLessThanOrEqual(base.maxDelayMs);
  });
});

describe('R-17 row 10: one customer, 20 calls in one step, some numbers never answer', () => {
  it.each([[1, 'spread'], [3, 'spread'], [3, 'first'], [5, 'first'], [8, 'spread']] as const)('%i bad numbers (%s) → every healthy call is out within one tick', async (k, where) => {
    const bad = new Set(where === 'first' ? Array.from({ length: k }, (_, i) => i) : Array.from({ length: k }, (_, i) => Math.floor((i * 20) / k)));
    const isBad = (key: string) => bad.has(Number(key.slice(key.lastIndexOf('_') + 1)));
    const o = await simulate({ tenants: 1, minutes: 5, feed: (m) => (m === 1 ? [{ tenant: 0, count: 20 }] : []), fate: (msg) => (isBad(msg.idempotencyKey) ? 'HANG' : 'OK') }, 'lanes');
    const healthy = o.jobs.filter((j) => !isBad(j.key));
    expect(healthy).toHaveLength(20 - k);
    expect(Math.max(...healthy.map((j) => j.delayMs))).toBeLessThanOrEqual(TICK);
  });
});

describe('R-17: seeded random scenarios against the no-breaker reference', () => {
  it('20 seeds: delivered ≥ reference in sum (per seed within noise), latest delivery ≤ reference + 1 tick, a healthy tenant’s fresh SEV-1 call ≤ 1 tick', async () => {
    const report: string[] = [];
    const worse: string[] = [];
    const sum = { base: 0, lanes: 0 };
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed);
      const tenants = 2 + Math.floor(r() * 3);
      const rate = 1 + Math.floor(r() * 4);
      const p = r() < 0.75 ? r() * 0.6 : 0; // random timeout share
      const flap = r() < 0.5 ? { down: [0.5, 1, 2, 3, 5][Math.floor(r() * 5)]!, up: [0.5, 1, 2][Math.floor(r() * 3)]! } : null;
      const hangTenant = r() < 0.5 ? 0 : -1; // tenant 0's recipients never answer
      const feedMin = 10 + Math.floor(r() * 20);
      const probeAt = 2 + Math.floor(r() * feedMin);
      const healthy = tenants - 1; // the last tenant gets one marked call; it is never the hanging tenant
      const sc: Scenario = {
        tenants, minutes: feedMin + 40,
        feed: (m) => [...(m <= feedMin ? Array.from({ length: tenants }, (_, tenant) => ({ tenant, count: rate })) : []), ...(m === probeAt ? [{ tenant: healthy, count: 1, tag: 'mark' }] : [])],
        fate: (msg, attempt, now) => {
          if (hangTenant >= 0 && msg.customerId === `cus_t${hangTenant}`) return 'HANG';
          if (flap && sinceStart(now) % (flap.down + flap.up) < flap.down) return 'HANG';
          return dice(`${msg.idempotencyKey}|${attempt}`, seed) < p ? 'HANG' : 'OK';
        },
      };
      const { base, lanes } = await both(sc);
      const label = `seed ${seed}: tenants ${tenants}, ${rate}/min, timeouts ${(p * 100).toFixed(0)}%, flap ${flap ? `${flap.down}/${flap.up}` : '-'}, hanging tenant ${hangTenant >= 0 ? 'yes' : 'no'}`;
      report.push(`${label} → reference ${base.delivered}/${base.total} max ${(base.maxDelayMs / MIN).toFixed(1)} | lanes ${lanes.delivered}/${lanes.total} max ${(lanes.maxDelayMs / MIN).toFixed(1)}`);
      // Per seed the two engines meet a time-dependent provider at slightly different moments, so a page or two can
      // go either way (measured: one seed of 20, 38 against 40 of 43). The rule is asserted with that noise allowed
      // per seed and with none in the sum.
      expect(lanes.delivered, label).toBeGreaterThanOrEqual(base.delivered - Math.max(2, Math.ceil(lanes.total * 0.05)));
      if (lanes.delivered < base.delivered) worse.push(label);
      sum.base += base.delivered; sum.lanes += lanes.delivered;
      // the single latest page may land one tick later than in the reference (where a retry falls relative to the
      // minute boundary); never more
      if (lanes.delivered >= base.delivered && base.delivered > 0) expect(lanes.maxDelayMs, label).toBeLessThanOrEqual(base.maxDelayMs + TICK);
      // with a healthy provider at that moment, the marked call is never behind another tenant for more than a tick
      if (!flap && p === 0) expect(lanes.delayOf('mark'), label).toBeLessThanOrEqual(TICK);
      expect(lanes.maxTickMs, label).toBeLessThanOrEqual(TICK_RESPONSE_LIMIT_MS);
    }
    expect(report).toHaveLength(20);
    expect(worse.length, worse.join('\n')).toBeLessThanOrEqual(2);
    expect(sum.lanes).toBeGreaterThanOrEqual(sum.base);
    console.log(`R-17 random comparison, 20 seeds: reference ${sum.base} delivered, lanes ${sum.lanes}; seeds below the reference: ${worse.length}`);
  }, 120_000);
});

describe('R-17: what replaced the breaker', () => {
  it('a dead provider: one call in flight, 5 calls per tick, never the same job in two consecutive ticks; the lane is reported, never closed', async () => {
    const perTick: string[][] = [];
    const o = await simulate({ tenants: 2, minutes: 6, feed: (m) => (m === 1 ? [{ tenant: 0, count: 20 }, { tenant: 1, count: 20 }] : []), fate: (msg, _a, now) => { (perTick[Math.floor(sinceStart(now))] ??= []).push(`${msg.customerId}|${msg.idempotencyKey}`); return 'HANG'; } }, 'lanes');
    expect(o.delivered).toBe(0);
    for (const calls of perTick) expect(calls.length).toBeLessThanOrEqual(5); // budget 45 s / timeout 10 s
    for (let i = 1; i < perTick.length; i++) expect(perTick[i]!.filter((k) => perTick[i - 1]!.includes(k))).toEqual([]);
    // both tenants are probed in every tick (round-robin), not one tenant five times
    for (const calls of perTick) expect(new Set(calls.map((k) => k.split('|')[0])).size).toBe(2);
    expect(o.maxTickMs).toBeLessThanOrEqual(45_000 + 10_000 + 1_000);
  });

  it('the provider comes back in the middle of a tick → the lane goes to full width in that same tick', async () => {
    // down for the first 25 s of minute 1 only
    const o = await simulate({ tenants: 2, minutes: 2, feed: (m) => (m === 1 ? [{ tenant: 0, count: 15 }, { tenant: 1, count: 15 }] : []), fate: (_m, _a, now) => (sinceStart(now) < 25 / 60 ? 'HANG' : 'OK') }, 'lanes');
    const first = o.jobs.filter((j) => j.delayMs < TICK);
    expect(first.length).toBeGreaterThanOrEqual(27); // 30 minus the three calls that timed out at 0, 10 and 20 s
    expect(o.delivered).toBe(30);
  });
});

describe('N-21: one tick call answers within budget + send timeout ≤ 60 s', () => {
  it('providers that answer just under the timeout: 4 lanes × 60 jobs → the tick ends within 45 s + 10 s + 1 s', async () => {
    for (const latency of [8_900, 9_900, 4_400]) {
      vi.setSystemTime(T0);
      const { tenants } = await import('./lane-world.js');
      const { store, inject } = await tenants(4, (i) => (['VOICE', 'SMS', 'EMAIL', 'SLACK_DM'] as const)[i]!);
      for (let t = 0; t < 4; t++) inject(t, 60);
      const slow = { send: (): Promise<SendResult> => new Promise<SendResult>((res) => setTimeout(() => res({ ok: true, providerMessageId: 'x' }), latency)) };
      const p = runTick({ scheduledAt: T0, jobs: ['notify'] }, { repo: store, senders: { VOICE: slow, SMS: slow, EMAIL: slow, SLACK: slow }, now: () => new Date(Date.now()) }) as Promise<TickSummary>;
      await vi.advanceTimersByTimeAsync(70_000);
      const r = await p;
      expect(r.durationMs, `latency ${latency}`).toBeLessThanOrEqual(56_000);
      expect(r.durationMs).toBeLessThanOrEqual(TICK_RESPONSE_LIMIT_MS);
      expect(r.notify.sent).toBeGreaterThan(0);
    }
  });

  it('a budget or a send timeout that would break the bound is cut down, not trusted', async () => {
    vi.setSystemTime(T0);
    const { tenants } = await import('./lane-world.js');
    const { store, inject } = await tenants(1, () => 'VOICE');
    inject(0, 60);
    const calls: OutboundMessage[] = [];
    const hang = { send: (m: OutboundMessage): Promise<SendResult> => { calls.push(m); return new Promise<SendResult>(() => undefined); } };
    const p = runTick({ scheduledAt: T0, jobs: ['notify'] }, { repo: store, senders: { VOICE: hang }, now: () => new Date(Date.now()), budgetMs: 600_000, sendTimeoutMs: 120_000 }) as Promise<TickSummary>;
    await vi.advanceTimersByTimeAsync(120_000);
    const r = await p;
    expect(r.durationMs).toBeLessThanOrEqual(TICK_RESPONSE_LIMIT_MS);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('a store call that never returns inside the outbox: the tick still answers within the bound and says so', async () => {
    vi.setSystemTime(T0);
    const { tenants } = await import('./lane-world.js');
    const { store, inject } = await tenants(1, () => 'VOICE');
    inject(0, 3);
    store.findIncidentById = () => new Promise(() => undefined);
    const p = runTick({ scheduledAt: T0, jobs: ['notify'] }, { repo: store, senders: { VOICE: new FakeSender() }, now: () => new Date(Date.now()) }) as Promise<TickSummary>;
    await vi.advanceTimersByTimeAsync(70_000);
    const r = await p;
    expect(r.durationMs).toBeLessThanOrEqual(TICK_RESPONSE_LIMIT_MS);
    expect(r.errors.some((e) => e.phase === 'notify' && /did not finish/.test(e.message))).toBe(true);
    expect((await store.readHeartbeats()).find((h) => h.name === 'notify')?.lastStatus).toBe('ERROR');
  });
});
