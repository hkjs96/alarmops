import { describe, expect, it } from 'vitest';
import {
  ack, buildSnapshot, escalationView, incidentMute, newIncident, nextStep, parseSnapshot, planEscalation, scheduleNext, unack,
  type IncidentRow, type MaintenanceWindow, type PagingConfig,
} from '../src/index.js';
import { PATTERNS, Sim, T0, at, closedGroup, config, seedWorld, step } from './world.js';

const POLICY = { renotifyAfterSec: 3600 };

function simWith(cfg: PagingConfig, o: { customerId?: string; severity?: 'SEV_1' | 'SEV_2' } = {}): Sim {
  const sim = new Sim();
  sim.store.configs.push(cfg);
  closedGroup(sim.store, { customerId: o.customerId ?? cfg.customerId, severity: o.severity, at: T0, alerts: [{ id: 'al_1', title: 'web-1 CPU high' }] });
  return sim;
}

describe('escalation timelines for the four sample call orders', () => {
  it('rotation, then the customer person by phone at 10 min; repeats once, then stops (D-20)', async () => {
    const sim = simWith(PATTERNS.rotationThenCustomer());
    await sim.run(90);
    expect(sim.timeline()).toEqual([
      '0 SLACK_DM Haeun Kim', '10 VOICE Yuna Seo',
      '20 SLACK_DM Haeun Kim', '30 VOICE Yuna Seo', // one repeat, started one last-interval (10 min) after the ladder ended
    ]);
    const inc = sim.incident();
    expect(inc.escalationDoneAt).toEqual(at(30));
    expect(inc.nextEscalationAt).toBeNull();
    expect(escalationView(inc, { now: sim.now, ...POLICY }).state).toBe('STOPPED_EXHAUSTED');
    expect(sim.slack.sent.map((m) => m.to)).toEqual(['U_ct_haeun', 'U_ct_haeun']);
    expect(sim.voice.sent).toHaveLength(2);
  });

  it('all at once: every pageable responder at 0 (notify-only people are not paged), repeated once', async () => {
    const sim = simWith(PATTERNS.allAtOnce());
    await sim.run(60);
    expect(sim.timeline()).toEqual([
      '0 SMS Haeun Kim', '0 SMS Junho Park', '0 SMS Yuna Seo',
      '5 SMS Haeun Kim', '5 SMS Junho Park', '5 SMS Yuna Seo',
    ]);
    expect(sim.timeline().join()).not.toContain('Seojun');
  });

  it('customer rotation (Urgent template): on-call customer person, then everyone at 5 min', async () => {
    const sim = simWith(PATTERNS.customerRotation());
    await sim.run(60);
    expect(sim.timeline()).toEqual([
      '0 VOICE Dohyun Han',
      '5 VOICE Dohyun Han', '5 VOICE Minjae Lee', '5 VOICE Sora Lim',
      '10 VOICE Dohyun Han',
      '15 VOICE Dohyun Han', '15 VOICE Minjae Lee', '15 VOICE Sora Lim',
    ]);
  });

  it('shared rotation + Standard template: Slack 0 → SMS 2 → call 7 → call everyone 12', async () => {
    const sim = simWith(PATTERNS.templateStandard());
    await sim.run(11);
    expect(sim.timeline()).toEqual(['0 SLACK_BOT scope', '2 SMS Haeun Kim', '7 VOICE Haeun Kim']);
    expect(sim.slack.sent[0]!.to).toBe('C_MIRAE');
    await sim.run(60);
    expect(sim.timeline().slice(3)).toEqual([
      '12 VOICE Haeun Kim', '12 VOICE Junho Park', '12 VOICE Yuna Seo',
      '17 SLACK_BOT scope', '19 SMS Haeun Kim', '24 VOICE Haeun Kim',
      '29 VOICE Haeun Kim', '29 VOICE Junho Park', '29 VOICE Yuna Seo',
    ]);
  });

  it('repeatCount 0: the ladder runs once and stops', async () => {
    const sim = simWith({ ...PATTERNS.rotationThenCustomer(), repeatCount: 0 });
    await sim.run(60);
    expect(sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim', '10 VOICE Yuna Seo']);
    expect(sim.incident().escalationDoneAt).toEqual(at(10));
  });
});

describe('ack, undo, re-notify', () => {
  it('ack stops paging; undo continues from the step where it stopped, without paging earlier steps again', async () => {
    const sim = simWith(PATTERNS.templateStandard());
    await sim.run(3); // step 1 (0) and step 2 (2) are out
    const before = sim.incident();
    const acked = ack(before, 'usr_1', at(3, 30))!;
    await sim.store.commitIncident({ row: { ...acked, nextEscalationAt: scheduleNext(acked, { now: at(3, 30), ...POLICY }) }, expectedVersion: before.version, bump: true });
    await sim.run(20);
    expect(sim.timeline()).toEqual(['0 SLACK_BOT scope', '2 SMS Haeun Kim']);
    expect(escalationView(sim.incident(), { now: sim.now, ...POLICY })).toMatchObject({ state: 'STOPPED_ACKED', stoppedAt: at(3, 30), nextAt: null });

    const cur = sim.incident();
    const restored = unack(cur)!;
    await sim.store.commitIncident({ row: { ...restored, nextEscalationAt: scheduleNext(restored, { now: sim.now, ...POLICY }) }, expectedVersion: cur.version, bump: true });
    await sim.run(40);
    // 21: the overdue step 3 goes out once; the ladder then keeps its intervals (5 min to step 4).
    expect(sim.timeline().slice(2, 6)).toEqual(['21 VOICE Haeun Kim', '26 VOICE Haeun Kim', '26 VOICE Junho Park', '26 VOICE Yuna Seo']);
    expect(new Set(sim.store.jobList().map((j) => j.idempotencyKey)).size).toBe(sim.store.jobList().length);
  });

  it('a page still retrying when the incident is acknowledged is not sent', async () => {
    const sim = simWith(PATTERNS.rotationThenCustomer());
    sim.slack.failNext(1);
    await sim.tick();
    expect(sim.slack.sent).toHaveLength(0);
    const inc = sim.incident();
    await sim.store.commitIncident({ row: ack(inc, 'usr_1', at(0, 10))!, expectedVersion: inc.version, bump: true });
    await sim.run(5);
    expect(sim.slack.sent).toHaveLength(0);
    expect(sim.store.jobList()[0]).toMatchObject({ status: 'SKIPPED', lastError: 'acknowledged' });
  });

  it('acknowledged and still unresolved: reminder after renotifyAfterSec to the first step, once per period (R5-2)', async () => {
    const sim = simWith(PATTERNS.rotationThenCustomer());
    sim.store.policy.renotifyAfterSec = 600;
    await sim.tick();
    const inc = sim.incident();
    const acked = ack(inc, 'usr_1', at(1))!;
    await sim.store.commitIncident({ row: { ...acked, nextEscalationAt: scheduleNext(acked, { now: at(1), renotifyAfterSec: 600 }) }, expectedVersion: inc.version, bump: true });
    await sim.run(32);
    expect(sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim', '11 SLACK_DM Haeun Kim', '21 SLACK_DM Haeun Kim', '31 SLACK_DM Haeun Kim']);
    expect(sim.store.jobList().slice(1).every((j) => j.purpose === 'RENOTIFY')).toBe(true);
    expect(sim.store.eventsOf(inc.id).filter((e) => e.kind === 'RENOTIFIED')[0]!.message).toContain('after acknowledgement 2026-11-09 03:01Z');
  });
});

describe('maintenance windows (D-17)', () => {
  const win = (o: Partial<MaintenanceWindow> = {}): MaintenanceWindow =>
    ({ id: 'mw_1', customerId: 'cus_mirae', scopeType: 'CUSTOMER', scopeId: 'cus_mirae', startsAt: at(1), endsAt: at(30), ...o });

  it('SEV-2 is muted: no step fires during the window, the step counter is kept, one delayed step right after (R4-6)', async () => {
    const sim = simWith(PATTERNS.templateStandard());
    sim.store.windows.push(win());
    await sim.run(29);
    expect(sim.timeline()).toEqual(['0 SLACK_BOT scope']);
    expect(sim.incident().escalationStep).toBe(1);
    expect(escalationView(sim.incident(), { now: sim.now, ...POLICY, mutedUntil: at(30) })).toMatchObject({ state: 'MUTED', mutedByMaintenance: true, nextAt: null });
    expect(sim.results.some((r) => !('skipped' in r) && r.escalation.muted > 0)).toBe(true);
    await sim.run(45);
    // 30: the delayed step goes out once, then normal intervals from there (5 min, 5 min) — never a burst.
    expect(sim.timeline().slice(1)).toEqual(['30 SMS Haeun Kim', '35 VOICE Haeun Kim', '40 VOICE Haeun Kim', '40 VOICE Junho Park', '40 VOICE Yuna Seo', '45 SLACK_BOT scope']);
  });

  it('SEV-1 keeps paging through the window', async () => {
    const sim = simWith(PATTERNS.templateStandard(), { severity: 'SEV_1' });
    sim.store.windows.push(win({ startsAt: at(-5) }));
    await sim.run(8);
    expect(sim.timeline()).toEqual(['0 SLACK_BOT scope', '2 SMS Haeun Kim', '7 VOICE Haeun Kim']);
  });

  it('another customer’s window and a revoked window do not mute', () => {
    const t = { customerId: 'cus_mirae', severity: 'SEV_3' as const, accountIds: ['111111111111'] };
    expect(incidentMute(t, [win({ customerId: 'cus_hanbit', scopeId: 'cus_hanbit' })], at(5))).toBeNull();
    expect(incidentMute(t, [win({ revokedAt: at(2) })], at(5))).toBeNull();
    expect(incidentMute(t, [win()], at(5))?.id).toBe('mw_1');
    expect(incidentMute({ ...t, severity: 'SEV_1' }, [win()], at(5))).toBeNull();
    // account window mutes only when it covers every account of the incident
    const acct = win({ scopeType: 'ACCOUNT', scopeId: '111111111111' });
    expect(incidentMute(t, [acct], at(5))?.id).toBe('mw_1');
    expect(incidentMute({ ...t, accountIds: ['111111111111', '333333333333'] }, [acct], at(5))).toBeNull();
  });
});

describe('rotation resolution at open (shift → accepted override → leave)', () => {
  const snapAt = (s: ReturnType<typeof seedWorld>, when: Date) =>
    buildSnapshot([PATTERNS.rotationThenCustomer()], { customerId: 'cus_mirae' }, s.worldOf('cus_mirae'), when)!;

  it('the shift member is paged; next day the next member', () => {
    const s = seedWorld();
    expect(snapAt(s, T0).steps[0]!.resolved.map((r) => r.name)).toEqual(['Haeun Kim']);
    expect(snapAt(s, at(24 * 60)).steps[0]!.resolved.map((r) => r.name)).toEqual(['Junho Park']);
  });
  it('an accepted override wins; a pending one does not', () => {
    const s = seedWorld();
    s.overrides.push({ rotationId: 'rot_night', contactId: 'ct_minjae', startAt: at(-60), endAt: at(60), status: 'PENDING' });
    expect(snapAt(s, T0).steps[0]!.resolved[0]!.name).toBe('Haeun Kim');
    s.overrides[0]!.status = 'ACCEPTED';
    expect(snapAt(s, T0).steps[0]!.resolved[0]).toMatchObject({ name: 'Minjae Lee', via: 'rotation+override' });
    expect(snapAt(s, at(61)).steps[0]!.resolved[0]!.name).toBe('Haeun Kim');
  });
  it('leave replaces the on-call person and a PERSON step target; cancelled leave does not', () => {
    const s = seedWorld();
    s.leaves.push({ contactId: 'ct_haeun', replacementId: 'ct_minjae', startDate: '2026-11-09', endDate: '2026-11-10' });
    expect(snapAt(s, T0).steps[0]!.resolved[0]).toMatchObject({ name: 'Minjae Lee', via: 'rotation+leave' });
    s.leaves[0]!.cancelledAt = at(-1);
    expect(snapAt(s, T0).steps[0]!.resolved[0]!.name).toBe('Haeun Kim');
    s.leaves.push({ contactId: 'ct_yuna', replacementId: 'ct_junho', startDate: '2026-11-09', endDate: '2026-11-09' });
    const snap = snapAt(s, T0);
    expect(snap.steps[1]!.resolved[0]!.name).toBe('Junho Park');
    expect(snap.leaveApplied).toEqual(['ct_yuna']);
  });
  it('the order is frozen at open: a shift change during the incident does not change who is paged (R2-5)', async () => {
    const sim = new Sim();
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'ROTATION', 'rot_night', ['SMS']), step(1, 30, 'ROTATION', 'rot_night', ['VOICE'])], { repeatCount: 0 }));
    sim.now = at(21 * 60 - 10); // 10 minutes before the daily handover to Junho
    closedGroup(sim.store, { customerId: 'cus_mirae', at: sim.now, alerts: [{ id: 'al_1' }] });
    for (let m = 0; m <= 31; m++) { sim.now = at(21 * 60 - 10 + m); await sim.tick(); }
    expect(sim.store.jobList().map((j) => `${j.channel} ${j.contactName}`)).toEqual(['SMS Haeun Kim', 'VOICE Haeun Kim']);
  });
  it('contact addresses are read at send time, not frozen (R3-2); a person deleted meanwhile is skipped', async () => {
    const sim = simWith(PATTERNS.rotationThenCustomer());
    await sim.run(5);
    sim.store.contacts.get('ct_yuna')!.phone = '+821099990000';
    await sim.run(10);
    expect(sim.voice.sent[0]!.to).toBe('+821099990000');
    expect(JSON.stringify(sim.incident().assignmentSnapshot)).not.toMatch(/\+82|@example/);
    sim.store.contacts.delete('ct_haeun');
    await sim.run(20);
    expect(sim.store.jobList().find((j) => j.repeat === 1 && j.stepIndex === 0)).toMatchObject({ status: 'SKIPPED', lastError: 'no_contact' });
  });
});

