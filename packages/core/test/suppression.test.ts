import { describe, expect, it } from 'vitest';
import {
  decide, decideSafe, DEFAULT_POLICY, effectiveState, EMPTY_STATE, finalizeDeferred, nextAlertStatus, nextState, policyFromRow,
  validateWindow, windowCovers, type FingerprintState, type MaintenanceWindow, type SuppressionInput,
} from '../src/index.js';
import { t } from './helpers.js';

const P = DEFAULT_POLICY;
const fire = (at: string, sev: SuppressionInput['severity'] = 'SEV_3', target = { customerId: 'cus_1' }): SuppressionInput =>
  ({ eventType: 'STATE_CHANGE', state: 'FIRING', previousState: 'OK', severity: sev, occurredAt: t(at), target });
const clear = (at: string, sev: SuppressionInput['severity'] = 'SEV_3'): SuppressionInput =>
  ({ eventType: 'STATE_CHANGE', state: 'RESOLVED', previousState: 'ALARM', severity: sev, occurredAt: t(at), target: { customerId: 'cus_1' } });
const mw = (over: Partial<MaintenanceWindow> = {}): MaintenanceWindow => ({
  id: 'mw1', customerId: 'cus_1', scopeType: 'CUSTOMER', scopeId: 'cus_1', startsAt: t('2026-11-09T00:00:00Z'), endsAt: t('2026-11-09T06:00:00Z'), ...over,
});

/** Run a sequence of events through decide + nextState. */
function run(events: SuppressionInput[], windows: MaintenanceWindow[] = [], policy = P) {
  let st: FingerprintState = { ...EMPTY_STATE, recentEpisodes: [] };
  return events.map((e) => {
    const r = decide(e, st, policy, windows);
    st = nextState(st, e, r, policy);
    return { r, st };
  });
}

