/**
 * Regression tests for the fourth security review (core, everything but the lanes):
 * N-33 time guards around the four store calls outside the phases, R-19 residuals (who is cut is said exactly),
 * N-37 `order: NaN`, R-20 sanitiser additions and the STORE_PROVIDER_TEXT switch.
 * The lanes (R-22) are in security-review-4.lanes.test.ts and security-review-4.baseline.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakeSender, MAX_ALL_RESPONDERS, MAX_SENDS_PER_CYCLE, MemoryTickStore, PROVIDER_EXCERPT_MAX_CHARS, STORE_CALL_TIMEOUT_MS, TICK_RESPONSE_LIMIT_MS,
  allResponders, buildSnapshot, clampMessage, heartbeatHealth, loadPolicyFlags, onCallAt, orderKey, providerText, resolveStep, runTick, sanitizeProviderError,
  type EscalationStep, type OutboundMessage, type Responder, type SendResult, type StepChannel, type TickSummary,
} from '../src/index.js';
import { tenants } from './lane-world.js';
import { Sim, T0, at, closedGroup, config, on, seedWorld, step } from './world.js';

const V = new Date('2026-10-01T00:00:00Z');
afterEach(() => { vi.useRealTimers(); });

// ───────────────────────────── N-33 ─────────────────────────────

describe('N-33: runTick answers within 60 s whatever the store does', () => {
  const never = (): Promise<never> => new Promise<never>(() => undefined);
  const now = (): Date => new Date(Date.now());
  /** One tenant with `pages` SEV-1 voice pages due; returns the running tick after 120 simulated seconds. */
  async function run(patch: (s: MemoryTickStore) => void, opts: { pages?: number; sender?: { send(m: OutboundMessage): Promise<SendResult> }; jobs?: Array<'group' | 'reconcile' | 'escalation' | 'notify'> } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { store, inject } = await tenants(1, () => 'VOICE');
    inject(0, opts.pages ?? 3);
    patch(store);
    const voice = opts.sender ?? new FakeSender('voice');
    let settled = false;
    const p = (runTick({ scheduledAt: at(1), jobs: opts.jobs }, { repo: store, senders: { VOICE: voice }, now }) as Promise<TickSummary>).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(TICK_RESPONSE_LIMIT_MS);
    expect(settled, 'runTick must have returned after 60 s').toBe(true);
    const r = await p;
    expect(r.durationMs).toBeLessThanOrEqual(TICK_RESPONSE_LIMIT_MS);
    return { r, store, voice };
  }

  it('claimTick never returns → the call ends after the guard, did nothing, says so, and writes no heartbeat', async () => {
    const { r, store, voice } = await run((s) => { s.claimTick = never; });
    expect(r.durationMs).toBe(STORE_CALL_TIMEOUT_MS);
    expect(r.errors).toEqual([{ phase: 'group', id: 'claimTick', message: expect.stringContaining('claimTick did not answer') }]);
    expect((voice as FakeSender).attempts).toHaveLength(0);
    // (the rows of the seeding tick at T0 are still there; this tick wrote none)
    expect((await store.readHeartbeats()).every((h) => h.lastStartedAt!.getTime() === T0.getTime())).toBe(true);
    expect(heartbeatHealth(await store.readHeartbeats(), new Date(Date.now())).stale).toBe(true); // this is how it is noticed
  });

  it('loadPolicy never returns → the three phases that need it are skipped with an error, the queued pages still go out', async () => {
    const { r, store, voice } = await run((s) => { s.loadPolicy = never; });
    expect(r.notify.sent).toBe(3);
    expect((voice as FakeSender).sent).toHaveLength(3);
    expect(r.errors.map((e) => `${e.phase}:${e.id}`)).toEqual(['group:policy', 'reconcile:policy', 'escalation:policy']);
    const hb = Object.fromEntries((await store.readHeartbeats()).map((h) => [h.name, h.lastStatus]));
    expect(hb).toEqual({ group: 'ERROR', reconcile: 'ERROR', escalation: 'ERROR', notify: 'OK' });
    expect(r.durationMs).toBeLessThanOrEqual(STORE_CALL_TIMEOUT_MS + 1_000);
  });

  it('outboxBacklog never returns → the notify heartbeat is ERROR (unknown is not OK), the pages were sent', async () => {
    const { r, store } = await run((s) => { s.outboxBacklog = never; });
    expect(r.notify.sent).toBe(3);
    expect(r.errors).toEqual([{ phase: 'notify', id: 'backlog', message: expect.stringContaining('outboxBacklog did not answer') }]);
    expect((await store.readHeartbeats()).find((h) => h.name === 'notify')!.lastStatus).toBe('ERROR');
  });

  it('writeHeartbeat never returns (all four) → still within 60 s; the rows go stale', async () => {
    const { r, store } = await run((s) => { s.writeHeartbeat = never; });
    expect(r.notify.sent).toBe(3);
    expect(r.errors.map((e) => `${e.phase}:${e.id}`)).toEqual(['group:heartbeat', 'reconcile:heartbeat', 'escalation:heartbeat', 'notify:heartbeat']);
    expect((await store.readHeartbeats()).every((h) => h.lastStartedAt!.getTime() === T0.getTime())).toBe(true); // only the seeding tick's rows
  });

  it('the worst case together: loadPolicy, outboxBacklog and writeHeartbeat hang AND the provider is dead with 60 pages waiting → ≤ 60 s', async () => {
    const hang = { send: (): Promise<SendResult> => never() };
    const { r } = await run((s) => { s.loadPolicy = never; s.outboxBacklog = never; s.writeHeartbeat = never; }, { pages: 60, sender: hang });
    expect(r.notify.timeouts).toBeGreaterThan(0);
    expect(r.durationMs).toBeGreaterThan(45_000);
  });

  it.each(['findIncidentById', 'completeJob', 'beginSend', 'claimDueJobs', 'releaseJob', 'listGroupsToClose', 'listEscalationDue', 'listAutoResolvable'] as const)('%s never returns (inside a phase) together with a hanging heartbeat write → ≤ 60 s', async (method) => {
    const hang = { send: (): Promise<SendResult> => never() };
    await run((s) => { (s as unknown as Record<string, unknown>)[method] = never; s.writeHeartbeat = never; }, { pages: 60, sender: method === 'releaseJob' ? hang : undefined });
  });

  it('slow but answering (4 s each): nothing is skipped', async () => {
    const slow = <A extends unknown[], T>(f: (...a: A) => Promise<T>) => (...a: A): Promise<T> => new Promise<T>((res) => setTimeout(() => res(f(...a)), 4_000));
    const { r, store } = await run((s) => { s.claimTick = slow(s.claimTick.bind(s)); s.loadPolicy = slow(s.loadPolicy.bind(s)); s.outboxBacklog = slow(s.outboxBacklog.bind(s)); s.writeHeartbeat = slow(s.writeHeartbeat.bind(s)); });
    expect(r.errors).toEqual([]);
    expect(r.notify.sent).toBe(3);
    expect((await store.readHeartbeats()).map((h) => h.lastStatus)).toEqual(['OK', 'OK', 'OK', 'OK']);
  });

  it('a rejection is still a rejection (claimTick, loadPolicy) or an error line (backlog, heartbeat) — the guard only adds the time limit', async () => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    const boom = (): Promise<never> => Promise.reject(new Error('db down'));
    for (const m of ['claimTick', 'loadPolicy'] as const) {
      const { store } = await tenants(1, () => 'VOICE');
      store[m] = boom;
      await expect(runTick({ scheduledAt: at(1) }, { repo: store, senders: {}, now })).rejects.toThrow('db down');
    }
    const { store } = await tenants(1, () => 'VOICE');
    store.outboxBacklog = boom;
    const r = await runTick({ scheduledAt: at(1), jobs: ['notify'] }, { repo: store, senders: {}, now }) as TickSummary;
    expect(r.errors).toEqual([{ phase: 'notify', id: 'backlog', message: 'db down' }]);
  });
});

