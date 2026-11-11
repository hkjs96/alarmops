/**
 * Regression tests for the second security review of feat/tick-escalation
 * (R-11 … R-16, N-11 … N-20). Each block names the finding and reproduces the reviewer's probe.
 */
import { describe, expect, it } from 'vitest';
import {
  FakeSender, LANE_CONCURRENCY, MAINTENANCE_RECHECK_SEC, MAX_ATTEMPTS, MAX_SENDS_PER_CYCLE, MAX_SENDS_PER_HOUR, MemoryTickStore,
  NON_SEV1_RESERVE_PCT, NOTIFY_BATCH, buildSnapshot, clampSnapshot, dispatchJob, fairOrder, heartbeatHealth, loadPolicyFlags, pagingHealth, parseFlag, parseSnapshot,
  resolveDestination, runTick, sanitizeProviderError, selectForClaim, sendCapViolations, verifiedAt,
  type Contact, type NotificationJob, type NotifyChannel, type OutboundMessage, type SendResult, type Severity, type StepChannel, type TickSummary,
} from '../src/index.js';
import { Sim, T0, at, closedGroup, config, on, seedWorld, step } from './world.js';

const V = new Date('2026-10-01T00:00:00Z');
const minutes = (d: Date) => (d.getTime() - T0.getTime()) / 60_000;

/** A simulated clock shared by the runner and the store. A hanging provider call moves it 10 s on (the send timeout). */
function simClock(start: Date) {
  let now = start;
  return {
    get: () => now,
    set: (d: Date) => { now = d; },
    /** Calls that start together time out together: the clock ends at (start of the call + 10 s), not + 10 s per call. */
    hang: () => { const started = now; return () => { if (now.getTime() < started.getTime() + 10_000) now = new Date(started.getTime() + 10_000); }; },
  };
}
const hanging = (clock: ReturnType<typeof simClock>, calls: OutboundMessage[] = []) => ({
  calls,
  send(m: OutboundMessage): Promise<SendResult> {
    calls.push(m);
    const passed = clock.hang();
    // the tick's own timeout (sendTimeoutMs: 1) cuts the call; by then 10 simulated seconds have gone by
    // (a microtask, not a timer: it must have run before the timeout timer does, also for calls made one by one)
    void Promise.resolve().then(passed);
    return new Promise<SendResult>(() => undefined);
  },
});

function addStaff(s: MemoryTickStore, customerId: string, n: number) {
  for (let i = 0; i < n; i++) {
    s.contacts.set(`ct_s${i}`, { id: `ct_s${i}`, kind: 'INTERNAL', customerId: null, name: `Staff ${i}`, active: true, phone: `+8210555000${i}`, email: `s${i}@example.test`, slackUserId: `US${i}`, phoneVerifiedAt: V, emailVerifiedAt: V, slackVerifiedAt: V });
    s.responders.push({ customerId, contactId: `ct_s${i}`, role: 'PAGEABLE' });
  }
}

/** n tenants (`cus_t0…`), one open incident each; `inject` adds queued pages straight to the outbox. */
async function tenants(n: number, sev: (i: number) => Severity, channel: (i: number) => StepChannel) {
  const store = seedWorld();
  for (let i = 0; i < n; i++) {
    const cid = `cus_t${i}`; const p = `ct_t${i}`; const acct = `40000000${String(i).padStart(4, '0')}`;
    store.customers.set(cid, { id: cid, name: `T${i}`, slug: `t${i}` });
    store.accounts.set(acct, { awsAccountId: acct, customerId: cid, serviceId: null });
    store.contacts.set(p, { id: p, kind: 'CUSTOMER', customerId: cid, name: `P${i}`, active: true, phone: `+82105550${String(i).padStart(4, '0')}`, email: `${p}@example.test`, slackUserId: `U${p}`, phoneVerifiedAt: V, emailVerifiedAt: V, slackVerifiedAt: V });
    store.responders.push({ customerId: cid, contactId: p, role: 'PAGEABLE' });
    store.configs.push(config(cid, [step(0, 0, 'PERSON', p, [channel(i)])], { repeatCount: 0 }));
    closedGroup(store, { customerId: cid, awsAccountId: acct, severity: sev(i), at: T0, alerts: [{ id: `al_${i}` }] });
  }
  await runTick({ scheduledAt: T0, jobs: ['group', 'escalation'] }, on({ repo: store, senders: {}, now: () => T0 }));
  const inc = (i: number) => [...store.incidents.values()].find((x) => x.customerId === `cus_t${i}`)!;
  const inject = (i: number, count: number, when: Date, tag: string, over: Partial<NotificationJob> = {}) => {
    const base = store.jobList(inc(i).id)[0]!;
    for (let k = 0; k < count; k++) {
      const key = `${base.idempotencyKey}#${tag}${k}`;
      store.jobs.set(key, { ...structuredClone(base), id: `job_${i}_${tag}${k}`, idempotencyKey: key, nextAttemptAt: when, dueAt: when, createdAt: when, status: 'QUEUED', attempts: 0, claimSeq: 0, ...over });
    }
  };
  return { store, inc, inject };
}

// ───────────────────────────── R-11 ─────────────────────────────

