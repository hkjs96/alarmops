/**
 * Lane scenarios on a REAL engine (security review 4). Every scenario drives the engine's own `runTick` and
 * `MemoryTickStore` — nothing of the drain is re-implemented here. The engine is a parameter:
 *
 * - `NOW`      — `../src` (this worktree);
 * - `BASELINE` — `./fixtures/baseline-7b85c90`, the core of commit 7b85c90 as `git archive` wrote it (see its README).
 *
 * The only fakes are the provider (a sender whose answer is a pure function of the message, the number of the call
 * for that key, and the time — so both engines meet the same provider) and the clock: vitest fake timers, one tick
 * per simulated minute, `Date.now()` is the runner's and the store's clock. Timeouts, the 45 s budget and
 * concurrency are therefore exact and repeatable; there is no scaled real-time clock and no timer jitter.
 *
 * The scenarios are the ones of the reviewer's probe (`v4/lanes.mts`: S1 … S7) with the same shapes and numbers.
 * One deliberate difference: S5 ("k numbers of one customer hang") gives every call its own contact, because that
 * is what 20 numbers are; the probe reused one contact for all 20.
 */
import { vi } from 'vitest';
import * as now from '../src/index.js';
import * as base from './fixtures/baseline-7b85c90/packages/core/src/index.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Engine { name: 'now' | '7b85c90'; mod: any }
export const NOW: Engine = { name: 'now', mod: now };
export const BASELINE: Engine = { name: '7b85c90', mod: base };

export type Lane = 'VOICE' | 'SMS' | 'EMAIL' | 'SLACK_DM' | 'SLACK_CHANNEL';
export const LANES_5: readonly Lane[] = ['VOICE', 'SMS', 'EMAIL', 'SLACK_DM', 'SLACK_CHANNEL'];
const KIND: Record<Lane, string> = { VOICE: 'VOICE', SMS: 'SMS', EMAIL: 'EMAIL', SLACK_DM: 'SLACK', SLACK_CHANNEL: 'SLACK' };

export const T0 = new Date('2026-11-09T03:00:00Z');
export const at = (min: number, sec = 0): Date => new Date(T0.getTime() + min * 60_000 + sec * 1000);
export const MIN = 60_000;
export const SEND_TIMEOUT = 10_000;
const V = new Date('2026-10-01T00:00:00Z');
const clock = (): Date => new Date(Date.now());

/** FNV-1a → [0,1): the dice of one provider call. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Let a promise finish on the fake clock: flush everything that is runnable, jump to the next timer, repeat. */
export async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; !done; i++) {
    await vi.advanceTimersByTimeAsync(0);
    if (done) break;
    if (i > 200_000) throw new Error('the tick does not finish');
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
  }
  return p;
}

const contact = (id: string, customerId: string, name: string, n: number) => ({
  id, kind: 'CUSTOMER', customerId, name, active: true, phone: `+8210555${String(n).padStart(5, '0')}`, email: `${id}@example.test`, slackUserId: `U${id}`,
  phoneVerifiedAt: V, emailVerifiedAt: V, slackVerifiedAt: V,
});

export interface World {
  store: any;
  /** Put `count` pages of tenant `i` in the outbox, due at `when`. Returns their idempotency keys. */
  inject(i: number, count: number, when: Date, tag: string, opts?: { ownContact?: boolean; contactId?: string }): string[];
}

/**
 * `n` tenants (`cus_t0` …), each with one person and one open incident whose single step pages that person on
 * `lane(i)`. The incident is opened by the engine itself (group + escalation phases); its first page is the
 * template for the injected ones and is marked SENT.
 */
