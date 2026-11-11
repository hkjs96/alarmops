/**
 * Outbox lane simulator for security review 3 (R-17). Runs one tick per simulated minute on vitest's FAKE timers,
 * so provider timeouts, the tick budget and concurrency are exact and repeatable (no scaled real-time clock).
 *
 * Two engines drain the same scenario:
 * - 'lanes'    — the current `runTick` notify phase;
 * - 'baseline' — the outbox drain of commit 7b85c90 (before lanes and the circuit breaker): one claim of
 *   NOTIFY_BATCH in the old fair order, sent ONE AT A TIME until the 45 s budget, the rest released "due now".
 *   It is the reference the design rule is measured against: the lanes must never deliver less or later.
 *
 * A provider call's fate (`OK` / `HANG`) is a pure function of (job, attempt number, time), never of call order,
 * so both engines meet the same provider.
 */
import { vi } from 'vitest';
import {
  CLAIM_LEASE_SEC, MAX_ATTEMPTS, NOTIFY_BATCH, dispatchJob, runTick, type MemoryTickStore,
  type NotificationJob, type OutboundMessage, type SendResult, type Severity, type TickSummary,
} from '../src/index.js';
import { seedTenants } from './lane-world.js';
import { T0, at, seedWorld } from './world.js';

export const SEND_TIMEOUT = 10_000;
export const BASELINE_BUDGET = 45_000;

export type Fate = 'OK' | 'HANG';
export interface Feed { tenant: number; count: number; severity?: Severity; tag?: string }
export interface Scenario {
  tenants: number;
  /** Ticks run at minute 1 … `minutes`. */
  minutes: number;
  /** VOICE pages put in the outbox right before the tick of minute `m`. */
  feed: (m: number) => Feed[];
  fate: (msg: OutboundMessage, attempt: number, now: Date) => Fate;
}
export interface JobOutcome { key: string; tenant: number; severity: Severity; queuedAt: Date; reachedAt: Date | null; delayMs: number; status: string; attempts: number }
export interface Outcome {
  jobs: JobOutcome[];
  total: number;
  delivered: number;
  /** Largest queue-to-provider delay among delivered jobs. */
  maxDelayMs: number;
  /** Delay below which 90% of ALL jobs were delivered (Infinity when fewer than 90% were). */
  p90DelayMs: number;
  providerCalls: number;
  timeouts: number;
  /** Longest tick, in simulated ms. */
  maxTickMs: number;
  delayOf: (tag: string) => number;
}

/** mulberry32: small seeded generator for scenario parameters. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Uniform [0,1) from a string — the per-(job, attempt) dice. */
export function dice(text: string, seed = 0): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const now = (): Date => new Date(Date.now());

/** Let a promise finish on the fake clock: flush microtasks, jump to the next timer, repeat. */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; !done; i++) {
    await vi.advanceTimersByTimeAsync(0);
    if (done) break;
    if (i > 100_000) throw new Error('simulation does not finish');
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
  }
  return p;
}

function oldFairOrder(due: NotificationJob[]): NotificationJob[] {
  const sev1 = (j: NotificationJob): number => (j.payload.severity === 'SEV_1' ? 0 : 1);
  const cmp = (a: NotificationJob, b: NotificationJob): number => sev1(a) - sev1(b) || a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime();
  const queues = new Map<string, NotificationJob[]>();
  for (const j of due) { const k = j.customerId ?? ''; const q = queues.get(k); if (q) q.push(j); else queues.set(k, [j]); }
  for (const q of queues.values()) q.sort(cmp);
  const out: NotificationJob[] = [];
  for (let round = 0; out.length < due.length; round++) out.push(...[...queues.values()].filter((q) => q.length > round).map((q) => q[round]!).sort(cmp));
  return out;
}

/** The notify phase of 7b85c90, on the same store and sender port. */
async function baselineTick(store: MemoryTickStore, senders: { VOICE: { send(m: OutboundMessage): Promise<SendResult> } }): Promise<void> {
  const deadline = Date.now() + BASELINE_BUDGET;
  const t = now();
  const due: NotificationJob[] = [];
  for (const j of store.jobs.values()) {
    if (!((j.status === 'QUEUED' || j.status === 'SENDING') && j.nextAttemptAt.getTime() <= t.getTime())) continue;
    if (j.attempts >= MAX_ATTEMPTS) { j.status = 'FAILED'; continue; }
    due.push(j);
  }
  const claimed = oldFairOrder(due).slice(0, NOTIFY_BATCH);
  for (const j of claimed) { j.status = 'SENDING'; j.claimSeq++; j.nextAttemptAt = new Date(t.getTime() + CLAIM_LEASE_SEC * 1000); }
  for (let i = 0; i < claimed.length; i++) {
    if (Date.now() >= deadline) {
      for (const rest of claimed.slice(i)) { rest.status = 'QUEUED'; rest.nextAttemptAt = now(); }
      return;
    }
    const job = claimed[i]!;
    const inc = await store.findIncidentById(job.incidentId);
    const person = job.contactId ? await store.getContact(job.contactId) : null;
    const out = await dispatchJob(structuredClone(job), {
      now: now(), senders, incidentStatus: inc?.status ?? null, contact: person, slackChannels: [], sendTimeoutMs: SEND_TIMEOUT,
      beginSend: () => store.beginSend(job.id, job.claimSeq),
    });
    if (out.status === 'SENT') await store.completeJob(job.id, job.claimSeq, { status: 'SENT', providerMessageId: out.providerMessageId }, out.log);
    else if (out.status === 'FAILED') await store.completeJob(job.id, job.claimSeq, { status: 'FAILED', error: out.error, errorCode: out.errorCode }, out.log);
    else if (out.status === 'RETRY') await store.completeJob(job.id, job.claimSeq, { status: 'QUEUED', error: out.error, errorCode: out.errorCode });
    else if (out.status === 'SKIPPED') await store.completeJob(job.id, job.claimSeq, { status: 'SKIPPED', error: out.reason });
  }
}