describe('R-11: a provider that hangs does not delay the healthy channels', () => {
  /** The reviewer's v2-trace: one customer, SEV-1, 20 people × [SMS, VOICE], SMS never answers. */
  const trace = () => {
    const store = seedWorld();
    addStaff(store, 'cus_mirae', 17); // + Haeun, Junho, Yuna = 20 pageable
    store.configs.push(config('cus_mirae', [step(0, 0, 'ALL_RESPONDERS', null, ['SMS', 'VOICE'])], { repeatCount: 0 }));
    closedGroup(store, { customerId: 'cus_mirae', severity: 'SEV_1', at: at(1), alerts: [{ id: 'a' }] });
    const clock = simClock(at(1));
    const voiceAt: number[] = [];
    const voice = { async send(): Promise<SendResult> { voiceAt.push(minutes(clock.get())); return { ok: true, providerMessageId: `v${voiceAt.length}` }; } };
    return { store, clock, voiceAt, voice, sms: hanging(clock) };
  };
  const tick = (t: ReturnType<typeof trace>, m: number, senders: Record<string, unknown>) => {
    t.clock.set(at(m));
    return runTick({ scheduledAt: at(m) }, on({ repo: t.store, senders: senders as never, now: t.clock.get, sendTimeoutMs: 1 })) as Promise<TickSummary>;
  };

  it('SMS hangs → all 20 voice calls go out within the SAME tick (was: tick 12, 11.5 minutes later)', async () => {
    const t = trace();
    const r = await tick(t, 1, { SMS: t.sms, VOICE: t.voice });
    expect(t.voiceAt).toHaveLength(20);
    expect(Math.max(...t.voiceAt)).toBeLessThan(2); // inside the tick that queued them
    expect(r.notify).toMatchObject({ sent: 20, unanswered: ['SMS'] });
    // review 3 (R-17): no breaker. A lane that got no answer keeps ONE call in flight: 45 s budget / 10 s timeout = 5
    // calls in the tick, one after the other; the rest went back untouched.
    const PROBES = 5;
    expect(t.sms.calls).toHaveLength(PROBES);
    expect(r.notify.timeouts).toBe(PROBES);
    expect(r.notify.released).toBe(20 - PROBES);
    const sms = t.store.jobList().filter((j) => j.channel === 'SMS');
    expect(sms.filter((j) => j.attempts === 0).map((j) => [j.status, j.dueAt, j.nextAttemptAt])).toEqual(Array.from({ length: 15 }, () => ['QUEUED', at(1), at(1)])); // original due time kept
    expect(sms.filter((j) => j.attempts === 1)).toHaveLength(PROBES);
    expect(r.durationMs).toBeLessThanOrEqual(45_000 + 10_000); // budget + one timeout
  });

  it('while SMS stays down: at most 5 calls per tick, never the same job twice in a row, voice keeps flowing; SMS recovers → the lane drains at once', async () => {
    const t = trace();
    for (let m = 1; m <= 3; m++) {
      const before = t.sms.calls.length;
      const r = await tick(t, m, { SMS: t.sms, VOICE: t.voice });
      expect(t.sms.calls.length - before).toBeLessThanOrEqual(5);
      expect(r.notify.unanswered).toEqual(['SMS']);
    }
    // fresh pages go before retries: 15 different people were tried in the three ticks, nobody twice
    expect(new Set(t.sms.calls.map((x) => x.contactId)).size).toBe(t.sms.calls.length);
    expect(t.store.jobList().filter((j) => j.channel === 'SMS' && j.status === 'FAILED')).toHaveLength(0);
    // the provider is back: the first call is answered and the lane goes to full width in that same tick
    const sms = new FakeSender('sms');
    const r4 = await tick(t, 4, { SMS: sms, VOICE: t.voice });
    expect(r4.notify.unanswered).toEqual([]);
    expect(sms.sent.length).toBeGreaterThanOrEqual(19); // everything that is due (one retry is due 10 s after the tick started)
    await tick(t, 5, { SMS: sms, VOICE: t.voice });
    expect(sms.sent).toHaveLength(20);
    expect(new Set(sms.sent.map((x) => x.contactId)).size).toBe(20);
  });

  it('5 (and 9) tenants paging through the hung SMS provider → another tenant’s SEV-1 e-mail is sent in the tick that queued it (was: not within 90 minutes)', async () => {
    for (const k of [5, 9]) {
      const { store, inc, inject } = await tenants(k + 1, () => 'SEV_1', (i) => (i === k ? 'EMAIL' : 'SMS'));
      const clock = simClock(at(1));
      const sms = hanging(clock);
      const mailAt: number[] = [];
      const mail = { async send(m: OutboundMessage): Promise<SendResult> { if (m.idempotencyKey.includes('#v')) mailAt.push(minutes(clock.get())); return { ok: true, providerMessageId: 'e' }; } };
      for (let t = 0; t < k; t++) inject(t, 20, at(1), 'b');
      for (let m = 1; m <= 3; m++) {
        clock.set(at(m));
        if (m === 2) inject(k, 1, at(2), 'v');
        await runTick({ scheduledAt: at(m), jobs: ['notify'] }, on({ repo: store, senders: { SMS: sms, EMAIL: mail }, now: clock.get, sendTimeoutMs: 1 }));
      }
      expect(mailAt, `${k} tenants`).toHaveLength(1);
      expect(mailAt[0]! - 2, `${k} tenants`).toBeLessThan(1); // queued 02:00, sent in the 02:00 tick
      expect(store.jobList(inc(k).id).every((j) => j.status === 'SENT')).toBe(true);
    }
  });

  it('voice, SMS, Slack and e-mail are independent: whichever one hangs, the other three deliver in the same tick', async () => {
    const CH: Array<[StepChannel, string]> = [['VOICE', 'VOICE'], ['SMS', 'SMS'], ['SLACK_DM', 'SLACK'], ['EMAIL', 'EMAIL']];
    for (const [, down] of CH) {
      const { store, inject } = await tenants(4, () => 'SEV_2', (i) => CH[i]![0]);
      const clock = simClock(at(1));
      const sent: Record<string, number> = {};
      const ok = (kind: string) => ({ async send(): Promise<SendResult> { sent[kind] = (sent[kind] ?? 0) + 1; return { ok: true, providerMessageId: kind }; } });
      const senders = Object.fromEntries(CH.map(([, kind]) => [kind, kind === down ? hanging(clock) : ok(kind)]));
      for (let i = 0; i < 4; i++) inject(i, 10, at(1), 'x');
      const r = (await runTick({ scheduledAt: at(1), jobs: ['notify'] }, on({ repo: store, senders, now: clock.get, sendTimeoutMs: 1 }))) as TickSummary;
      for (const [, kind] of CH) expect(sent[kind] ?? 0, `${down} down → ${kind}`).toBe(kind === down ? 0 : 11); // 10 injected + the incident's own page
      expect(r.notify.unanswered).toEqual([down]);
    }
  });

  it('throughput: 4 lanes × the batch per tick when healthy; a hung lane takes nothing from the others', async () => {
    const CH: StepChannel[] = ['VOICE', 'SMS', 'SLACK_DM', 'EMAIL'];
    const run = async (smsDown: boolean) => {
      const { store, inject } = await tenants(4, () => 'SEV_2', (i) => CH[i]!);
      for (let i = 0; i < 4; i++) inject(i, 149, at(1), 'x'); // 150 per lane with the incident's own page
      const clock = simClock(at(1));
      const fake = new FakeSender();
      const perTick: number[] = [];
      for (let m = 1; m <= 3; m++) {
        clock.set(at(m));
        const r = (await runTick({ scheduledAt: at(m), jobs: ['notify'] }, on({ repo: store, senders: { VOICE: fake, SLACK: fake, EMAIL: fake, SMS: smsDown ? hanging(clock) : fake }, now: clock.get, sendTimeoutMs: 1 }))) as TickSummary;
        perTick.push(r.notify.sent);
      }
      return perTick;
    };
    expect(await run(false)).toEqual([4 * NOTIFY_BATCH, 4 * NOTIFY_BATCH, 4 * NOTIFY_BATCH]); // 200 / tick (was 50)
    expect(await run(true)).toEqual([3 * NOTIFY_BATCH, 3 * NOTIFY_BATCH, 3 * NOTIFY_BATCH]); // 150 / tick with SMS down (was 5)
  });

  it('order inside a customer: SEV-1, then never-attempted before retries, then the ORIGINAL due time', () => {
    const mk = (title: string, severity: Severity, attempts: number, dueSec: number) =>
      ({ customerId: 'a', createdAt: at(0), dueAt: at(0, dueSec), nextAttemptAt: at(5), attempts, payload: { title, severity, text: '', stepLabel: '' } });
    const due = [mk('retry-early', 'SEV_2', 2, 0), mk('fresh-late', 'SEV_2', 0, 50), mk('fresh-early', 'SEV_2', 0, 10), mk('sev1-retry', 'SEV_1', 1, 40), mk('sev1-fresh', 'SEV_1', 0, 45)];
    expect(fairOrder(due).map((j) => j.payload.title)).toEqual(['sev1-fresh', 'sev1-retry', 'fresh-early', 'fresh-late', 'retry-early']);
  });

  it('a provider that answers with errors (not timeouts) is not reported as unanswered and is drained at full width', async () => {
    const { store, inject } = await tenants(1, () => 'SEV_2', () => 'SMS');
    inject(0, 20, at(1), 'x');
    const sms = new FakeSender('sms').failNext(100, { retryable: true, error: '503' });
    const r = (await runTick({ scheduledAt: at(1), jobs: ['notify'] }, on({ repo: store, senders: { SMS: sms }, now: () => at(1) }))) as TickSummary;
    expect(r.notify).toMatchObject({ retried: 21, released: 0, timeouts: 0, unanswered: [] });
  });
});