export async function world(e: Engine, n: number, lane: (i: number) => Lane, sev: (i: number) => string = () => 'SEV_1'): Promise<World> {
  vi.setSystemTime(T0);
  const store = new e.mod.MemoryTickStore();
  store.clock = clock;
  store.slackChannels.set('msp', ['C_MSP']);
  for (let i = 0; i < n; i++) {
    const cid = `cus_t${i}`; const p = `ct_t${i}`; const acct = `40000000${String(i).padStart(4, '0')}`;
    store.customers.set(cid, { id: cid, name: `T${i}`, slug: `t${i}` });
    store.accounts.set(acct, { awsAccountId: acct, customerId: cid, serviceId: null });
    store.contacts.set(p, contact(p, cid, `P${i}`, i));
    store.responders.push({ customerId: cid, contactId: p, role: 'PAGEABLE' });
    store.slackChannels.set(`customer:${cid}`, [`C_T${i}`]);
    store.configs.push({ id: `pc_${cid}`, customerId: cid, scopeType: 'CUSTOMER', scopeId: cid, style: 'CUSTOM', plan: 'STANDARD', edited: false, repeatCount: 0, version: 1,
      steps: [{ index: 0, atMin: 0, targetType: 'PERSON', targetId: p, channels: [lane(i)] }] });
    const severity = sev(i);
    const key = e.mod.groupKey({ customerId: cid, awsAccountId: acct, severity });
    const openedAt = new Date(T0.getTime() - 40_000);
    const gid = e.mod.groupId(key, openedAt);
    store.groups.set(gid, { id: gid, groupKey: key, customerId: cid, severity, status: 'CLOSED', openedAt, groupWaitSec: 30, closeAt: new Date(T0.getTime() - 10_000),
      closedAt: new Date(T0.getTime() - 10_000), pauseUntil: null, staleAfter: new Date(T0.getTime() + 300_000), deliveredAt: null, version: 1 });
    store.members.set(gid, [{ alertId: `al_${i}`, fingerprint: `fp:al_${i}`, severity, title: `al_${i} high`, awsAccountId: acct, resourceType: 'EC2', source: 'CLOUDWATCH', decision: 'NOTIFY', episodeOpen: true, eventCount: 1 }]);
    store.episodes.set(`al_${i}`, true);
  }
  await settle(e.mod.runTick({ scheduledAt: T0, jobs: ['group', 'escalation'] }, { repo: store, senders: {}, now: clock }));
  const bases = new Map<number, any>();
  for (const v of store.jobs.values()) {
    const m = /^cus_t(\d+)$/.exec(v.customerId ?? '');
    if (m) { if (!bases.has(+m[1]!)) bases.set(+m[1]!, structuredClone(v)); v.status = 'SENT'; }
  }
  if (bases.size !== n) throw new Error(`expected a template page for ${n} tenants, got ${bases.size}`);
  let people = 0;
  const inject: World['inject'] = (i, count, when, tag, opts = {}) => {
    const b = bases.get(i);
    const keys: string[] = [];
    for (let k = 0; k < count; k++) {
      const key = `${b.idempotencyKey}#${tag}${k}`;
      const over: Record<string, unknown> = {};
      if (b.contactId && (opts.ownContact || opts.contactId)) {
        const id = opts.contactId ?? `ct_t${i}_${tag}${k}`;
        if (!store.contacts.has(id)) store.contacts.set(id, contact(id, b.customerId, `P${i}-${tag}${k}`, 1000 + people++));
        Object.assign(over, { contactId: id, targetRef: id, contactName: store.contacts.get(id).name });
      }
      store.jobs.set(key, { ...structuredClone(b), ...over, id: `job_${i}_${tag}${k}`, idempotencyKey: key, nextAttemptAt: when, dueAt: when, createdAt: when, status: 'QUEUED', attempts: 0, claimSeq: 0, lastError: null, providerMessageId: null });
      keys.push(key);
    }
    return keys;
  };
  return { store, inject };
}

export type Fate = 'OK' | 'HANG' | 'FAIL';
export interface Run {
  /** key → when the provider first accepted it. */
  reached: Map<string, Date>;
  okCount: Map<string, number>;
  calls: number;
  hangs: number;
  /** Provider calls per tick: `${customerId}|${idempotencyKey}`. */
  perTick: string[][];
  /** Most HANGING calls started at the same instant — they are all in flight together until the timeout. */
  maxBurst: number;
  /** Longest runTick call, simulated ms. */
  maxTickMs: number;
  degraded: number;
  unanswered: number;
  ticks: number;
  errors: string[];
  store: any;
}

