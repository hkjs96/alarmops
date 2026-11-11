/**
 * Security review SQL, R-1 — the probe cursor of an unanswered lane (R-24), measured for EVERY position.
 *
 * The rule before (`start = minute × stride mod n`, stride 20 or 25) assumed a tick makes exactly 25 (or 20) probes.
 * When it made fewer (a slow store) the start stood still or stepped over positions: with 20, 49 or 50 customers
 * some positions were never reached. Now the next tick starts where this one stopped (the cursor is stored with the
 * notify heartbeat), so the bound does not depend on how many probes a tick manages:
 *
 *   slip ≤ ⌈n ÷ P⌉ − 1 ticks,  n = customers due on the lane, P = customers probed per tick
 *   P = 25 (fast store), 20 (0.4 s and 1 s a store call), 15 (2.5 s a store call).
 *
 * Harness: the REAL `runTick` + `MemoryTickStore` (test/real-engine.ts), fake provider, fake timers. A lane with n
 * customers: ONE is healthy (one page), the other n − 1 never answer (20 pages each, each to its own number); all
 * pages are due at the same instant. The healthy customer is put at every one of the n positions in turn.
 * slip = whole ticks between the tick in which the page was due and the tick that sent it (0 = same tick).
 *
 * The sweep is 1 830 scenarios per latency. R24_N="26,49,50" (a list) or R24_N="1-60" narrows it; R24_OUT=<file>
 * writes one JSON line per (latency, n) — the table in docs/API-CONTRACT.md is made from that.
 */
import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, at, drive, dups, world } from './real-engine.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

/** The four store calls inside one send each take `ms` (simulated). */
function slowStore(store: any, ms: number): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const name of ['findIncidentById', 'getContact', 'beginSend', 'completeJob']) {
    const real = store[name].bind(store);
    store[name] = (...args: unknown[]) => new Promise((res, rej) => setTimeout(() => real(...args).then(res, rej), ms));
  }
}

/** Customers probed per tick while nothing answers, by store latency (ms per store call). */
export const PROBES_PER_TICK: Record<number, number> = { 0: 25, 400: 20, 1000: 20, 2500: 15 };
const CLAIM = 50;
/** The stated bound. Above one claim (50 jobs per lane) the first tick's window is the fair order, not the cursor's: one more tick. */
export const bound = (n: number, slowMs: number): number => Math.ceil(n / PROBES_PER_TICK[slowMs]!) - 1 + (n > CLAIM ? 1 : 0);

const range = (spec: string | undefined, dflt: number[]): number[] => {
  if (!spec) return dflt;
  return spec.split(',').flatMap((p) => { const [a, b] = p.split('-').map(Number); return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i); });
};
const NS = range(process.env.R24_N, Array.from({ length: 60 }, (_, i) => i + 1));
const OUT = process.env.R24_OUT;

async function slipAt(n: number, p: number, slowMs: number): Promise<{ slip: number; dups: number; maxTickMs: number }> {
  vi.clearAllTimers();
  const { store, inject } = await world(NOW, n, () => 'VOICE');
  let a: string[] = [];
  for (let i = 0; i < n; i++) { if (i === p) a = inject(i, 1, at(0, 30), 'good'); else inject(i, 20, at(0, 30), 'bad', { ownContact: true }); }
  if (slowMs) slowStore(store, slowMs);
  const maxTicks = bound(n, slowMs) + 2;
  const r = await drive(NOW, store, maxTicks, () => undefined, (m) => (m.customerId === `cus_t${p}` ? 'OK' : 'HANG'), (x) => x.reached.has(a[0]!));
  const ok = r.reached.has(a[0]!);
  return { slip: ok ? Math.floor((r.reached.get(a[0]!)!.getTime() - at(1).getTime()) / 60_000) : Infinity, dups: dups(r), maxTickMs: r.maxTickMs };
}

describe('R-1 / R-24: one healthy customer among n − 1 that never answer, at every position', () => {
  it.each([0, 400, 1000, 2500])('store call %i ms: n = 1 … 60, every position — slip ≤ ⌈n ÷ P⌉ − 1 (+1 above the claim of 50), never unreached, no duplicate, tick ≤ 60 s', async (slowMs) => {
    for (const n of NS) {
      let worst = 0; let worstP = -1; let d = 0; let maxTick = 0;
      const unreached: number[] = [];
      for (let p = 0; p < n; p++) {
        const r = await slipAt(n, p, slowMs);
        if (r.slip === Infinity) unreached.push(p); else if (r.slip > worst) { worst = r.slip; worstP = p; }
        d += r.dups; maxTick = Math.max(maxTick, r.maxTickMs);
      }
      if (OUT) appendFileSync(OUT, JSON.stringify({ slowMs, n, worst, worstP, unreached, bound: bound(n, slowMs), dups: d, maxTickMs: maxTick }) + '\n');
      const label = `n=${n}, ${slowMs} ms`;
      expect(unreached, `${label}: positions never reached`).toEqual([]);
      expect(worst, `${label}: worst slip (position ${worstP})`).toBeLessThanOrEqual(bound(n, slowMs));
      expect(d, label).toBe(0);
      expect(maxTick, label).toBeLessThanOrEqual(60_000);
    }
  }, 3_600_000);
});