describe('states the UI shows', () => {
  const base = (): IncidentRow => newIncident('cus_mirae#SEV-2', { customerId: 'cus_mirae', severity: 'SEV_2', title: 't' }, T0);

  it('never escalating: no call order applies (no config / unmapped account) — nobody is paged, one MSP channel post', async () => {
    const sim = new Sim();
    closedGroup(sim.store, { customerId: null, at: T0, alerts: [{ id: 'al_u' }] });
    closedGroup(sim.store, { customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'al_h' }] }); // Hanbit has no paging config here
    await sim.run(30);
    expect(sim.timeline()).toEqual(['0 SLACK_BOT msp-default', '0 SLACK_BOT msp-default']);
    expect(sim.slack.sent.map((m) => m.to)).toEqual(['C_MSP', 'C_MSP']);
    for (const inc of sim.store.incidents.values()) {
      expect(inc.assignmentSnapshot).toBeNull();
      expect(inc.nextEscalationAt).toBeNull();
      expect(escalationView(inc, { now: sim.now, ...POLICY })).toMatchObject({ state: 'NEVER_ESCALATING', nextAt: null, totalSteps: 0 });
    }
    expect(sim.store.events.filter((e) => /Nobody is paged/.test(e.message))).toHaveLength(2);
  });

  it('unreachable: a call order exists but no step resolves to a person', async () => {
    const sim = new Sim();
    sim.store.contacts.get('ct_yuna')!.active = false;
    sim.store.rotations.get('rot_night')!.members = [];
    sim.store.configs.push(PATTERNS.rotationThenCustomer());
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    await sim.tick();
    const inc = sim.incident();
    expect(escalationView(inc, { now: sim.now, ...POLICY })).toMatchObject({ state: 'UNREACHABLE', totalSteps: 2 });
    expect(sim.store.jobList()).toHaveLength(0);
    expect(sim.store.eventsOf(inc.id).some((e) => e.message.includes('nobody (no reachable responder)'))).toBe(true);
    await sim.run(40);
    expect(sim.allSent()).toHaveLength(0);
    expect(escalationView(sim.incident(), { now: sim.now, ...POLICY }).state).toBe('STOPPED_EXHAUSTED');
  });

  it('paging: next step time and label; a broken snapshot is treated as none (R3-3)', () => {
    const s = seedWorld();
    const snap = buildSnapshot([PATTERNS.templateStandard()], { customerId: 'cus_mirae' }, s.worldOf('cus_mirae'), T0)!;
    const inc = { ...base(), assignmentSnapshot: snap, escalationStep: 1, escalationBaseAt: T0 };
    expect(escalationView(inc, { now: at(1), ...POLICY })).toMatchObject({ state: 'PAGING', step: 0, totalSteps: 4, repeat: 0, repeatCount: 1, nextAt: at(2), nextLabel: 'Step 2 · SMS Haeun Kim', escalated: false });
    expect(escalationView({ ...inc, escalationStep: 3, escalationBaseAt: at(7) }, { now: at(8), ...POLICY })).toMatchObject({ step: 2, nextAt: at(12), escalated: true });
    expect(parseSnapshot({ capturedAt: 'x', steps: [{ atMin: 'soon' }], repeatCount: 1 })).toBeNull();
    const broken = { ...inc, assignmentSnapshot: { steps: 'oops' } as never };
    expect(nextStep(broken)).toBeNull();
    expect(planEscalation(broken, { now: at(50), ...POLICY })).toMatchObject({ kind: 'NONE', reason: 'NO_SNAPSHOT' });
  });
});

