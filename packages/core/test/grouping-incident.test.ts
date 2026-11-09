import { describe, expect, it } from 'vitest';
import {
  ack, addMember, assignGroup, decide, DEFAULT_POLICY, EMPTY_STATE, entersGroup, groupId, groupKey, incidentId, mergeOrOpen,
  newIncident, nextState, representative, resolve, shouldAutoResolve, staleAfter, withVersionRetry, type FingerprintState,
} from '../src/index.js';
import { t } from './helpers.js';

const P = DEFAULT_POLICY;

describe('group key / id (G-1, G-4, known-bugs 3-3)', () => {
  it('unmapped accounts get distinct axes', () => {
    const a = groupKey({ customerId: null, awsAccountId: '111111111111', severity: 'SEV_3' });
    const b = groupKey({ customerId: null, awsAccountId: '222222222222', severity: 'SEV_3' });
    expect(a).not.toBe(b);
    expect(a).toBe('acct:111111111111#SEV-3');
    expect(groupKey({ customerId: 'cus_1', awsAccountId: '1', severity: 'SEV_2' })).toBe('cus_1#SEV-2');
  });
  it('deterministic ids', () => {
    expect(groupId('cus_1#SEV-2', t('2026-11-09T03:12:05Z'))).toMatch(/^g-[0-9a-f]{16}-20261109031205$/);
    expect(incidentId('cus_1#SEV-2', t('2026-11-09T03:12:05Z'))).toMatch(/^inc-[0-9a-f]{12}-20261109031205$/);
  });
  it('only NOTIFY/DEFER enter groups (G-2)', () => {
    expect(['NOTIFY', 'DEFER', 'SUPPRESS'].map((d) => entersGroup(d as any))).toEqual([true, true, false]);
  });
});

describe('assignGroup (G-3, G-6)', () => {
  const ctx = { customerId: 'cus_1', severity: 'SEV_3' as const, policy: P };
  it('opens, then joins within stale deadline, reopens after', () => {
    const a = assignGroup(null, 'k', { ...ctx, wallNow: t('2026-11-09T00:00:00.400Z') });
    expect(a.action).toBe('OPEN');
    if (a.action !== 'OPEN') return;
    expect(a.group.closeAt.toISOString()).toBe('2026-11-09T00:00:30.000Z');
    expect(assignGroup(a.group, 'k', { ...ctx, wallNow: t('2026-11-09T00:00:20Z') })).toEqual({ action: 'JOIN', groupId: a.group.id });
    const late = assignGroup(a.group, 'k', { ...ctx, wallNow: t('2026-11-09T00:10:00Z') });
    expect(late).toMatchObject({ action: 'OPEN', staleReplaced: a.group.id });
  });
  it('stale deadline includes max auto-pause (G-6 defect fixed)', () => {
    const p = { ...P, autoPauseSec: { SEV_4: 600 } };
    expect(staleAfter(t('2026-11-09T00:00:00Z'), 30, p).toISOString()).toBe('2026-11-09T00:15:35.000Z');
    // a pausing group at +8 min is not stale
    const g = assignGroup(null, 'k', { ...ctx, policy: p, wallNow: t('2026-11-09T00:00:00Z') });
    if (g.action !== 'OPEN') throw new Error();
    expect(assignGroup(g.group, 'k', { ...ctx, policy: p, wallNow: t('2026-11-09T00:08:00Z') }).action).toBe('JOIN');
  });
  it('same-second reopen uses +1s id', () => {
    const taken = new Set([groupId('k', t('2026-11-09T00:00:00Z'))]);
    const g = assignGroup(null, 'k', { ...ctx, wallNow: t('2026-11-09T00:00:00Z'), idTaken: (id) => taken.has(id) });
    if (g.action !== 'OPEN') throw new Error();
    expect(g.group.id.endsWith('20261109000001')).toBe(true);
  });
  it('representative is the most severe member (G-9)', () => {
    expect(representative([{ severity: 'SEV_3', n: 1 }, { severity: 'SEV_1', n: 2 }, { severity: null, n: 3 }])?.n).toBe(2);
  });
});