describe('order (S-3) and D-17', () => {
  it('SEV-1 passes a maintenance window; SEV-2 is silenced', () => {
    expect(decide(fire('2026-11-09T01:00:00Z', 'SEV_1'), EMPTY_STATE, P, [mw()])).toMatchObject({ decision: 'NOTIFY', reason: 'exempt_sev1' });
    expect(decide(fire('2026-11-09T01:00:00Z', 'SEV_2'), EMPTY_STATE, P, [mw()])).toMatchObject({ decision: 'SUPPRESS', reason: 'silence', maintenanceWindowId: 'mw1' });
  });
  it('window end is exclusive and judged at occurredAt, not wall clock (S-4, S-5)', () => {
    expect(decide(fire('2026-11-09T06:00:00Z'), EMPTY_STATE, P, [mw()]).reason).toBe('notify');
    expect(decide(fire('2026-11-09T05:59:59Z'), EMPTY_STATE, P, [mw()]).reason).toBe('silence');
  });
  it('revoked window no longer silences', () => {
    expect(decide(fire('2026-11-09T02:00:00Z'), EMPTY_STATE, P, [mw({ revokedAt: t('2026-11-09T01:00:00Z') })]).reason).toBe('notify');
  });
  it('dedup within 15 min after a clear, notify after (S-8)', () => {
    const res = run([fire('2026-11-09T10:00:00Z'), clear('2026-11-09T10:05:00Z'), fire('2026-11-09T10:10:00Z'), clear('2026-11-09T10:11:00Z'), fire('2026-11-09T10:16:00Z')], [], { ...P, flappingPerDay: 100 });
    expect(res.map((x) => x.r.reason)).toEqual(['notify', 'cleared', 'dedup', 'cleared', 'notify']);
    expect(res[1]!.r.decision).toBe('NOTIFY'); // first episode was notified → clear is sent
    expect(res[3]!.r.decision).toBe('SUPPRESS'); // deduped episode → silent clear
  });
  it('negative elapsed (clock skew) is not dedup', () => {
    const st = { ...EMPTY_STATE, lastNotifiedAt: t('2026-11-09T11:00:00Z') };
    expect(decide(fire('2026-11-09T10:59:00Z'), st, P, []).reason).toBe('notify');
  });
  it('flapping: third fire of the day is quarantined, then 1h quarantine holds (S-7)', () => {
    const P0 = { ...P, repeatIntervalSec: 0 };
    const res = run([
      fire('2026-11-09T01:00:00Z'), clear('2026-11-09T01:01:00Z'),
      fire('2026-11-09T02:00:00Z'), clear('2026-11-09T02:01:00Z'),
      fire('2026-11-09T03:00:00Z'), clear('2026-11-09T03:01:00Z'),
    ], [], P0);
    expect(res.filter((_, i) => i % 2 === 0).map((x) => x.r.reason)).toEqual(['notify', 'notify', 'flapping']);
    expect(res[4]!.st.quarantinedUntil?.toISOString()).toBe('2026-11-09T04:00:00.000Z');
    const st = res[5]!.st;
    expect(decide(fire('2026-11-10T03:30:00Z'), { ...st, recentEpisodes: [] }, P0, []).reason).toBe('notify');
  });
  it('SEV-1 is never quarantined; silenced fire does not start quarantine', () => {
    const P0 = { ...P, repeatIntervalSec: 0, flappingPerDay: 1 };
    expect(decide(fire('2026-11-09T01:00:00Z', 'SEV_1'), EMPTY_STATE, P0, []).reason).toBe('exempt_sev1');
    const r = run([fire('2026-11-09T01:00:00Z')], [mw()], P0)[0]!;
    expect(r.r.reason).toBe('silence');
    expect(r.st.quarantinedUntil).toBeNull();
  });
  it('auto-pause DEFER only when configured (S-10 default off)', () => {
    expect(decide(fire('2026-11-09T10:00:00Z'), EMPTY_STATE, P, []).decision).toBe('NOTIFY');
    const r = decide(fire('2026-11-09T10:00:00Z', 'SEV_4'), EMPTY_STATE, { ...P, autoPauseSec: { SEV_4: 120 } }, []);
    expect(r).toMatchObject({ decision: 'DEFER', reason: 'auto_pause', deferSec: 120 });
  });
  it('finalize of deferred member: still open → auto_pause_expired; self-resolved → suppressed', () => {
    const open = { ...EMPTY_STATE, episodeOpen: true, episodeStartedAt: t('2026-11-09T10:00:00Z') };
    expect(finalizeDeferred(open, t('2026-11-09T10:00:00Z')).reason).toBe('auto_pause_expired');
    expect(finalizeDeferred({ ...open, episodeOpen: false }, t('2026-11-09T10:00:00Z')).reason).toBe('auto_pause');
  });
});

describe('S-2 pre-filter', () => {
  it('config change is not actionable', () => {
    expect(decide({ ...fire('2026-11-09T10:00:00Z'), eventType: 'CONFIG_CHANGE' }, EMPTY_STATE, P, []).reason).toBe('not_actionable');
  });
  it('duplicate clear on closed episode is not re-sent', () => {
    expect(decide(clear('2026-11-09T10:00:00Z'), EMPTY_STATE, P, [])).toMatchObject({ decision: 'SUPPRESS', reason: 'cleared' });
  });
  it('OK → INSUFFICIENT_DATA is not actionable', () => {
    expect(decide({ ...clear('2026-11-09T10:00:00Z'), state: 'INSUFFICIENT_DATA', previousState: 'OK' }, EMPTY_STATE, P, []).reason).toBe('not_actionable');
  });
  it('webhook resolve (no previousState) closes an open episode', () => {
    const st = { ...EMPTY_STATE, episodeOpen: true, episodeNotified: true };
    expect(decide({ ...clear('2026-11-09T10:00:00Z'), previousState: null }, st, P, [])).toMatchObject({ decision: 'NOTIFY', reason: 'cleared', closesEpisode: true });
  });
  it('Alertmanager re-sending FIRING of an open episode never re-pages, even SEV-1 (S-9)', () => {
    const st = { ...EMPTY_STATE, episodeOpen: true, episodeNotified: true };
    expect(decide({ ...fire('2026-11-09T10:04:00Z', 'SEV_1'), previousState: null }, st, P, []).decision).toBe('SUPPRESS');
  });
});