describe('planEscalation is idempotent and words its events with the base time (known-bugs 7-2)', () => {
  const s = seedWorld();
  const snap = buildSnapshot([PATTERNS.templateStandard()], { customerId: 'cus_mirae' }, s.worldOf('cus_mirae'), T0)!;
  const inc: IncidentRow = { ...newIncident('cus_mirae#SEV-2', { customerId: 'cus_mirae', severity: 'SEV_2', title: 'db-1 disk' }, T0), assignmentSnapshot: snap };

  it('same state + same clock → same notification keys; after applying the patch → nothing', () => {
    const a = planEscalation(inc, { now: T0, ...POLICY });
    const b = planEscalation(inc, { now: T0, ...POLICY });
    if (a.kind !== 'STEP' || b.kind !== 'STEP') throw new Error('expected STEP');
    expect(a.intents.map((i) => i.idempotencyKey)).toEqual(b.intents.map((i) => i.idempotencyKey));
    expect(a.intents[0]!.idempotencyKey).toBe(`${inc.id}:INITIAL:0:0:SLACK_BOT:scope`);
    expect(planEscalation({ ...inc, ...a.patch }, { now: T0, ...POLICY })).toMatchObject({ kind: 'NONE', reason: 'NOT_DUE' });
  });

  it('key = incident + step + repeat + channel + contact', () => {
    const p = planEscalation({ ...inc, escalationStep: 4, escalationBaseAt: at(12) }, { now: at(19), ...POLICY });
    if (p.kind !== 'STEP') throw new Error('expected STEP');
    expect(p).toMatchObject({ stepIndex: 0, repeat: 1 });
    const q = planEscalation({ ...inc, ...p.patch }, { now: at(21), ...POLICY });
    if (q.kind !== 'STEP') throw new Error('expected STEP');
    expect(q.intents.map((i) => i.idempotencyKey)).toEqual([`${inc.id}:ESCALATION:1:1:SMS:ct_haeun`]);
  });

  it('message names what the wait counted from', () => {
    const first = planEscalation(inc, { now: T0, ...POLICY });
    if (first.kind !== 'STEP') throw new Error();
    expect(first.event).toMatchObject({ kind: 'NOTIFIED', message: 'Paged step 1/4: Slack Haeun Kim.' });
    const second = planEscalation({ ...inc, ...first.patch }, { now: at(2), ...POLICY });
    if (second.kind !== 'STEP') throw new Error();
    expect(second.event.kind).toBe('ESCALATED');
    expect(second.event.message).toBe('No ack within 2 min of the previous page 2026-11-09 03:00Z → step 2/4: SMS Haeun Kim.');
    const delayed = planEscalation({ ...inc, escalationBaseAt: T0, triggeredAt: T0 }, { now: at(0), ...POLICY });
    expect(delayed.kind).toBe('STEP');
  });

  it('a late call fires one step and re-bases on now; an on-time call keeps the schedule', () => {
    const after1 = { ...inc, escalationStep: 1, escalationBaseAt: T0 };
    const onTime = planEscalation(after1, { now: at(2, 20), ...POLICY });
    const late = planEscalation(after1, { now: at(30), ...POLICY });
    if (onTime.kind !== 'STEP' || late.kind !== 'STEP') throw new Error();
    expect(onTime.patch.escalationBaseAt).toEqual(at(2));
    expect(onTime.patch.nextEscalationAt).toEqual(at(7));
    expect(late.stepIndex).toBe(1);
    expect(late.patch.escalationBaseAt).toEqual(at(30));
    expect(late.patch.nextEscalationAt).toEqual(at(35));
  });

  it('manual escalate fires the next step now, even when muted; nothing left → DONE', () => {
    const p = planEscalation({ ...inc, escalationStep: 1, escalationBaseAt: T0 }, { now: at(0, 30), ...POLICY, mutedUntil: at(60), force: { by: 'Haeun Kim' } });
    if (p.kind !== 'STEP') throw new Error();
    expect(p.event.message).toBe('Escalated manually by Haeun Kim → step 2/4: SMS Haeun Kim.');
    expect(planEscalation({ ...inc, escalationStep: 4, escalationRepeat: 1, escalationDoneAt: at(29) }, { now: at(40), ...POLICY, force: { by: 'x' } })).toMatchObject({ kind: 'NONE', reason: 'DONE' });
  });

  it('advanceOnAllFail: when every notification of the step failed the next step goes out early', () => {
    const cfg = config('cus_mirae', [step(0, 0, 'PERSON', 'ct_haeun', ['SMS'], { advanceOnAllFail: true }), step(1, 10, 'PERSON', 'ct_junho', ['VOICE'])]);
    const sn = buildSnapshot([cfg], { customerId: 'cus_mirae' }, s.worldOf('cus_mirae'), T0)!;
    const st = { ...inc, assignmentSnapshot: sn, escalationStep: 1, escalationBaseAt: T0 };
    expect(scheduleNext(st, { now: at(1), ...POLICY })).toEqual(at(2)); // looked at every minute
    expect(planEscalation(st, { now: at(1), ...POLICY }).kind).toBe('NONE');
    const p = planEscalation(st, { now: at(1), ...POLICY, lastStepAllFailed: true });
    expect(p).toMatchObject({ kind: 'STEP', stepIndex: 1 });
  });
});
