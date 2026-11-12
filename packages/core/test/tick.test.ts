import { describe, expect, it } from 'vitest';
import {
  CLAIM_LEASE_SEC, FakeSender, MAX_ATTEMPTS, RETRY_DELAYS_SEC, SMS_VOICE_REQUIRE_VERIFIED, ack, dispatchJob, heartbeatHealth, minuteKey, resolveDestination, retryAt, runTick, scheduleNext, unack,
  type Contact, type NotificationJob, type TickSummary,
} from '../src/index.js';
import { PATTERNS, Sim, T0, at, closedGroup, config, on, seedWorld, step } from './world.js';

const POLICY = { renotifyAfterSec: 3600 };

describe('tick: groups → incidents', () => {
  it('closes due OPEN groups first and collects them only after the 5s grace (next tick)', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.allAtOnce());
    const gid = closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    const g = sim.store.groups.get(gid)!;
    Object.assign(g, { status: 'OPEN', closedAt: null, closeAt: at(0, -5) }); // safety net: the delayed GROUP_CLOSE never arrived
    const r1 = await sim.tick();
    expect(r1.group).toMatchObject({ closed: 1, delivered: 0 });
    expect(sim.store.incidents.size).toBe(0);
    sim.now = at(1);
    const r2 = await sim.tick();
    expect(r2.group).toMatchObject({ closed: 0, delivered: 1, opened: 1 });
    expect(sim.store.groups.get(gid)).toMatchObject({ status: 'DELIVERED', deliveredAt: at(1) });
  });

  it('opens one incident per axis, merges a later group into it, and counts members once (I-4)', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.rotationThenCustomer());
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1', eventCount: 2 }, { id: 'al_2', severity: 'SEV_2' }] });
    await sim.tick();
    const inc = sim.incident();
    expect(inc).toMatchObject({ status: 'TRIGGERED', memberCount: 2, eventCount: 3, projectId: 'prj_core', serviceId: 'svc_pay', number: 1, source: 'CLOUDWATCH', isMergeTarget: true });
    expect(inc.assignmentSnapshot).toMatchObject({ level: 'CUSTOMER', pagingConfigId: 'pc_cus_mirae_CUSTOMER', repeatCount: 1 });
    expect(sim.store.eventsOf(inc.id).map((e) => e.kind)).toEqual(['TRIGGERED', 'NOTE', 'NOTIFIED']);
    expect(sim.store.eventsOf(inc.id)[1]!.message).toBe('Paging steps at open: MSP night desk → Yuna Seo');

    sim.now = at(3);
    closedGroup(sim.store, { customerId: 'cus_mirae', at: at(3), alerts: [{ id: 'al_1' }, { id: 'al_3' }] });
    const r = await sim.tick();
    expect(r.group).toMatchObject({ merged: 1, opened: 0 });
    expect(sim.store.incidents.size).toBe(1);
    expect(sim.incident()).toMatchObject({ memberCount: 3, eventCount: 5, version: inc.version + 1 });
    expect(sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim']); // a merge does not page again
  });

  it('known-bugs 3-3: two unmapped accounts never share an incident; customers never share one', async () => {
    const sim = new Sim();
    closedGroup(sim.store, { customerId: null, awsAccountId: '999999999999', at: T0, alerts: [{ id: 'al_a' }] });
    closedGroup(sim.store, { customerId: null, awsAccountId: '888888888888', at: T0, alerts: [{ id: 'al_b' }] });
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_c' }] });
    closedGroup(sim.store, { customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'al_d' }] });
    await sim.tick();
    const incs = [...sim.store.incidents.values()];
    expect(incs).toHaveLength(4);
    expect(new Set(incs.map((i) => i.axis)).size).toBe(4);
    expect(incs.filter((i) => i.customerId === null).map((i) => i.accountIds)).toEqual([['999999999999'], ['888888888888']]);
  });

  it('known-bugs 3-4: after 6h a new incident opens instead of merging; the old one stays open but is no merge target', async () => {
    const sim = new Sim();
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    await sim.tick();
    sim.now = at(6 * 60 + 1);
    closedGroup(sim.store, { customerId: 'cus_mirae', at: sim.now, alerts: [{ id: 'al_2' }] });
    await sim.tick();
    const [old, fresh] = [...sim.store.incidents.values()];
    expect(old).toMatchObject({ status: 'TRIGGERED', isMergeTarget: false });
    expect(fresh).toMatchObject({ status: 'TRIGGERED', isMergeTarget: true, memberCount: 1 });
  });

  it('known-bugs 3-1: a group whose delivery failed is picked up again by the next tick', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.allAtOnce());
    const gid = closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    sim.store.failGroups.add(gid);
    const r1 = await sim.tick();
    expect(r1.errors).toEqual([{ phase: 'group', id: gid, message: 'Error' }]); // the error's tag, never its raw message
    expect(sim.store.incidents.size).toBe(0);
    sim.store.failGroups.clear();
    sim.now = at(1);
    expect((await sim.tick()).group.opened).toBe(1);
    expect(sim.sms.sent).toHaveLength(3);
  });

  it('known-bugs 3-2: an ack that lands between read and write is not overwritten by the merge', async () => {
    const sim = new Sim();
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    await sim.tick();
    sim.now = at(2);
    closedGroup(sim.store, { customerId: 'cus_mirae', at: sim.now, alerts: [{ id: 'al_2' }] });
    // The ack commits after the tick read the merge target: first commit conflicts, the retry re-reads.
    const orig = sim.store.commitGroupDelivery.bind(sim.store);
    let raced = false;
    sim.store.commitGroupDelivery = async (c) => {
      if (!raced && c.incident) {
        raced = true;
        const cur = sim.incident();
        await sim.store.commitIncident({ row: ack(cur, 'usr_1', sim.now)!, expectedVersion: cur.version, bump: true });
      }
      return orig(c);
    };
    const r = await sim.tick();
    expect(r.group).toMatchObject({ merged: 1, conflicts: 0 });
    expect(sim.incident()).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: 'usr_1', memberCount: 2 });
  });

  it('DEFER members: only those still firing after the pause enter the incident; an all-cleared group opens nothing', async () => {
    const sim = new Sim();
    sim.store.policy.autoPauseSec = { SEV_3: 120 };
    const gid = closedGroup(sim.store, { customerId: 'cus_mirae', severity: 'SEV_3', at: T0, alerts: [{ id: 'al_1', decision: 'DEFER' }, { id: 'al_2', decision: 'DEFER' }] });
    expect((await sim.tick()).group.paused).toBe(1);
    sim.store.episodes.set('al_1', false);
    sim.now = at(2);
    await sim.tick();
    expect(sim.incident()).toMatchObject({ memberCount: 1 });
    expect(sim.store.groups.get(gid)!.status).toBe('DELIVERED');
    const g2 = closedGroup(sim.store, { customerId: 'cus_hanbit', severity: 'SEV_3', at: at(2), alerts: [{ id: 'al_9', decision: 'DEFER' }] });
    sim.store.episodes.set('al_9', false);
    sim.now = at(5);
    expect((await sim.tick()).group.empty).toBe(1);
    expect(sim.store.groups.get(g2)!.status).toBe('DELIVERED');
    expect(sim.store.incidents.size).toBe(1);
  });
});

