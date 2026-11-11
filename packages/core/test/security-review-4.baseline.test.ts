/**
 * Security review 4 — the current engine against the REAL engine of commit 7b85c90.
 *
 * Both columns come from the engines' own `runTick` + `MemoryTickStore` (real-engine.ts): `NOW` is ../src,
 * `BASELINE` is test/fixtures/baseline-7b85c90 — the files `git archive 7b85c90 packages/core/src` wrote, not a
 * re-implementation. (Until review 4 this comparison used a hand-written copy of the old drain, `lane-sim.ts`;
 * the reviewer showed that the copy and the real 7b85c90 disagree. That file is gone.)
 *
 * RULE 1: a customer whose own recipients answer never waits more than one tick for its SEV-1 page.
 * RULE 2: nothing is more than one tick worse than 7b85c90:
 *   - a single page: delay(now) ≤ delay(7b85c90) + 1 tick;
 *   - a population of pages: sort both engines' delays (never delivered = ∞); for EVERY rank,
 *     delay(now)[rank] ≤ delay(7b85c90)[rank] + 1 tick. That covers the number delivered, every percentile and the maximum.
 * Also for every run of the current engine: no idempotency key is accepted twice, and no tick call is longer than 60 s.
 *
 * Scenarios: the reviewer's list (v4/matrix*.txt) — S1 one hanging tenant, S2 random timeouts 20/40/60% × 5 seeds,
 * S3 a flapping provider, S4 H hanging tenants in front, S5 k bad numbers, S6 lane isolation, S7 overlapping ticks.
 * The measured table is printed at the end (`npx vitest run test/security-review-4.baseline.test.ts`).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASELINE, MIN, NOW, S1, S2, S3, S4, S5, S6, S7, mins, ticksSlipped, type Dist, type Lane } from './real-engine.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const TICK = MIN;
const LIMIT = 60_000;
const table: string[] = ['scenario | 7b85c90 | now'];
afterAll(() => { console.log(`\nMeasured with the real engines (minutes; "t" = whole ticks slipped)\n${table.join('\n')}\n`); });

const cell = (ms: number): string => (ms === Infinity ? 'not in 240 ticks' : `${mins(ms)} (${ticksSlipped(ms)}t)`);
/** RULE 2 for a population: rank by rank. Returns the worst difference in ms (≤ TICK is inside the rule). */
function worstRank(now: Dist, base: Dist): number {
  let worst = -Infinity;
  for (let i = 0; i < base.delays.length; i++) {
    const n = now.delays[i]!; const b = base.delays[i]!;
    const d = n === Infinity ? (b === Infinity ? 0 : Infinity) : b === Infinity ? -Infinity : n - b;
    if (d > worst) worst = d;
  }
  return worst;
}
const distCell = (d: Dist): string => `${d.delivered}/${d.total} gave up ${d.gaveUp} waiting ${d.waiting}, p50 ${mins(d.p50)} p90 ${mins(d.p90)} max ${mins(d.max)}`;
function checkDist(label: string, now: Dist, base: Dist): void {
  const worst = worstRank(now, base);
  table.push(`${label} | ${distCell(base)} | ${distCell(now)}; worst rank vs 7b85c90 ${worst === -Infinity ? '−∞' : `${worst > 0 ? '+' : ''}${mins(worst)}`}`);
  expect(now.total).toBe(base.total);
  expect(worst, label).toBeLessThanOrEqual(TICK);
  expect(now.delivered, label).toBeGreaterThanOrEqual(base.delivered);
  expect(now.dups, label).toBe(0);
  expect(now.maxTickMs, label).toBeLessThanOrEqual(LIMIT);
}