// ───────────────────────────── R-19 residuals ─────────────────────────────

const staff = (s: MemoryTickStore, id: string, name: string): void => {
  s.contacts.set(id, { id, kind: 'INTERNAL', customerId: null, name, active: true, phone: '+821055500000', email: `${id}@example.test`, slackUserId: `U${id}`, phoneVerifiedAt: V, emailVerifiedAt: V, slackVerifiedAt: V });
};
/** Mirae Pay with `n` extra staff responders R00 …; the first `rotations` of them are on shift (one customer rotation each). */
function shifts(n: number, rotations: number, opts: { haeunResponder?: boolean } = {}): MemoryTickStore {
  const s = seedWorld();
  if (opts.haeunResponder === false) s.responders = s.responders.filter((r) => !(r.customerId === 'cus_mirae' && r.contactId === 'ct_haeun'));
  for (let i = 0; i < n; i++) {
    const id = `ct_r${String(i).padStart(2, '0')}`;
    staff(s, id, `R${String(i).padStart(2, '0')}`);
    s.responders.push({ customerId: 'cus_mirae', contactId: id, role: 'PAGEABLE', order: i });
    if (i < rotations) s.rotations.set(`rot_c${i}`, { id: `rot_c${i}`, scope: 'CUSTOMER', customerId: 'cus_mirae', name: `C${i}`, cadence: 'DAILY', anchorAt: new Date('2026-11-09T00:00:00Z'), members: [{ contactId: id, order: 0 }] });
  }
  return s;
}
const snapOf = (s: MemoryTickStore, steps: EscalationStep[]) => buildSnapshot([config('cus_mirae', steps, { repeatCount: 0 })], { customerId: 'cus_mirae' }, s.worldOf('cus_mirae'), T0)!;
const pagedIn = (snap: ReturnType<typeof snapOf>): Set<string> => new Set(snap.steps.flatMap((st) => st.resolved.map((r) => r.contactId)));