describe('tick: auto-resolve (I-5)', () => {
  it('resolves when every member has cleared, records the resolution, and stops paging', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.templateStandard());
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }, { id: 'al_2' }] });
    await sim.run(1);
    sim.store.episodes.set('al_1', false);
    await sim.run(2);
    expect(sim.incident().status).toBe('TRIGGERED'); // one member is still firing
    sim.store.episodes.set('al_2', false);
    await sim.run(20);
    expect(sim.incident()).toMatchObject({ status: 'RESOLVED', resolvedVia: 'AUTO', isMergeTarget: false, nextEscalationAt: null, mttrSec: 180 });
    expect(sim.store.resolutions).toEqual([expect.objectContaining({ via: 'AUTO', kind: 'AUTO', serviceId: 'svc_pay' })]);
    expect(sim.timeline()).toEqual(['0 SLACK_BOT scope', '2 SMS Haeun Kim']);
  });

  it('does not resolve in the tick that just merged a fire into it', async () => {
    const sim = new Sim();
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    sim.store.episodes.set('al_1', false); // fired and cleared inside the group wait
    const r = await sim.tick();
    expect(r.reconcile).toMatchObject({ checked: 1, resolved: 0 });
    expect(sim.incident().status).toBe('TRIGGERED');
    sim.now = at(1);
    expect((await sim.tick()).reconcile.resolved).toBe(1);
  });
});