// ───────────────────────────── N-11 / N-12 ─────────────────────────────

describe('N-11: a Slack job with several channels is bounded by one timeout', () => {
  it('five hanging channels cost one timeout, not five', async () => {
    const job: NotificationJob = {
      id: 'job_1', idempotencyKey: 'inc:INITIAL:0:0:SLACK_BOT:scope', incidentId: 'inc', customerId: 'cus_mirae', purpose: 'INITIAL', channel: 'SLACK_BOT', targetRef: 'scope', contactId: null, contactName: null,
      stepIndex: 0, repeat: 0, payload: { title: 't', severity: 'SEV_2', text: 'x', stepLabel: 'Step 1/1' }, status: 'SENDING', attempts: 1, claimSeq: 1, nextAttemptAt: T0, dueAt: T0, lastError: null, providerMessageId: null, createdAt: T0,
    };
    const started: string[] = [];
    const slack = { send: (m: OutboundMessage) => { started.push(m.to); return new Promise<SendResult>(() => undefined); } };
    const t0 = performance.now();
    const out = await dispatchJob(job, { now: T0, senders: { SLACK: slack }, incidentStatus: 'TRIGGERED', contact: null, slackChannels: ['C1', 'C2', 'C3', 'C4', 'C5'], sendTimeoutMs: 40 });
    const elapsed = performance.now() - t0;
    expect(started).toHaveLength(5); // all five were started at once
    expect(elapsed).toBeLessThan(40 * 3); // ≈ 40 ms; sequential was 200 ms (5 × 10 s in production = past the tick budget)
    expect(out).toMatchObject({ status: 'RETRY', errorCode: 'TIMEOUT' });
  });

  it('one channel hanging does not hide the delivery to the others', async () => {
    const job = { id: 'j', idempotencyKey: 'k', incidentId: 'inc', customerId: 'c', purpose: 'INITIAL', channel: 'SLACK_BOT', targetRef: 'scope', contactId: null, contactName: null, stepIndex: 0, repeat: 0,
      payload: { title: 't', severity: 'SEV_2', text: 'x', stepLabel: 's' }, status: 'SENDING', attempts: 1, claimSeq: 1, nextAttemptAt: T0, dueAt: T0, lastError: null, providerMessageId: null, createdAt: T0 } as NotificationJob;
    const slack = { send: (m: OutboundMessage) => (m.to === 'C2' ? new Promise<SendResult>(() => undefined) : Promise.resolve<SendResult>({ ok: true, providerMessageId: `ts-${m.to}` })) };
    const out = await dispatchJob(job, { now: T0, senders: { SLACK: slack }, incidentStatus: 'TRIGGERED', contact: null, slackChannels: ['C1', 'C2', 'C3'], sendTimeoutMs: 20 });
    expect(out).toMatchObject({ status: 'SENT', providerMessageId: 'ts-C1,ts-C3' });
  });
});