/** Run a scenario. The caller must have fake timers on (`vi.useFakeTimers()`). */
export async function simulate(sc: Scenario, engine: 'lanes' | 'baseline'): Promise<Outcome> {
  vi.setSystemTime(T0);
  const store = seedWorld();
  store.clock = now;
  const base = await drive(seedTenants(store, sc.tenants, () => 'VOICE', now));

  const reached = new Map<string, Date>();
  const calls = new Map<string, number>();
  let providerCalls = 0; let timeouts = 0;
  const voice = { send(m: OutboundMessage): Promise<SendResult> {
    providerCalls++;
    const attempt = (calls.get(m.idempotencyKey) ?? 0) + 1;
    calls.set(m.idempotencyKey, attempt);
    if (sc.fate(m, attempt, now()) === 'HANG') { timeouts++; return new Promise<SendResult>(() => undefined); }
    if (!reached.has(m.idempotencyKey)) reached.set(m.idempotencyKey, now());
    return Promise.resolve({ ok: true, providerMessageId: `v-${providerCalls}` });
  } };

  const injected: Array<{ key: string; tenant: number; severity: Severity; queuedAt: Date }> = [];
  let maxTickMs = 0;
  for (let m = 1; m <= sc.minutes; m++) {
    const wait = at(m).getTime() - Date.now();
    if (wait > 0) await vi.advanceTimersByTimeAsync(wait);
    for (const f of sc.feed(m)) {
      const b = base.get(f.tenant)!;
      for (let k = 0; k < f.count; k++) {
        const key = `${b.idempotencyKey}#${f.tag ?? 'j'}_m${m}_${k}`;
        const severity = f.severity ?? 'SEV_1';
        store.jobs.set(key, { ...structuredClone(b), id: `job_${f.tenant}_${f.tag ?? 'j'}_m${m}_${k}`, idempotencyKey: key, payload: { ...b.payload, severity }, nextAttemptAt: at(m), dueAt: at(m), createdAt: at(m), status: 'QUEUED', attempts: 0, claimSeq: 0, lastError: null });
        injected.push({ key, tenant: f.tenant, severity, queuedAt: at(m) });
      }
    }
    const started = Date.now();
    if (engine === 'lanes') {
      const r = await drive(runTick({ scheduledAt: at(m), jobs: ['notify'] }, { repo: store, senders: { VOICE: voice }, now, sendTimeoutMs: SEND_TIMEOUT })) as TickSummary;
      if ('skipped' in r) throw new Error('tick skipped');
    } else await drive(baselineTick(store, { VOICE: voice }));
    maxTickMs = Math.max(maxTickMs, Date.now() - started);
  }

  const jobs: JobOutcome[] = injected.map((x) => {
    const j = store.jobs.get(x.key)!;
    const r = reached.get(x.key) ?? null;
    return { ...x, reachedAt: r, delayMs: r ? r.getTime() - x.queuedAt.getTime() : Infinity, status: j.status, attempts: j.attempts };
  });
  const delays = jobs.map((j) => j.delayMs).sort((a, b) => a - b);
  const fin = delays.filter((d) => d !== Infinity);
  return {
    jobs, total: jobs.length, delivered: fin.length, maxDelayMs: fin.length ? fin[fin.length - 1]! : 0,
    p90DelayMs: delays.length ? delays[Math.min(delays.length - 1, Math.ceil(delays.length * 0.9) - 1)]! : 0,
    providerCalls, timeouts, maxTickMs,
    delayOf: (tag) => jobs.find((j) => j.key.includes(`#${tag}_`))?.delayMs ?? NaN,
  };
}

export const MIN = 60_000;
/** Minutes since the first tick (minute 1). */
export const sinceStart = (d: Date): number => (d.getTime() - at(1).getTime()) / MIN;