/** One tick per simulated minute m = 1 … `to` (stops early when `stop` says so). `before(m)` injects pages. */
export async function drive(
  e: Engine, store: any, to: number, before: (m: number) => void, fate: (msg: any, nth: number, now: Date) => Fate,
  stop: (r: Run) => boolean = () => false, opts: { deps?: Record<string, unknown>; answerMs?: number; parallel?: number } = {},
): Promise<Run> {
  // A release is a store write and takes time. Against a database, consecutive releases get different timestamps;
  // 7b85c90 stamps a released job "due now" and orders the next claim by that stamp, so with a frozen clock all
  // released jobs would tie and it would look far worse than it is (6 hanging tenants × 5 pages: 22 minutes instead
  // of 1 tick). Each release therefore moves the clock by 1 ms — for both engines.
  if (!store.__timedRelease) {
    const release = store.releaseJob.bind(store);
    store.releaseJob = (...args: unknown[]) => { vi.setSystemTime(Date.now() + 1); return release(...args); };
    store.__timedRelease = true;
  }
  const run: Run = { reached: new Map(), okCount: new Map(), calls: 0, hangs: 0, perTick: [], maxBurst: 0, maxTickMs: 0, degraded: 0, unanswered: 0, ticks: 0, errors: [], store };
  const nth = new Map<string, number>();
  let tickCalls: string[] = [];
  const burst = new Map<number, number>();
  const sender = { send(m: any): Promise<any> {
    run.calls++; tickCalls.push(`${m.customerId}|${m.idempotencyKey}`);
    const n = (nth.get(m.idempotencyKey) ?? 0) + 1; nth.set(m.idempotencyKey, n);
    const f = fate(m, n, clock());
    if (f === 'HANG') {
      run.hangs++;
      const b = (burst.get(Date.now()) ?? 0) + 1; burst.set(Date.now(), b); run.maxBurst = Math.max(run.maxBurst, b);
      return new Promise(() => undefined);
    }
    const answer = (): any => {
      if (f === 'FAIL') return { ok: false, error: 'provider said no', retryable: true };
      if (!run.reached.has(m.idempotencyKey)) run.reached.set(m.idempotencyKey, clock());
      run.okCount.set(m.idempotencyKey, (run.okCount.get(m.idempotencyKey) ?? 0) + 1);
      return { ok: true, providerMessageId: 'ok' };
    };
    return opts.answerMs ? new Promise((res) => setTimeout(() => res(answer()), opts.answerMs)) : Promise.resolve(answer());
  } };
  const senders = { VOICE: sender, SMS: sender, EMAIL: sender, SLACK: sender };
  for (let m = 1; m <= to && !stop(run); m++) {
    const wait = at(m).getTime() - Date.now();
    if (wait > 0) await vi.advanceTimersByTimeAsync(wait);
    before(m);
    tickCalls = [];
    const t0 = Date.now();
    const tick = (): Promise<any> => e.mod.runTick({ scheduledAt: at(m), jobs: ['notify'] }, { repo: store, senders, now: clock, sendTimeoutMs: SEND_TIMEOUT, ...opts.deps });
    const results: any[] = await settle(Promise.all(Array.from({ length: opts.parallel ?? 1 }, tick)));
    run.maxTickMs = Math.max(run.maxTickMs, Date.now() - t0); run.ticks++;
    run.perTick.push(tickCalls);
    for (const r of results) {
      for (const x of r.errors ?? []) run.errors.push(`${x.phase}:${x.id}:${x.message}`);
      if (r.notify?.unanswered?.length) run.unanswered++;
    }
    const hb = (await store.readHeartbeats()).find((h: any) => h.name === 'notify');
    if (hb?.lastStatus === 'DEGRADED') run.degraded++;
  }
  return run;
}

/** Keys the provider accepted more than once — must always be 0. */
export const dups = (r: Run): number => [...r.okCount.values()].filter((n) => n > 1).length;
const delayMs = (r: Run, key: string, from: Date): number => (r.reached.has(key) ? r.reached.get(key)!.getTime() - from.getTime() : Infinity);

export interface Single { delayMs: number; dups: number; maxTickMs: number; degradedTicks: number; ticks: number; calls: number }
const single = (r: Run, key: string, from: Date): Single => ({ delayMs: delayMs(r, key, from), dups: dups(r), maxTickMs: r.maxTickMs, degradedTicks: r.degraded, ticks: r.ticks, calls: r.calls });