describe('R-19 residual: more than 20 people on shift', () => {
  it('26 on shift: the first 20 on-shift people are kept, the 6 that are cut are named AS on shift, and the note no longer says "always kept"', () => {
    const s = shifts(25, 25); // R00 … R24 on shift + Haeun (MSP night desk) = 26; Junho and Yuna are not on shift
    const w = s.worldOf('cus_mirae');
    const { kept, cut } = allResponders(w, T0);
    expect(kept).toHaveLength(MAX_ALL_RESPONDERS);
    expect(kept.every((t) => t.onShift)).toBe(true);
    // Responder order decides, the last ones go: R00 … R19 stay; Haeun has no `order` and sorts after every row that has one
    expect(cut.filter((t) => t.onShift).map((t) => t.name)).toEqual(['R20', 'R21', 'R22', 'R23', 'R24', 'Haeun Kim']);
    const snap = snapOf(s, [step(0, 0, 'ALL_RESPONDERS', null, ['SMS'])]);
    const c = snap.clamped!;
    expect(c.dropped!.filter((d) => d.onShift).map((d) => d.name)).toEqual(['R20', 'R21', 'R22', 'R23', 'R24', 'Haeun Kim']);
    expect(c.unreached!.map((u) => u.name).sort()).toEqual(['Haeun Kim', 'Junho Park', 'R20', 'R21', 'R22', 'R23', 'R24', 'Yuna Seo']);
    const msg = clampMessage(c);
    expect(msg).not.toMatch(/always kept/);
    expect(msg).toContain('Not paged — step 1: R20 (on shift), R21 (on shift), R22 (on shift), R23 (on shift), R24 (on shift), Haeun Kim (on shift), Junho Park, Yuna Seo.');
    expect(msg).toContain('Not paged in ANY step: R20 (on shift), R21 (on shift), R22 (on shift), R23 (on shift), R24 (on shift), Haeun Kim (on shift), Junho Park, Yuna Seo.');
    expect(msg).toContain('6 of them are on shift now.');
    expect(msg).toContain(`People on shift are kept first, up to ${MAX_ALL_RESPONDERS} per step.`);
  });

  it('20 or fewer on shift: nobody on shift is cut and the note says everyone it names is NOT on shift', () => {
    const s = shifts(30, 19); // 19 + Haeun = 20 on shift
    const snap = snapOf(s, [step(0, 0, 'ALL_RESPONDERS', null, ['SMS'])]);
    expect(snap.steps[0]!.resolved.every((r) => r.onShift)).toBe(true);
    expect(snap.clamped!.dropped!.some((d) => d.onShift)).toBe(false);
    expect(clampMessage(snap.clamped!)).not.toMatch(/on shift\)|on shift now\./);
  });
});

