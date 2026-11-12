/**
 * Regression tests for the security review of feat/tick-escalation (R-1 … R-4, R-9, R-10, Q-2, N-2, N-8).
 * Each `describe` names the finding it closes.
 */
import { describe, expect, it } from 'vitest';
import {
  CLAIM_LEASE_SEC, FakeSender, MAX_ALL_RESPONDERS, MAX_ATTEMPTS, MAX_RENOTIFY, MAX_REPEAT, MAX_SENDS_PER_CYCLE, RETRY_DELAYS_SEC, SEND_TIMEOUT_MS,
  ack, buildSnapshot, estimateSends, fairOrder, pagingHealth, planEscalation, runTick, sanitizeProviderError, scheduleNext,
  type MemoryTickStore, type NotificationJob, type OutboundMessage, type SendResult, type StepChannel, type TickSummary,
} from '../src/index.js';
import { PATTERNS, Sim, T0, at, closedGroup, config, on, seedWorld, step } from './world.js';

const V = new Date('2026-10-01T00:00:00Z');
const addStaff = (s: MemoryTickStore, customerId: string, n: number) => {
  for (let i = 0; i < n; i++) {
    s.contacts.set(`ct_s${i}`, { id: `ct_s${i}`, kind: 'INTERNAL', customerId: null, name: `Staff ${i}`, active: true, phone: `+8210555000${i}`, email: `s${i}@example.test`, slackUserId: `US${i}`, phoneVerifiedAt: V, emailVerifiedAt: V, slackVerifiedAt: V });
    s.responders.push({ customerId, contactId: `ct_s${i}`, role: 'PAGEABLE' });
  }
};
const ALL_CH: StepChannel[] = ['SLACK_CHANNEL', 'SLACK_DM', 'SMS', 'VOICE', 'EMAIL'];
const minutes = (d: Date) => (d.getTime() - T0.getTime()) / 60_000;