export interface Dist {
  total: number; delivered: number; gaveUp: number; waiting: number;
  /** Queue-to-provider delay of every page, ascending; Infinity = never accepted by the provider. */
  delays: number[];
  p50: number; p90: number; max: number;
  dups: number; maxTickMs: number; calls: number;
}
function dist(r: Run, keys: string[], created: Map<string, Date>): Dist {
  const jobs = keys.map((k) => r.store.jobs.get(k));
  const delays = keys.map((k) => delayMs(r, k, created.get(k)!)).sort((a, b) => a - b);
  const fin = delays.filter((d) => d !== Infinity);
  const q = (f: number): number => (fin.length ? fin[Math.min(fin.length - 1, Math.floor(fin.length * f))]! : Infinity);
  return {
    total: keys.length, delivered: fin.length, gaveUp: jobs.filter((j) => j.status === 'FAILED').length, waiting: jobs.filter((j) => j.status === 'QUEUED' || j.status === 'SENDING').length,
    delays, p50: q(0.5), p90: q(0.9), max: fin.length ? fin[fin.length - 1]! : Infinity, dups: dups(r), maxTickMs: r.maxTickMs, calls: r.calls,
  };
}

/** S1 — tenant B has `nBad` hanging SEV-1 pages (queued 01:00, + `feed` a minute); healthy A gets one SEV-1 at 02:00. */
export async function S1(e: Engine, lane: Lane, nBad: number, feed = 0): Promise<Single> {
  const { store, inject } = await world(e, 2, () => lane);
  inject(0, nBad, at(1), 'bad');
  let a: string[] = [];
  const r = await drive(e, store, 120, (m) => { if (m === 2) a = inject(1, 1, at(2), 'good'); if (feed && m >= 2) inject(0, feed, at(m), `bad_m${m}_`); },
    (msg) => (msg.customerId === 'cus_t0' ? 'HANG' : 'OK'), (x) => a.length > 0 && x.reached.has(a[0]!));
  return single(r, a[0]!, at(2));
}

/** S2 — a share `p` of all calls times out. 3 tenants × 4 SEV-1 a minute for 30 minutes, 60 ticks. */
export async function S2(e: Engine, lane: Lane, p: number, seed: number): Promise<Dist> {
  const { store, inject } = await world(e, 3, () => lane);
  const keys: string[] = []; const created = new Map<string, Date>();
  const r = await drive(e, store, 60, (m) => { if (m <= 30) for (let t = 0; t < 3; t++) for (const k of inject(t, 4, at(m), `m${m}_`)) { keys.push(k); created.set(k, at(m)); } },
    (msg, n) => (hash01(`${seed}|${msg.idempotencyKey}|${n}`) < p ? 'HANG' : 'OK'));
  return dist(r, keys, created);
}

/** S3 — the whole provider is down `down` minutes, up `up` minutes. 2 tenants × 4 SEV-1 a minute for 30 minutes, 75 ticks. */
export async function S3(e: Engine, lane: Lane, down: number, up: number): Promise<Dist> {
  const { store, inject } = await world(e, 2, () => lane);
  const keys: string[] = []; const created = new Map<string, Date>();
  const r = await drive(e, store, 75, (m) => { if (m <= 30) for (let t = 0; t < 2; t++) for (const k of inject(t, 4, at(m), `m${m}_`)) { keys.push(k); created.set(k, at(m)); } },
    (_m, _n, t) => (((t.getTime() - at(1).getTime()) / MIN) % (down + up) < down ? 'HANG' : 'OK'));
  return dist(r, keys, created);
}

/**
 * S4 — `H` tenants whose calls hang stand AHEAD of healthy tenant A's single page (`aSev`). `depth` hanging pages per
 * tenant (queued 00:30), `feed` more per tenant per minute; A's page is queued 00:59. Delay is counted from 01:00,
 * A's first chance.
 */
export async function S4(e: Engine, lane: Lane, H: number, depth: number, feed = 0, aSev = 'SEV_1', maxTicks = 240): Promise<Single> {
  const { store, inject } = await world(e, H + 1, () => lane, (i) => (i === H ? aSev : 'SEV_1'));
  for (let i = 0; i < H; i++) inject(i, depth, at(0, 30), 'bad');
  const a = inject(H, 1, at(0, 59), 'good');
  const r = await drive(e, store, maxTicks, (m) => { if (feed && m >= 2) for (let i = 0; i < H; i++) inject(i, feed, at(m, -1), `bad_m${m}_`); },
    (msg) => (msg.customerId === `cus_t${H}` ? 'OK' : 'HANG'), (x) => x.reached.has(a[0]!));
  return single(r, a[0]!, at(1));
}