describe('R-19 residual: a step dropped as a whole is named, and a ROTATION / PERSON step is the last to go', () => {
  const SV: StepChannel[] = ['SMS', 'VOICE'];

  it('the reviewer’s case: 7 on shift, 5 × everyone × [SMS, call], then the MSP rotation last → the rotation step STAYS and its on-call is paged (was: dropped, nobody named)', () => {
    const s = shifts(12, 7, { haeunResponder: false }); // Haeun: on call in rot_night, not a Mirae responder
    const snap = snapOf(s, [...Array.from({ length: 5 }, (_, i) => step(i, i * 5, 'ALL_RESPONDERS', null, SV)), step(5, 30, 'ROTATION', 'rot_night', SV)]);
    expect(snap.steps.map((st) => `${st.index}:${st.targetType}`)).toEqual(['0:ALL_RESPONDERS', '1:ALL_RESPONDERS', '2:ALL_RESPONDERS', '3:ALL_RESPONDERS', '5:ROTATION']);
    expect(snap.steps.at(-1)!.resolved.map((r) => r.contactId)).toEqual(['ct_haeun']);
    const c = snap.clamped!;
    expect(c.removedSteps).toBe(1);
    expect(c.droppedSteps).toEqual([{ stepIndex: 4, targetType: 'ALL_RESPONDERS', label: expect.stringContaining('everyone in Responders'), people: expect.arrayContaining([{ contactId: 'ct_r00', name: 'R00' }]) }]);
    expect(c.droppedSteps![0]!.people).toHaveLength(14); // the step as the order had it: 12 staff + Junho + Yuna
    const msg = clampMessage(c);
    expect(msg).toMatch(/1 step was dropped/);
    expect(msg).toMatch(/Dropped — step 5 \(everyone in Responders \(14\)\): .*R00.*R11/);
    // the people who are not on shift were left out of every "everyone" step and are in no other step: named
    expect(c.unreached!.map((u) => u.name).sort()).toEqual(['Junho Park', 'R07', 'R08', 'R09', 'R10', 'R11', 'Yuna Seo']);
    expect(msg).toContain('Not paged in ANY step: ');
    expect(msg).not.toMatch(/Haeun/); // she is paged
    expect(msg).not.toMatch(/always kept/);
  });

  it('only single-person steps and still over the cap: the last step goes, WITH the name of its on-call person, marked on shift', () => {
    const s = shifts(0, 0, { haeunResponder: false });
    const five: StepChannel[] = ['SLACK_CHANNEL', 'SLACK_DM', 'SMS', 'VOICE', 'EMAIL'];
    const snap = snapOf(s, [...Array.from({ length: 12 }, (_, i) => step(i, i * 5, 'PERSON', 'ct_yuna', five)), step(12, 65, 'ROTATION', 'rot_night', five)]); // 13 × 5 = 65 > 60: a row written around the API
    expect(snap.steps).toHaveLength(12);
    expect(pagedIn(snap).has('ct_haeun')).toBe(false);
    const c = snap.clamped!;
    expect(c.droppedSteps).toEqual([{ stepIndex: 12, targetType: 'ROTATION', label: 'MSP night desk', people: [{ contactId: 'ct_haeun', name: 'Haeun Kim' }] }]);
    expect(c.unreached).toEqual([{ contactId: 'ct_haeun', name: 'Haeun Kim', onShift: true }]);
    const msg = clampMessage(c);
    expect(msg).toContain('Dropped — step 13 (MSP night desk): Haeun Kim.');
    expect(msg).toContain('Not paged in ANY step: Haeun Kim (on shift). 1 of them is on shift now.');
  });

  it('nobody is lost → the note says so; the event on the timeline carries the lists', async () => {
    const s = seedWorld();
    const five: StepChannel[] = ['SLACK_CHANNEL', 'SLACK_DM', 'SMS', 'VOICE', 'EMAIL'];
    // 13 single-person steps × 5 = 65 > 60 (a row written around the API): the last one goes, the same person is paged by the other 12
    s.configs.push(config('cus_mirae', Array.from({ length: 13 }, (_, i) => step(i, i * 5, 'ROTATION', 'rot_night', five)), { repeatCount: 0 }));
    const sim = new Sim(s);
    closedGroup(s, { customerId: 'cus_mirae', severity: 'SEV_1', at: T0, alerts: [{ id: 'a' }] });
    await sim.tick();
    const note = s.eventsOf(sim.incident().id).find((e) => e.data?.note === 'SEND_CAP_CLAMPED')!;
    expect(note.message).toContain('1 step was dropped');
    expect(note.message).toContain('Dropped — step 13 (MSP night desk): Haeun Kim.');
    expect(note.message).toContain('Everyone in this call order is still paged in at least one step.');
    expect(note.message).not.toMatch(/Not paged in ANY step|on shift now\./);
    expect(note.data).toMatchObject({ removedSteps: 1, unreached: [], droppedSteps: [{ stepIndex: 12, targetType: 'ROTATION', label: 'MSP night desk', people: [{ contactId: 'ct_haeun', name: 'Haeun Kim' }] }] });
  });

  it('property: 400 random orders — everyone the order would have paged is either still paged or listed in `unreached`; every dropped step is listed with its people', () => {
    let seed = 20261111;
    const rnd = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    const CH: StepChannel[] = ['SLACK_CHANNEL', 'SLACK_DM', 'SMS', 'VOICE', 'EMAIL'];
    let clamped = 0; let wholeSteps = 0; let shiftCut = 0;
    for (let i = 0; i < 400; i++) {
      const n = Math.floor(rnd() * 45);
      const s = shifts(n, Math.floor(rnd() * (n + 1)), { haeunResponder: rnd() < 0.5 });
      const steps: EscalationStep[] = Array.from({ length: 1 + Math.floor(rnd() * 13) }, (_, x) => {
        const kind = rnd();
        const channels = CH.filter(() => rnd() < 0.6);
        return step(x, x * 5, kind < 0.5 ? 'ALL_RESPONDERS' : kind < 0.75 ? 'ROTATION' : 'PERSON', kind < 0.5 ? null : kind < 0.75 ? 'rot_night' : 'ct_yuna', channels.length ? channels : ['SMS']);
      });
      const w = s.worldOf('cus_mirae');
      const snap = snapOf(s, steps);
      // what the order would page without any limit
      const wanted = new Map<string, string>();
      for (const st of steps) for (const t of resolveStep(st, w, T0)) wanted.set(t.contactId, t.name);
      if (steps.some((st) => st.targetType === 'ALL_RESPONDERS')) for (const t of allResponders(w, T0).cut) wanted.set(t.contactId, t.name);
      const paged = pagedIn(snap);
      const unreached = new Set((snap.clamped?.unreached ?? []).map((u) => u.contactId));
      const label = `case ${i}`;
      for (const id of wanted.keys()) expect(paged.has(id) !== unreached.has(id), `${label}: ${id} must be paged or listed, not both, not neither`).toBe(true);
      for (const id of unreached) expect(wanted.has(id), label).toBe(true);
      const keptIdx = new Set(snap.steps.map((st) => st.index));
      const gone = steps.filter((st) => !keptIdx.has(st.index));
      expect((snap.clamped?.droppedSteps ?? []).map((d) => d.stepIndex).sort((a, b) => a - b), label).toEqual(gone.map((st) => st.index));
      for (const d of snap.clamped?.droppedSteps ?? []) expect(d.people.map((p) => p.contactId), label).toEqual(resolveStep(steps[d.stepIndex]!, w, T0).map((t) => t.contactId));
      // a ROTATION / PERSON step is dropped only when no "everyone" step is left
      if (gone.some((st) => st.targetType !== 'ALL_RESPONDERS')) expect(snap.steps.some((st) => st.targetType === 'ALL_RESPONDERS' && st.resolved.length > 0 && st.channels.some((c) => c !== 'SLACK_CHANNEL')), label).toBe(false);
      if (snap.clamped) {
        clamped++;
        const msg = clampMessage(snap.clamped);
        expect(msg, label).not.toMatch(/always kept/);
        const lost = snap.clamped.unreached!;
        if (lost.length) expect(msg, label).toContain('Not paged in ANY step: '); else expect(msg, label).toContain('Everyone in this call order is still paged in at least one step.');
        if (lost.some((u) => u.onShift)) { shiftCut++; expect(msg, label).toMatch(/\(on shift\)/); }
        if (gone.length) { wholeSteps++; for (const st of gone) expect(msg, label).toContain(`step ${st.index + 1}`); }
      }
      const sends = snap.steps.reduce((a, st) => a + st.channels.reduce((b, c) => b + (c === 'SLACK_CHANNEL' ? 1 : st.resolved.length), 0), 0);
      if (snap.steps.length > 1) expect(sends, label).toBeLessThanOrEqual(MAX_SENDS_PER_CYCLE);
    }
    expect(clamped).toBeGreaterThan(100);
    expect(wholeSteps).toBeGreaterThan(20);
    expect(shiftCut).toBeGreaterThan(5);
  });
});