describe('incident open/merge (I-3, I-4, I-5)', () => {
  const m = { customerId: 'cus_1', severity: 'SEV_3' as const, title: 'disk' };
  it('merges within 6h, opens after and demotes old target (known-bugs 3-4)', () => {
    const inc = newIncident('cus_1#SEV-3', m, t('2026-11-09T00:00:00Z'));
    expect(mergeOrOpen(inc, t('2026-11-09T05:59:59Z'), P)).toEqual({ action: 'MERGE', incidentId: inc.id });
    expect(mergeOrOpen(inc, t('2026-11-09T06:00:00Z'), P)).toEqual({ action: 'OPEN', demote: inc.id });
    expect(mergeOrOpen(null, t('2026-11-09T00:00:00Z'), P)).toEqual({ action: 'OPEN', demote: null });
    const r = resolve(inc, 'AUTO', null, t('2026-11-09T01:00:00Z'))!;
    expect(mergeOrOpen(r, t('2026-11-09T01:00:01Z'), P).action).toBe('OPEN');
  });
  it('members: same fingerprint only bumps eventCount; cap 200; most severe sets title', () => {
    let inc = newIncident('a', m, t('2026-11-09T00:00:00Z'));
    const set = new Set<string>();
    inc = addMember(inc, set, { fingerprint: 'f1', severity: 'SEV_3', title: 'disk', awsAccountId: '1', resourceType: 'EC2' }).incident;
    inc = addMember(inc, set, { fingerprint: 'f1', severity: 'SEV_3', title: 'disk', awsAccountId: '1', resourceType: 'EC2' }).incident;
    expect(inc).toMatchObject({ memberCount: 1, eventCount: 2, accountIds: ['1'], resourceTypes: ['EC2'] });
    inc = addMember(inc, set, { fingerprint: 'f2', severity: 'SEV_2', title: 'api down', awsAccountId: '2', resourceType: 'ALB' }).incident;
    expect(inc).toMatchObject({ severity: 'SEV_2', title: 'api down', accountIds: ['1', '2'] });
    for (let i = 0; i < 300; i++) inc = addMember(inc, set, { fingerprint: `x${i}`, severity: 'SEV_5', title: '', awsAccountId: null, resourceType: null }).incident;
    expect(inc.memberCount).toBe(200);
    expect(addMember(inc, set, { fingerprint: '', severity: 'SEV_1', title: '', awsAccountId: null, resourceType: null }).memberAdded).toBe(false);
  });
  it('ack only from TRIGGERED, resolve idempotent (MTTR not pushed)', () => {
    const inc = newIncident('a', m, t('2026-11-09T00:00:00Z'));
    const a = ack(inc, 'usr', t('2026-11-09T00:03:00Z'))!;
    expect(a.mttaSec).toBe(180);
    expect(ack(a, 'usr2', t('2026-11-09T00:04:00Z'))).toBeNull();
    const r = resolve(a, 'MANUAL', 'usr', t('2026-11-09T01:00:00Z'))!;
    expect(r.mttrSec).toBe(3600);
    expect(r.isMergeTarget).toBe(false);
    expect(resolve(r, 'MANUAL', 'usr', t('2026-11-09T02:00:00Z'))).toBeNull();
  });
  it('auto-resolve needs members and none open; never right after merging a fire', () => {
    expect(shouldAutoResolve([], false)).toBe(false);
    expect(shouldAutoResolve([false, false], false)).toBe(true);
    expect(shouldAutoResolve([false, true], false)).toBe(false);
    expect(shouldAutoResolve([false], true)).toBe(false);
  });
  it('version retry gives up after 3 conflicts (I-7)', async () => {
    let n = 0;
    expect(await withVersionRetry(async () => (++n < 3 ? 'CONFLICT' : 'ok'))).toBe('ok');
    n = 0;
    expect(await withVersionRetry(async () => { n++; return 'CONFLICT'; })).toBe('CONFLICT');
    expect(n).toBe(3);
  });
});

describe('known-bugs 1-2: dedup state survives long suppression history', () => {
  it('100 suppressed re-fires do not release dedup (state is separate from history)', () => {
    let st: FingerprintState = { ...EMPTY_STATE, recentEpisodes: [] };
    const p = { ...P, repeatIntervalSec: 86400, flappingPerDay: 1000 };
    const base = t('2026-11-09T00:00:00Z').getTime();
    const ev = (i: number, state: 'FIRING' | 'RESOLVED') => ({ eventType: 'STATE_CHANGE' as const, state, previousState: state === 'FIRING' ? 'OK' : 'ALARM', severity: 'SEV_3' as const, occurredAt: new Date(base + i * 60_000), target: { customerId: 'c' } });
    const reasons: string[] = [];
    for (let i = 0; i < 202; i += 2) {
      const f = ev(i, 'FIRING');
      const r = decide(f, st, p, []);
      reasons.push(r.reason);
      st = nextState(st, f, r, p);
      const c = ev(i + 1, 'RESOLVED');
      st = nextState(st, c, decide(c, st, p, []), p);
    }
    expect(reasons[0]).toBe('notify');
    expect(reasons.slice(1).every((r) => r === 'dedup')).toBe(true);
    expect(st.recentEpisodes.length).toBeLessThanOrEqual(30);
  });
});