describe('R-1: one customer’s call order cannot delay another customer’s page', () => {
  it('the 19-minute delay: a flooding tenant and another tenant’s SEV-1 — every page of the other tenant leaves within one tick', async () => {
    const sim = new Sim();
    addStaff(sim.store, 'cus_mirae', 30); // 33 pageable responders
    // The worst call order the old validation accepted, written straight to the store (as if saved before the cap existed).
    sim.store.configs.push(
      config('cus_mirae', Array.from({ length: 12 }, (_, i) => step(i, 0, 'ALL_RESPONDERS', null, ALL_CH)), { repeatCount: 5 }),
      PATTERNS.customerRotation(),
    );
    sim.now = at(1);
    closedGroup(sim.store, { customerId: 'cus_mirae', severity: 'SEV_1', at: at(1), alerts: [{ id: 'al_big' }] });
    closedGroup(sim.store, { customerId: 'cus_hanbit', severity: 'SEV_1', at: at(1), alerts: [{ id: 'al_h' }] });
    await sim.run(40);
    const hanbit = [...sim.store.incidents.values()].find((i) => i.customerId === 'cus_hanbit')!;
    const mirae = [...sim.store.incidents.values()].find((i) => i.customerId === 'cus_mirae')!;
    // Review 2 (R-12): the engine now cuts this order to the caps when the incident opens, so the flood itself is gone:
    // one pass ≤ MAX_SENDS_PER_CYCLE, and the timeline says the limit was applied.
    expect(mirae.assignmentSnapshot!.clamped).toMatchObject({ perCycle: 12 * 81 });
    expect(sim.store.eventsOf(mirae.id).filter((e) => e.data?.note === 'SEND_CAP_CLAMPED')).toHaveLength(1);
    const perMinute = new Map<number, number>();
    for (const j of sim.store.jobList(mirae.id)) perMinute.set(minutes(j.createdAt), (perMinute.get(minutes(j.createdAt)) ?? 0) + 1);
    expect(Math.max(...perMinute.values())).toBeLessThanOrEqual(MAX_SENDS_PER_CYCLE);
    const jobs = sim.store.jobList(hanbit.id);
    expect(jobs.length).toBeGreaterThanOrEqual(4);
    const delays = jobs.map((j) => {
      const log = sim.store.logs.find((l) => l.jobId === j.id)!;
      expect(log, `${j.idempotencyKey} was never sent`).toBeTruthy();
      return minutes(log.at) - minutes(j.createdAt);
    });
    expect(Math.max(...delays)).toBeLessThanOrEqual(1); // was up to 19 minutes with the FIFO outbox
    expect(Math.max(...delays)).toBe(0); // in fact: the same tick that queued it
  });

  it('fairOrder: round-robin by customer; SEV-1 first inside a customer and at the head of each round', () => {
    const j = (customerId: string | null, sev: 'SEV_1' | 'SEV_2', sec: number, tag: string) =>
      ({ customerId, nextAttemptAt: at(0, sec), createdAt: at(0, sec), payload: { title: tag, severity: sev, text: '', stepLabel: '' } });
    const due = [...Array.from({ length: 5 }, (_, i) => j('a', 'SEV_1', i, `a${i}`)), j('b', 'SEV_2', 9, 'b0'), j('b', 'SEV_1', 10, 'b1'), j('c', 'SEV_3' as 'SEV_2', 11, 'c0'), j(null, 'SEV_2', 0, 'm0')];
    expect(fairOrder(due).map((x) => x.payload.title)).toEqual(['a0', 'b1', 'm0', 'c0', 'a1', 'b0', 'a2', 'a3', 'a4']);
    // a claim limit of 4 therefore serves every customer once, however long a's queue is
    expect(new Set(fairOrder(due).slice(0, 4).map((x) => x.customerId)).size).toBe(4);
  });

  it('estimateSends: per cycle and per busiest hour', () => {
    const std = PATTERNS.templateStandard().steps; // Slack 0, SMS 2, call 7, call everyone 12
    expect(estimateSends(std, 1, 3)).toEqual({ perCycle: 6, perHour: 12 });
    expect(estimateSends(std, 0, 20)).toEqual({ perCycle: 23, perHour: 23 });
    // 12 steps one minute apart, 5 repeats: one pass is under the cycle cap but the hour is not
    const tight = Array.from({ length: 12 }, (_, i) => step(i, i, 'PERSON', 'ct_haeun', ['SMS', 'VOICE', 'EMAIL']));
    expect(estimateSends(tight, 5, 0)).toEqual({ perCycle: 36, perHour: 180 });
    expect(estimateSends([], 3, 5)).toEqual({ perCycle: 0, perHour: 0 });
  });

  it('the engine does not trust stored numbers: repeatCount, ALL_RESPONDERS and the per-step fan-out are cut (R-1c)', () => {
    const s = seedWorld();
    addStaff(s, 'cus_mirae', 30);
    const cfg = config('cus_mirae', [step(0, 0, 'ALL_RESPONDERS', null, ALL_CH)], { repeatCount: 999 });
    const snap = buildSnapshot([cfg], { customerId: 'cus_mirae' }, s.worldOf('cus_mirae'), T0)!;
    // 999 → MAX_REPEAT → 1: six passes of 57 five minutes apart would be 342 in an hour (cap 120) — R-12
    expect(snap.repeatCount).toBe(1);
    // review 3 (R-19): channels go before people — e-mail and Slack DM are taken off, all 20 people keep SMS + call.
    // The 13 people beyond MAX_ALL_RESPONDERS are named in the note.
    expect(snap.clamped).toMatchObject({ perCycle: 1 + MAX_ALL_RESPONDERS * 4, perHour: 6 * (1 + MAX_ALL_RESPONDERS * 4), repeatCountBefore: MAX_REPEAT, repeatCountAfter: 1, removedPeople: 13, removedSteps: 0, removedChannels: 2 });
    expect(snap.clamped!.dropped).toHaveLength(13);
    expect(snap.steps[0]!.resolved).toHaveLength(MAX_ALL_RESPONDERS); // 30 + 3 responders → 20
    expect(snap.steps[0]!.channels).toEqual(['SLACK_CHANNEL', 'SMS', 'VOICE']);
    const sim = new Sim(s);
    s.configs.push(cfg);
    closedGroup(s, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a' }] });
    return sim.tick(['group', 'escalation']).then(() => {
      expect(s.jobList()).toHaveLength(41); // 1 + 20 × 2; 1 + 20 × 4 = 81 without the cut
      expect(s.jobList().length).toBeLessThanOrEqual(MAX_SENDS_PER_CYCLE);
      // a snapshot row edited by hand is clamped when it is read
      const inc = sim.incident();
      const raw = { ...inc, escalationStep: 1, escalationRepeat: MAX_REPEAT, assignmentSnapshot: { ...inc.assignmentSnapshot!, repeatCount: 1000 } };
      expect(planEscalation(raw, { now: at(500), renotifyAfterSec: 0 })).toMatchObject({ kind: 'NONE', reason: 'DONE' });
    });
  });
});

describe('R-2: overlapping ticks send a page once', () => {
  const one = () => {
    const store = seedWorld();
    store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['SMS'])], { repeatCount: 0 }));
    store.dedupeTicks = false;
    closedGroup(store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    return store;
  };
  /** A provider whose first call stays open until the test settles it. */
  const slowFirst = () => {
    const calls: OutboundMessage[] = [];
    let settle!: (r: SendResult) => void;
    const sender = { async send(m: OutboundMessage): Promise<SendResult> {
      calls.push(m);
      if (calls.length === 1) return new Promise<SendResult>((res) => { settle = res; });
      return { ok: true, providerMessageId: `sms-${calls.length}` };
    } };
    return { calls, sender, settle: (r: SendResult) => settle(r) };
  };
  const pause = () => new Promise((r) => setTimeout(r, 15));

  it('timings hold the design: the send timeout is shorter than the first retry, the claim lease covers budget + timeout', () => {
    expect(SEND_TIMEOUT_MS).toBeLessThan(RETRY_DELAYS_SEC[0] * 1000);
    expect(CLAIM_LEASE_SEC * 1000).toBeGreaterThanOrEqual(45_000 + SEND_TIMEOUT_MS);
  });

  it('a second tick while the first is still sending = exactly one SMS', async () => {
    const store = one();
    const p = slowFirst();
    let now = T0;
    const deps = on({ repo: store, senders: { SMS: p.sender }, now: () => now });
    const tickA = runTick({ scheduledAt: T0 }, deps); // stays inside the provider call
    await pause();
    now = at(0, 9); // the next run starts while A's call is in flight (a call cannot be in flight longer than the timeout)
    const b = (await runTick({ scheduledAt: at(1) }, deps)) as TickSummary;
    expect(b.notify).toMatchObject({ sent: 0, failed: 0, retried: 0, skipped: 0 });
    p.settle({ ok: true, providerMessageId: 'sms-A' });
    const a = (await tickA) as TickSummary;
    expect(a.notify.sent).toBe(1);
    for (const m of [1, 2, 3, 10]) { now = at(m); await runTick({ scheduledAt: now }, deps); }
    expect(p.calls).toHaveLength(1);
    expect(store.jobList()[0]).toMatchObject({ status: 'SENT', attempts: 1, providerMessageId: 'sms-A' });
    expect(store.logs.filter((l) => l.status === 'SENT')).toHaveLength(1);
  });

  it('a run that lost its claim cannot write: SENT is never turned back into QUEUED, and nothing is sent a third time', async () => {
    const store = one();
    const p = slowFirst();
    let now = T0;
    // sendTimeoutMs is far away: run A is frozen inside the call (the review's reproduction)
    const deps = on({ repo: store, senders: { SMS: p.sender }, now: () => now, sendTimeoutMs: 60_000 });
    const tickA = runTick({ scheduledAt: T0 }, deps);
    await pause();
    now = at(1); // past the retry time written by A's beginSend → B may take the job over
    const b = (await runTick({ scheduledAt: at(1) }, deps)) as TickSummary;
    expect(b.notify.sent).toBe(1);
    expect(store.jobList()[0]).toMatchObject({ status: 'SENT', attempts: 2, claimSeq: 2, providerMessageId: 'sms-2' });
    // A's call finally comes back as a failure: before the fix this wrote QUEUED over SENT and the SMS went out again
    p.settle({ ok: false, error: 'timeout', retryable: true });
    const a = (await tickA) as TickSummary;
    expect(a.notify).toMatchObject({ sent: 0, failed: 0, retried: 0, skipped: 0 });
    expect(store.jobList()[0]).toMatchObject({ status: 'SENT', providerMessageId: 'sms-2' });
    for (const m of [3, 4, 5, 30]) { now = at(m); await runTick({ scheduledAt: now }, deps); }
    expect(p.calls).toHaveLength(2); // the frozen call and its takeover — both carry the same provider idempotency key
    expect(new Set(p.calls.map((m) => m.idempotencyKey)).size).toBe(1);
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0]).toMatchObject({ status: 'SENT', attempt: 2 });
  });

  it('a late success of the frozen run is discarded too (one SENT log, one provider id)', async () => {
    const store = one();
    const p = slowFirst();
    let now = T0;
    const deps = on({ repo: store, senders: { SMS: p.sender }, now: () => now, sendTimeoutMs: 60_000 });
    const tickA = runTick({ scheduledAt: T0 }, deps);
    await pause();
    now = at(1);
    await runTick({ scheduledAt: at(1) }, deps);
    p.settle({ ok: true, providerMessageId: 'sms-late' });
    await tickA;
    expect(store.jobList()[0]).toMatchObject({ status: 'SENT', providerMessageId: 'sms-2' });
    expect(store.logs.map((l) => l.providerMessageId)).toEqual(['sms-2']);
  });

  it('a provider that never answers is cut off by the send timeout and retried on schedule; the tick finishes', async () => {
    const store = one();
    const calls: OutboundMessage[] = [];
    const hang = { send: (m: OutboundMessage) => { calls.push(m); return new Promise<SendResult>(() => undefined); } };
    const r = (await runTick({ scheduledAt: T0 }, on({ repo: store, senders: { SMS: hang }, now: () => T0, sendTimeoutMs: 20 }))) as TickSummary;
    expect(r.notify).toMatchObject({ sent: 0, failed: 0, retried: 1, skipped: 0 });
    expect(store.jobList()[0]).toMatchObject({ status: 'QUEUED', attempts: 1, nextAttemptAt: at(0, 30), lastError: 'no answer from the provider within 20 ms' });
    const sms = new FakeSender('sms');
    await runTick({ scheduledAt: at(1) }, on({ repo: store, senders: { SMS: sms }, now: () => at(1) }));
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
  });

  it('completeJob / beginSend / releaseJob act only for the current claim', async () => {
    const store = one();
    await runTick({ scheduledAt: T0, jobs: ['group', 'escalation'] }, on({ repo: store, senders: {}, now: () => T0 }));
    store.clock = () => T0;
    const [first] = await store.claimDueJobs(10);
    store.clock = () => at(0, CLAIM_LEASE_SEC);
    const [second] = await store.claimDueJobs(10); // lease ran out → taken over
    store.clock = () => at(2);
    expect([first!.claimSeq, second!.claimSeq]).toEqual([1, 2]);
    expect(await store.beginSend(first!.id, first!.claimSeq)).toBeNull();
    expect(await store.releaseJob(first!.id, first!.claimSeq)).toBe(false);
    expect(await store.completeJob(first!.id, first!.claimSeq, { status: 'QUEUED', error: 'late' })).toBe(false);
    expect(await store.beginSend(second!.id, second!.claimSeq)).toBe(1);
    expect(await store.completeJob(second!.id, second!.claimSeq, { status: 'SENT', providerMessageId: 'p1' })).toBe(true);
    expect(await store.completeJob(second!.id, second!.claimSeq, { status: 'QUEUED' })).toBe(false); // already written
    expect(store.jobList()[0]).toMatchObject({ status: 'SENT', attempts: 1, lastError: null });
  });
});

