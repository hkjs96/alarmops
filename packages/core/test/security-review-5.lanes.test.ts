/**
 * Security review 5, R-24 — the rotating start of the probing while a lane is unanswered.
 *
 * Before: while the provider answered nothing, every tick probed the SAME first 25 customers of the fair order
 * (5 at once × 5 rounds), so the 26th customer waited until the backlog of the 25 was used up (25 × 20 pages:
 * 20 ticks), and with a slow store (0.4 s a call) the fifth round did not start, so the cliff was at 20 customers.
 * Review 5 moved the starting customer by a fixed stride every minute (`minute × 25 mod n`); the security review of
 * the SQL store (R-1) showed that this stands still or skips positions when a tick makes fewer probes than the
 * stride. Now a tick that got no answer stores the customer it reached (probe cursor, notify heartbeat) and the
 * next tick starts after it. Worst case: ⌈n ÷ P⌉ − 1 ticks for n due customers and P probes a tick — with a fast
 * store ⌈(H + 1) ÷ 25⌉ − 1 for H hanging customers in front. The sweep over every position and four store
 * latencies is test/r24-rotation.test.ts; this file keeps the scenarios of review 5.
 *
 * Same harness as review 4: the REAL `runTick` + `MemoryTickStore`, fake provider, fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN, NOW, S4, at, drive, dups, world, type Lane } from './real-engine.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const LIMIT = 60_000;
const SAME_TICK = 45_000;
/** Worst case in whole ticks for H hanging customers in front. */
const worstTicks = (h: number): number => Math.ceil((h + 1) / 25) - 1;

describe('R-24: more hanging customers than one tick can probe', () => {
  it.each([['VOICE', 25], ['SMS', 25], ['VOICE', 30], ['VOICE', 40], ['SMS', 40], ['SLACK_DM', 40], ['EMAIL', 49], ['SMS', 49]] as const)(
    '%s: %i hanging customers × 20 pages → the healthy SEV-1 page slips at most one tick (was 20)', async (lane, h) => {
      const r = await S4(NOW, lane as Lane, h, 20, 0, 'SEV_1', 30);
      expect(worstTicks(h)).toBe(1);
      expect(r.delayMs).toBeLessThanOrEqual(MIN + SAME_TICK);
      expect(r.ticks).toBeLessThanOrEqual(2);
      expect(r.dups).toBe(0);
      expect(r.maxTickMs).toBeLessThanOrEqual(LIMIT);
    });

  it('every start minute: 25 and 40 hanging customers × 20 pages, the page is at the provider within one tick slip whatever the minute number is', async () => {
    for (const h of [25, 40]) {
      for (let shift = 0; shift < h + 1; shift += 3) {
        const { store, inject } = await world(NOW, h + 1, () => 'VOICE');
        // move the whole scenario by `shift` minutes: the start position depends on the minute number
        const t = (min: number, sec = 0): Date => at(min + shift, sec);
        for (let i = 0; i < h; i++) inject(i, 20, t(0, 30), 'bad');
        const [a] = inject(h, 1, t(0, 59), 'good');
        await vi.advanceTimersByTimeAsync(shift * MIN);
        const run = await drive(NOW, store, shift + 4, () => undefined, (m) => (m.customerId === `cus_t${h}` ? 'OK' : 'HANG'), (x) => x.reached.has(a!));
        const label = `${h} hanging, start minute +${shift}`;
        expect(run.reached.has(a!), label).toBe(true);
        expect(run.reached.get(a!)!.getTime() - t(1).getTime(), label).toBeLessThanOrEqual(MIN + SAME_TICK);
        expect(dups(run), label).toBe(0);
      }
    }
  });

  it('with feed (+1 page per hanging customer per minute) the bound holds: 40 hanging customers', async () => {
    const r = await S4(NOW, 'VOICE', 40, 20, 1, 'SEV_1', 30);
    expect(r.delayMs).toBeLessThanOrEqual(MIN + SAME_TICK);
    expect(r.dups).toBe(0);
  });

  it('no regression at or below 24: same tick, ⌊H÷5⌋ × 10 s at the latest', async () => {
    for (const h of [4, 12, 24]) {
      const r = await S4(NOW, 'VOICE', h, 20);
      expect(r.delayMs, `${h}`).toBeLessThanOrEqual(SAME_TICK);
      expect(r.ticks, `${h}`).toBe(1);
    }
  });
});

/** The four store calls inside one send each take `ms` (simulated). */
function slowStore(store: any, ms: number): void {
  for (const name of ['findIncidentById', 'getContact', 'beginSend', 'completeJob']) {
    const real = store[name].bind(store);
    store[name] = (...args: unknown[]) => new Promise((res, rej) => setTimeout(() => real(...args).then(res, rej), ms));
  }
}

describe('R-24: a slow store (review 5: with 0.4 s a call the limit of 24 fell to 19)', () => {
  it.each([[24, 400], [24, 1000], [19, 1000], [40, 400]])('%i hanging customers × 20 pages, %i ms per store call → at most one tick slip, never "not delivered"', async (h, ms) => {
    const { store, inject } = await world(NOW, h + 1, () => 'VOICE');
    for (let i = 0; i < h; i++) inject(i, 20, at(0, 30), 'bad', { ownContact: true });
    const [a] = inject(h, 1, at(0, 59), 'good');
    slowStore(store, ms);
    const r = await drive(NOW, store, 6, () => undefined, (m) => (m.customerId === `cus_t${h}` ? 'OK' : 'HANG'), (x) => x.reached.has(a!));
    expect(r.reached.has(a!)).toBe(true);
    expect(r.reached.get(a!)!.getTime() - at(1).getTime()).toBeLessThanOrEqual(MIN + SAME_TICK);
    expect(dups(r)).toBe(0);
    expect(r.maxTickMs).toBeLessThanOrEqual(LIMIT);
  });
});
