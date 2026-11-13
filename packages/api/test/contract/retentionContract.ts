/**
 * D-45 / D-46 contract: the retention job, legal hold, purge log, CSV export and digest, through the real handlers and
 * `runTick`. The SAME tests run against MemoryApiStore and the SQL store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { T0 } from '../../../core/test/world.js';
import { USERS, body } from '../helpers.js';
import { cworld, type CWorld, type MakeApiFixture } from './apiContract.js';
import type { MemoryApiStore } from '../../src/index.js';

const DAY = 86_400_000;
const day = (n: number): Date => new Date(T0.getTime() + n * DAY);

export function retentionContract(make: MakeApiFixture): void {
  let w: CWorld;
  const open = async (extra?: (s: MemoryApiStore) => void): Promise<CWorld> => (w = await cworld(make, extra));
  afterEach(async () => { await w?.fx.close(); });

  const terminate = async (cid = 'cus_mirae', name = 'Mirae Pay') => {
    const r = await w.call(USERS.minjae, 'PATCH', `/customers/${cid}/status`, { headers: { 'if-match': '0' }, body: { status: 'TERMINATED', reason: 'contract ended', confirmName: name } });
    expect(r.status).toBe(200);
  };
  const completeOffboarding = async (cid = 'cus_mirae') => {
    await w.fx.repo.recordOffboardPublishFailure(cid, await w.fx.repo.cloudAccountIds(cid), w.sim.now);
    for (const key of ['PAGING_STOPPED', 'ALARMS_DELETED', 'CUSTOMER_STACK_REMOVED', 'ACCOUNTS_DISABLED', 'BUS_ALLOWLIST_REMOVED']) {
      const r = await w.call(USERS.minjae, 'PATCH', `/customers/${cid}/offboarding`, { body: { key, state: 'DONE', detail: 'checked by hand' } });
      expect(r.status).toBe(200);
    }
    expect(body(await w.call(USERS.minjae, 'GET', `/customers/${cid}/offboarding`)).completedAt).toEqual(expect.any(String));
  };
  const retain = async (at: Date) => { w.sim.now = at; return w.sim.tick(['retention']); };
  const log = async (cid = 'cus_mirae') => body(await w.call(USERS.minjae, 'GET', `/customers/${cid}/purge-log`));
  const stages = async (cid = 'cus_mirae') => (await log(cid)).entries.map((e: any) => e.stage);
  const mirae = async () => (await w.fx.incidents()).filter((i) => i.customerId === 'cus_mirae');
  const hanbit = async () => (await w.fx.incidents()).filter((i) => i.customerId === 'cus_hanbit');

  describe('retention job (D-45)', () => {
    it('does nothing for ACTIVE and SUSPENDED customers, however old the data', async () => {
      await open();
      await w.fx.setCustomerStatus('cus_hanbit', 'SUSPENDED');
      const s = await retain(day(4000));
      expect(s.retention).toMatchObject({ ran: true, customers: 0 });
      expect((await mirae())[0]!.title).not.toBe('[purged]');
      expect((await hanbit())[0]!.title).not.toBe('[purged]');
      expect(await stages()).toEqual([]);
    });

    it('stages in order: connections at offboarding completion, content at +30 days, audit at +2 years, SLA at +5 years; other customers untouched', async () => {
      await open();
      const ack = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'if-match': await w.version(w.ids.mirae) } });
      expect(ack.status).toBe(200);
      await w.fx.repo.recordAudit({ at: T0, customerId: 'cus_mirae', actorType: 'USER', actorId: 'usr_minjae', action: 'responders.add', targetType: 'Responders', targetId: 'cus_mirae', before: { version: 0 }, after: { version: 1 } });
      await w.fx.repo.recordAudit({ at: T0, customerId: 'cus_mirae', actorType: 'USER', actorId: 'usr_minjae', action: 'contact.update', targetType: 'Contact', targetId: 'ct_seojun', before: { email: 'a@b.c', active: true }, after: { phone: '+821012345678', active: false } });
      await w.fx.repo.recordAudit({ at: T0, customerId: 'cus_hanbit', actorType: 'USER', actorId: 'usr_minjae', action: 'contact.update', targetType: 'Contact', targetId: 'ct_sora', before: { email: 'h@b.c' }, after: null });
      const hanbitJobs = (await w.fx.jobs()).filter((j) => j.customerId === 'cus_hanbit').length;
      expect(hanbitJobs).toBeGreaterThan(0);
      await terminate();
      // Before the offboarding is complete only the time-based stages could run, and none is due yet.
      expect((await retain(day(1))).retention).toMatchObject({ ran: true, customers: 1, stages: 0 });
      expect(await stages()).toEqual([]);

      await completeOffboarding();
      // Same KST day as the run above: the day is claimed, nothing happens.
      expect((await retain(new Date(day(1).getTime() + 3600_000))).retention).toBeUndefined();
      expect(await stages()).toEqual([]);
      const next = await retain(day(2));
      expect(next.retention).toMatchObject({ ran: true, stages: 1 });
      expect(await stages()).toEqual(['CONNECTIONS']);
      expect((await log()).entries[0]).toMatchObject({ stage: 'CONNECTIONS', actor: 'system', counts: expect.objectContaining({ CloudAccount: 1 }) });
      expect((await mirae())[0]!.title).not.toBe('[purged]'); // content is kept for the return period

      // Rerun the same day: claimed, nothing new.
      const again = await retain(new Date(day(2).getTime() + 60_000));
      expect(again.retention).toBeUndefined();
      expect(await stages()).toEqual(['CONNECTIONS']);

      // +31 days: contacts, portal users, content; incidents become SLA records.
      await retain(day(32));
      expect(await stages()).toEqual(['CONNECTIONS', 'RETURN_PERIOD']);
      const rp = (await log()).entries[1];
      expect(rp.counts).toMatchObject({ Contact: 2, User: 1 });
      expect(rp.counts.Incident).toBeGreaterThan(0);
      const m = (await mirae())[0]!;
      expect(m).toMatchObject({ title: '[purged]', accountIds: [], resourceTypes: [], status: 'ACKNOWLEDGED', acknowledgedBy: 'Responder 1' });
      expect(m.acknowledgedAt).toBeInstanceOf(Date);
      expect(m.triggeredAt).toEqual(T0);
      expect((await w.fx.jobs()).filter((j) => j.incidentId === m.id)).toEqual([]);
      expect(await w.fx.events(m.id)).toEqual([]);
      expect(await w.fx.repo.getContact('ct_seojun')).toBeNull();
      expect(await w.fx.repo.getContact('ct_yuna')).toBeNull();
      expect(await w.fx.repo.getContact('ct_haeun')).not.toBeNull(); // MSP staff are not customer data
      const contactAudit = (await w.fx.audits()).find((a) => a.customerId === 'cus_mirae' && a.targetType === 'Contact')!;
      expect(contactAudit.before).toEqual({ active: true });
      expect(contactAudit.after).toEqual({ active: false });
      // Hanbit: nothing of the above happened.
      expect((await hanbit())[0]!.title).not.toBe('[purged]');
      expect((await w.fx.jobs()).filter((j) => j.customerId === 'cus_hanbit')).toHaveLength(hanbitJobs);
      expect(await w.fx.repo.getContact('ct_sora')).not.toBeNull();
      expect((await w.fx.audits()).find((a) => a.customerId === 'cus_hanbit' && a.targetType === 'Contact')!.before).toEqual({ email: 'h@b.c' });
      expect(await stages('cus_hanbit')).toEqual([]);

      // Idempotent: a later day with nothing left to do adds no log row.
      await retain(day(33));
      expect(await stages()).toEqual(['CONNECTIONS', 'RETURN_PERIOD']);

      // +2 years: audit goes, except the protected target types (the status version is a COUNT of its rows).
      const versionBefore = body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/status')).version;
      await retain(day(740));
      expect(await stages()).toEqual(['CONNECTIONS', 'RETURN_PERIOD', 'AUDIT_EXPIRY']);
      const left = (await w.fx.audits()).filter((a) => a.customerId === 'cus_mirae').map((a) => a.targetType);
      expect(left.every((t) => t === 'CustomerStatus' || t === 'Responders')).toBe(true);
      expect(left).toContain('Responders');
      expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/status')).version).toBe(versionBefore);
      expect((await w.fx.audits()).filter((a) => a.customerId === 'cus_hanbit' && a.targetType === 'Contact')).toHaveLength(1);
      expect(await mirae()).toHaveLength(1);

      // +5 years: the SLA records.
      await retain(day(1900));
      expect(await stages()).toEqual(['CONNECTIONS', 'RETURN_PERIOD', 'AUDIT_EXPIRY', 'SLA_EXPIRY']);
      expect(await mirae()).toEqual([]);
      expect(await hanbit()).toHaveLength(1);
      expect(await stages('cus_hanbit')).toEqual([]);
    });

    it('legal hold stops every stage; releasing it lets the next daily run catch up', async () => {
      await open();
      await terminate();
      await completeOffboarding();
      const put = (who: any, b: unknown) => w.call(who, 'PUT', '/customers/cus_mirae/legal-hold', { body: b });
      expect(body(await put(USERS.minjae, { reason: 'dispute with customer' }))).toMatchObject({ legalHold: { active: true, byUserId: 'usr_minjae', reason: 'dispute with customer' }, changed: true });
      const s = await retain(day(60));
      expect(s.retention).toMatchObject({ ran: true, customers: 0 });
      expect(await stages()).toEqual(['LEGAL_HOLD_SET']);
      expect((await mirae())[0]!.title).not.toBe('[purged]');
      const del = await w.call(USERS.minjae, 'DELETE', '/customers/cus_mirae/legal-hold', { body: { reason: 'settled' } });
      expect(body(del)).toMatchObject({ legalHold: { active: false }, changed: true });
      await retain(day(61));
      expect(await stages()).toEqual(['LEGAL_HOLD_SET', 'LEGAL_HOLD_RELEASED', 'CONNECTIONS', 'RETURN_PERIOD']);
      expect((await mirae())[0]!.title).toBe('[purged]');
    });
  });

  describe('legal hold and purge log API', () => {
    it('ADMIN only, reason required, audited, idempotent; portal users and unknown customers get the same 404', async () => {
      await open();
      const put = (who: any, b: unknown, cid = 'cus_mirae') => w.call(who, 'PUT', `/customers/${cid}/legal-hold`, { body: b, requestId: 'req_same' });
      expect((await put(USERS.haeun, { reason: 'x' })).status).toBe(403);
      expect((await put(USERS.viewer, { reason: 'x' })).status).toBe(403);
      const a = await put(USERS.yuna, { reason: 'x' });
      const b = await put(USERS.minjae, { reason: 'x' }, 'cus_nope');
      expect(a.status).toBe(404);
      expect(a.body).toEqual(b.body);
      for (const bad of [undefined, {}, { reason: '   ' }, { reason: 5 }, { reason: 'x'.repeat(501) }]) {
        const r = await put(USERS.minjae, bad);
        expect(r.status, JSON.stringify(bad)).toBe(400);
      }
      expect((await w.fx.audits()).filter((x) => x.targetType === 'CustomerLegalHold')).toEqual([]);
      expect(body(await put(USERS.minjae, { reason: 'court order 2026-11-13' }))).toMatchObject({ changed: true });
      expect(body(await put(USERS.minjae, { reason: 'again' }))).toMatchObject({ changed: false, legalHold: { active: true, reason: 'court order 2026-11-13' } });
      const audits = (await w.fx.audits()).filter((x) => x.targetType === 'CustomerLegalHold');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ customerId: 'cus_mirae', actorId: 'usr_minjae', action: 'customer.legal_hold.set', after: { legalHold: true, reason: 'court order 2026-11-13' } });
      expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_hanbit/purge-log')).legalHold).toEqual({ active: false });
      expect((await w.call(USERS.minjae, 'DELETE', '/customers/cus_hanbit/legal-hold')).status).toBe(200); // not held: no-op
      expect((await w.fx.audits()).filter((x) => x.customerId === 'cus_hanbit' && x.targetType === 'CustomerLegalHold')).toEqual([]);
    });

    it('purge-log: ADMIN only, scoped to the customer, with the schedule once TERMINATED', async () => {
      await open();
      expect((await w.call(USERS.haeun, 'GET', '/customers/cus_mirae/purge-log')).status).toBe(403);
      expect((await w.call(USERS.yuna, 'GET', '/customers/cus_mirae/purge-log')).status).toBe(404);
      expect((await w.call(USERS.yuna, 'GET', '/customers/cus_hanbit/purge-log')).status).toBe(404);
      expect(body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/purge-log'))).toMatchObject({ customer: { id: 'cus_mirae', status: 'ACTIVE' }, entries: [], schedule: null });
      await terminate();
      const l = body(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/purge-log'));
      expect(l.schedule).toMatchObject({ returnDays: 30, auditDays: 730, slaDays: 1826 });
      expect(new Date(l.schedule.returnPeriodEndsAt).getTime() - new Date(l.customer.statusChangedAt).getTime()).toBe(30 * DAY);
    });
  });

  describe('incident history export (D-45)', () => {
    const get = (who: any, cid = 'cus_mirae') => w.call(who, 'GET', `/customers/${cid}/export.csv`);
    const text = async (r: Awaited<ReturnType<typeof get>>): Promise<string> => { let t = ''; for await (const c of r.stream!) t += c; return t; };

    it('only for a TERMINATED customer, only by ADMIN, only inside the return period (410 after); streamed, tenant-scoped, audited', async () => {
      await open();
      const active = await get(USERS.minjae);
      expect(active.status).toBe(409); // ACTIVE
      expect(body(active).error.code).toBe('CUSTOMER_NOT_TERMINATED');
      await terminate();
      expect((await get(USERS.haeun)).status).toBe(403);
      expect((await get(USERS.yuna)).status).toBe(404);
      expect((await get(USERS.minjae, 'cus_nope')).status).toBe(404);
      const r = await get(USERS.minjae);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(r.headers['content-disposition']).toContain('attachment');
      expect(r.body).toBeUndefined();
      const csv = await text(r);
      const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0]).toBe('number,id,title,severity,status,triggeredAt,acknowledgedAt,resolvedAt,mttaSec,mttrSec,memberCount,eventCount,accountIds,resourceTypes,pagingSuppressed');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(w.ids.mirae);
      expect(csv).not.toContain(w.ids.hanbit); // other tenants never appear
      expect(csv).not.toContain('shop-db');
      expect((await w.fx.audits()).filter((a) => a.action === 'customer.export')).toMatchObject([{ customerId: 'cus_mirae', actorId: 'usr_minjae', after: { format: 'csv', incidents: 1 } }]);
      // 29 days after termination still open, 31 days closed.
      const t0 = w.sim.now.getTime();
      w.sim.now = new Date(t0 + 29 * DAY);
      expect((await get(USERS.minjae)).status).toBe(200);
      w.sim.now = new Date(t0 + 31 * DAY);
      const late = await get(USERS.minjae);
      expect(late.status).toBe(410);
      expect(body(late).error.code).toBe('EXPORT_WINDOW_CLOSED');
      expect(late.stream).toBeUndefined();
    });
  });

  describe('digest (D-46)', () => {
    it('GET /digests/latest: staff only; suspended-customer incidents and terminated residuals, counts only', async () => {
      await open();
      expect((await w.call(USERS.yuna, 'GET', '/digests/latest')).status).toBe(404);
      await w.fx.setCustomerStatus('cus_hanbit', 'SUSPENDED');
      await w.sim.group({ customerId: 'cus_hanbit', at: w.sim.now, severity: 'SEV_2', alerts: [{ id: 'al_h9', title: 'secret-db down' }] });
      w.sim.now = new Date(T0.getTime() + 60_000);
      await w.sim.tick(['group']);
      await terminate();
      await w.fx.addResidual('cus_mirae', 'aws:111111111111', 7, new Date(T0.getTime() + 60_000));
      // T0 is Monday 12:00 KST; the digest of Tuesday 10:00 KST covers [Mon 10:00, Tue 10:00).
      w.sim.now = new Date('2026-11-10T02:00:00Z');
      const d = body(await w.call(USERS.viewer, 'GET', '/digests/latest'));
      expect(d).toMatchObject({ businessDay: '2026-11-10', digestAt: '2026-11-10T01:00:00.000Z', from: '2026-11-09T01:00:00.000Z', to: '2026-11-10T01:00:00.000Z', empty: false });
      expect(d.suspended).toMatchObject([{ customerId: 'cus_hanbit', customerName: 'Hanbit Retail', incidents: 1 }]);
      expect(d.terminatedResiduals).toMatchObject([{ customerId: 'cus_mirae', sources: 1, totalEvents: 7 }]);
      expect(JSON.stringify(d)).not.toContain('secret-db');
      // B-1: narrowed MSP staff see only their own customers in the digest (no names, counts or ids of the others).
      const onlyHanbit = { ...USERS.haeun, customerIds: ['cus_hanbit'] };
      const h = body(await w.call(onlyHanbit, 'GET', '/digests/latest'));
      expect(h.suspended).toHaveLength(1);
      expect(h.terminatedResiduals).toEqual([]);
      expect(JSON.stringify(h)).not.toMatch(/Mirae|cus_mirae/);
      const onlyMirae = { ...USERS.haeun, customerIds: ['cus_mirae'] };
      const m = body(await w.call(onlyMirae, 'GET', '/digests/latest'));
      expect(m.suspended).toEqual([]);
      expect(m.terminatedResiduals).toHaveLength(1);
      expect(JSON.stringify(m)).not.toMatch(/Hanbit|cus_hanbit/);
      const none = body(await w.call({ ...USERS.haeun, customerIds: [] }, 'GET', '/digests/latest'));
      expect(none).toMatchObject({ suspended: [], terminatedResiduals: [], empty: true });
      // sub-scoped staff do not see whole-customer residuals
      const sub = { ...USERS.haeun, customerIds: ['cus_mirae'], subScopes: [{ customerId: 'cus_mirae', projectId: 'prj_data' }] };
      expect(body(await w.call(sub, 'GET', '/digests/latest')).terminatedResiduals).toEqual([]);
      // The window moves on: the day after, the same events are not repeated.
      w.sim.now = new Date('2026-11-11T02:00:00Z');
      expect(body(await w.call(USERS.viewer, 'GET', '/digests/latest'))).toMatchObject({ businessDay: '2026-11-11', suspended: [], terminatedResiduals: [], empty: true });
    });
  });
}
