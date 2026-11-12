/**
 * Security review 4, R-22 — the send order inside one lane, by numbers.
 *
 * Every test here drives the REAL `runTick` + `MemoryTickStore` of this worktree through `real-engine.ts` (fake
 * provider, fake timers; timeout 10 s, one tick per minute, budget 45 s). Nothing of the drain is re-implemented.
 * The comparison with the real 7b85c90 engine is in security-review-4.baseline.test.ts.
 *
 * RULE 1: a customer whose own recipients answer gets its SEV-1 page to the provider within one tick, whatever
 * other customers' recipients do on the same lane — asserted up to 24 customers whose calls hang, each with up to
 * 20 pages waiting. Measured: it goes out in the SAME tick (≤ 40 s). The limit beyond 24 is pinned at the end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANES_5, MIN, NOW, S4, S5, at, drive, dups, hash01, world, type Lane } from './real-engine.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const LIMIT = 60_000;
/** A page attempted in the tick in which it was first due is at the provider before the 45 s budget ends. */
const SAME_TICK = 45_000;

describe('R-22: customers whose calls hang stand in front of a healthy customer’s SEV-1 page', () => {
  // [hanging customers, pages waiting per customer, more pages per customer per minute]
  const CASES: Array<[number, number, number]> = [[4, 1, 0], [4, 20, 0], [5, 1, 0], [8, 1, 0], [12, 1, 0], [6, 5, 0], [8, 5, 1], [5, 20, 0], [12, 20, 0], [24, 20, 0]];
  // expected wait: A is the (H+1)-th customer in fair order, 5 customers are probed every 10 s
  const expected = (h: number): number => Math.floor(h / 5) * 10_000;

  for (const lane of LANES_5) {
    it.each(CASES)(`${lane}: %i hanging × %i pages (+%i/min) → the healthy page is at the provider in the same tick`, async (h, depth, feed) => {
      const r = await S4(NOW, lane, h, depth, feed);
      expect(r.delayMs).toBeLessThanOrEqual(expected(h) + 100); // the exact number: one 10 s round per 5 customers in front
      expect(r.delayMs).toBeLessThanOrEqual(SAME_TICK);
      expect(r.delayMs).toBeLessThan(MIN); // RULE 1
      expect(r.ticks).toBe(1);
      expect(r.dups).toBe(0);
      expect(r.maxTickMs).toBeLessThanOrEqual(LIMIT);
    });
  }

  it('N-35: the healthy page is SEV-3 behind 12 hanging SEV-1 customers × 20 pages → same tick (was 232 minutes)', async () => {
    const r = await S4(NOW, 'VOICE', 12, 20, 0, 'SEV_3');
    expect(r.delayMs).toBeLessThanOrEqual(SAME_TICK);
    expect(r.ticks).toBe(1);
  });

  it('a shared number that hangs (one MSP on-call person paged for 8 customers × 5 pages) → another customer’s page goes out at once', async () => {
    const { store, inject } = await world(NOW, 9, () => 'VOICE');
    store.contacts.set('ct_shared', { id: 'ct_shared', kind: 'INTERNAL', customerId: null, name: 'Shared on-call', active: true, phone: '+821055599999', email: 's@example.test', slackUserId: 'US', phoneVerifiedAt: new Date('2026-10-01'), emailVerifiedAt: null, slackVerifiedAt: null });
    for (let i = 0; i < 8; i++) inject(i, 5, at(0, 30), 'bad', { contactId: 'ct_shared' });
    const [a] = inject(8, 1, at(0, 59), 'good');
    const r = await drive(NOW, store, 3, () => undefined, (m) => (m.contactId === 'ct_shared' ? 'HANG' : 'OK'), (x) => x.reached.has(a!));
    expect(r.reached.get(a!)!.getTime() - at(1).getTime()).toBe(0);
    expect(dups(r)).toBe(0);
  });

  it('once the provider has answered: a customer whose calls time out waits until every other customer was served', async () => {
    const { store, inject } = await world(NOW, 3, () => 'SMS');
    inject(0, 20, at(0, 30), 'bad', { ownContact: true });
    const good = [...inject(1, 12, at(0, 59), 'c'), ...inject(2, 12, at(0, 59), 'd')];
    const r = await drive(NOW, store, 1, () => undefined, (m) => (m.customerId === 'cus_t0' ? 'HANG' : 'OK'));
    const last = Math.max(...good.map((k) => r.reached.get(k)?.getTime() ?? Infinity)) - at(1).getTime();
    expect(good.every((k) => r.reached.has(k))).toBe(true);
    expect(last).toBeLessThanOrEqual(10_000); // behind at most one round of the hanging customer's calls
    expect(dups(r)).toBe(0);
  });

  it('30 random mixes (0–24 hanging customers, depth 1–20, feed 0–3/min, any lane, one or many numbers per customer) → always the same tick', async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const u = (n: number): number => hash01(`mix|${seed}|${n}`);
      const h = Math.floor(u(1) * 25); const depth = 1 + Math.floor(u(2) * 20); const feed = Math.floor(u(3) * 4);
      const lane = LANES_5[Math.floor(u(4) * 5)] as Lane; const own = u(5) < 0.5 && lane !== 'SLACK_CHANNEL';
      const label = `seed ${seed}: ${h} × ${depth} +${feed}/min on ${lane}, ${own ? 'a number per page' : 'one number per customer'}`;
      const { store, inject } = await world(NOW, h + 1, () => lane);
      for (let i = 0; i < h; i++) inject(i, depth, at(0, 30), 'bad', { ownContact: own });
      const [a] = inject(h, 1, at(0, 59), 'good');
      const r = await drive(NOW, store, 3, (m) => { if (feed && m >= 2) for (let i = 0; i < h; i++) inject(i, feed, at(m, -1), `f${m}_`); }, (m) => (m.customerId === `cus_t${h}` ? 'OK' : 'HANG'), (x) => x.reached.has(a!));
      expect(r.reached.has(a!), label).toBe(true);
      expect(r.reached.get(a!)!.getTime() - at(1).getTime(), label).toBeLessThanOrEqual(SAME_TICK);
      expect(r.maxBurst, label).toBeLessThanOrEqual(5);
      expect(r.maxTickMs, label).toBeLessThanOrEqual(LIMIT);
      expect(dups(r), label).toBe(0);
    }
  });
});