describe('R-3: a tick without budget does not burn attempts', () => {
  const queued = async () => {
    const store = seedWorld();
    store.configs.push(PATTERNS.allAtOnce());
    const sim = new Sim(store);
    closedGroup(store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    await runTick({ scheduledAt: T0, jobs: ['group', 'escalation'] }, on({ repo: store, senders: sim.senders, now: () => T0 }));
    expect(store.jobList()).toHaveLength(3);
    return sim;
  };

  it('25 minutes of ticks whose budget is gone before the outbox: nothing is claimed, nothing FAILED; the first healthy tick sends all', async () => {
    const sim = await queued();
    for (let m = 1; m <= 25; m++) {
      const r = (await runTick({ scheduledAt: at(m), jobs: ['notify'] }, on({ repo: sim.store, senders: sim.senders, budgetMs: 0, now: () => at(m) }))) as TickSummary;
      expect(r).toMatchObject({ truncated: true, notify: { sent: 0, failed: 0, retried: 0, skipped: 0 } });
    }
    expect(sim.store.jobList().map((j) => [j.status, j.attempts, j.claimSeq])).toEqual([['QUEUED', 0, 0], ['QUEUED', 0, 0], ['QUEUED', 0, 0]]);
    expect(sim.store.logs).toHaveLength(0);
    const r = (await runTick({ scheduledAt: at(26), jobs: ['notify'] }, on({ repo: sim.store, senders: sim.senders, now: () => at(26) }))) as TickSummary;
    expect(r.notify.sent).toBe(3);
    expect(sim.sms.sent).toHaveLength(3);
  });

  it('budget runs out in the middle of the batch: the jobs not reached are handed back untouched and go out next tick', async () => {
    const sim = await queued();
    let late = false;
    const sms = { async send(m: OutboundMessage): Promise<SendResult> { late = true; return sim.sms.send(m); } };
    // one call at a time in the lane, so "the middle of the batch" is a definite place
    const r = (await runTick({ scheduledAt: at(1), jobs: ['notify'] }, on({ repo: sim.store, senders: { SMS: sms }, laneConcurrency: 1, now: () => (late ? at(1, 50) : at(1)) }))) as TickSummary;
    expect(r).toMatchObject({ truncated: true, notify: { sent: 1, released: 2 } });
    const rest = sim.store.jobList().filter((j) => j.status !== 'SENT');
    // R-11: handed back with the ORIGINAL due time (T0), not re-stamped with the time of the release
    expect(rest.map((j) => [j.status, j.attempts, j.nextAttemptAt, j.dueAt])).toEqual([['QUEUED', 0, T0, T0], ['QUEUED', 0, T0, T0]]);
    await runTick({ scheduledAt: at(2), jobs: ['notify'] }, on({ repo: sim.store, senders: sim.senders, now: () => at(2) }));
    expect(sim.sms.sent).toHaveLength(3);
    expect(sim.store.jobList().every((j) => j.status === 'SENT' && j.attempts === 1)).toBe(true);
  });

  it('the outbox has a reserved share of the budget: busy earlier phases stop first, pages still go out', async () => {
    const sim = await queued();
    closedGroup(sim.store, { customerId: 'cus_hanbit', at: at(1), alerts: [{ id: 'a2' }] });
    let n = 0;
    // 40 s into a 45 s budget: past the soft deadline (35 s) of the group/escalation phases, inside the hard one
    const r = (await runTick({ scheduledAt: at(1) }, on({ repo: sim.store, senders: sim.senders, now: () => (n++ < 6 ? at(1) : at(1, 40)) }))) as TickSummary; // the reads before the phases (start, store clock, claim) are at 01:00
    expect(r.group.delivered).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.notify.sent).toBe(3);
  });

  it('FAILED always has a send attempt and a NotificationLog row — also when the process died during the last attempt', async () => {
    const sim = await queued();
    const j = sim.store.jobList()[0]!;
    Object.assign(sim.store.jobs.get(j.idempotencyKey)!, { status: 'SENDING', attempts: MAX_ATTEMPTS, claimSeq: 5, nextAttemptAt: at(9) });
    sim.now = at(10);
    await sim.tick(['notify']);
    expect(sim.store.jobs.get(j.idempotencyKey)).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS });
    expect(sim.store.logs.filter((l) => l.jobId === j.id)).toEqual([expect.objectContaining({ status: 'FAILED', errorCode: 'GAVE_UP', attempt: MAX_ATTEMPTS, targetSummary: j.contactName })]);
    // invariant over the whole outbox
    for (const x of sim.store.jobList().filter((y) => y.status === 'FAILED')) {
      expect(x.attempts).toBeGreaterThan(0);
      expect(sim.store.logs.some((l) => l.jobId === x.id && l.status === 'FAILED')).toBe(true);
    }
  });
});