describe('N-37: an `order` that is not a finite number is "no order"', () => {
  it('orderKey', () => {
    expect([0, 3, -1, 2.5].map(orderKey)).toEqual([0, 3, -1, 2.5]);
    expect([NaN, Infinity, -Infinity, null, undefined, '1', {}, []].map(orderKey)).toEqual(Array(8).fill(Infinity));
  });

  it('Responder.order NaN / ±Infinity / null / string: 300 shuffles of the rows → ONE result (was 56), the broken rows after every real order, by contactId', () => {
    const bad = [NaN, Infinity, -Infinity, null, '0', undefined] as unknown as number[];
    const rows = (seed: number): Responder[] => {
      const rs: Responder[] = Array.from({ length: 30 }, (_, i) => ({ customerId: 'cus_mirae', contactId: `ct_n${String(i).padStart(2, '0')}`, role: 'PAGEABLE' as const, order: i % 3 === 0 ? bad[(i / 3) % bad.length] : 100 - i }));
      let a = seed;
      for (let i = rs.length - 1; i > 0; i--) { a = (Math.imul(a, 1103515245) + 12345) >>> 0; const j = a % (i + 1); [rs[i], rs[j]] = [rs[j]!, rs[i]!]; }
      return rs;
    };
    const seen = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const s = seedWorld();
      s.rotations.clear();
      s.responders = rows(seed);
      for (const r of s.responders) staff(s, r.contactId, r.contactId);
      const { kept, cut } = allResponders(s.worldOf('cus_mirae'), T0);
      seen.add([...kept, ...cut].map((t) => t.contactId).join(','));
    }
    expect(seen.size).toBe(1);
    const order = [...seen][0]!.split(',');
    const real = order.slice(0, 20); const broken = order.slice(20);
    expect(real.every((id) => Number(id.slice(4)) % 3 !== 0)).toBe(true);
    expect(real[0]).toBe('ct_n29'); // order 71, the smallest real one
    expect(broken).toEqual([...broken].sort());
  });

  it('rotation member order NaN: the on-call person does not depend on the order of the member rows', () => {
    const members = [{ contactId: 'ct_haeun', order: NaN }, { contactId: 'ct_junho', order: 1 }, { contactId: 'ct_minjae', order: NaN }];
    const seen = new Set<string | null>();
    for (const m of [members, [...members].reverse(), [members[1]!, members[2]!, members[0]!], [members[2]!, members[0]!, members[1]!]]) {
      const s = seedWorld();
      s.rotations.set('rot_night', { ...s.rotations.get('rot_night')!, members: m });
      seen.add(onCallAt(s.rotations.get('rot_night')!, s.worldOf('cus_mirae'), T0).contactId);
    }
    expect([...seen]).toEqual(['ct_junho']); // the only real order is first
  });
});