export interface Numbers { healthy: number; delivered: number; firstMs: number; lastMs: number; dups: number; maxTickMs: number }
/** S5 — one tenant, one step of 20 SEV-1 pages to 20 DIFFERENT people; `k` of the numbers hang (the first k, or spread). */
export async function S5(e: Engine, lane: Lane, k: number, where: 'first' | 'spread'): Promise<Numbers> {
  const { store, inject } = await world(e, 1, () => lane);
  const keys: string[] = [];
  for (let i = 0; i < 20; i++) keys.push(...inject(0, 1, new Date(at(0, 30).getTime() + i), `c${String(i).padStart(2, '0')}_`, { ownContact: true })); // createdAt order = list order
  const badIdx = new Set(where === 'first' ? Array.from({ length: k }, (_, i) => i) : Array.from({ length: k }, (_, i) => Math.floor((i * 20) / k)));
  const bad = new Set([...badIdx].map((i) => keys[i]!));
  const r = await drive(e, store, 60, () => undefined, (msg) => (bad.has(msg.idempotencyKey) ? 'HANG' : 'OK'), (x) => x.reached.size >= 20 - k);
  const d = [...r.reached.values()].map((x) => x.getTime() - at(1).getTime()).sort((a, b) => a - b);
  return { healthy: 20 - k, delivered: d.length, firstMs: d[0] ?? Infinity, lastMs: d.length === 20 - k ? d[d.length - 1]! : Infinity, dups: dups(r), maxTickMs: r.maxTickMs };
}

/** S6 — lane `hung` hangs entirely with a deep backlog (4 tenants × 20); a fifth … tenant has one SEV-1 page in each OTHER lane. */
export async function S6(e: Engine, hung: Lane): Promise<{ delays: Record<string, number>; dups: number; maxTickMs: number }> {
  const others = (['VOICE', 'SMS', 'EMAIL', 'SLACK_DM'] as Lane[]).filter((l) => l !== hung);
  const { store, inject } = await world(e, 4 + others.length, (i) => (i < 4 ? hung : others[i - 4]!));
  for (let i = 0; i < 4; i++) inject(i, 20, at(0, 30), 'bad');
  const good = others.map((_, x) => inject(4 + x, 1, at(0, 59), 'good')[0]!);
  const r = await drive(e, store, 30, () => undefined, (msg) => (msg.kind === KIND[hung] ? 'HANG' : 'OK'), (x) => good.every((g) => x.reached.has(g)));
  return { delays: Object.fromEntries(others.map((l, x) => [l, delayMs(r, good[x]!, at(1))])), dups: dups(r), maxTickMs: r.maxTickMs };
}

/** S7 — a slow provider that answers after `answerMs`, and THREE runners calling the tick for the same minute. 3 tenants × 15 pages, 6 minutes. */
export async function S7(e: Engine, lane: Lane, answerMs: number): Promise<{ jobs: number; providerOk: number; keysCalledTwice: number; sentLogs: number; sentJobs: number; maxTickMs: number }> {
  const { store, inject } = await world(e, 3, () => lane);
  const keys: string[] = [];
  for (let t = 0; t < 3; t++) keys.push(...inject(t, 15, at(0, 30), 'x'));
  store.dedupeTicks = false;
  const r = await drive(e, store, 6, () => undefined, () => 'OK', () => false, { answerMs, parallel: 3 });
  const ids = new Set(keys.map((k) => store.jobs.get(k).id));
  return {
    jobs: keys.length, providerOk: [...r.okCount.values()].reduce((a, b) => a + b, 0), keysCalledTwice: dups(r),
    sentLogs: store.logs.filter((l: any) => l.status === 'SENT' && ids.has(l.jobId)).length, sentJobs: keys.filter((k) => store.jobs.get(k).status === 'SENT').length, maxTickMs: r.maxTickMs,
  };
}

export const mins = (ms: number): string => (ms === Infinity ? 'never' : (ms / MIN).toFixed(2));
/** Whole ticks a page slipped: 0 = sent in the tick in which it was first due. */
export const ticksSlipped = (ms: number): number => (ms === Infinity ? Infinity : Math.floor(ms / MIN));