describe('R-4: provider words are sanitised and classified; no channel id in the log', () => {
  it('sanitizeProviderError masks numbers, addresses and credentials', () => {
    const raw = 'vendor: number +82100008995 rejected (acct AC123, key sk_live_x) for a@b.example Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345';
    const out = sanitizeProviderError(raw);
    for (const leak of ['82100008995', 'AC123', 'sk_live_x', 'a@b.example', 'abcdefghijklmnopqrstuvwxyz012345']) expect(out).not.toContain(leak);
    expect(out).toContain('rejected');
    expect(sanitizeProviderError('x'.repeat(50) + ' y'.repeat(400)).length).toBeLessThanOrEqual(300);
    expect(sanitizeProviderError('010-1234-5678 is not reachable')).toBe('[number] is not reachable');
  });

  it('a rejected SMS: the log and the job keep the masked text plus a reason code; Slack rows name the kind of channel, never its id', async () => {
    const sim = new Sim();
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_yuna', ['SLACK_CHANNEL', 'SMS'])], { repeatCount: 0 }), config('cus_hanbit', [step(0, 0, 'PERSON', 'ct_dohyun', ['SLACK_CHANNEL'])], { repeatCount: 0 }));
    sim.sms.failNext(1, { retryable: false, error: 'vendor: number +82100008995 rejected (acct AC123, key sk_live_x)' });
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    closedGroup(sim.store, { customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'a2' }] }); // Hanbit has no channel of its own → MSP default
    await sim.tick();
    const sms = sim.store.logs.find((l) => l.channel === 'SMS')!;
    expect(sms).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_REJECTED', targetSummary: 'Yuna Seo', targetKind: 'CUSTOMER_PERSON', contactId: 'ct_yuna' });
    expect(sms.error).toBe('vendor: number [number] rejected ([secret], [secret])');
    expect(sim.store.jobList().find((j) => j.channel === 'SMS')!.lastError).toBe(sms.error);
    expect(sim.store.logs.filter((l) => l.channel === 'SLACK_BOT').map((l) => [l.customerId, l.targetSummary, l.targetKind, l.contactId]))
      .toEqual(expect.arrayContaining([['cus_mirae', 'Customer Slack channel', 'CUSTOMER_CHANNEL', null], ['cus_hanbit', 'MSP Slack channel', 'MSP_CHANNEL', null]]));
    expect(JSON.stringify(sim.store.logs)).not.toMatch(/C_MSP|C_MIRAE/);
    // the messages themselves still went to the right channels
    expect(sim.slack.sent.map((m) => m.to).sort()).toEqual(['C_MIRAE', 'C_MSP']);
  });

  it('timeouts and missing senders have their own codes', async () => {
    const sim = new Sim();
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['EMAIL'])], { repeatCount: 0 }));
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    await runTick({ scheduledAt: T0 }, on({ repo: sim.store, senders: {}, now: () => T0 }));
    expect(sim.store.logs[0]).toMatchObject({ status: 'FAILED', errorCode: 'NOT_CONFIGURED', attempt: 1 });
    expect(sim.store.jobList()[0]).toMatchObject({ status: 'FAILED', attempts: 1 });
  });
});