describe('S1: one tenant’s pages hang → another tenant’s SEV-1 page', () => {
  it.each([['VOICE', 10, 0], ['VOICE', 20, 0], ['VOICE', 20, 2], ['SMS', 20, 0], ['EMAIL', 20, 0], ['SLACK_DM', 20, 0], ['SLACK_CHANNEL', 20, 0]] as const)('%s: B has %i hanging pages (+%i/min)', async (lane, n, feed) => {
    const base = await S1(BASELINE, lane, n, feed);
    const now = await S1(NOW, lane, n, feed);
    table.push(`S1 ${lane} B=${n}${feed ? ` +${feed}/min` : ''} | ${cell(base.delayMs)} | ${cell(now.delayMs)}`);
    expect(now.delayMs).toBeLessThanOrEqual(TICK);
    expect(now.delayMs).toBeLessThanOrEqual(base.delayMs + TICK);
    expect(now.dups).toBe(0);
    expect(now.maxTickMs).toBeLessThanOrEqual(LIMIT);
  });
});

describe('S4: H tenants whose pages hang stand in front of a healthy tenant’s SEV-1 page', () => {
  // the reviewer's matrix (matrix.txt, matrix2.txt, matrix3.txt): [H, pages per tenant, more per minute]
  const M: Array<[number, number, number]> = [
    [4, 1, 0], [4, 20, 0], [5, 1, 0], [5, 1, 1], [5, 20, 0], [8, 1, 0], [8, 20, 0], [12, 1, 0], [12, 20, 0], [24, 20, 0],
    ...[6, 8, 12].flatMap((h) => [2, 3, 5].flatMap((d) => [0, 1, 3].map((f) => [h, d, f] as [number, number, number]))),
  ];
  it.each(M)('VOICE: %i × %i (+%i/min)', async (h, depth, feed) => {
    const base = await S4(BASELINE, 'VOICE', h, depth, feed);
    const now = await S4(NOW, 'VOICE', h, depth, feed);
    table.push(`S4 VOICE ${h} × ${depth}${feed ? ` +${feed}/min` : ''} | ${cell(base.delayMs)} | ${cell(now.delayMs)}`);
    expect(now.delayMs).toBeLessThan(TICK); // RULE 1
    expect(now.delayMs).toBeLessThanOrEqual(base.delayMs + TICK); // RULE 2
    expect(now.dups).toBe(0);
    expect(now.maxTickMs).toBeLessThanOrEqual(LIMIT);
  });
  it.each([['SMS', 8, 1], ['SMS', 5, 20], ['EMAIL', 8, 1], ['EMAIL', 5, 20], ['SLACK_DM', 8, 1], ['SLACK_DM', 5, 20], ['SLACK_CHANNEL', 8, 1], ['SLACK_CHANNEL', 5, 20]] as const)('%s: %i × %i', async (lane, h, depth) => {
    const base = await S4(BASELINE, lane, h, depth);
    const now = await S4(NOW, lane, h, depth);
    table.push(`S4 ${lane} ${h} × ${depth} | ${cell(base.delayMs)} | ${cell(now.delayMs)}`);
    expect(now.delayMs).toBeLessThan(TICK);
    expect(now.delayMs).toBeLessThanOrEqual(base.delayMs + TICK);
    expect(now.dups).toBe(0);
  });
  it('VOICE: 12 × 20, the healthy page is SEV-3 (N-35)', async () => {
    const base = await S4(BASELINE, 'VOICE', 12, 20, 0, 'SEV_3');
    const now = await S4(NOW, 'VOICE', 12, 20, 0, 'SEV_3');
    table.push(`S4 VOICE 12 × 20, healthy page SEV-3 | ${cell(base.delayMs)} | ${cell(now.delayMs)}`);
    expect(now.delayMs).toBeLessThan(TICK);
    expect(now.delayMs).toBeLessThanOrEqual(base.delayMs + TICK);
  });
});

describe('S2: a share of all calls times out (3 tenants × 4 pages a minute × 30 minutes, 60 ticks)', () => {
  const cases = [0.2, 0.4, 0.6].flatMap((p) => [1, 2, 3, 4, 5].map((seed) => ['VOICE', p, seed] as [Lane, number, number]));
  it.each([...cases, ['SMS', 0.4, 7] as [Lane, number, number], ['VOICE', 0.8, 1] as [Lane, number, number]])('%s: %f, seed %i', async (lane, p, seed) => {
    const base = await S2(BASELINE, lane, p, seed);
    const now = await S2(NOW, lane, p, seed);
    checkDist(`S2 ${lane} ${p * 100}% seed ${seed}`, now, base);
  });
});