// ───────────────────────────── R-20 ─────────────────────────────

describe('R-20 residual: sanitiser — escaped JSON, arrays, XML, middle dots', () => {
  const K = 'Zq7hunter2Zq7';
  const SECRETS: string[] = [
    `{\\"api_key\\":\\"${K}\\"}`, `{\\\\\\"api_key\\\\\\":\\\\\\"${K}\\\\\\"}`, `"{\\"error\\":{\\"authToken\\":\\"${K}\\"}}"`,
    `{"token":["${K}","${K}x"]}`, `{"tokens": [ "${K}" ]}`, `{"api_keys":['${K}']}`, `secrets=[${K},${K}]`,
    `<apiKey>${K}</apiKey>`, `<token value="${K}"/>`, `<ns:authToken xmlns="x">${K}</ns:authToken>`, `&lt;apiKey&gt;${K}&lt;/apiKey&gt;`, `<Password>${K}</Password>`, `<credential type="basic">${K}</credential>`,
    `api_key => ${K}`, `apiKey[${K}]`, `apiKey{${K}}`, `passphrase=${K}`, `passcode=${K}`, `jwt=${K}`, `csrf=${K}`, `nonce=${K}`, `client_id=${K}`, `code=${K}`,
    `비밀번호=${K}`, `암호: ${K}`, `пароль=${K}`, `токен: ${K}`,
  ];
  const NUMBERS: string[] = ['call 010·1234·5678 failed', '010ㆍ1234ㆍ5678', '010‧1234‧5678', '010•1234•5678', '010∙1234∙5678', '010・1234・5678', '+82·10·1234·5678', '010=1234=5678', '010+1234+5678', '010#1234#5678', '010"1234"5678', '010\\1234\\5678', '010→1234→5678'];
  const EMAILS: string[] = ['haeun\\u0040example.test', 'haeun\\x40example.test', 'to: haeun\\u0040example.test rejected'];

  it.each(SECRETS)('secret: %s', (raw) => {
    const out = sanitizeProviderError(`provider says ${raw} end`);
    expect(out).not.toContain(K);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('[secret]');
  });
  it.each(NUMBERS)('number: %s', (raw) => {
    const out = sanitizeProviderError(raw);
    expect(out).toContain('[number]');
    expect(out).not.toMatch(/1234|5678/);
  });
  it.each(EMAILS)('address: %s', (raw) => {
    expect(sanitizeProviderError(raw)).not.toMatch(/haeun|example/);
  });

  it('ordinary provider messages are not touched', () => {
    for (const t of ["Invalid 'To' phone number", 'HTTP 429 rate limited, retry later', 'connection reset by peer', 'error 21211: not a mobile number', 'channel_not_found', '<html><body>502 Bad Gateway</body></html>', 'items [a, b] rejected']) {
      expect(sanitizeProviderError(t)).toBe(t);
    }
  });

  it('still idempotent, bounded in length and in time', () => {
    for (const raw of [...SECRETS, ...NUMBERS, ...EMAILS]) {
      const once = sanitizeProviderError(raw);
      expect(sanitizeProviderError(once)).toBe(once);
      expect(once.length).toBeLessThanOrEqual(300);
    }
    const worst = ['<key'.repeat(80), '"key.'.repeat(80), 'key=['.repeat(80), '\\"'.repeat(200), '<a key="'.repeat(60), '0·'.repeat(200), 'token:['.repeat(60), `{\\"k`.repeat(100)];
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) for (const w of worst) sanitizeProviderError(w + i);
    expect((performance.now() - t0) / (200 * worst.length)).toBeLessThan(5); // ms per call; measured ≈ 0.05
    const big = `{\\"api_key\\":\\"${K}\\"}`.repeat(400_000);
    const t1 = performance.now();
    expect(sanitizeProviderError(big)).not.toContain(K);
    expect(performance.now() - t1).toBeLessThan(50);
  });

  it('what is known to pass is written down, not hidden (these are why the text is an excerpt for ADMIN by default)', () => {
    // If one of these starts being masked, good — move it to the list above.
    for (const raw of [`{"name":"api_key","value":"${K}"}`, `the secret was ${K}`, `{"k":"${K}"}`]) expect(sanitizeProviderError(raw)).toContain(K);
  });
});