describe('R-9: the recipient’s tenant is checked again at send time', () => {
  it('a job row pointing at another customer’s person is skipped and reported; staff and own people pass', async () => {
    const sim = new Sim();
    sim.store.dedupeTicks = false;
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_yuna', ['SMS']), step(1, 5, 'PERSON', 'ct_haeun', ['SMS'])], { repeatCount: 0 }));
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    await sim.tick(['group', 'escalation']);
    const job = sim.store.jobList()[0]!;
    Object.assign(sim.store.jobs.get(job.idempotencyKey)!, { contactId: 'ct_dohyun', contactName: 'Dohyun Han' }); // corrupted row: Hanbit's person on a Mirae job
    const r = await sim.tick(['notify']);
    expect(r.notify).toMatchObject({ sent: 0, failed: 0, retried: 0, skipped: 1 });
    expect(r.errors).toEqual([{ phase: 'notify', id: job.id, message: expect.stringContaining('does not belong to the incident customer') }]);
    expect(sim.allSent()).toHaveLength(0);
    expect(sim.store.jobList()[0]).toMatchObject({ status: 'SKIPPED', lastError: 'tenant_mismatch', attempts: 0 });
    await sim.run(6);
    expect(sim.sms.sent.map((m) => m.contactId)).toEqual(['ct_haeun']); // staff are fine for any customer
  });
});

