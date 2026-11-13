import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION, KOREAN_HOLIDAYS, buildDigest, digestWindowFor, dueStages, isBusinessDay, kstDay, latestDigestWindow, previousBusinessDay, retentionConfigFromEnv, retentionSchedule,
  runRetention, maskContactValues, TICK_JOBS, type RetentionRepository,
} from '../src/index.js';

describe('D-46 business days', () => {
  it('weekends and Korean public holidays are not business days', () => {
    expect(isBusinessDay('2026-11-09')).toBe(true); // Monday
    expect(isBusinessDay('2026-11-14')).toBe(false); // Saturday
    expect(isBusinessDay('2026-11-15')).toBe(false); // Sunday
    expect(isBusinessDay('2026-10-09')).toBe(false); // Hangul Day (Friday)
    expect(isBusinessDay('2026-12-25')).toBe(false);
    expect(isBusinessDay('2027-02-09')).toBe(false); // Seollal substitute
    expect(isBusinessDay('2027-12-31')).toBe(true);
    expect(KOREAN_HOLIDAYS.size).toBeGreaterThan(30);
  });
  it('previous business day skips weekends and holidays', () => {
    expect(previousBusinessDay('2026-11-09')).toBe('2026-11-06'); // Monday -> Friday
    expect(previousBusinessDay('2026-10-12')).toBe('2026-10-08'); // after Oct 9 (Fri holiday) + weekend
    expect(previousBusinessDay('2026-09-28')).toBe('2026-09-23'); // after Chuseok 24-26 + weekend
  });
  it('the digest of a business day covers [previous business day 10:00, this day 10:00) KST', () => {
    const w = digestWindowFor('2026-11-09')!;
    expect(w.digestAt.toISOString()).toBe('2026-11-09T01:00:00.000Z');
    expect(w.from.toISOString()).toBe('2026-11-06T01:00:00.000Z'); // the weekend is folded in
    expect(digestWindowFor('2026-11-14')).toBeNull();
  });
  it('latest digest at a given moment: before 10:00 KST it is the previous business day, on a weekend it is Friday', () => {
    expect(latestDigestWindow(new Date('2026-11-09T00:59:00Z')).businessDay).toBe('2026-11-06'); // Mon 09:59 KST
    expect(latestDigestWindow(new Date('2026-11-09T01:00:00Z')).businessDay).toBe('2026-11-09');
    expect(latestDigestWindow(new Date('2026-11-14T05:00:00Z')).businessDay).toBe('2026-11-13'); // Saturday
    expect(latestDigestWindow(new Date('2026-10-09T05:00:00Z')).businessDay).toBe('2026-10-08'); // holiday
  });
  it('buildDigest: counts only, empty flag, ordering', () => {
    const w = digestWindowFor('2026-11-10')!;
    const t = new Date('2026-11-09T05:00:00Z');
    const d = buildDigest(w, {
      suspended: [{ customerId: 'a', customerName: 'A', incidents: 1, firstAt: t, lastAt: t }, { customerId: 'b', customerName: 'B', incidents: 4, firstAt: t, lastAt: t }],
      terminatedResiduals: [],
    });
    expect(d.suspended.map((s) => s.customerId)).toEqual(['b', 'a']);
    expect(d.totals).toEqual({ suspendedIncidents: 5, suspendedCustomers: 2, residualCustomers: 0 });
    expect(d.empty).toBe(false);
    expect(buildDigest(w, { suspended: [], terminatedResiduals: [] }).empty).toBe(true);
  });
});