describe('tick: idempotency, skipped minutes, bounds, isolation', () => {
  it('same minute twice → duplicate; nothing is done the second time', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.allAtOnce());
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    await sim.tick();
    const again = await runTick({ scheduledAt: at(0, 40) }, on({ repo: sim.store, senders: sim.senders, now: () => at(0, 40) }));
    expect(again).toEqual({ skipped: 'duplicate', scheduledAt: minuteKey(T0) });
    expect(sim.sms.sent).toHaveLength(3);
  });

  it('double tick without the minute guard (overlapping runs): no second page, no second event', async () => {
    const sim = new Sim();
    sim.store.dedupeTicks = false;
    sim.store.configs.push(PATTERNS.templateStandard());
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    for (let m = 0; m <= 30; m++) {
      sim.now = at(m);
      await sim.tick();
      const snap = JSON.stringify([[...sim.store.incidents.values()], sim.store.events.length, sim.store.jobList().map((j) => [j.idempotencyKey, j.status, j.attempts])]);
      const second = await sim.tick();
      expect(second.escalation).toMatchObject({ escalated: 0, renotified: 0 });
      expect(second.notify).toMatchObject({ sent: 0, failed: 0, retried: 0, skipped: 0 });
      expect(JSON.stringify([[...sim.store.incidents.values()], sim.store.events.length, sim.store.jobList().map((j) => [j.idempotencyKey, j.status, j.attempts])])).toBe(snap);
    }
    expect(sim.timeline()).toHaveLength(12);
    const sentKeys = sim.allSent().map((m) => m.idempotencyKey);
    expect(new Set(sentKeys).size).toBe(sentKeys.length);
  });

  it('two overlapping ticks reading the same incident: the version guard lets only one fire the step (R4-5)', async () => {
    const sim = new Sim();
    sim.store.dedupeTicks = false;
    sim.store.configs.push(PATTERNS.rotationThenCustomer());
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    await sim.tick();
    sim.now = at(10);
    const stale = (await sim.store.listEscalationDue(sim.now, 10))[0]!;
    await sim.tick();
    // A second worker still holds the row it read before the first one committed.
    sim.store.listEscalationDue = async () => [stale];
    const r = await sim.tick(['escalation']);
    expect(r.escalation).toMatchObject({ checked: 1, escalated: 0, conflicts: 1 });
    expect(sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim', '10 VOICE Yuna Seo']);
    expect(sim.store.events.filter((e) => e.kind === 'ESCALATED')).toHaveLength(1);
  });

  it('skipped minutes: catches up one step per tick, never two steps at once, never the same step twice', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.templateStandard());
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    // The scheduler is down from minute 1 to 14: steps at 2, 7 and 12 were all missed.
    await sim.run(40, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(sim.timeline()).toEqual([
      '0 SLACK_BOT scope',
      '15 SMS Haeun Kim', // first tick back: exactly one step
      '20 VOICE Haeun Kim', // then the ladder keeps its own intervals (5 min, 5 min)
      '25 VOICE Haeun Kim', '25 VOICE Junho Park', '25 VOICE Yuna Seo',
      '30 SLACK_BOT scope', '32 SMS Haeun Kim', '37 VOICE Haeun Kim',
    ]);
    const steps = sim.store.events.filter((e) => e.kind === 'ESCALATED' || e.kind === 'NOTIFIED').map((e) => `${e.data!.repeat}:${e.data!.stepIndex}`);
    expect(new Set(steps).size).toBe(steps.length);
    expect(sim.store.events.find((e) => e.kind === 'ESCALATED')!.message).toContain('of the previous page 2026-11-09 03:00Z');
  });

  it('a single skipped minute keeps the schedule (late within tolerance is not re-based)', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.rotationThenCustomer());
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    await sim.run(31, [10]);
    expect(sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim', '11 VOICE Yuna Seo', '20 SLACK_DM Haeun Kim', '30 VOICE Yuna Seo']);
  });

  it('bounded batch: at most `batch` incidents per tick, the rest next tick, nobody skipped or paged twice', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.allAtOnce());
    for (let i = 0; i < 7; i++) closedGroup(sim.store, { customerId: 'cus_mirae', severity: (['SEV_1', 'SEV_2', 'SEV_3', 'SEV_4', 'SEV_5'] as const)[i % 5], awsAccountId: `11111111111${i}`, at: T0, alerts: [{ id: `al_${i}` }] });
    // 5 axes for one customer (customer#severity): groups 5 and 6 merge into the incidents of 0 and 1.
    const deps = { repo: sim.store, senders: sim.senders, batch: 2, notifyBatch: 4 };
    const run = async (m: number) => (await runTick({ scheduledAt: at(m) }, on({ ...deps, now: () => at(m) }))) as TickSummary;
    const r0 = await run(0);
    expect(r0.truncated).toBe(true);
    expect(r0.group.delivered).toBe(2);
    expect(r0.escalation.checked).toBe(2);
    expect(r0.notify.sent).toBe(4);
    for (let m = 1; m <= 6; m++) await run(m);
    expect(sim.store.incidents.size).toBe(5);
    const first = sim.store.jobList().filter((j) => j.repeat === 0);
    expect(first).toHaveLength(15);
    expect(first.every((j) => j.status === 'SENT')).toBe(true);
    expect(sim.sms.sent.length).toBeGreaterThanOrEqual(15);
    expect(new Set(sim.sms.sent.map((m) => m.idempotencyKey)).size).toBe(sim.sms.sent.length);
  });

  it('time budget: stops taking work when the budget is spent and reports truncated', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.allAtOnce());
    for (const c of ['cus_mirae', 'cus_hanbit']) closedGroup(sim.store, { customerId: c, at: T0, alerts: [{ id: `al_${c}` }] });
    let calls = 0;
    const r = (await runTick({ scheduledAt: T0 }, on({ repo: sim.store, senders: sim.senders, budgetMs: 1000, now: () => new Date(T0.getTime() + (calls++ > 3 ? 5000 : 0)) }))) as TickSummary;
    expect(r.truncated).toBe(true);
    expect(r.group.delivered).toBeLessThan(2);
  });

  it('one incident failing does not stop the others, and the heartbeat records the error', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.allAtOnce(), { ...PATTERNS.customerRotation(), repeatCount: 0 });
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    closedGroup(sim.store, { customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'al_2' }] });
    await sim.tick();
    const [mirae, hanbit] = [...sim.store.incidents.values()];
    sim.store.failIncidents.add(mirae!.id);
    sim.now = at(5);
    const r = await sim.tick();
    expect(r.errors).toEqual([{ phase: 'escalation', id: mirae!.id, message: 'Error' }]); // the error's tag, never its raw message
    expect(r.escalation).toMatchObject({ checked: 2, escalated: 1 });
    expect(sim.voice.sent.filter((m) => m.incidentId === hanbit!.id)).toHaveLength(4);
    const hb = await sim.store.readHeartbeats();
    expect(hb.find((h) => h.name === 'escalation')).toMatchObject({ lastStatus: 'ERROR', consecutiveFailures: 1, lastFinishedAt: at(5) });
    expect(hb.find((h) => h.name === 'notify')).toMatchObject({ lastStatus: 'OK', consecutiveFailures: 0 });
    sim.store.failIncidents.clear();
    sim.now = at(6);
    await sim.tick();
    expect(sim.sms.sent.filter((m) => m.incidentId === mirae!.id)).toHaveLength(6); // caught up, once
    expect((await sim.store.readHeartbeats()).find((h) => h.name === 'escalation')).toMatchObject({ lastStatus: 'OK', consecutiveFailures: 0 });
  });

  it('`jobs` limits the phases; summary shape matches API-CONTRACT §5', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.allAtOnce());
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    const r = await sim.tick(['group']);
    expect(r.group.opened).toBe(1);
    expect(r.escalation.checked).toBe(0);
    expect(sim.sms.sent).toHaveLength(0);
    expect((await sim.store.readHeartbeats()).map((h) => h.name)).toEqual(['group']);
    expect(Object.keys(r)).toEqual(['scheduledAt', 'group', 'reconcile', 'escalation', 'notify', 'errors', 'truncated', 'durationMs']);
  });
});