describe('R-10: a page queued before a maintenance window is not sent inside it (D-17)', () => {
  const setup = async (severity: 'SEV_1' | 'SEV_2') => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.templateStandard());
    closedGroup(sim.store, { customerId: 'cus_mirae', severity, at: T0, alerts: [{ id: 'a1' }] });
    sim.sms.failNext(2); // the SMS of step 2 (minute 2) is retrying when the window starts
    await sim.run(2);
    sim.store.windows.push({ id: 'mw1', customerId: 'cus_mirae', scopeType: 'CUSTOMER', scopeId: 'cus_mirae', startsAt: at(2, 30), endsAt: at(600) });
    await sim.run(8);
    return sim;
  };
  it('SEV-2: the retry is held (not sent, not dropped — N-13) and the step counter stays', async () => {
    const sim = await setup('SEV_2');
    expect(sim.sms.sent).toHaveLength(0);
    expect(sim.store.jobList().find((j) => j.channel === 'SMS')).toMatchObject({ status: 'QUEUED', lastError: 'deferred_by_maintenance', attempts: 1 });
    expect(sim.incident().escalationStep).toBe(2);
    expect(sim.voice.sent).toHaveLength(0);
  });
  it('SEV-1 keeps going', async () => {
    const sim = await setup('SEV_1');
    expect(sim.sms.sent).toHaveLength(1);
    expect(sim.voice.sent.length).toBeGreaterThan(0);
  });
});

