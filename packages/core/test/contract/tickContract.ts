/**
 * Contract suite of the tick's store (TickRepository): the SAME tests run against MemoryTickStore
 * (test/contract.memory.test.ts) and against the SQL store (packages/store-sql/test/contract.tick.test.ts).
 * Everything goes through the real `runTick` and the repository port; the fixture only seeds and reads back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAIM_LEASE_SEC, FakeSender, MAX_ALL_RESPONDERS, MAX_ATTEMPTS, MemoryTickStore, RETRY_DELAYS_SEC, ack, heartbeatHealth, runTick, scheduleNext, selectForClaim, unack,
  type Contact, type IncidentRow, type NotificationJob, type OutboundMessage, type Severity, type TickJob, type TickSummary,
} from '../../src/index.js';
import { PATTERNS, T0, at, closedGroup, config, seedWorld, step, type AlertSeed } from '../world.js';
import type { MakeFixture, StoreFixture } from './fixture.js';

const POLICY = { renotifyAfterSec: 3600 };
const V = new Date('2026-10-01T00:00:00Z');

/** `Sim` of world.ts on a fixture: simulated clock for the runner AND the store, four fake senders. */
export class CSim {
  now = T0;
  slack = new FakeSender('slack'); sms = new FakeSender('sms'); voice = new FakeSender('voice'); email = new FakeSender('email');
  private seq = 0;
  constructor(readonly fx: StoreFixture) { fx.setClock(() => this.now); }
  get senders() { return { SLACK: this.slack, SMS: this.sms, VOICE: this.voice, EMAIL: this.email }; }
  async tick(jobs?: TickJob[]): Promise<TickSummary> {
    const r = await runTick({ scheduledAt: this.now, jobs }, { repo: this.fx.repo, senders: this.senders, now: () => this.now });
    if ('skipped' in r) throw new Error('tick skipped as duplicate');
    return r;
  }
  /** One tick per minute from the current minute to `untilMin` (inclusive), skipping `skip`; the first minute is ticked only when `first`. */
  async run(untilMin: number, skip: number[] = [], first = false): Promise<void> {
    const start = Math.round((this.now.getTime() - T0.getTime()) / 60_000);
    for (let m = first ? start : start + 1; m <= untilMin; m++) {
      this.now = at(m);
      if (!skip.includes(m)) await this.tick();
    }
  }
  /** A closed group as ingest leaves it (world.ts `closedGroup`), written through the fixture. */
  async group(o: { customerId: string | null; awsAccountId?: string | null; severity?: Severity; at: Date; alerts: AlertSeed[] }, patch: Record<string, unknown> = {}): Promise<string> {
    const scratch = new MemoryTickStore();
    const id = closedGroup(scratch, o);
    const g = { ...scratch.groups.get(id)!, ...patch, id: this.seq++ ? `${id}-${this.seq}` : id };
    await this.fx.addGroup(g, scratch.members.get(id)!);
    return g.id;
  }
  async timeline(incidentId?: string): Promise<string[]> {
    return (await this.fx.jobs(incidentId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.idempotencyKey.localeCompare(b.idempotencyKey))
      .map((j) => `${Math.round((j.createdAt.getTime() - T0.getTime()) / 60_000)} ${j.channel} ${j.contactName ?? j.targetRef}`);
  }
  async incident(i = 0): Promise<IncidentRow> { return (await this.fx.incidents())[i]!; }
  allSent(): OutboundMessage[] { return [...this.slack.sent, ...this.sms.sent, ...this.voice.sent, ...this.email.sent]; }
}

/** n tenants (`cus_t0` …) with one person each; returns the seed. */
export function tenantSeed(n: number, channel: 'SMS' | 'VOICE' | 'EMAIL' | 'SLACK_DM' = 'SMS', extra: (s: MemoryTickStore) => void = () => undefined): MemoryTickStore {
  const s = seedWorld();
  for (let i = 0; i < n; i++) {
    const cid = `cus_t${i}`; const p = `ct_t${i}`; const acct = `40000000${String(i).padStart(4, '0')}`;
    s.customers.set(cid, { id: cid, name: `T${i}`, slug: `t${i}` });
    s.accounts.set(acct, { awsAccountId: acct, customerId: cid, serviceId: null });
    s.contacts.set(p, { id: p, kind: 'CUSTOMER', customerId: cid, name: `P${i}`, active: true, phone: `+82105550${String(i).padStart(4, '0')}`, email: `${p}@example.test`, slackUserId: `U${p}`, phoneVerifiedAt: V, emailVerifiedAt: V, slackVerifiedAt: V });
    s.responders.push({ customerId: cid, contactId: p, role: 'PAGEABLE' });
    s.configs.push(config(cid, [step(0, 0, 'PERSON', p, [channel])], { repeatCount: 0 }));
    closedGroup(s, { customerId: cid, awsAccountId: acct, severity: 'SEV_1', at: T0, alerts: [{ id: `al_${i}` }] });
  }
  extra(s);
  return s;
}

/** Opens the tenants' incidents and returns each tenant's first page as a template (marked SENT). */
export async function openTenants(sim: CSim, n: number): Promise<Map<number, NotificationJob>> {
  await runTick({ scheduledAt: T0, jobs: ['group', 'escalation'] }, { repo: sim.fx.repo, senders: {}, now: () => sim.now });
  await sim.fx.clearTickClaims();
  const base = new Map<number, NotificationJob>();
  for (const j of await sim.fx.jobs()) {
    const m = /^cus_t(\d+)$/.exec(j.customerId ?? '');
    if (!m || base.has(Number(m[1]))) continue;
    base.set(Number(m[1]), j);
    await sim.fx.patchJob(j.idempotencyKey, { status: 'SENT' });
  }
  if (base.size !== n) throw new Error(`expected ${n} template pages, got ${base.size}`);
  return base;
}

export const pageOf = (b: NotificationJob, tag: string, when: Date, over: Partial<NotificationJob> = {}): NotificationJob => ({
  ...structuredClone(b), id: `job_${b.customerId}_${tag}`, idempotencyKey: `${b.idempotencyKey}#${tag}`, nextAttemptAt: when, dueAt: when, createdAt: when,
  status: 'QUEUED', attempts: 0, claimSeq: 0, lastError: null, providerMessageId: null, ...over,
});

export function tickContract(make: MakeFixture): void {
  let fx: StoreFixture;
  const open = async (seed: MemoryTickStore = seedWorld()): Promise<CSim> => { fx = await make(seed); return new CSim(fx); };
  beforeEach(() => { fx = undefined as unknown as StoreFixture; });
  afterEach(async () => { await fx?.close(); });

  describe('groups → incidents', () => {
    it('closes due OPEN groups first and collects them only after the grace (next tick)', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.allAtOnce());
      const sim = await open(seed);
      const gid = await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] }, { status: 'OPEN', closedAt: null, closeAt: at(0, -5) });
      const r1 = await sim.tick();
      expect(r1.group).toMatchObject({ closed: 1, delivered: 0 });
      expect(await fx.incidents()).toHaveLength(0);
      expect(await fx.group(gid)).toMatchObject({ status: 'CLOSED', closedAt: T0, version: 2 });
      sim.now = at(1);
      const r2 = await sim.tick();
      expect(r2.group).toMatchObject({ closed: 0, delivered: 1, opened: 1 });
      expect(await fx.group(gid)).toMatchObject({ status: 'DELIVERED', deliveredAt: at(1), version: 3 });
    });

    it('opens one incident per axis, merges a later group into it, counts members once; a merge does not page again', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1', eventCount: 2 }, { id: 'al_2', severity: 'SEV_2' }] });
      await sim.tick();
      const inc = await sim.incident();
      expect(inc).toMatchObject({ status: 'TRIGGERED', memberCount: 2, eventCount: 3, projectId: 'prj_core', serviceId: 'svc_pay', number: 1, source: 'CLOUDWATCH', isMergeTarget: true, customerId: 'cus_mirae' });
      expect(inc.assignmentSnapshot).toMatchObject({ level: 'CUSTOMER', pagingConfigId: 'pc_cus_mirae_CUSTOMER', repeatCount: 1 });
      expect((await fx.events(inc.id)).map((e) => e.kind)).toEqual(['TRIGGERED', 'NOTE', 'NOTIFIED']);
      expect((await fx.events(inc.id))[1]!.message).toBe('Paging steps at open: MSP night desk → Yuna Seo');
      expect(await fx.repo.incidentFingerprints(inc.id)).toEqual(expect.arrayContaining(['fp:al_1', 'fp:al_2']));

      sim.now = at(3);
      await sim.group({ customerId: 'cus_mirae', at: at(3), alerts: [{ id: 'al_1' }, { id: 'al_3' }] });
      const r = await sim.tick();
      expect(r.group).toMatchObject({ merged: 1, opened: 0 });
      expect(await fx.incidents()).toHaveLength(1);
      expect(await sim.incident()).toMatchObject({ memberCount: 3, eventCount: 5, version: inc.version + 1, lastMergedAt: at(3) });
      expect(await sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim']);
    });

    it('two unmapped accounts never share an incident; customers never share one; unmapped → one MSP channel post', async () => {
      const sim = await open();
      await sim.group({ customerId: null, awsAccountId: '999999999999', at: T0, alerts: [{ id: 'al_a' }] });
      await sim.group({ customerId: null, awsAccountId: '888888888888', at: T0, alerts: [{ id: 'al_b' }] });
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_c' }] });
      await sim.group({ customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'al_d' }] });
      await sim.tick();
      const incs = await fx.incidents();
      expect(incs).toHaveLength(4);
      expect(new Set(incs.map((i) => i.axis)).size).toBe(4);
      expect(incs.filter((i) => i.customerId === null).map((i) => i.accountIds).sort()).toEqual([['888888888888'], ['999999999999']]);
      expect(sim.slack.sent.map((m) => m.to)).toEqual(['C_MSP', 'C_MSP', 'C_MSP', 'C_MSP']); // nobody has a call order here
      expect(new Set(incs.map((i) => i.number)).size).toBe(4);
    });

    it('after 6 h a new incident opens instead of merging; the old one stays open but is no merge target', async () => {
      const sim = await open();
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      sim.now = at(6 * 60 + 1);
      await sim.group({ customerId: 'cus_mirae', at: sim.now, alerts: [{ id: 'al_2' }] });
      await sim.tick();
      const [old, fresh] = await fx.incidents();
      expect(old).toMatchObject({ status: 'TRIGGERED', isMergeTarget: false });
      expect(fresh).toMatchObject({ status: 'TRIGGERED', isMergeTarget: true, memberCount: 1 });
      expect((await fx.repo.findMergeTarget(old!.axis))!.id).toBe(fresh!.id);
    });

    it('an ack that lands between read and write is not overwritten by the merge (version guard)', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      const read = await sim.incident();
      const acked = ack(read, 'usr_haeun', at(1))!;
      expect(await fx.repo.commitIncident({ row: { ...acked, nextEscalationAt: scheduleNext(acked, { now: at(1), ...POLICY }) }, expectedVersion: read.version, bump: true, memberEffect: 'ACK' })).not.toBe('CONFLICT');
      // a writer that still holds the row it read before the ack
      expect(await fx.repo.commitIncident({ row: { ...read, memberCount: 9 }, expectedVersion: read.version, bump: true })).toBe('CONFLICT');
      sim.now = at(2);
      await sim.group({ customerId: 'cus_mirae', at: at(2), alerts: [{ id: 'al_2' }] });
      expect((await sim.tick()).group).toMatchObject({ merged: 1 });
      expect(await sim.incident()).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: 'usr_haeun', memberCount: 2 });
    });

    it('commitGroupDelivery: a second delivery of the same group is ALREADY_DELIVERED; a stale group version is a CONFLICT; one merge target per axis', async () => {
      const sim = await open();
      const gid = await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      const g = (await fx.group(gid))!;
      const empty = { groupId: gid, deliveredAt: T0, incident: null, members: [], events: [], jobs: [], finalized: [] };
      expect(await fx.repo.commitGroupDelivery({ ...empty, groupVersion: g.version + 1 })).toBe('CONFLICT');
      expect(await fx.repo.commitGroupDelivery({ ...empty, groupVersion: g.version })).toBe('OK');
      expect(await fx.repo.commitGroupDelivery({ ...empty, groupVersion: g.version })).toBe('ALREADY_DELIVERED');
      expect(await fx.repo.commitGroupDelivery({ ...empty, groupVersion: g.version + 1 })).toBe('ALREADY_DELIVERED');

      // a second CREATE on an axis that already has a merge target loses
      await sim.group({ customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'al_2' }] });
      await sim.tick();
      const target = (await fx.incidents())[0]!;
      const g2 = await sim.group({ customerId: 'cus_hanbit', at: at(1), alerts: [{ id: 'al_3' }] });
      const clash = { ...target, id: `${target.id}-x`, version: 0 };
      expect(await fx.repo.commitGroupDelivery({ groupId: g2, groupVersion: 1, deliveredAt: at(1), incident: { mode: 'CREATE', row: clash, demoteId: null }, members: [], events: [], jobs: [], finalized: [] })).toBe('CONFLICT');
      expect(await fx.repo.commitGroupDelivery({ groupId: g2, groupVersion: 1, deliveredAt: at(1), incident: { mode: 'CREATE', row: target, demoteId: null }, members: [], events: [], jobs: [], finalized: [] })).toBe('CONFLICT');
      expect((await fx.group(g2))!.status).toBe('CLOSED'); // nothing of the failed commit stayed
      expect(await fx.incidents()).toHaveLength(1);
    });

    it('DEFER members: only those still firing enter the incident; an all-cleared group opens nothing', async () => {
      const seed = seedWorld(); seed.policy = { ...seed.policy, autoPauseSec: { SEV_2: 60 } };
      const sim = await open(seed);
      const g1 = await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1', decision: 'DEFER' }, { id: 'al_2', decision: 'DEFER' }] });
      const g2 = await sim.group({ customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'al_3', decision: 'DEFER' }] });
      expect((await sim.tick()).group).toMatchObject({ paused: 2, delivered: 0 });
      await fx.setEpisode('al_2', false);
      await fx.setEpisode('al_3', false);
      sim.now = at(1);
      const r = await sim.tick();
      expect(r.group).toMatchObject({ delivered: 2, opened: 1, empty: 1 });
      const incs = await fx.incidents();
      expect(incs).toHaveLength(1);
      expect(incs[0]).toMatchObject({ customerId: 'cus_mirae', memberCount: 1 });
      expect((await fx.group(g1))!.status).toBe('DELIVERED');
      expect((await fx.group(g2))!.status).toBe('DELIVERED');
    });
  });

  describe('auto-resolve', () => {
    it('resolves when every member has cleared, records the resolution, stops paging; not in the tick that merged a fire', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }, { id: 'al_2' }] });
      await sim.tick();
      await fx.setEpisode('al_1', false);
      sim.now = at(1);
      expect((await sim.tick()).reconcile.resolved).toBe(0); // al_2 still fires
      await fx.setEpisode('al_2', false);
      sim.now = at(2);
      await sim.group({ customerId: 'cus_mirae', at: at(2), alerts: [{ id: 'al_1' }] }); // merged in this very tick
      expect((await sim.tick()).reconcile.resolved).toBe(0);
      sim.now = at(3);
      expect((await sim.tick()).reconcile.resolved).toBe(1);
      const inc = await sim.incident();
      expect(inc).toMatchObject({ status: 'RESOLVED', resolvedVia: 'AUTO', isMergeTarget: false, nextEscalationAt: null, mttrSec: 180 });
      expect(await fx.resolutions()).toMatchObject([{ incidentId: inc.id, via: 'AUTO', kind: 'AUTO', customerId: 'cus_mirae', durationSec: 180 }]);
      await sim.run(30);
      expect(await sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim']);
    });
  });

  describe('tick idempotency: double, overlapping, skipped', () => {
    it('same minute twice → duplicate; nothing is done the second time', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.allAtOnce());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      const again = await runTick({ scheduledAt: new Date(T0.getTime() + 20_000) }, { repo: fx.repo, senders: sim.senders, now: () => sim.now });
      expect(again).toEqual({ skipped: 'duplicate', scheduledAt: '2026-11-09T03:00Z' });
      expect(sim.sms.sent).toHaveLength(3);
      expect(await fx.incidents()).toHaveLength(1);
    });

    it('the same minute run again without the minute guard: no second page, no second event, no second incident', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      for (const m of [0, 0, 10, 10, 10]) {
        sim.now = at(m);
        await fx.clearTickClaims();
        await sim.tick();
      }
      expect(await sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim', '10 VOICE Yuna Seo']);
      expect(sim.allSent()).toHaveLength(2);
      const inc = await sim.incident();
      expect((await fx.events(inc.id)).filter((e) => e.kind === 'NOTIFIED' || e.kind === 'ESCALATED')).toHaveLength(2);
      expect(await fx.incidents()).toHaveLength(1);
    });

    it('two runners in the same minute, at the same time, without the minute guard: every page goes out exactly once', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.allAtOnce(), PATTERNS.customerRotation());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.group({ customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'al_2' }] });
      const other = fx.secondRunner();
      for (const m of [0, 5, 6]) {
        sim.now = at(m);
        const deps = { senders: sim.senders, now: () => sim.now };
        const key = `${m}`;
        await fx.clearTickClaims();
        const a = runTick({ scheduledAt: sim.now }, { repo: fx.repo, ...deps });
        // the second runner's claim of the minute is lost on purpose: it runs as if the guard did not exist
        const b = (async () => { await fx.clearTickClaims(); return runTick({ scheduledAt: new Date(sim.now.getTime() + 1000 * 60 * 1000 + Number(key)) }, { repo: other, ...deps }); })();
        const rs = await Promise.all([a, b]);
        for (const r of rs) if (!('skipped' in r)) expect(r.errors).toEqual([]);
      }
      const sent = sim.allSent();
      const keys = sent.map((m) => m.idempotencyKey);
      expect(new Set(keys).size).toBe(keys.length); // duplicates = 0
      expect(await fx.incidents()).toHaveLength(2);
      const jobs = await fx.jobs();
      expect(jobs.filter((j) => j.status === 'SENT')).toHaveLength(sent.length);
      expect((await fx.logs()).filter((l) => l.status === 'SENT')).toHaveLength(sent.length);
      expect(jobs.length).toBeGreaterThanOrEqual(5);
    });

    it('two overlapping ticks reading the same incident: the version guard lets only one fire the step', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      sim.now = at(10);
      const [due] = await fx.repo.listEscalationDue(sim.now, 10);
      const patch = { escalationStep: 2, escalationBaseAt: sim.now };
      const first = await fx.repo.commitIncident({ row: { ...due!, ...patch }, expectedVersion: due!.version, bump: true });
      const second = await fx.secondRunner().commitIncident({ row: { ...due!, ...patch }, expectedVersion: due!.version, bump: true });
      expect(first).not.toBe('CONFLICT');
      expect(second).toBe('CONFLICT');
      expect((await sim.incident()).version).toBe(due!.version + 1);
    });

    it('bookkeeping writes (bump: false) are version-guarded but do not move the version', async () => {
      const sim = await open();
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      const inc = await sim.incident();
      const saved = await fx.repo.commitIncident({ row: { ...inc, nextEscalationAt: at(7) }, expectedVersion: inc.version, bump: false });
      expect(saved).toMatchObject({ version: inc.version, nextEscalationAt: at(7), number: inc.number });
      expect(await fx.repo.commitIncident({ row: inc, expectedVersion: inc.version + 1, bump: false })).toBe('CONFLICT');
    });

    it('skipped minutes: catches up one step per tick, never two steps at once, never the same step twice', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.templateStandard());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      await sim.run(40, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]); // the tick was down for 13 minutes
      const tl = await sim.timeline();
      const minutes = tl.map((l) => Number(l.split(' ')[0]));
      expect(tl.slice(0, 2).map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual(['0 SLACK_BOT', '14 SMS']);
      const perMinute = new Map<number, Set<string>>();
      for (const j of await fx.jobs()) {
        const m = Math.round((j.createdAt.getTime() - T0.getTime()) / 60_000);
        perMinute.set(m, (perMinute.get(m) ?? new Set()).add(`${j.repeat}:${j.stepIndex}`));
      }
      for (const steps of perMinute.values()) expect(steps.size).toBe(1); // one step per tick
      const keys = (await fx.jobs()).map((j) => j.idempotencyKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
    });

    it('escalation timeline of the sample call order: rotation, then the customer person at 10 min, repeated once, then done', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      await sim.run(60);
      expect(await sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim', '10 VOICE Yuna Seo', '20 SLACK_DM Haeun Kim', '30 VOICE Yuna Seo']);
      const inc = await sim.incident();
      expect(inc).toMatchObject({ status: 'TRIGGERED', escalationRepeat: 1, nextEscalationAt: null });
      expect(inc.escalationDoneAt).not.toBeNull();
      expect(sim.allSent()).toHaveLength(4);
    });

    it('bounded batch: at most `batch` incidents per tick, the rest next tick, nobody skipped or paged twice', async () => {
      const sim = await open(tenantSeed(7));
      const deps = { repo: fx.repo, senders: sim.senders, now: () => sim.now, batch: 3 };
      const seen: number[] = [];
      for (let m = 0; m < 4; m++) {
        sim.now = at(m);
        const r = await runTick({ scheduledAt: sim.now }, deps) as TickSummary;
        seen.push(r.group.opened);
      }
      expect(seen).toEqual([3, 3, 1, 0]);
      expect(sim.sms.sent).toHaveLength(7);
      expect(new Set(sim.sms.sent.map((m) => m.customerId)).size).toBe(7);
    });

    it('heartbeats: one row per phase, consecutiveFailures counts and resets, stale after 3 minutes', async () => {
      const sim = await open();
      await sim.tick();
      const rows = await fx.repo.readHeartbeats();
      expect(rows.map((r) => r.name).sort()).toEqual(['escalation', 'group', 'notify', 'reconcile']);
      expect(rows.every((r) => r.lastStatus === 'OK' && r.consecutiveFailures === 0 && r.lastFinishedAt!.getTime() === T0.getTime())).toBe(true);
      expect(heartbeatHealth(rows, at(2)).ok).toBe(true);
      expect(heartbeatHealth(rows, at(4)).stale).toBe(true);
      const hb = { name: 'notify' as const, lastStartedAt: at(1), lastFinishedAt: at(1), lastDurationMs: 12.4, lastStats: { sent: 1 } };
      await fx.repo.writeHeartbeat({ ...hb, lastStatus: 'ERROR' });
      await fx.repo.writeHeartbeat({ ...hb, lastStatus: 'DEGRADED' });
      const notify = async () => (await fx.repo.readHeartbeats()).find((r) => r.name === 'notify')!;
      expect(await notify()).toMatchObject({ lastStatus: 'DEGRADED', consecutiveFailures: 2, lastStats: { sent: 1 } });
      expect(heartbeatHealth(await fx.repo.readHeartbeats(), at(1)).degraded).toBe(true);
      await fx.repo.writeHeartbeat({ ...hb, lastStatus: 'OK' });
      expect((await notify()).consecutiveFailures).toBe(0);
    });

    it('claimTick: a minute is claimed once, by whichever runner asks first; other minutes are independent', async () => {
      const sim = await open();
      sim.now = at(7);
      const other = fx.secondRunner();
      const both = await Promise.all([fx.repo.claimTick('2026-11-09T03:07Z', at(7)), other.claimTick('2026-11-09T03:07Z', at(7))]);
      expect(both.filter((x) => x === true)).toHaveLength(1);
      expect(both.filter((x) => x === false)).toHaveLength(1);
      expect(await fx.repo.claimTick('2026-11-09T03:07Z', at(7))).toBe(false);
      expect(await fx.repo.claimTick('2026-11-09T03:06Z', at(7))).toBe(true); // an earlier minute that arrives late still runs once
      expect(await fx.repo.claimTick('2026-11-09T03:08Z', at(7, 25))).toBe(true); // 25 s apart: inside the skew limit
      // R-2: the caller's clock more than 30 s from the store's → no claim, and the minute stays free
      expect(await fx.repo.claimTick('2026-11-09T03:09Z', at(9))).toBe('CLOCK_SKEW');
      expect(await fx.repo.claimTick('2026-11-09T03:09Z', at(6))).toBe('CLOCK_SKEW');
      expect(await fx.repo.claimTick('2026-11-09T03:09Z', at(7))).toBe(true);
      expect((await fx.repo.now())?.getTime()).toBe(at(7).getTime());
    });
  });

  describe('ack, undo, re-notify', () => {
    it('ack stops paging and acknowledges the member alerts; undo continues from the step where it stopped and restores only the cancelled page', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      sim.slack.failNext(1, { retryable: true }); // the first page is still retrying when the ack lands
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }, { id: 'al_2' }] });
      await sim.tick();
      const inc = await sim.incident();
      const acked = ack(inc, 'usr_haeun', at(0, 20))!;
      const saved = await fx.repo.commitIncident({ row: { ...acked, nextEscalationAt: scheduleNext(acked, { now: at(0, 20), ...POLICY }) }, expectedVersion: inc.version, bump: true, memberEffect: 'ACK',
        audit: { at: at(0, 20), customerId: inc.customerId, actorType: 'USER', actorId: 'usr_haeun', action: 'incident.ack', targetType: 'Incident', targetId: inc.id, before: { status: 'TRIGGERED' }, after: { status: 'ACKNOWLEDGED' }, requestId: 'req_1' } }) as IncidentRow;
      expect(saved.status).toBe('ACKNOWLEDGED');
      expect(await fx.alertAcked('al_1')).toBe(true);
      expect(await fx.alertAcked('al_2')).toBe(true);
      expect(await fx.audits()).toMatchObject([{ action: 'incident.ack', actorId: 'usr_haeun', targetId: inc.id, requestId: 'req_1' }]);
      await sim.run(12);
      expect(sim.allSent()).toHaveLength(0);
      const [page] = await fx.jobs(inc.id);
      expect(page).toMatchObject({ status: 'SKIPPED', lastError: 'acknowledged', attempts: 1 });
      expect(await sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim']); // step 2 at 10 min did not fire

      sim.now = at(12, 30); // the undo happens 30 s after the last tick, by the store's clock too
      const cur = await sim.incident();
      const back = unack(cur)!;
      const undone = await fx.repo.commitIncident({ row: { ...back, nextEscalationAt: scheduleNext(back, { now: at(12, 30), ...POLICY }) }, expectedVersion: cur.version, bump: true, memberEffect: 'UNACK',
        restoreAckSkipped: { stepIndex: 0, repeat: 0, at: at(12, 30) } });
      expect(undone).not.toBe('CONFLICT');
      expect(await fx.alertAcked('al_1')).toBe(false);
      expect((await fx.jobs(inc.id))[0]).toMatchObject({ status: 'QUEUED', lastError: null, dueAt: at(12, 30), nextAttemptAt: at(12, 30), attempts: 1 });
      sim.now = at(12);
      await sim.run(40);
      expect(await sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim', '13 VOICE Yuna Seo', '23 SLACK_DM Haeun Kim', '33 VOICE Yuna Seo']);
      expect(sim.slack.sent.map((m) => m.idempotencyKey)).toHaveLength(2); // the restored page and the repeat, each once
    });

    it('acknowledged and still unresolved: one reminder per period to the first step', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      const inc = await sim.incident();
      const acked = ack(inc, 'usr_haeun', at(1))!;
      await fx.repo.commitIncident({ row: { ...acked, nextEscalationAt: scheduleNext(acked, { now: at(1), ...POLICY }) }, expectedVersion: inc.version, bump: true, memberEffect: 'ACK' });
      await sim.run(125);
      const reminders = (await fx.jobs(inc.id)).filter((j) => j.purpose === 'RENOTIFY');
      expect(reminders.map((j) => Math.round((j.createdAt.getTime() - T0.getTime()) / 60_000))).toEqual([61, 121]);
      expect(await sim.incident()).toMatchObject({ renotifyCount: 2, status: 'ACKNOWLEDGED' });
    });
  });

  describe('maintenance windows', () => {
    const win = { id: 'mw_1', customerId: 'cus_mirae', scopeType: 'CUSTOMER' as const, scopeId: 'cus_mirae', startsAt: at(5), endsAt: at(20) };

    it('SEV-2: no step fires during the window, one delayed step right after; SEV-1 keeps paging', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      await fx.addWindow(win);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.group({ customerId: 'cus_mirae', severity: 'SEV_1', at: T0, alerts: [{ id: 'al_2', severity: 'SEV_1' }] });
      await sim.tick();
      await sim.run(22);
      const incs = await fx.incidents(); // two groups opened in the same instant: which incident comes first is the store's business
      const sev2 = incs.find((i) => i.severity === 'SEV_2'); const sev1 = incs.find((i) => i.severity === 'SEV_1');
      expect(await sim.timeline(sev2!.id)).toEqual(['0 SLACK_DM Haeun Kim', '20 VOICE Yuna Seo']);
      expect(await sim.timeline(sev1!.id)).toEqual(['0 SLACK_DM Haeun Kim', '10 VOICE Yuna Seo', '20 SLACK_DM Haeun Kim']);
    });

    it('a page that waited into a window is held (not dropped, no attempt counted), said once on the timeline, and sent when the window ends', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      sim.slack.failNext(1, { retryable: true });
      await fx.addWindow({ ...win, startsAt: at(0, 10), endsAt: at(9) });
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick(); // first try fails, retry due at 00:30 — inside the window
      const inc = await sim.incident();
      sim.now = at(1);
      const r = await sim.tick();
      expect(r.notify).toMatchObject({ deferred: 1, sent: 0 });
      expect((await fx.jobs(inc.id))[0]).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'deferred_by_maintenance', dueAt: at(6), nextAttemptAt: at(6) });
      await sim.run(8);
      expect(sim.slack.sent).toHaveLength(0);
      expect((await fx.events(inc.id)).filter((e) => e.data?.note === 'DEFERRED_MAINTENANCE')).toHaveLength(1);
      await sim.run(10);
      expect(sim.slack.sent).toHaveLength(1);
      expect((await fx.jobs(inc.id))[0]).toMatchObject({ status: 'SENT', attempts: 2 });
    });

    it('a revoked window and another customer’s window do not hold anything', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      await fx.addWindow({ ...win, startsAt: at(-1), endsAt: at(30) });
      await fx.addWindow({ ...win, id: 'mw_2', customerId: 'cus_hanbit', scopeId: 'cus_hanbit', startsAt: at(-1), endsAt: at(30) });
      await fx.revokeWindow('mw_1', at(-1, 30));
      expect((await fx.repo.maintenanceWindows('cus_mirae', T0)).map((w) => w.id)).toEqual([]);
      expect((await fx.repo.maintenanceWindows('cus_hanbit', T0)).map((w) => w.id)).toEqual(['mw_2']);
      expect(await fx.repo.maintenanceWindows(null, T0)).toEqual([]);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      await sim.run(11);
      expect(await sim.timeline()).toEqual(['0 SLACK_DM Haeun Kim', '10 VOICE Yuna Seo']);
    });
  });

  describe('send caps', () => {
    it('an ALL_RESPONDERS step reaches at most 20 people; the cut is written to the timeline at open', async () => {
      const seed = seedWorld();
      for (let i = 0; i < 26; i++) {
        const id = `ct_x${String(i).padStart(2, '0')}`;
        seed.contacts.set(id, { id, kind: 'INTERNAL', customerId: null, name: `X${i}`, active: true, phone: `+8210777${String(i).padStart(5, '0')}`, phoneVerifiedAt: V });
        seed.responders.push({ customerId: 'cus_hanbit', contactId: id, role: 'PAGEABLE' });
      }
      seed.configs.push(config('cus_hanbit', [step(0, 0, 'ALL_RESPONDERS', null, ['SMS'])], { repeatCount: 0 }));
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      const inc = await sim.incident();
      const jobs = await fx.jobs(inc.id);
      expect(jobs).toHaveLength(MAX_ALL_RESPONDERS);
      expect(sim.sms.sent).toHaveLength(MAX_ALL_RESPONDERS);
      expect((await fx.events(inc.id)).filter((e) => e.data?.note === 'SEND_CAP_CLAMPED')).toHaveLength(1);
      expect(inc.assignmentSnapshot?.clamped).toBeTruthy();
    });

    it('re-notify stops at the cap and the same page key is never queued twice (outbox uniqueness)', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      const inc = await sim.incident();
      const [page] = await fx.jobs(inc.id);
      const again = { ...page!, payload: { ...page!.payload, text: 'changed' } };
      const r = await fx.repo.commitIncident({ row: inc, expectedVersion: inc.version, bump: false, jobs: [again], events: [{ incidentId: inc.id, customerId: inc.customerId, at: at(1), kind: 'NOTE', actorType: 'SYSTEM', actorId: null, message: 'x' }] });
      expect(r).not.toBe('CONFLICT');
      const jobs = await fx.jobs(inc.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ status: 'SENT', payload: page!.payload });
    });
  });

  describe('outbox: claims, leases, clock', () => {
    const lane = (kinds: Array<'SMS' | 'VOICE' | 'SLACK' | 'EMAIL'> = ['SMS']) => ({ kinds });

    it('the claim order is selectForClaim: round-robin over customers, SEV-1 first, never-attempted before retries, dueAt, a share for the oldest non-SEV-1', async () => {
      const n = 9;
      const sim = await open(tenantSeed(n));
      const base = await openTenants(sim, n);
      // a deterministic mix: per tenant 0–11 pages, some SEV-3, some already attempted, due at different times, a few not due yet
      let u = 7;
      const rnd = (k: number): number => { u = (u * 1103515245 + 12345) % 2147483648; return u % k; };
      const all: NotificationJob[] = [];
      for (let i = 0; i < n; i++) {
        const count = 2 + rnd(10);
        for (let k = 0; k < count; k++) {
          const sev = rnd(4) === 0 ? 'SEV_3' : 'SEV_1';
          const due = at(rnd(6) === 0 ? 9 : 0, 10 + rnd(40));
          const j = pageOf(base.get(i)!, `p${k}`, due, { attempts: rnd(5) === 0 ? 1 + rnd(3) : 0, createdAt: at(0, rnd(10)), payload: { ...base.get(i)!.payload, severity: sev as Severity } });
          all.push(j);
          await fx.putJob(j);
        }
      }
      sim.now = at(2);
      for (const limit of [4, 5, 10, 23, 200]) {
        const due = all.filter((j) => j.nextAttemptAt.getTime() <= sim.now.getTime());
        const expected = selectForClaim(due, limit).map((j) => j.idempotencyKey);
        const got = await fx.repo.claimDueJobs(limit, lane());
        expect(got.map((j) => j.idempotencyKey), `limit ${limit}`).toEqual(expected);
        expect(got.every((j) => j.status === 'SENDING' && j.claimSeq >= 1 && j.nextAttemptAt.getTime() === sim.now.getTime() + CLAIM_LEASE_SEC * 1000)).toBe(true);
        // hand everything back untouched: the next round sees the same queue (a release keeps the original due time)
        for (const j of got) expect(await fx.repo.releaseJob(j.id, j.claimSeq)).toBe(true);
        const after = new Map((await fx.jobs()).map((j) => [j.idempotencyKey, j]));
        for (const j of got) expect(after.get(j.idempotencyKey)).toMatchObject({ status: 'QUEUED', attempts: all.find((x) => x.idempotencyKey === j.idempotencyKey)!.attempts, dueAt: j.dueAt, nextAttemptAt: j.dueAt });
      }
      expect(all.length).toBeGreaterThan(30);
    });

    it('a claim takes only its lane; other lanes’ pages stay', async () => {
      const sim = await open(tenantSeed(2));
      const base = await openTenants(sim, 2);
      await fx.putJob(pageOf(base.get(0)!, 'sms', at(0, 30)));
      await fx.putJob(pageOf(base.get(1)!, 'voice', at(0, 30), { channel: 'VOICE' }));
      await fx.putJob(pageOf(base.get(1)!, 'dm', at(0, 30), { channel: 'SLACK_DM' }));
      sim.now = at(1);
      expect((await fx.repo.claimDueJobs(50, lane(['VOICE']))).map((j) => j.channel)).toEqual(['VOICE']);
      expect((await fx.repo.claimDueJobs(50, lane(['SLACK']))).map((j) => j.channel)).toEqual(['SLACK_DM']);
      expect((await fx.repo.claimDueJobs(50, lane(['EMAIL'])))).toEqual([]);
      expect((await fx.repo.claimDueJobs(50)).map((j) => j.channel)).toEqual(['SMS']);
    });

    it('claim token: after the lease another runner takes the job; the first runner can no longer begin, release or complete it', async () => {
      const sim = await open(tenantSeed(1));
      const base = await openTenants(sim, 1);
      await fx.putJob(pageOf(base.get(0)!, 'a', at(0, 30)));
      sim.now = at(1);
      const [mine] = await fx.repo.claimDueJobs(50, lane());
      expect(await fx.repo.claimDueJobs(50, lane())).toEqual([]); // leased
      sim.now = new Date(at(1).getTime() + CLAIM_LEASE_SEC * 1000 - 1);
      expect(await fx.secondRunner().claimDueJobs(50, lane())).toEqual([]);
      sim.now = new Date(at(1).getTime() + CLAIM_LEASE_SEC * 1000);
      const [theirs] = await fx.secondRunner().claimDueJobs(50, lane());
      expect(theirs).toMatchObject({ id: mine!.id, claimSeq: mine!.claimSeq + 1, attempts: 0, dueAt: at(0, 30) });
      expect(await fx.repo.beginSend(mine!.id, mine!.claimSeq)).toBeNull();
      expect(await fx.repo.releaseJob(mine!.id, mine!.claimSeq)).toBe(false);
      expect(await fx.repo.completeJob(mine!.id, mine!.claimSeq, { status: 'SENT', providerMessageId: 'late' })).toBe(false);
      expect(await fx.repo.beginSend(theirs!.id, theirs!.claimSeq)).toBe(1);
      expect(await fx.repo.completeJob(theirs!.id, theirs!.claimSeq, { status: 'SENT', providerMessageId: 'p-1' })).toBe(true);
      // a SENT job never goes back
      expect(await fx.repo.completeJob(theirs!.id, theirs!.claimSeq, { status: 'QUEUED', error: 'x' })).toBe(false);
      expect((await fx.jobs()).find((j) => j.id === mine!.id)).toMatchObject({ status: 'SENT', providerMessageId: 'p-1', attempts: 1, lastError: null });
      expect(await fx.logs()).toEqual([]);
    });

    it('beginSend counts the attempt and writes the retry time from the STORE clock: 30 s, 1, 2, 5, 10 min; the 5th unfinished send is given up on the record', async () => {
      const sim = await open(tenantSeed(1));
      const base = await openTenants(sim, 1);
      const page = pageOf(base.get(0)!, 'a', at(0, 30));
      await fx.putJob(page);
      sim.now = at(1);
      for (let n = 1; n <= MAX_ATTEMPTS; n++) {
        const [j] = await fx.repo.claimDueJobs(50, lane());
        expect(j, `attempt ${n}`).toBeTruthy();
        const t = sim.now;
        expect(await fx.repo.beginSend(j!.id, j!.claimSeq)).toBe(n);
        const due = new Date(t.getTime() + RETRY_DELAYS_SEC[n - 1]! * 1000);
        expect((await fx.jobs()).find((x) => x.id === j!.id)).toMatchObject({ status: 'SENDING', attempts: n, nextAttemptAt: due, dueAt: due });
        // the process dies here: nothing is written; the job comes back when nextAttemptAt passes
        sim.now = new Date(due.getTime() - 1);
        expect(await fx.repo.claimDueJobs(50, lane())).toEqual([]);
        sim.now = due;
      }
      expect(await fx.repo.claimDueJobs(50, lane())).toEqual([]); // given up, not handed out again
      const after = (await fx.jobs()).find((x) => x.idempotencyKey === page.idempotencyKey)!;
      expect(after).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS, lastError: 'gave up after a send that never finished' });
      expect(await fx.logs()).toMatchObject([{ jobId: after.id, status: 'FAILED', errorCode: 'GAVE_UP', attempt: MAX_ATTEMPTS, targetKind: 'STAFF', contactId: 'ct_t0', targetSummary: 'P0', at: sim.now, customerId: 'cus_t0', warnings: [] }]);
      expect(await fx.repo.claimDueJobs(50, lane())).toEqual([]);
      expect(await fx.logs()).toHaveLength(1);
    });

    it('R-14 / R-2: the runner’s clock does not decide. 20 s ahead or behind: the tick runs on the store’s time; an hour (or 3 days) off: the tick does nothing and says so', async () => {
      const sim = await open(tenantSeed(2));
      const base = await openTenants(sim, 2);
      await fx.putJob(pageOf(base.get(0)!, 'a', at(0, 30)));
      await fx.putJob(pageOf(base.get(1)!, 'future', at(1, 15)));
      sim.now = at(1); // the store's clock
      const off = (ms: number) => () => new Date(at(1).getTime() + ms);
      // far off, both ways: nothing runs, nothing is claimed, the heartbeat says ERROR and has no finish time (→ stale)
      for (const ms of [3_600_000, -3_600_000, 10 * 60_000, -10 * 60_000, 3 * 86_400_000]) {
        const r = await runTick({ scheduledAt: off(ms)(), jobs: ['notify'] }, { repo: fx.repo, senders: sim.senders, now: off(ms) });
        expect(r, `${ms}`).toMatchObject({ skipped: 'clock-skew' });
        expect(Math.abs((r as { clockSkewMs: number }).clockSkewMs - ms), `${ms}`).toBeLessThan(1500);
        const hb = (await fx.repo.readHeartbeats()).find((h) => h.name === 'notify')!;
        expect(hb, `${ms}`).toMatchObject({ lastStatus: 'ERROR', lastFinishedAt: null, lastStats: { skipped: 'clock-skew' } });
        expect(heartbeatHealth(await fx.repo.readHeartbeats(), sim.now, { jobs: ['notify'] }).stale).toBe(true);
        // the store says the same to a caller that did not ask first
        expect(await fx.repo.claimTick('2026-11-09T03:01Z', off(ms)())).toBe('CLOCK_SKEW');
      }
      expect(sim.sms.sent).toHaveLength(0);
      expect((await fx.jobs()).filter((j) => j.claimSeq > 0)).toHaveLength(0);
      // 20 s ahead: inside the limit. The 01:15 page is "due" for the runner but not for the store → not sent.
      const r1 = await runTick({ scheduledAt: at(1), jobs: ['notify'] }, { repo: fx.repo, senders: sim.senders, now: off(20_000) }) as TickSummary;
      expect(r1.notify.sent).toBe(1);
      expect(sim.sms.sent).toHaveLength(1);
      const [future] = (await fx.jobs()).filter((j) => j.idempotencyKey.endsWith('#future'));
      expect(future).toMatchObject({ status: 'QUEUED', claimSeq: 0 });
      // 20 s behind, store at 01:20: the page is due for the store → sent, although the runner thinks it is 01:00
      sim.now = at(1, 20);
      await fx.clearTickClaims();
      const r2 = await runTick({ scheduledAt: at(1), jobs: ['notify'] }, { repo: fx.repo, senders: sim.senders, now: () => at(1) }) as TickSummary;
      expect(r2.notify.sent).toBe(1);
      expect((await fx.repo.readHeartbeats()).find((h) => h.name === 'notify')).toMatchObject({ lastStatus: 'OK', lastFinishedAt: at(1, 20) });
    });

    it('completeJob writes the result, the delivery log and the timeline event together; provider text is masked', async () => {
      const sim = await open(tenantSeed(1));
      const base = await openTenants(sim, 1);
      await fx.putJob(pageOf(base.get(0)!, 'a', at(0, 30)));
      sim.now = at(1);
      sim.sms.failNext(1, { retryable: false, error: 'rejected: number +82 10-1234-5678 token=abc123456789 is blocked' });
      const r = await sim.tick(['notify']);
      expect(r.notify).toMatchObject({ failed: 1 });
      const [j] = (await fx.jobs()).filter((x) => x.idempotencyKey.endsWith('#a'));
      expect(j).toMatchObject({ status: 'FAILED', attempts: 1 });
      expect(j!.lastError).not.toMatch(/1234|abc123/);
      const logs = await fx.logs();
      expect(logs).toMatchObject([{ jobId: j!.id, status: 'FAILED', errorCode: 'PROVIDER_REJECTED', attempt: 1, incidentId: j!.incidentId, channel: 'SMS', targetKind: 'CUSTOMER_PERSON', contactId: 'ct_t0', escalationStep: 0, at: at(1) }]);
      expect(logs[0]!.error).not.toMatch(/1234|abc123/);
    });

    it('an unverified phone number is skipped with one timeline line and no delivery log; a recipient of another tenant is never called', async () => {
      const sim = await open(tenantSeed(2));
      const base = await openTenants(sim, 2);
      await fx.patchContact('ct_t0', { phoneVerifiedAt: null });
      await fx.putJob(pageOf(base.get(0)!, 'unverified', at(0, 30)));
      await fx.putJob(pageOf(base.get(1)!, 'foreign', at(0, 30), { contactId: 'ct_t0', targetRef: 'ct_t0' })); // tenant 1's page pointing at tenant 0's person
      sim.now = at(1);
      const r = await sim.tick(['notify']);
      expect(r.notify).toMatchObject({ skipped: 2, sent: 0 });
      expect(sim.sms.attempts).toHaveLength(0);
      const jobs = await fx.jobs();
      expect(jobs.find((j) => j.idempotencyKey.endsWith('#unverified'))).toMatchObject({ status: 'SKIPPED', lastError: 'unverified', attempts: 0 });
      expect(jobs.find((j) => j.idempotencyKey.endsWith('#foreign'))).toMatchObject({ status: 'SKIPPED', lastError: 'tenant_mismatch', attempts: 0 });
      expect(r.errors.map((e) => e.message)).toEqual(['recipient does not belong to the incident customer; not sent']);
      expect(await fx.logs()).toEqual([]);
      const inc0 = (await fx.incidents()).find((i) => i.customerId === 'cus_t0')!;
      expect((await fx.events(inc0.id)).filter((e) => e.data?.note === 'SKIPPED_UNVERIFIED')).toHaveLength(1);
    });

    it('Slack destinations: the customer’s own channel when it has one, else the MSP channel; never another customer’s', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.templateStandard(), config('cus_hanbit', [step(0, 0, 'ROTATION', 'rot_hanbit', ['SLACK_CHANNEL'])], { repeatCount: 0 }));
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.group({ customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'al_2' }] });
      await sim.tick();
      expect(sim.slack.sent.map((m) => `${m.customerId} ${m.to}`).sort()).toEqual(['cus_hanbit C_MSP', 'cus_mirae C_MIRAE']);
      expect((await fx.logs()).map((l) => l.targetKind).sort()).toEqual(['CUSTOMER_CHANNEL', 'MSP_CHANNEL']);
    });

    it('outboxBacklog counts what is due and was never attempted (store clock); stepAllFailed sees a step whose pages all failed', async () => {
      const sim = await open(tenantSeed(2));
      const base = await openTenants(sim, 2);
      await fx.putJob(pageOf(base.get(0)!, 'a', at(0, 30)));
      await fx.putJob(pageOf(base.get(0)!, 'b', at(0, 40), { payload: { ...base.get(0)!.payload, severity: 'SEV_3' } }));
      await fx.putJob(pageOf(base.get(1)!, 'tried', at(0, 20), { attempts: 1 }));
      await fx.putJob(pageOf(base.get(1)!, 'later', at(5)));
      sim.now = at(1);
      expect(await fx.repo.outboxBacklog()).toEqual({ dueUnattempted: 2, dueSev1Unattempted: 1, oldestDueAt: at(0, 30) });
      sim.now = at(6);
      expect(await fx.repo.outboxBacklog()).toMatchObject({ dueUnattempted: 3, dueSev1Unattempted: 2 });
      const inc = (await fx.incidents()).find((i) => i.customerId === 'cus_t0')!;
      expect(await fx.repo.stepAllFailed(inc.id, 0, 0)).toBe(false); // the template page is SENT
      for (const j of await fx.jobs(inc.id)) await fx.patchJob(j.idempotencyKey, { status: j.idempotencyKey.endsWith('#a') ? 'SKIPPED' : 'FAILED' });
      expect(await fx.repo.stepAllFailed(inc.id, 0, 0)).toBe(true);
      expect(await fx.repo.stepAllFailed(inc.id, 3, 0)).toBe(false); // a step without pages
    });

    it('two runners claiming at once never get the same job, and together never more than what is due', async () => {
      const n = 6;
      const sim = await open(tenantSeed(n));
      const base = await openTenants(sim, n);
      for (let i = 0; i < n; i++) for (let k = 0; k < 20; k++) await fx.putJob(pageOf(base.get(i)!, `k${k}`, at(0, 30)));
      sim.now = at(1);
      const runners = [fx.repo, fx.secondRunner(), fx.secondRunner(), fx.secondRunner()];
      const seen = new Map<string, number>();
      for (let round = 0; round < 4; round++) {
        const claims = await Promise.all(runners.map((r) => r.claimDueJobs(25, lane())));
        for (const c of claims) for (const j of c) seen.set(j.id, (seen.get(j.id) ?? 0) + 1);
        expect(claims.flat().length).toBeLessThanOrEqual(100);
      }
      expect([...seen.values()].filter((v) => v > 1)).toEqual([]); // no double claim
      expect(seen.size).toBe(120); // and nothing was left behind after four rounds
      expect((await fx.jobs()).filter((j) => j.status === 'SENDING' && j.claimSeq !== 1)).toEqual([]);
    });

    it('two runners draining the same outbox at once: every page reaches the provider exactly once', async () => {
      const n = 5;
      const sim = await open(tenantSeed(n));
      const base = await openTenants(sim, n);
      for (let i = 0; i < n; i++) for (let k = 0; k < 12; k++) await fx.putJob(pageOf(base.get(i)!, `k${k}`, at(0, 30)));
      const other = fx.secondRunner();
      for (let m = 1; m <= 3; m++) {
        sim.now = at(m);
        await Promise.all([fx.repo, other, fx.secondRunner()].map((repo, i) => runTick({ scheduledAt: new Date(sim.now.getTime() + i * 3_600_000), jobs: ['notify'] }, { repo, senders: sim.senders, now: () => sim.now })));
      }
      const keys = sim.sms.sent.map((m) => m.idempotencyKey);
      expect(keys).toHaveLength(60);
      expect(new Set(keys).size).toBe(60);
      expect((await fx.logs()).filter((l) => l.status === 'SENT')).toHaveLength(60);
      expect((await fx.jobs()).filter((j) => j.status !== 'SENT')).toEqual([]);
    });
  });

  describe('tenant isolation inside the store', () => {
    it('pagingContext hands out only this customer’s people, responders, rotations and call orders (plus MSP staff and shared rotations)', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.templateStandard(), PATTERNS.customerRotation());
      seed.leaves.push({ contactId: 'ct_haeun', replacementId: 'ct_junho', startDate: '2026-11-09', endDate: '2026-11-10' });
      seed.overrides.push({ rotationId: 'rot_hanbit', contactId: 'ct_sora', startAt: at(-10), endAt: at(600), status: 'ACCEPTED' });
      await open(seed);
      const m = await fx.repo.pagingContext('cus_mirae');
      expect(m.configs.map((c) => c.id)).toEqual(['pc_cus_mirae_CUSTOMER']);
      expect(m.configs[0]!.steps.map((s) => [s.index, s.atMin, s.targetType, s.targetId, s.channels])).toEqual(PATTERNS.templateStandard().steps.map((s) => [s.index, s.atMin, s.targetType, s.targetId, s.channels]));
      expect([...m.world.contacts.keys()].sort()).toEqual(['ct_haeun', 'ct_junho', 'ct_minjae', 'ct_seojun', 'ct_yuna']);
      expect(m.world.responders.map((r) => `${r.contactId}:${r.role}`).sort()).toEqual(['ct_haeun:PAGEABLE', 'ct_junho:PAGEABLE', 'ct_seojun:NOTIFY_ONLY', 'ct_yuna:PAGEABLE']);
      expect([...m.world.rotations.keys()]).toEqual(['rot_night']);
      expect(m.world.overrides).toEqual([]);
      expect(m.world.leaves.filter((l) => l.contactId === 'ct_haeun')).toMatchObject([{ replacementId: 'ct_junho', startDate: '2026-11-09', endDate: '2026-11-10' }]);
      const h = await fx.repo.pagingContext('cus_hanbit');
      expect([...h.world.rotations.keys()].sort()).toEqual(['rot_hanbit', 'rot_night']);
      expect(h.world.rotations.get('rot_hanbit')!.members).toEqual([{ contactId: 'ct_dohyun', order: 0 }, { contactId: 'ct_sora', order: 1 }]);
      expect(h.world.overrides).toMatchObject([{ rotationId: 'rot_hanbit', contactId: 'ct_sora', status: 'ACCEPTED', startAt: at(-10) }]);
      expect([...h.world.contacts.keys()]).not.toContain('ct_yuna');
      expect((await fx.repo.pagingContext('cus_nobody')).configs).toEqual([]);
    });

    it('orgForAccount answers only for the customer that owns the account', async () => {
      await open();
      expect(await fx.repo.orgForAccount('cus_mirae', '111111111111')).toEqual({ projectId: 'prj_core', serviceId: 'svc_pay' });
      expect(await fx.repo.orgForAccount('cus_hanbit', '111111111111')).toBeNull();
      expect(await fx.repo.orgForAccount('cus_mirae', '999999999999')).toBeNull();
    });

    it('a person removed or deactivated after the incident opened is not paged (addresses are read at send time)', async () => {
      const seed = seedWorld(); seed.configs.push(PATTERNS.rotationThenCustomer());
      const sim = await open(seed);
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.tick();
      await fx.patchContact('ct_yuna', { active: false });
      await sim.run(11);
      expect(sim.voice.attempts).toHaveLength(0);
      expect((await fx.jobs()).find((j) => j.channel === 'VOICE')).toMatchObject({ status: 'SKIPPED', lastError: 'contact_inactive' });
      const c = await fx.repo.getContact('ct_yuna') as Contact;
      expect(c).toMatchObject({ id: 'ct_yuna', active: false, kind: 'CUSTOMER', customerId: 'cus_mirae', phoneVerifiedAt: V });
      expect(await fx.repo.getContact('ct_nobody')).toBeNull();
    });
  });
}