describe('N-12: the outbox keeps its share of the tick, and a tick that did not page does not report OK', () => {
  const queuedSev1 = async () => {
    const sim = new Sim();
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['SMS', 'VOICE'])], { repeatCount: 0 }));
    closedGroup(sim.store, { customerId: 'cus_mirae', severity: 'SEV_1', at: T0, alerts: [{ id: 'a1' }] });
    await sim.tick(['group', 'escalation']);
    expect(sim.store.jobList()).toHaveLength(2);
    return sim;
  };

  it('an earlier phase that uses the WHOLE budget (and more): the outbox still gets its reserved share and pages', async () => {
    const sim = await queuedSev1();
    closedGroup(sim.store, { customerId: 'cus_hanbit', at: at(1), alerts: [{ id: 'a2' }] });
    let now = at(1);
    // the group phase's first query takes 50 simulated seconds — past the 45 s budget (the review's probe X)
    const slow = sim.store.listGroupsToClose.bind(sim.store);
    sim.store.listGroupsToClose = async (...a) => { now = at(1, 50); return slow(...a); };
    const r = (await runTick({ scheduledAt: at(1) }, on({ repo: sim.store, senders: sim.senders, now: () => now }))) as TickSummary;
    expect(r.truncated).toBe(true);
    expect(r.notify).toMatchObject({ sent: 2, dueSev1Unattempted: 0 });
    expect((await sim.store.readHeartbeats()).find((h) => h.name === 'notify')).toMatchObject({ lastStatus: 'OK' });
  });

  it('an earlier phase that never comes back (real time): it is left behind at its deadline and the outbox runs', async () => {
    const sim = await queuedSev1();
    sim.store.clock = () => new Date(); // real clocks for this one
    sim.store.listAutoResolvable = () => new Promise(() => undefined);
    const errors: string[] = [];
    const t0 = Date.now();
    const r = (await runTick({}, { repo: sim.store, senders: sim.senders, budgetMs: 400, log: (_l, _m, d) => { errors.push(String(d?.message)); } })) as TickSummary;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.notify.sent).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.errors.find((e) => e.phase === 'reconcile')?.message).toMatch(/did not finish within its share/);
    const hb = await sim.store.readHeartbeats();
    expect(hb.find((h) => h.name === 'reconcile')).toMatchObject({ lastStatus: 'ERROR' });
    expect(hb.find((h) => h.name === 'notify')).toMatchObject({ lastStatus: 'OK' });
  });

  it('ten ticks with no budget at all: SEV-1 pages were due and not attempted → notify heartbeat DEGRADED, health not ok (was: OK, 0 errors)', async () => {
    const sim = await queuedSev1();
    for (let m = 1; m <= 10; m++) {
      const r = (await runTick({ scheduledAt: at(m), jobs: ['notify'] }, on({ repo: sim.store, senders: sim.senders, budgetMs: 0, now: () => at(m) }))) as TickSummary;
      expect(r.notify).toMatchObject({ sent: 0, dueUnattempted: 2, dueSev1Unattempted: 2 });
    }
    const hb = (await sim.store.readHeartbeats()).find((h) => h.name === 'notify')!;
    expect(hb).toMatchObject({ lastStatus: 'DEGRADED', consecutiveFailures: 10 });
    expect(hb.lastStats).toMatchObject({ dueSev1Unattempted: 2 });
    const health = heartbeatHealth(await sim.store.readHeartbeats(), at(10), { jobs: ['notify'] });
    expect(health).toMatchObject({ stale: false, degraded: true, ok: false });
    // a healthy tick clears it
    await runTick({ scheduledAt: at(11), jobs: ['notify'] }, on({ repo: sim.store, senders: sim.senders, now: () => at(11) }));
    expect(heartbeatHealth(await sim.store.readHeartbeats(), at(11), { jobs: ['notify'] })).toMatchObject({ degraded: false, ok: true });
    expect(sim.allSent()).toHaveLength(2);
  });

  it('non-SEV-1 backlog alone is truncated, not DEGRADED; an unanswered lane holding SEV-1 pages IS degraded', async () => {
    const { store, inject } = await tenants(1, () => 'SEV_3', () => 'SMS');
    inject(0, 80, at(1), 'x');
    await runTick({ scheduledAt: at(1), jobs: ['notify'] }, on({ repo: store, senders: { SMS: new FakeSender() }, now: () => at(1) }));
    expect((await store.readHeartbeats()).find((h) => h.name === 'notify')).toMatchObject({ lastStatus: 'OK', lastStats: expect.objectContaining({ dueUnattempted: 31, dueSev1Unattempted: 0 }) });

    const t = await tenants(1, () => 'SEV_1', () => 'SMS');
    t.inject(0, 9, at(1), 'x');
    const clock = simClock(at(1));
    await runTick({ scheduledAt: at(1), jobs: ['notify'] }, on({ repo: t.store, senders: { SMS: hanging(clock) }, now: clock.get, sendTimeoutMs: 1 }));
    expect((await t.store.readHeartbeats()).find((h) => h.name === 'notify')).toMatchObject({ lastStatus: 'DEGRADED', lastStats: expect.objectContaining({ dueSev1Unattempted: 5, unanswered: ['SMS'] }) });
  });
});

// ───────────────────────────── N-13 ─────────────────────────────