describe('S3: the whole provider flaps (2 tenants × 4 pages a minute × 30 minutes, 75 ticks)', () => {
  it.each([['VOICE', 3, 1], ['VOICE', 5, 1], ['VOICE', 0.5, 0.5], ['VOICE', 1, 1], ['VOICE', 10, 2], ['SMS', 3, 1]] as const)('%s: down %f min / up %f min', async (lane, down, up) => {
    const base = await S3(BASELINE, lane, down, up);
    const now = await S3(NOW, lane, down, up);
    checkDist(`S3 ${lane} down ${down} / up ${up}`, now, base);
  });
});

describe('S5: one tenant, 20 pages to 20 numbers, k numbers hang', () => {
  it.each([['VOICE', 1, 'first'], ['VOICE', 3, 'first'], ['VOICE', 5, 'first'], ['VOICE', 8, 'first'], ['VOICE', 12, 'first'], ['VOICE', 8, 'spread'], ['SMS', 8, 'first']] as const)('%s: k = %i (%s)', async (lane, k, where) => {
    const base = await S5(BASELINE, lane, k, where);
    const now = await S5(NOW, lane, k, where);
    table.push(`S5 ${lane} k=${k} ${where}: last healthy number | ${cell(base.lastMs)} | ${cell(now.lastMs)}`);
    expect(now.delivered).toBe(20 - k);
    expect(now.lastMs).toBeLessThan(TICK); // target of review 4: healthy numbers of the same tenant within one tick
    expect(now.lastMs).toBeLessThanOrEqual(base.lastMs + TICK);
    expect(now.dups).toBe(0);
  });
});

describe('S6: one lane hangs entirely (4 tenants × 20 pages) → SEV-1 pages on the other lanes', () => {
  it.each(['VOICE', 'SMS', 'EMAIL', 'SLACK_DM'] as const)('%s hangs', async (hung) => {
    const base = await S6(BASELINE, hung);
    const now = await S6(NOW, hung);
    table.push(`S6 ${hung} hangs: other lanes | ${Object.entries(base.delays).map(([l, d]) => `${l} ${mins(d)}`).join(', ')} | ${Object.entries(now.delays).map(([l, d]) => `${l} ${mins(d)}`).join(', ')}`);
    for (const [lane, d] of Object.entries(now.delays)) {
      expect(d, lane).toBe(0); // lanes do not wait for each other
      expect(d, lane).toBeLessThanOrEqual(base.delays[lane]! + TICK);
    }
    expect(now.dups).toBe(0);
    expect(now.maxTickMs).toBeLessThanOrEqual(LIMIT);
  });
});

describe('S7: duplicates — three runners on the same minute, a provider that answers just under the timeout', () => {
  it.each([['VOICE', 8_000], ['VOICE', 9_500], ['SLACK_CHANNEL', 8_000]] as const)('%s, answers after %i ms', async (lane, answerMs) => {
    const now = await S7(NOW, lane, answerMs);
    table.push(`S7 ${lane} answer ${answerMs / 1000} s × 3 runners | — | ${now.providerOk} provider OK for ${now.jobs} pages, keys accepted twice ${now.keysCalledTwice}, SENT logs ${now.sentLogs}, longest tick ${(now.maxTickMs / 1000).toFixed(1)} s`);
    expect(now.keysCalledTwice).toBe(0);
    expect(now.providerOk).toBe(now.jobs);
    expect(now.sentLogs).toBe(now.jobs);
    expect(now.sentJobs).toBe(now.jobs);
    expect(now.maxTickMs).toBeLessThanOrEqual(LIMIT);
  });
});