describe('heartbeat staleness (D-10, known-bugs 7-1)', () => {
  it('fresh after a tick, stale after 3 minutes without one, stale when a job never ran', async () => {
    const sim = new Sim();
    expect(heartbeatHealth(await sim.store.readHeartbeats(), T0).stale).toBe(true); // never ran
    await sim.tick();
    const rows = await sim.store.readHeartbeats();
    expect(heartbeatHealth(rows, at(3))).toMatchObject({ stale: false });
    const late = heartbeatHealth(rows, at(3, 1));
    expect(late.stale).toBe(true);
    expect(late.jobs.every((j) => j.stale && j.ageSec === 181)).toBe(true);
    // only the escalation job stopped
    const partial = rows.map((r) => (r.name === 'escalation' ? r : { ...r, lastFinishedAt: at(10) }));
    expect(heartbeatHealth(partial, at(10)).jobs.filter((j) => j.stale).map((j) => j.name)).toEqual(['escalation']);
    expect(heartbeatHealth(partial, at(10), { jobs: ['notify'] }).stale).toBe(false);
  });
});

describe('notification dispatch port', () => {
  const contact = (o: Partial<Contact> = {}): Contact => ({ ...seedWorld().contacts.get('ct_haeun')!, ...o });
  const job = (o: Partial<NotificationJob> = {}): NotificationJob => ({
    id: 'job_1', idempotencyKey: 'inc:ESCALATION:1:0:SMS:ct_haeun', incidentId: 'inc', customerId: 'cus_mirae', purpose: 'ESCALATION', channel: 'SMS',
    targetRef: 'ct_haeun', contactId: 'ct_haeun', contactName: 'Haeun Kim', stepIndex: 1, repeat: 0, payload: { title: 't', severity: 'SEV_2', text: 'x', stepLabel: 'Step 2/4' },
    status: 'SENDING', attempts: 1, claimSeq: 1, nextAttemptAt: T0, dueAt: T0, lastError: null, providerMessageId: null, createdAt: T0, ...o,
  });
  const ctx = (o: object = {}) => ({ now: T0, senders: { SMS: new FakeSender('sms') }, incidentStatus: 'TRIGGERED' as const, contact: contact(), slackChannels: [], ...o });

  it('retry policy: 30s, 1m, 2m, 5m, 10m, then give up at the 5th failure', () => {
    expect(RETRY_DELAYS_SEC).toEqual([30, 60, 120, 300, 600]);
    expect([1, 2, 3, 4, 5, 9].map((n) => (retryAt(n, T0).getTime() - T0.getTime()) / 1000)).toEqual([30, 60, 120, 300, 600, 600]);
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it('a failing provider is retried on that schedule, logged once as FAILED, and never sent twice', async () => {
    const sim = new Sim();
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['SMS'])], { repeatCount: 0 }));
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    sim.sms.failNext(99);
    sim.store.dedupeTicks = false;
    const attemptsAt: number[] = [];
    for (let s = 0; s <= 1500; s += 30) {
      sim.now = at(0, s);
      const before = sim.sms.attempts.length;
      await sim.tick();
      if (sim.sms.attempts.length > before) attemptsAt.push(s);
    }
    expect(attemptsAt).toEqual([0, 30, 90, 210, 510]);
    expect(sim.store.jobList()[0]).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(sim.store.logs).toEqual([expect.objectContaining({ status: 'FAILED', attempt: 5, channel: 'SMS', providerMessageId: null })]);
  });

  it('success after a retry: provider message id on the job and the delivery log', async () => {
    const sim = new Sim();
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['SMS', 'EMAIL'])], { repeatCount: 0 }));
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    sim.sms.failNext(1);
    const r = await sim.tick();
    expect(r.notify).toMatchObject({ sent: 1, failed: 0, retried: 1, skipped: 0 });
    sim.now = at(1);
    await sim.tick();
    expect(sim.store.jobList().map((j) => [j.channel, j.status, j.attempts, j.providerMessageId])).toEqual([['SMS', 'SENT', 2, 'sms-1'], ['EMAIL', 'SENT', 1, 'email-1']]);
    expect(sim.store.logs.map((l) => [l.channel, l.status, l.providerMessageId, l.targetSummary, l.escalationStep])).toEqual([['EMAIL', 'SENT', 'email-1', 'Haeun Kim', 0], ['SMS', 'SENT', 'sms-1', 'Haeun Kim', 0]]);
    expect(sim.sms.sent[0]).toMatchObject({ kind: 'SMS', to: sim.store.contacts.get('ct_haeun')!.phone, purpose: 'INITIAL' });
  });

  it('a send that never finished (process died while SENDING) is picked up again at nextAttemptAt', async () => {
    const sim = new Sim();
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['SMS'])], { repeatCount: 0 }));
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    sim.store.dedupeTicks = false;
    await sim.tick(['group', 'escalation']);
    const claimed = await sim.store.claimDueJobs(10); // claimed, then the process dies
    // a claim is a lease, not an attempt (R-3)
    expect(claimed[0]).toMatchObject({ status: 'SENDING', attempts: 0, claimSeq: 1, nextAttemptAt: at(0, CLAIM_LEASE_SEC) });
    sim.now = at(0, 20);
    await sim.tick(['notify']);
    expect(sim.sms.sent).toHaveLength(0);
    sim.now = at(1);
    await sim.tick(['notify']);
    expect(sim.sms.sent).toHaveLength(1);
  });

  it('non-retryable failure, missing sender: fail at once', async () => {
    const sms = new FakeSender('sms').failNext(1, { retryable: false });
    expect(await dispatchJob(job(), ctx({ senders: { SMS: sms } }))).toMatchObject({ status: 'FAILED', log: { status: 'FAILED', attempt: 1 } });
    expect(await dispatchJob(job(), ctx({ senders: {} }))).toMatchObject({ status: 'FAILED', error: 'No SMS sender is configured' });
    const throwing = { send: async () => { throw new Error('socket hang up'); } };
    expect(await dispatchJob(job(), ctx({ senders: { SMS: throwing } }))).toEqual({ status: 'RETRY', error: 'socket hang up', errorCode: 'PROVIDER_ERROR' });
    expect(await dispatchJob(job({ attempts: 5 }), ctx({ senders: { SMS: throwing } }))).toMatchObject({ status: 'FAILED' });
  });

  it('channel verification (R9-3, D-32, Q-DM-16): SMS/voice to an unverified number follows SMS_VOICE_REQUIRE_VERIFIED; missing address / inactive person is a skip without a log', async () => {
    // switch off (R9-3 as specified): still sent, flagged
    const unverified = await dispatchJob(job(), ctx({ contact: contact({ phoneVerifiedAt: null }), requireVerifiedPhone: false }));
    expect(unverified).toMatchObject({ status: 'SENT', warnings: ['UNVERIFIED_ADDRESS'], log: { warnings: ['UNVERIFIED_ADDRESS'] } });
    // switch on — and the default, which must be the safe value
    expect(SMS_VOICE_REQUIRE_VERIFIED).toBe(true);
    for (const o of [{ requireVerifiedPhone: true }, {}]) {
      for (const channel of ['SMS', 'VOICE'] as const) {
        const sms = new FakeSender('x');
        expect(await dispatchJob(job({ channel }), ctx({ contact: contact({ phoneVerifiedAt: null }), senders: { SMS: sms, VOICE: sms }, ...o }))).toEqual({ status: 'SKIPPED', reason: 'unverified' });
        expect(sms.attempts).toHaveLength(0);
      }
    }
    // Slack DM and e-mail are not part of the switch
    expect(await dispatchJob(job({ channel: 'EMAIL' }), ctx({ contact: contact({ emailVerifiedAt: null }), senders: { EMAIL: new FakeSender('e') }, requireVerifiedPhone: true })))
      .toMatchObject({ status: 'SENT', warnings: ['UNVERIFIED_ADDRESS'] });
    expect(await dispatchJob(job(), ctx())).toMatchObject({ status: 'SENT', warnings: [] });
    expect(await dispatchJob(job(), ctx({ contact: contact({ phone: null }) }))).toEqual({ status: 'SKIPPED', reason: 'no_address' });
    expect(await dispatchJob(job(), ctx({ contact: contact({ active: false }) }))).toEqual({ status: 'SKIPPED', reason: 'contact_inactive' });
    expect(resolveDestination(job({ channel: 'SLACK_DM' }), contact(), [])).toEqual({ ok: true, to: ['U_ct_haeun'], warnings: [] });
    expect(resolveDestination(job({ channel: 'SLACK_BOT', contactId: null }), null, [])).toEqual({ ok: false, reason: 'NO_CHANNEL' });
  });

  it('Slack with several destinations: one failing does not stop the others (R4-3)', async () => {
    const slack = new FakeSender('slack').failNext(1, { match: (m) => m.to === 'C_A' });
    const out = await dispatchJob(job({ channel: 'SLACK_BOT', contactId: null, contactName: null, targetRef: 'scope' }), ctx({ senders: { SLACK: slack }, contact: null, slackChannels: ['C_A', 'C_B'] }));
    expect(out).toMatchObject({ status: 'SENT', providerMessageId: 'slack-1' });
    expect(slack.sent.map((m) => m.to)).toEqual(['C_B']);
  });

  it('re-notify is only sent while still acknowledged; pages only while triggered', async () => {
    expect(await dispatchJob(job({ purpose: 'RENOTIFY' }), ctx({ incidentStatus: 'TRIGGERED' }))).toEqual({ status: 'SKIPPED', reason: 'not_acknowledged' });
    expect(await dispatchJob(job({ purpose: 'RENOTIFY' }), ctx({ incidentStatus: 'ACKNOWLEDGED' }))).toMatchObject({ status: 'SENT' });
    expect(await dispatchJob(job(), ctx({ incidentStatus: 'RESOLVED' }))).toEqual({ status: 'SKIPPED', reason: 'incident_closed' });
  });
});