describe('N-13: a page that waits into a maintenance window is held until the window ends, then sent if still unacknowledged', () => {
  /** One-step order. The first try fails at 00:00 (retry due 00:30); the window covers 00:10 → 20:00. */
  const oneStep = async (severity: Severity = 'SEV_2') => {
    const sim = new Sim();
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['SMS'])], { repeatCount: 0 }));
    closedGroup(sim.store, { customerId: 'cus_mirae', severity, at: T0, alerts: [{ id: 'a1' }] });
    sim.sms.failNext(1);
    await sim.run(0);
    sim.store.windows.push({ id: 'mw1', customerId: 'cus_mirae', scopeType: 'CUSTOMER', scopeId: 'cus_mirae', startsAt: at(0, 10), endsAt: at(20) });
    return sim;
  };
  const job = (sim: Sim) => sim.store.jobList().find((j) => j.channel === 'SMS')!;

  it('one-step order: held through the window (no attempt used, one timeline line), sent at the first tick after it ends', async () => {
    const sim = await oneStep();
    await sim.run(1);
    expect(job(sim)).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'deferred_by_maintenance', dueAt: at(1, MAINTENANCE_RECHECK_SEC) });
    await sim.run(19);
    expect(sim.sms.sent).toHaveLength(0);
    expect(job(sim)).toMatchObject({ status: 'QUEUED', attempts: 1, dueAt: at(20) }); // the last re-check lands on the window's end
    const notes = sim.store.eventsOf(sim.incident().id).filter((e) => e.data?.note === 'DEFERRED_MAINTENANCE');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toBe('Step 1/1: SMS to Haeun Kim is held by a maintenance window until 2026-11-09T03:20Z. It is sent then if the incident is still unacknowledged.');
    await sim.run(20); // [start, end): the window is over at 20:00
    expect(sim.sms.sent).toHaveLength(1);
    expect(job(sim)).toMatchObject({ status: 'SENT', attempts: 2 });
    expect(sim.store.logs.filter((l) => l.status === 'SENT')).toHaveLength(1);
  });

  it('acknowledged during the window → not sent when it ends', async () => {
    const sim = await oneStep();
    await sim.run(5);
    const inc = sim.incident();
    sim.store.incidents.set(inc.id, { ...inc, status: 'ACKNOWLEDGED', acknowledgedAt: at(5), nextEscalationAt: null, version: inc.version + 1 });
    await sim.run(25);
    expect(sim.sms.sent).toHaveLength(0);
    expect(job(sim)).toMatchObject({ status: 'SKIPPED', lastError: 'acknowledged' });
  });

  it('window revoked early → the page goes out at the next re-check, not at the original end', async () => {
    const sim = await oneStep();
    await sim.run(3);
    sim.store.windows[0]!.revokedAt = at(3, 30);
    await sim.run(12);
    expect(sim.sms.sent).toHaveLength(1);
    expect(minutes(sim.store.logs.find((l) => l.status === 'SENT')!.at)).toBeLessThanOrEqual(1 + MAINTENANCE_RECHECK_SEC / 60 + 1);
  });

  it('SEV-1 is never held', async () => {
    const sim = await oneStep('SEV_1');
    await sim.run(1);
    expect(sim.sms.sent).toHaveLength(1);
  });
});

// ───────────────────────────── R-12 ─────────────────────────────