describe('R-22: numbers of the SAME customer that hang (one step, 20 people)', () => {
  it.each([['VOICE', 1, 'first'], ['VOICE', 3, 'first'], ['VOICE', 5, 'first'], ['VOICE', 8, 'first'], ['VOICE', 12, 'first'], ['VOICE', 16, 'first'], ['VOICE', 8, 'spread'], ['SMS', 8, 'first'], ['SMS', 12, 'first']] as const)(
    '%s: %i of 20 numbers hang (%s) → every healthy number is called in the same tick', async (lane, k, where) => {
      const r = await S5(NOW, lane, k, where);
      expect(r.delivered).toBe(20 - k);
      // five numbers are tried at once, a number that timed out is not in the way of the next five
      expect(r.lastMs).toBeLessThanOrEqual(Math.floor(k / 5) * 10_000 + 100);
      expect(r.lastMs).toBeLessThanOrEqual(SAME_TICK);
      expect(r.dups).toBe(0);
      expect(r.maxTickMs).toBeLessThanOrEqual(LIMIT);
    });
});

describe('R-22: what a dead provider costs', () => {
  it('2 customers × 20 pages, one number each, nothing answers: at most 6 calls a tick, both customers every tick, no page in two ticks running, reported', async () => {
    const { store, inject } = await world(NOW, 2, () => 'VOICE');
    inject(0, 20, at(0, 30), 'x'); inject(1, 20, at(0, 30), 'x');
    const r = await drive(NOW, store, 6, () => undefined, () => 'HANG');
    expect(r.reached.size).toBe(0);
    for (const calls of r.perTick) {
      expect(calls.length).toBeLessThanOrEqual(6); // 2 numbers at once, then one call per 10 s until the budget ends
      expect(new Set(calls.map((c) => c.split('|')[0])).size).toBe(2);
    }
    for (let i = 1; i < r.perTick.length; i++) expect(r.perTick[i]!.filter((k) => r.perTick[i - 1]!.includes(k))).toEqual([]);
    expect(r.maxBurst).toBe(2);
    expect(r.unanswered).toBe(6);
    expect(r.degraded).toBe(6);
    expect(r.maxTickMs).toBeLessThanOrEqual(LIMIT);
  });

  it('1 customer × 20 different numbers, nothing answers: never more than 5 calls at once, at most 25 a tick', async () => {
    const { store, inject } = await world(NOW, 1, () => 'VOICE');
    inject(0, 20, at(0, 30), 'x', { ownContact: true });
    const r = await drive(NOW, store, 3, () => undefined, () => 'HANG');
    expect(r.maxBurst).toBe(5);
    for (const calls of r.perTick) expect(calls.length).toBeLessThanOrEqual(25);
    expect(r.perTick[0]!.length).toBe(20); // every number is tried once in the first tick
    expect(r.maxTickMs).toBeLessThanOrEqual(LIMIT);
  });

  it('the provider comes back in the middle of a tick → everything waiting goes out in that same tick', async () => {
    const { store, inject } = await world(NOW, 2, () => 'VOICE');
    const keys = [...inject(0, 15, at(0, 30), 'x'), ...inject(1, 15, at(0, 30), 'x')];
    const r = await drive(NOW, store, 2, () => undefined, (_m, _n, t) => (t.getTime() - at(1).getTime() < 25_000 ? 'HANG' : 'OK'));
    const first = keys.filter((k) => r.reached.has(k) && r.reached.get(k)!.getTime() < at(2).getTime());
    expect(first.length).toBe(30 - r.hangs); // all but the calls that hung in the first 25 s
    expect(r.hangs).toBeLessThanOrEqual(4);
    expect(keys.every((k) => r.reached.has(k))).toBe(true);
  });
});

describe('R-22: the limit that was left (25 customers) — moved by R-24, see security-review-5.lanes.test.ts', () => {
  it('25 hanging customers × 20 pages: the healthy page slips at most ONE tick (it was 20 ticks before the rotating start of review 5)', async () => {
    const r = await S4(NOW, 'VOICE', 25, 20, 0, 'SEV_1', 30);
    expect(r.delayMs).toBeLessThanOrEqual(MIN + SAME_TICK);
    expect(r.degradedTicks).toBeLessThanOrEqual(2); // still visible while it lasts: the notify heartbeat is DEGRADED
    expect(r.dups).toBe(0);
  });
});