// ───────────────────────────── property test ─────────────────────────────

/** Deterministic PRNG (mulberry32) so failures reproduce from the seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('property: any interleaving of ticks, gaps, acks, undos, mutes and clears', () => {
  const fingerprint = (sim: Sim) => JSON.stringify([
    [...sim.store.incidents.values()], sim.store.events.length, sim.store.logs.length,
    sim.store.jobList().map((j) => [j.idempotencyKey, j.status, j.attempts, j.nextAttemptAt]), [...sim.store.groups.values()].map((g) => [g.id, g.status]),
  ]);

  it.each(Array.from({ length: 40 }, (_, i) => i + 1))('seed %i: a second tick at the same instant changes nothing; no step is paged twice; nothing is paged after ack', async (seed) => {
    const rand = rng(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const sim = new Sim();
    sim.store.dedupeTicks = false;
    sim.store.policy.renotifyAfterSec = pick([0, 600, 3600]);
    sim.store.configs.push(pick([PATTERNS.rotationThenCustomer, PATTERNS.allAtOnce, PATTERNS.templateStandard])(), PATTERNS.customerRotation());
    sim.store.configs[0]!.repeatCount = pick([0, 1, 2]);
    let minute = 0;
    let alertSeq = 0;
    const fire = () => closedGroup(sim.store, {
      customerId: pick(['cus_mirae', 'cus_hanbit', null]), severity: pick(['SEV_1', 'SEV_2', 'SEV_3'] as const), at: sim.now,
      alerts: [{ id: `al_${++alertSeq}` }, ...(rand() < 0.3 ? [{ id: `al_${++alertSeq}` }] : [])],
    });
    fire();
    for (let i = 0; i < 60; i++) {
      const op = rand();
      const incs = [...sim.store.incidents.values()];
      if (op < 0.12) fire();
      else if (op < 0.22 && incs.length) {
        const inc = pick(incs);
        const a = ack(inc, 'usr_1', sim.now);
        if (a) { await sim.store.commitIncident({ row: { ...a, nextEscalationAt: scheduleNext(a, { now: sim.now, renotifyAfterSec: sim.store.policy.renotifyAfterSec }) }, expectedVersion: inc.version, bump: true }); }
      } else if (op < 0.27 && incs.length) {
        const inc = pick(incs);
        const u = unack(inc);
        if (u) { await sim.store.commitIncident({ row: { ...u, nextEscalationAt: scheduleNext(u, { now: sim.now, renotifyAfterSec: sim.store.policy.renotifyAfterSec }) }, expectedVersion: inc.version, bump: true }); }
      } else if (op < 0.33) {
        sim.store.windows.push({ id: `mw_${i}`, customerId: pick(['cus_mirae', 'cus_hanbit']), scopeType: 'CUSTOMER', scopeId: null, startsAt: sim.now, endsAt: at(minute + 1 + Math.floor(rand() * 20)) });
      } else if (op < 0.38 && alertSeq) sim.store.episodes.set(`al_${1 + Math.floor(rand() * alertSeq)}`, false);
      else if (op < 0.43) pick([sim.sms, sim.voice, sim.slack]).failNext(1 + Math.floor(rand() * 3), { retryable: rand() < 0.8 });

      const pages = (id: string) => sim.allSent().filter((m) => m.incidentId === id && m.purpose !== 'RENOTIFY').length;
      const ackedBefore = [...sim.store.incidents.values()].filter((x) => x.status !== 'TRIGGERED').map((x) => [x.id, pages(x.id), sim.store.jobList(x.id).filter((j) => j.purpose !== 'RENOTIFY').length] as const);
      minute += pick([1, 1, 1, 1, 2, 3, 7, 15]); // mostly every minute, sometimes the scheduler skips
      sim.now = at(minute);
      await sim.tick();
      for (const [id, sent, queued] of ackedBefore) {
        expect(pages(id), `incident ${id} was paged after ack/resolve`).toBe(sent);
        expect(sim.store.jobList(id).filter((j) => j.purpose !== 'RENOTIFY').length).toBe(queued);
      }
      const once = fingerprint(sim);
      const second = await sim.tick();
      expect(fingerprint(sim), `second tick at minute ${minute} changed state`).toBe(once);
      expect(second.errors).toEqual([]);
    }

    // Each (incident, repeat, step) was fired at most once, in order, one step per tick instant.
    const fired = new Map<string, string[]>();
    const firedAt = new Map<string, Set<number>>();
    for (const e of sim.store.events.filter((x) => x.kind === 'ESCALATED' || x.kind === 'NOTIFIED')) {
      const list = fired.get(e.incidentId) ?? [];
      list.push(`${e.data!.repeat}:${e.data!.stepIndex}`);
      fired.set(e.incidentId, list);
      const times = firedAt.get(e.incidentId) ?? new Set<number>();
      expect(times.has(e.at.getTime()), 'two steps in one tick').toBe(false);
      times.add(e.at.getTime());
      firedAt.set(e.incidentId, times);
    }
    for (const [id, list] of fired) {
      expect(new Set(list).size, `incident ${id} fired a step twice: ${list.join(' ')}`).toBe(list.length);
      const snap = sim.store.incidents.get(id)!.assignmentSnapshot!;
      expect(list.length).toBeLessThanOrEqual(snap.steps.length * (1 + snap.repeatCount));
      expect([...list].sort((a, b) => { const [ar, as] = a.split(':').map(Number); const [br, bs] = b.split(':').map(Number); return ar! - br! || as! - bs!; })).toEqual(list);
    }
    // Every provider message is unique, and each job was delivered at most once.
    const keys = sim.allSent().map((m) => `${m.idempotencyKey}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sim.store.jobList().every((j) => j.attempts <= MAX_ATTEMPTS)).toBe(true);
    // Unmapped incidents never page a person; SEV-1 aside, nothing beyond the outbox key space exists.
    for (const inc of sim.store.incidents.values()) {
      if (inc.customerId === null) expect(sim.store.jobList(inc.id).every((j) => j.targetRef === 'msp-default')).toBe(true);
      // Tenant: a job's contact is staff or belongs to the incident's customer.
      for (const j of sim.store.jobList(inc.id)) {
        const c = j.contactId ? sim.store.contacts.get(j.contactId) : null;
        if (c && c.kind === 'CUSTOMER') expect(c.customerId).toBe(inc.customerId);
      }
    }
  });
});