describe('R-12: send caps are enforced when the incident is planned, not only when the order was saved', () => {
  const ALL: StepChannel[] = ['SLACK_CHANNEL', 'SLACK_DM', 'SMS', 'VOICE', 'EMAIL'];
  /** Saved with 3 responders (inside the caps); 40 more are added afterwards — the reviewer's CAPS probe. */
  const grown = () => {
    const s = seedWorld();
    const cfg = config('cus_mirae', [0, 1, 2, 3].map((i) => step(i, i * 5, 'ALL_RESPONDERS', null, ALL)), { repeatCount: 5 });
    s.configs.push(cfg);
    addStaff(s, 'cus_mirae', 40);
    return { s, cfg };
  };

  it('one incident in 60 minutes: ≤ 120 notifications (was 240), ≤ 60 per pass, with a timeline warning', async () => {
    const { s } = grown();
    const sim = new Sim(s);
    closedGroup(s, { customerId: 'cus_mirae', severity: 'SEV_1', at: T0, alerts: [{ id: 'a' }] });
    await sim.run(60);
    const jobs = s.jobList(sim.incident().id);
    expect(jobs.length).toBeGreaterThan(MAX_SENDS_PER_CYCLE); // repeats did run
    expect(jobs.length).toBeLessThanOrEqual(MAX_SENDS_PER_HOUR);
    const snap = sim.incident().assignmentSnapshot!;
    expect(snap.clamped).toMatchObject({ perCycle: 4 * 81, repeatCountBefore: 5 });
    expect(snap.steps.every((st) => st.resolved.length >= 1 && st.channels.includes('SMS') && st.channels.includes('VOICE') && st.channels.includes('SLACK_CHANNEL'))).toBe(true); // nobody's step is emptied; SMS and voice stay (R-19)
    const note = s.eventsOf(sim.incident().id).filter((e) => e.data?.note === 'SEND_CAP_CLAMPED');
    expect(note).toHaveLength(1);
    expect(note[0]!.message).toMatch(/^Send limit applied: this call order would send 324 notifications per pass and \d+ in one hour \(limits 60 \/ 120\)/);
  });

  it('an order inside the caps is not touched; clamping is deterministic and survives a re-read', () => {
    const s = seedWorld();
    const ok = config('cus_mirae', [step(0, 0, 'ALL_RESPONDERS', null, ['SMS']), step(1, 5, 'PERSON', 'ct_haeun', ['VOICE'])], { repeatCount: 1 });
    const snap = buildSnapshot([ok], { customerId: 'cus_mirae' }, s.worldOf('cus_mirae'), T0)!;
    expect(snap.clamped).toBeUndefined();
    expect(clampSnapshot(snap)).toBe(snap);
    const { s: big, cfg } = grown();
    const cut = buildSnapshot([cfg], { customerId: 'cus_mirae' }, big.worldOf('cus_mirae'), T0)!;
    expect(parseSnapshot(JSON.parse(JSON.stringify(cut)))).toEqual(cut);
    // a row written around the engine (100 steps, 1000 repeats) is cut the same way when it is read
    const garbage = { ...cut, clamped: undefined, repeatCount: 1000, steps: Array.from({ length: 100 }, (_, i) => ({ ...cut.steps[0]!, index: i, atMin: i })) };
    const read = parseSnapshot(garbage)!;
    expect(read.steps.length).toBeLessThanOrEqual(50);
    expect(read.steps.reduce((n, st) => n + st.channels.reduce((k, ch) => k + (ch === 'SLACK_CHANNEL' ? 1 : st.resolved.length), 0), 0)).toBeLessThanOrEqual(MAX_SENDS_PER_CYCLE);
  });

  it('re-validation when responders change: the same rule as the PUT, for every order of the customer; paging health shows it', () => {
    const before = seedWorld();
    const cfg = config('cus_mirae', [0, 1, 2, 3].map((i) => step(i, i * 5, 'ALL_RESPONDERS', null, ALL)), { repeatCount: 0 });
    const override = config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['SMS'])], { scopeType: 'SERVICE', scopeId: 'svc_pay' });
    expect(sendCapViolations([cfg, override], before.worldOf('cus_mirae'))).toEqual([]); // 3 responders: 4 × 13 = 52
    const { s } = grown();
    expect(sendCapViolations([cfg, override], s.worldOf('cus_mirae'))).toEqual([
      { pagingConfigId: cfg.id, scopeType: 'CUSTOMER', scopeId: 'cus_mirae', violation: { code: 'RESPONDER_LIMIT_EXCEEDED', stepIndex: 0, responders: 43, limit: 20 } },
    ]);
    const health = pagingHealth(cfg, s.worldOf('cus_mirae'), T0, { slackChannelVerified: true });
    expect(health.level).toBe('AT_RISK');
    expect(health.problems.find((p) => p.code === 'SEND_CAP_EXCEEDED')?.message).toBe('Step 1 pages everyone in Responders: 43 people, the limit is 20. Only the first 20 are paged.');
    // 12 responders: under the people limit, over the per-pass cap (4 × 49)
    const mid = seedWorld();
    addStaff(mid, 'cus_mirae', 9);
    expect(sendCapViolations([cfg], mid.worldOf('cus_mirae'))[0]!.violation).toEqual({ code: 'SEND_CAP_EXCEEDED', perCycle: 196, perHour: 196, limits: { perCycle: 60, perHour: 120 } });
  });
});

// ───────────────────────────── R-13 ─────────────────────────────

describe('R-13: the provider-text sanitiser', () => {
  it('masks every form the review got through', () => {
    const leaks: Array<[string, string]> = [
      ['callee ０１０-１２３４-５６７８ busy', '１２３４'], ['callee ٠١٠١٢٣٤٥٦٧٨ busy', '٠١٠١٢٣٤٥٦٧٨'], ['to 010‑1234‑5678', '1234'], ['to 010–1234–5678', '1234'],
      ['to 010/1234/5678', '1234'], ['to 010_1234_5678', '1234'], ['to 010%201234%205678', '1234'], ['rcpt user@host refused', 'user@host'],
      ['rcpt user%40host.com', 'host.com'], ['rcpt user＠host.com', 'host.com'], ['rcpt 홍길동@한글.한국 refused', '홍길동'],
      ['apikey=9f8e7d6c', '9f8e7d6c'], ['api_key: 9f8e7d6c', '9f8e7d6c'], ['pw=hunter2', 'hunter2'], ['pass=hunter2', 'hunter2'], ['password is hunter2', 'hunter2'],
      ['client_secret=s3cr3t', 's3cr3t'], ['session=abc123', 'abc123'], ['token=tok123', 'tok123'], ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'], ['x-api-key: k-1', 'k-1'],
      ['denied for AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'], ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part-1', 'eyJzdWIi'],
      ['channel C0123ABCD not found', 'C0123ABCD'], ['user U012ABCDEF left', 'U012ABCDEF'], ['+82 10 1234 5678', '1234'], ['Bearer abcdef', 'abcdef'], ['sk_live_x', 'sk_live_x'],
    ];
    for (const [raw, leak] of leaks) expect(sanitizeProviderError(raw), raw).not.toContain(leak);
    // ordinary provider words survive
    expect(sanitizeProviderError('HTTP 503 from provider: CONNECTION UNAVAILABLE after 10000 ms')).toBe('HTTP 503 from provider: CONNECTION UNAVAILABLE after 10000 ms');
    expect(sanitizeProviderError('no answer from the provider within 20 ms')).toBe('no answer from the provider within 20 ms');
  });

  it('cuts to 300 characters BEFORE any pattern runs: 100,000 (and 1,000,000) characters in well under 50 ms (was 12.4 s)', () => {
    const inputs = [
      'A1b2'.repeat(25_000), 'a@'.repeat(50_000), '1 '.repeat(50_000), 'key-'.repeat(25_000), `eyJ${'a.'.repeat(50_000)}`, '0'.repeat(100_000), `${'x'.repeat(299)}@${'y'.repeat(99_700)}`, '%40'.repeat(33_000),
      'B'.repeat(1_000_000),
    ];
    for (const raw of inputs) {
      const t0 = performance.now();
      const out = sanitizeProviderError(raw);
      const ms = performance.now() - t0;
      expect(ms, `${raw.slice(0, 8)}… took ${ms.toFixed(1)} ms`).toBeLessThan(50);
      expect(out.length).toBeLessThanOrEqual(300);
    }
    // nothing after the cut is looked at, and what is kept is still masked
    expect(sanitizeProviderError(`${'x '.repeat(140)}pw=hunter2 ${'z'.repeat(1000)}`)).not.toContain('hunter2');
    // not a string: no throw
    expect(sanitizeProviderError({ toString: () => 'pw=hunter2' })).toBe('[secret]');
    expect(sanitizeProviderError(undefined)).toBe('undefined');
  });
});

