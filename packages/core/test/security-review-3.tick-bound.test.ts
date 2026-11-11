/**
 * Security review 3, N-21 — one tick call answers within budget + send timeout ≤ 60 s.
 *
 * The R-17 lane comparisons that used to be in this file ran against `lane-sim.ts`, a hand-written copy of the
 * 7b85c90 drain. Security review 4 showed that copy does not behave like the real 7b85c90, so those tests and the
 * simulator were REMOVED. Their scenarios now run on the real engines: security-review-4.lanes.test.ts (current
 * engine, numbers) and security-review-4.baseline.test.ts (current engine against the vendored 7b85c90 core).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSender, runTick, TICK_RESPONSE_LIMIT_MS, type OutboundMessage, type SendResult, type TickSummary } from '../src/index.js';
import { T0 } from './world.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

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