describe('alert status and sticky ack (S-9)', () => {
  it('FIRING / INSUFFICIENT_DATA do not undo ACKNOWLEDGED; RESOLVED always applies', () => {
    expect(nextAlertStatus('ACKNOWLEDGED', 'FIRING')).toBe('ACKNOWLEDGED');
    expect(nextAlertStatus('ACKNOWLEDGED', 'INSUFFICIENT_DATA')).toBe('ACKNOWLEDGED');
    expect(nextAlertStatus('ACKNOWLEDGED', 'RESOLVED')).toBe('RESOLVED');
    expect(nextAlertStatus('RESOLVED', 'FIRING')).toBe('FIRING');
    expect(nextAlertStatus(null, 'INSUFFICIENT_DATA')).toBe('INSUFFICIENT_DATA');
  });
});

describe('fail-open and policy (S-11, S-12)', () => {
  it('error in decide → NOTIFY', () => {
    const r = decideSafe(fire('2026-11-09T10:00:00Z'), null as any, P, []);
    expect(r).toMatchObject({ decision: 'NOTIFY', reason: 'state_error' });
  });
  it('renotifyAfterSec from DB row is honored (AAM S-11 defect regression)', () => {
    expect(policyFromRow({ renotifyAfterSec: 120 }).renotifyAfterSec).toBe(120);
    expect(policyFromRow({}).renotifyAfterSec).toBe(3600);
  });
  it('ranges clamp; partial rows keep defaults; autoPause keys accept SEV-n', () => {
    const p = policyFromRow({ repeatIntervalSec: 999999, groupWaitSec: -5, flappingWindowDays: '0.5', autoPauseSec: { 'SEV-4': 9000, bogus: 1 } });
    expect(p).toMatchObject({ repeatIntervalSec: 86400, groupWaitSec: 0, flappingWindowDays: 0.5, autoPauseSec: { SEV_4: 3600 }, flappingPerDay: 3 });
  });
  it('30 quiet days reset state to first fire (F-4)', () => {
    const st = { ...EMPTY_STATE, lastNotifiedAt: t('2026-10-01T00:00:00Z'), quarantinedUntil: t('2099-01-01T00:00:00Z') };
    expect(effectiveState(st, t('2026-10-01T00:00:00Z'), t('2026-11-09T00:00:00Z')).quarantinedUntil).toBeNull();
    expect(effectiveState(st, t('2026-11-01T00:00:00Z'), t('2026-11-09T00:00:00Z'))).toBe(st);
  });
});

describe('maintenance scopes', () => {
  const at = t('2026-11-09T01:00:00Z');
  it('scope axes', () => {
    expect(windowCovers(mw({ scopeType: 'SERVICE', scopeId: 'svc1' }), { customerId: 'cus_1', serviceId: 'svc1' }, at)).toBe(true);
    expect(windowCovers(mw({ scopeType: 'SERVICE', scopeId: 'svc1' }), { customerId: 'cus_1', serviceId: 'svc2' }, at)).toBe(false);
    expect(windowCovers(mw({ customerId: null, scopeType: 'RESOURCE_TYPE', scopeId: null, resourceType: 'rds' }), { customerId: 'x', resourceType: 'RDS' }, at)).toBe(true);
    expect(windowCovers(mw(), { customerId: 'cus_2' }, at)).toBe(false);
    expect(windowCovers(mw({ scopeType: 'ALERT', scopeId: 'a1' }), { customerId: 'cus_1', alertId: 'a1' }, at)).toBe(true);
  });
  it('validation: 30-day cap, past windows rejected', () => {
    const now = t('2026-11-09T00:00:00Z');
    expect(validateWindow(now, t('2026-12-10T00:00:00Z'), now)).toMatch(/30 days/);
    expect(validateWindow(t('2026-11-01T00:00:00Z'), t('2026-11-02T00:00:00Z'), now)).toMatch(/ended/);
    expect(validateWindow(now, now, now)).toMatch(/after/);
    expect(validateWindow(now, t('2026-11-09T01:00:00Z'), now)).toBeNull();
  });
});