// ───────────────────────────── R-14 ─────────────────────────────

describe('R-14: due / lease / retry times come from the store’s clock, not from the runner’s', () => {
  it('a second runner whose clock is 10 minutes ahead cannot take a job that is being sent (was: a second provider call at +21 s)', async () => {
    const store = seedWorld();
    store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['SMS'])], { repeatCount: 0 }));
    store.dedupeTicks = false;
    closedGroup(store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    const calls: OutboundMessage[] = [];
    let settle!: (r: SendResult) => void;
    const sender = { send: (m: OutboundMessage) => { calls.push(m); return new Promise<SendResult>((res) => { settle = res; }); } };
    let dbNow = T0;
    store.clock = () => dbNow; // the database's time
    const a = runTick({ scheduledAt: T0 }, { repo: store, senders: { SMS: sender }, now: () => T0, sendTimeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 15));
    dbNow = at(0, 9); // 9 s later for the database …
    const b = (await runTick({ scheduledAt: at(10) }, { repo: store, senders: { SMS: sender }, now: () => at(10), sendTimeoutMs: 60_000 })) as TickSummary; // … 10 min later for runner B
    expect(b.notify).toMatchObject({ sent: 0, retried: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    settle({ ok: true, providerMessageId: 'p1' });
    expect(((await a) as TickSummary).notify.sent).toBe(1);
    // the retry time written by beginSend is store time + 30 s
    expect(store.jobList()[0]).toMatchObject({ status: 'SENT', attempts: 1, nextAttemptAt: at(0, 30) });
  });

  it('the in-memory store has its own clock (real time unless a simulation sets it)', () => {
    const before = Date.now();
    expect(new MemoryTickStore().clock().getTime()).toBeGreaterThanOrEqual(before);
  });
});

// ───────────────────────────── R-15 ─────────────────────────────

describe('R-15: flags are booleans; env strings go through the typed loader', () => {
  it('parseFlag / loadPolicyFlags: clear values are read, anything else keeps the safe default and is reported', () => {
    expect(['true', 'TRUE', ' 1 ', 'yes', 'on', true].map(parseFlag)).toEqual([true, true, true, true, true, true]);
    expect(['false', 'False', '0', 'no', 'off', false].map(parseFlag)).toEqual([false, false, false, false, false, false]);
    expect(['flase', 'null', 1, 0, null, undefined, {}, []].map(parseFlag)).toEqual(Array(8).fill(undefined));
    expect(loadPolicyFlags({})).toEqual({ flags: { portalShowsStaffNames: false, smsVoiceRequireVerified: true }, warnings: [] });
    expect(loadPolicyFlags({ PORTAL_SHOWS_STAFF_NAMES: 'false', SMS_VOICE_REQUIRE_VERIFIED: 'true' }).flags).toEqual({ portalShowsStaffNames: false, smsVoiceRequireVerified: true });
    expect(loadPolicyFlags({ PORTAL_SHOWS_STAFF_NAMES: 'true', SMS_VOICE_REQUIRE_VERIFIED: 'false' }).flags).toEqual({ portalShowsStaffNames: true, smsVoiceRequireVerified: false });
    const typo = loadPolicyFlags({ PORTAL_SHOWS_STAFF_NAMES: 'ture', SMS_VOICE_REQUIRE_VERIFIED: 'nope' });
    expect(typo.flags).toEqual({ portalShowsStaffNames: false, smsVoiceRequireVerified: true });
    expect(typo.warnings).toHaveLength(2);
    expect(typo.warnings.join(' ')).not.toMatch(/ture|nope/); // the value is never echoed
    // inherited keys are not configuration
    expect(loadPolicyFlags(Object.create({ PORTAL_SHOWS_STAFF_NAMES: 'true' })).flags.portalShowsStaffNames).toBe(false);
  });

  it('SMS_VOICE_REQUIRE_VERIFIED handed over as a string or 0 does not switch the rule off', async () => {
    const yuna: Contact = { ...seedWorld().contacts.get('ct_yuna')!, phoneVerifiedAt: null };
    const job = { channel: 'SMS' as NotifyChannel, targetRef: 'ct_yuna', contactId: 'ct_yuna', customerId: 'cus_mirae' };
    for (const v of ['false', 0, '', null, 'off']) expect(resolveDestination(job, yuna, [], { requireVerifiedPhone: v as never, now: T0 }), String(v)).toEqual({ ok: false, reason: 'UNVERIFIED' });
    expect(resolveDestination(job, yuna, [], { requireVerifiedPhone: false, now: T0 })).toMatchObject({ ok: true, warnings: ['UNVERIFIED_ADDRESS'] });
    const sim = new Sim();
    sim.store.contacts.set('ct_yuna', yuna);
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_yuna', ['SMS'])], { repeatCount: 0 }));
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    const r = (await runTick({ scheduledAt: T0 }, on({ repo: sim.store, senders: sim.senders, now: () => T0, smsVoiceRequireVerified: 'false' as never }))) as TickSummary;
    expect(r.notify).toMatchObject({ sent: 0, skipped: 1 });
  });
});

// ───────────────────────────── N-17 / N-18 / N-20 ─────────────────────────────