describe('D-45 retention schedule and config', () => {
  const c = { customerId: 'c', statusChangedAt: new Date('2026-11-01T00:00:00Z'), offboardingCompletedAt: null };
  const at = (days: number) => new Date(c.statusChangedAt.getTime() + days * 86_400_000);
  it('defaults are 30 days / 2 years / 5 years and stages come in order', () => {
    expect(DEFAULT_RETENTION).toEqual({ returnDays: 30, auditDays: 730, slaDays: 1826 });
    expect(dueStages(c, DEFAULT_RETENTION, at(29))).toEqual([]);
    expect(dueStages(c, DEFAULT_RETENTION, at(30))).toEqual(['RETURN_PERIOD']);
    expect(dueStages({ ...c, offboardingCompletedAt: at(1) }, DEFAULT_RETENTION, at(0))).toEqual(['CONNECTIONS']);
    expect(dueStages({ ...c, offboardingCompletedAt: at(1) }, DEFAULT_RETENTION, at(2000))).toEqual(['CONNECTIONS', 'RETURN_PERIOD', 'AUDIT_EXPIRY', 'SLA_EXPIRY']);
    expect(retentionSchedule(c.statusChangedAt, DEFAULT_RETENTION).returnPeriodEndsAt).toEqual(at(30));
  });
  it('env override: whole numbers >= 1 and ordered; anything else keeps the defaults', () => {
    expect(retentionConfigFromEnv({ RETENTION_RETURN_DAYS: '45', RETENTION_AUDIT_DAYS: '1000', RETENTION_SLA_DAYS: '3000' })).toEqual({ returnDays: 45, auditDays: 1000, slaDays: 3000 });
    expect(retentionConfigFromEnv({ RETENTION_RETURN_DAYS: '0' })).toEqual(DEFAULT_RETENTION);
    expect(retentionConfigFromEnv({ RETENTION_RETURN_DAYS: 'abc', RETENTION_SLA_DAYS: '-5' })).toEqual(DEFAULT_RETENTION);
    expect(retentionConfigFromEnv({ RETENTION_RETURN_DAYS: '900' })).toEqual(DEFAULT_RETENTION); // return > audit: refused as a whole
    expect(retentionConfigFromEnv({})).toEqual(DEFAULT_RETENTION);
    // floors 7 / 90 / 365 (R-3): below the floor is ignored with a warning
    const warns: string[] = [];
    expect(retentionConfigFromEnv({ RETENTION_RETURN_DAYS: '6' }, (m) => warns.push(m))).toEqual(DEFAULT_RETENTION);
    expect(retentionConfigFromEnv({ RETENTION_AUDIT_DAYS: '89' }, (m) => warns.push(m))).toEqual(DEFAULT_RETENTION);
    expect(retentionConfigFromEnv({ RETENTION_SLA_DAYS: '364' }, (m) => warns.push(m))).toEqual(DEFAULT_RETENTION);
    expect(warns).toHaveLength(3);
    expect(retentionConfigFromEnv({ RETENTION_RETURN_DAYS: '7', RETENTION_AUDIT_DAYS: '90', RETENTION_SLA_DAYS: '365' })).toEqual({ returnDays: 7, auditDays: 90, slaDays: 365 });
    expect(maskContactValues({ a: { email: 'x', ok: 1 }, list: [{ phone: '1', k: 2 }], name: 'n' })).toEqual({ a: { ok: 1 }, list: [{ k: 2 }] });
  });
  it('KST day boundary is 15:00 UTC', () => {
    expect(kstDay(new Date('2026-11-09T14:59:00Z'))).toBe('2026-11-09');
    expect(kstDay(new Date('2026-11-09T15:00:00Z'))).toBe('2026-11-10');
  });
  it('retention is a tick job, last in the list', () => { expect(TICK_JOBS[TICK_JOBS.length - 1]).toBe('retention'); });
});

describe('runRetention', () => {
  const stub = (over: Partial<RetentionRepository> = {}): { repo: Partial<RetentionRepository>; calls: string[] } => {
    const calls: string[] = [];
    const repo: Partial<RetentionRepository> = {
      claimRetentionDay: async (d) => { calls.push(`claim ${d}`); return true; },
      finishRetentionDay: async (d) => { calls.push(`finish ${d}`); },
      releaseRetentionDay: async (d) => { calls.push(`release ${d}`); },
      retentionCandidates: async () => [{ customerId: 'a', statusChangedAt: new Date('2020-01-01T00:00:00Z'), offboardingCompletedAt: null }, { customerId: 'b', statusChangedAt: new Date('2020-01-01T00:00:00Z'), offboardingCompletedAt: null }],
      runRetentionStage: async (c, s) => { calls.push(`${c} ${s}`); return { counts: { X: 2 }, partial: false }; },
      ...over,
    };
    return { repo, calls };
  };
  const now = new Date('2026-11-09T03:00:00Z');
  const far = Date.now() + 60_000;
  it('claims the KST day once, runs due stages per customer in order', async () => {
    const { repo, calls } = stub();
    const r = await runRetention(repo, DEFAULT_RETENTION, now, { deadlineMs: far });
    expect(calls).toEqual(['claim 2026-11-09', 'a RETURN_PERIOD', 'a AUDIT_EXPIRY', 'a SLA_EXPIRY', 'b RETURN_PERIOD', 'b AUDIT_EXPIRY', 'b SLA_EXPIRY', 'finish 2026-11-09']);
    expect(r).toMatchObject({ ran: true, customers: 2, stages: 6, rows: 12, partial: false });
  });
  it('an already claimed day does nothing; a store without retention is skipped', async () => {
    expect(await runRetention(stub({ claimRetentionDay: async () => false }).repo, DEFAULT_RETENTION, now, { deadlineMs: far })).toMatchObject({ ran: false, skipped: 'already-ran' });
    expect(await runRetention({}, DEFAULT_RETENTION, now, { deadlineMs: far })).toMatchObject({ ran: false, skipped: 'unsupported' });
  });
  it('one customer failing does not stop the next; a partial stage gives the day back', async () => {
    const f = stub({ runRetentionStage: async (c) => { if (c === 'a') throw new Error('boom'); return { counts: { X: 1 }, partial: false }; } });
    const r = await runRetention(f.repo, DEFAULT_RETENTION, now, { deadlineMs: far });
    expect(r.errors).toEqual([{ customerId: 'a', stage: 'RETURN_PERIOD', message: 'boom' }]);
    expect(r.customers).toBe(2);
    expect(f.calls).not.toContain('release 2026-11-09');
    const p = stub({ runRetentionStage: async () => ({ counts: { X: 1 }, partial: true }) });
    const r2 = await runRetention(p.repo, DEFAULT_RETENTION, now, { deadlineMs: far });
    expect(r2.partial).toBe(true);
    expect(p.calls).toContain('release 2026-11-09');
  });
});