describe('Q-2 switch SMS_VOICE_REQUIRE_VERIFIED (default: verified numbers only)', () => {
  const setup = () => {
    const store = seedWorld();
    store.contacts.get('ct_yuna')!.phoneVerifiedAt = null;
    store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_yuna', ['SMS', 'VOICE', 'SLACK_DM'])], { repeatCount: 0 }));
    const sim = new Sim(store);
    closedGroup(store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    return sim;
  };

  it('true (default): SMS and call are skipped, each with a timeline line; Slack DM still goes; paging health says so', async () => {
    const sim = setup();
    const r = await sim.tick();
    expect(r.notify).toMatchObject({ sent: 1, failed: 0, retried: 0, skipped: 2 });
    expect(sim.allSent().map((m) => m.channel)).toEqual(['SLACK_DM']);
    expect(sim.store.jobList().filter((j) => j.status === 'SKIPPED').map((j) => [j.channel, j.lastError, j.attempts]).sort()).toEqual([['SMS', 'unverified', 0], ['VOICE', 'unverified', 0]]);
    const notes = sim.store.eventsOf(sim.incident().id).filter((e) => e.data?.note === 'SKIPPED_UNVERIFIED');
    // the SMS and the voice lane run side by side: the two lines can land in either order
    expect(notes.map((e) => [e.kind, e.actorType, e.message]).sort((a, b) => b[2]!.localeCompare(a[2]!))).toEqual([
      ['NOTE', 'SYSTEM', 'Step 1/1: SMS to Yuna Seo was not sent — the phone number is not verified.'],
      ['NOTE', 'SYSTEM', 'Step 1/1: Call to Yuna Seo was not sent — the phone number is not verified.'],
    ]);
    expect(notes.find((e) => e.data?.channel === 'SMS')!.data).toMatchObject({ stepIndex: 0, channel: 'SMS', contactId: 'ct_yuna' });
    // skips are not delivery-log rows (R1-3)
    expect(sim.store.logs.map((l) => l.channel)).toEqual(['SLACK_DM']);
    const health = pagingHealth(sim.store.configs[0]!, sim.store.worldOf('cus_mirae'), T0);
    expect(health.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'NO_VERIFIED_PHONE', stepIndex: 0, contactIds: ['ct_yuna'], skipped: true, message: 'Step 1: SMS and calls to people without a verified phone are not sent.' })]));
    expect(health.level).toBe('AT_RISK');
  });

  it('false: sent to the unverified number with a warning, no timeline line; health keeps the old wording', async () => {
    const sim = setup();
    const r = (await runTick({ scheduledAt: T0 }, on({ repo: sim.store, senders: sim.senders, now: () => T0, smsVoiceRequireVerified: false }))) as TickSummary;
    expect(r.notify).toMatchObject({ sent: 3, failed: 0, retried: 0, skipped: 0 });
    expect(sim.store.logs.filter((l) => l.channel !== 'SLACK_DM').map((l) => l.warnings)).toEqual([['UNVERIFIED_ADDRESS'], ['UNVERIFIED_ADDRESS']]);
    expect(sim.store.eventsOf(sim.incident().id).some((e) => e.data?.note === 'SKIPPED_UNVERIFIED')).toBe(false);
    const p = pagingHealth(sim.store.configs[0]!, sim.store.worldOf('cus_mirae'), T0, { smsVoiceRequireVerified: false }).problems.find((x) => x.code === 'NO_VERIFIED_PHONE')!;
    expect(p.skipped).toBeUndefined();
    expect(p.message).toBe('Step 1 calls or texts people without a verified phone.');
  });

  it('a step whose every page was skipped counts as failed for advanceOnAllFail', async () => {
    const store = seedWorld();
    store.contacts.get('ct_yuna')!.phoneVerifiedAt = null;
    store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_yuna', ['SMS'], { advanceOnAllFail: true }), step(1, 10, 'PERSON', 'ct_haeun', ['SMS'])], { repeatCount: 0 }));
    const sim = new Sim(store);
    closedGroup(store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    await sim.run(2);
    expect(sim.sms.sent.map((m) => m.contactId)).toEqual(['ct_haeun']); // at minute 1, not 10
  });
});