describe('N-17: a wall of SEV-1 tenants does not starve lower severities', () => {
  const mk = (customerId: string, severity: Severity, sec: number) => ({ customerId, createdAt: at(0, sec), dueAt: at(0, sec), attempts: 0, payload: { title: customerId, severity, text: '', stepLabel: '' } });

  it('selectForClaim keeps a share for the oldest non-SEV-1 jobs, oldest first; unused share goes back', () => {
    const reserve = Math.floor((NOTIFY_BATCH * NON_SEV1_RESERVE_PCT) / 100);
    for (const n of [51, 60, 200]) {
      const due = [...Array.from({ length: n }, (_, i) => [mk(`s${i}`, 'SEV_1', 30), mk(`s${i}`, 'SEV_1', 31)]).flat(), mk('victim-b', 'SEV_3', 5), mk('victim-a', 'SEV_4', 1)];
      const picked = selectForClaim(due, NOTIFY_BATCH);
      expect(picked).toHaveLength(NOTIFY_BATCH);
      expect(picked.filter((j) => j.customerId.startsWith('victim')).map((j) => j.customerId)).toEqual(['victim-a', 'victim-b']);
      expect(picked.filter((j) => j.payload.severity === 'SEV_1')).toHaveLength(NOTIFY_BATCH - 2); // the rest of the reserve went back to SEV-1
    }
    const low = Array.from({ length: 30 }, (_, i) => mk(`v${i}`, 'SEV_3', i));
    const many = [...Array.from({ length: 100 }, (_, i) => mk(`s${i}`, 'SEV_1', 40)), ...low];
    const picked = selectForClaim(many, NOTIFY_BATCH);
    expect(picked.filter((j) => j.payload.severity !== 'SEV_1').map((j) => j.customerId)).toEqual(low.slice(0, reserve).map((j) => j.customerId));
    expect(selectForClaim(many, 1)[0]!.payload.severity).toBe('SEV_1'); // a single probe slot follows the fair order
    expect(selectForClaim(low, NOTIFY_BATCH)).toHaveLength(30);
  });

  it('51 and 80 tenants each adding SEV-1 pages every minute: a SEV-3-only tenant’s page leaves in the tick it was queued (was: not within 30 minutes)', async () => {
    for (const n of [51, 80]) {
      const { store, inc, inject } = await tenants(n + 1, (i) => (i === n ? 'SEV_3' : 'SEV_1'), () => 'SMS');
      const sms = new FakeSender();
      inject(n, 2, at(1), 'v');
      let sentAt: number | null = null;
      for (let m = 1; m <= 5 && sentAt == null; m++) {
        for (let t = 0; t < n; t++) inject(t, 2, at(m), `m${m}_`);
        await runTick({ scheduledAt: at(m), jobs: ['notify'] }, on({ repo: store, senders: { SMS: sms }, now: () => at(m) }));
        if (store.jobList(inc(n).id).filter((x) => x.id.includes('v') && x.status === 'SENT').length === 2) sentAt = m;
      }
      expect(sentAt, `${n} tenants`).toBe(1);
    }
  });
});

describe('N-18: a job whose lookups keep failing is counted and given up', () => {
  it('getContact throws every time → attempts go up with the usual retry delays → FAILED with a GAVE_UP log after MAX_ATTEMPTS (was: SENDING / attempts 0 forever)', async () => {
    const sim = new Sim();
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['SMS']), step(1, 1, 'PERSON', 'ct_junho', ['VOICE'])], { repeatCount: 0 }));
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    const real = sim.store.getContact.bind(sim.store);
    let lookups = 0;
    sim.store.getContact = async (id) => {
      if (id !== 'ct_haeun') return real(id);
      lookups++;
      throw new Error('db: connection reset for +821012345678');
    };
    await sim.run(30);
    const sms = sim.store.jobList().find((j) => j.channel === 'SMS')!;
    expect(sms).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS });
    expect(lookups).toBe(MAX_ATTEMPTS);
    expect(sms.lastError).not.toContain('821012345678'); // internal error text is sanitised like provider text
    expect(sim.store.logs.filter((l) => l.jobId === sms.id)).toMatchObject([{ status: 'FAILED', errorCode: 'GAVE_UP', attempt: MAX_ATTEMPTS, targetSummary: 'Haeun Kim' }]);
    expect(sim.sms.attempts).toHaveLength(0); // the provider was never called
    expect(sim.voice.sent).toHaveLength(1); // the other job is not affected
  });
});

describe('N-20: an invalid or future verification time is “not verified”', () => {
  it('verifiedAt / resolveDestination / paging health', () => {
    expect(verifiedAt(V, T0)).toBe(true);
    for (const bad of [new Date('nope'), at(60 * 24), null, undefined, '2026-10-01T00:00:00Z', 1, true]) expect(verifiedAt(bad, T0), String(bad)).toBe(false);
    const job = { channel: 'SMS' as NotifyChannel, targetRef: 'ct_yuna', contactId: 'ct_yuna', customerId: 'cus_mirae' };
    const base = seedWorld().contacts.get('ct_yuna')!;
    for (const phoneVerifiedAt of [new Date('nope'), at(60 * 24)]) {
      expect(resolveDestination(job, { ...base, phoneVerifiedAt }, [], { now: T0 })).toEqual({ ok: false, reason: 'UNVERIFIED' });
      const s = seedWorld();
      s.contacts.set('ct_yuna', { ...base, phoneVerifiedAt });
      const cfg = config('cus_mirae', [step(0, 0, 'PERSON', 'ct_yuna', ['SMS'])]);
      expect(pagingHealth(cfg, s.worldOf('cus_mirae'), T0)).toMatchObject({ level: 'UNREACHABLE', problems: expect.arrayContaining([expect.objectContaining({ code: 'NO_VERIFIED_PHONE', skipped: true })]) });
    }
    // e-mail / Slack DM: still sent, with the warning
    expect(resolveDestination({ ...job, channel: 'EMAIL' }, { ...base, emailVerifiedAt: at(60 * 24) }, [], { now: T0 })).toMatchObject({ ok: true, warnings: ['UNVERIFIED_ADDRESS'] });
  });
});