describe('R-20: STORE_PROVIDER_TEXT (default false) — what is stored of the provider’s words', () => {
  const LONG = `vendor: number +82100008995 rejected ${'lorem ipsum '.repeat(30)}`;

  it('providerText: an excerpt of 120 masked characters unless the switch is the boolean true', () => {
    expect(PROVIDER_EXCERPT_MAX_CHARS).toBe(120);
    expect(providerText(LONG)).toHaveLength(120);
    expect(providerText(LONG)).toMatch(/^vendor: number \[number\] rejected lorem/);
    expect(providerText(LONG, true).length).toBeGreaterThan(280); // the 300 characters, a little shorter after masking
    expect(providerText(LONG, true).length).toBeLessThanOrEqual(300);
    for (const v of ['true', 1, 'yes', {}, null, undefined, false]) expect(providerText(LONG, v)).toHaveLength(120);
    // masking happens on the 300 characters BEFORE the cut: a number that straddles position 120 does not leave half of itself
    const straddle = `${'x'.repeat(112)} 010-1234-5678 tail`;
    expect(providerText(straddle)).not.toMatch(/\d{3}/);
  });

  it('the flag is read by the typed loader; only clear "true" values switch it on', () => {
    expect(loadPolicyFlags({}).flags.storeProviderText).toBe(false);
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', true]) expect(loadPolicyFlags({ STORE_PROVIDER_TEXT: v }).flags.storeProviderText).toBe(true);
    for (const v of ['false', '0', 'off', false]) expect(loadPolicyFlags({ STORE_PROVIDER_TEXT: v })).toMatchObject({ flags: { storeProviderText: false }, warnings: [] });
    for (const v of ['', 'ture', 'enabled', 2, {}]) {
      const r = loadPolicyFlags({ STORE_PROVIDER_TEXT: v });
      expect(r.flags.storeProviderText).toBe(false);
      expect(r.warnings).toEqual([expect.stringMatching(/^STORE_PROVIDER_TEXT is .* using the safe default false\.$/)]);
    }
  });

  const failed = async (storeProviderText: unknown) => {
    const sim = new Sim();
    sim.store.configs.push(config('cus_mirae', [step(0, 0, 'PERSON', 'ct_yuna', ['SMS'])], { repeatCount: 0 }));
    sim.sms.failNext(1, { retryable: false, error: LONG });
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'a1' }] });
    await runTick({ scheduledAt: T0 }, on({ repo: sim.store, senders: sim.senders, now: () => T0, storeProviderText: storeProviderText as never }));
    return { log: sim.store.logs.find((l) => l.channel === 'SMS')!, job: sim.store.jobList().find((j) => j.channel === 'SMS')! };
  };

  it('default: the log row and the job keep the reason code and a 120-character masked excerpt', async () => {
    for (const v of [undefined, false, 'true', 1]) {
      const { log, job } = await failed(v);
      expect(log).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_REJECTED' });
      expect(log.error).toHaveLength(120);
      expect(log.error).toMatch(/^vendor: number \[number\] rejected lorem/);
      expect(job.lastError).toBe(log.error);
    }
  });

  it('switched on: the masked text up to 300 characters is kept', async () => {
    const { log, job } = await failed(true);
    expect(log.error!.length).toBeGreaterThan(280);
    expect(log.error!.length).toBeLessThanOrEqual(300);
    expect(log.error).not.toMatch(/82100008995/);
    expect(job.lastError).toBe(log.error);
  });
});