describe('N-2: reminders after an ack are capped', () => {
  it(`stops after ${MAX_RENOTIFY} reminders and schedules nothing more`, async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.rotationThenCustomer());
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    await sim.tick();
    const inc = sim.incident();
    const a = ack(inc, 'usr_1', at(1))!;
    await sim.store.commitIncident({ row: { ...a, nextEscalationAt: scheduleNext(a, { now: at(1), renotifyAfterSec: 3600 }) }, expectedVersion: inc.version, bump: true });
    for (let h = 1; h <= 72; h++) { sim.now = at(h * 60 + 1); await sim.tick(); }
    expect(sim.incident()).toMatchObject({ status: 'ACKNOWLEDGED', renotifyCount: MAX_RENOTIFY, nextEscalationAt: null });
    expect(sim.store.jobList().filter((j) => j.purpose === 'RENOTIFY')).toHaveLength(MAX_RENOTIFY);
  });
});

describe('N-8: incidents that fail every tick do not starve the batch', () => {
  it('with batch 2 and two broken incidents first in line, the third is still escalated in the same tick', async () => {
    const sim = new Sim();
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['SMS']), step(1, 5, 'PERSON', 'ct_junho', ['SMS'])], { repeatCount: 0 }), config('cus_hanbit', [step(0, 0, 'PERSON', 'ct_minjae', ['SMS']), step(1, 5, 'PERSON', 'ct_dohyun', ['SMS'])], { repeatCount: 0 }));
    closedGroup(sim.store, { customerId: 'cus_mirae', severity: 'SEV_2', at: T0, alerts: [{ id: 'a1' }] });
    closedGroup(sim.store, { customerId: 'cus_mirae', severity: 'SEV_3', at: T0, alerts: [{ id: 'a2' }] });
    closedGroup(sim.store, { customerId: 'cus_hanbit', severity: 'SEV_2', at: T0, alerts: [{ id: 'a3' }] });
    await sim.tick();
    const [b1, b2, ok] = [...sim.store.incidents.values()].sort((x, y) => (x.customerId! < y.customerId! ? 1 : -1));
    // the broken ones are due earlier, so they head every listing
    for (const b of [b1!, b2!]) { sim.store.incidents.get(b.id)!.nextEscalationAt = at(4); sim.store.failIncidents.add(b.id); }
    sim.now = at(5);
    const r = (await runTick({ scheduledAt: at(5) }, on({ repo: sim.store, senders: sim.senders, now: () => at(5), batch: 2 }))) as TickSummary;
    expect(r.errors.map((e) => e.id).sort()).toEqual([b1!.id, b2!.id].sort());
    expect(r.escalation.escalated).toBe(1);
    expect(sim.store.incidents.get(ok!.id)!.escalationStep).toBe(2);
    expect(sim.sms.sent.map((m) => m.contactId)).toContain('ct_dohyun');
  });
});

// keeps the unused-import check honest for helpers used only in types
export type { NotificationJob };
