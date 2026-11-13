/**
 * D-43 contract: what the tick does for a customer that is not ACTIVE. Same tests against the memory store and the
 * SQL store (test/contract.memory.test.ts, packages/store-sql/test/contract.tick.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryTickStore } from '../../src/index.js';
import { PATTERNS, T0, at, seedWorld } from '../world.js';
import { CSim } from './tickContract.js';
import type { MakeFixture, StoreFixture } from './fixture.js';

export function inactiveContract(make: MakeFixture): void {
  let fx: StoreFixture;
  const open = async (seed: MemoryTickStore = seedWorld()): Promise<CSim> => { fx = await make(seed); return new CSim(fx); };
  afterEach(async () => { await fx?.close(); });
  const world = (status?: 'SUSPENDED' | 'TERMINATED'): MemoryTickStore => {
    const s = seedWorld();
    s.configs.push(PATTERNS.rotationThenCustomer(), PATTERNS.customerRotation());
    if (status) s.customers.set('cus_mirae', { ...s.customers.get('cus_mirae')!, status });
    return s;
  };

  describe('inactive customers (D-43)', () => {
    for (const status of ['SUSPENDED', 'TERMINATED'] as const) {
      it(`${status} at open: the incident is recorded with pagingSuppressed, nothing is queued, nobody is paged for hours`, async () => {
        const sim = await open(world(status));
        await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
        await sim.run(180, [], true);
        const inc = await sim.incident();
        expect(inc).toMatchObject({ customerId: 'cus_mirae', status: 'TRIGGERED', pagingSuppressed: 'CUSTOMER_SUSPENDED', nextEscalationAt: null, assignmentSnapshot: null });
        expect(await fx.jobs()).toEqual([]);
        expect(sim.allSent()).toEqual([]);
        expect((await fx.events(inc.id)).map((e) => e.kind)).toEqual(['TRIGGERED', 'NOTE']);
      });
    }

    it('other customers are paged as usual while one is suspended', async () => {
      const sim = await open(world('SUSPENDED'));
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.group({ customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'al_2' }] });
      await sim.run(3, [], true);
      const incs = await fx.incidents();
      expect(incs.find((i) => i.customerId === 'cus_mirae')!.pagingSuppressed).toBe('CUSTOMER_SUSPENDED');
      expect(incs.find((i) => i.customerId === 'cus_hanbit')!.pagingSuppressed ?? null).toBeNull();
      const jobs = await fx.jobs();
      expect(jobs.length).toBeGreaterThan(0);
      expect(jobs.every((j) => j.customerId === 'cus_hanbit')).toBe(true);
    });

    it('suspended after the incident was opened: later steps are not queued (suppressed++), the incident is marked and parked', async () => {
      const sim = await open(world());
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.run(1, [], true);
      const before = await fx.jobs();
      expect(before.length).toBeGreaterThan(0); // step 0 was queued while ACTIVE
      await fx.setCustomerStatus('cus_mirae', 'SUSPENDED');
      sim.now = at(10);
      const r = await sim.tick(['escalation']);
      expect(r.escalation).toMatchObject({ suppressed: 1, escalated: 0 });
      expect(await fx.jobs()).toHaveLength(before.length); // step 1 (at 10 min) was NOT queued
      expect(await sim.incident()).toMatchObject({ pagingSuppressed: 'CUSTOMER_SUSPENDED', nextEscalationAt: null, escalationStep: 1 });
      sim.now = at(11);
      expect((await sim.tick(['escalation'])).escalation).toMatchObject({ checked: 0, suppressed: 0 }); // parked: not looked at again
    });

    it('a page queued while ACTIVE is closed as SKIPPED_CUSTOMER_INACTIVE right before the send when the customer was suspended meanwhile', async () => {
      const sim = await open(world());
      await sim.group({ customerId: 'cus_hanbit', at: T0, alerts: [{ id: 'al_h' }] });
      sim.now = at(1);
      await sim.tick(['group', 'escalation']); // queues the pages, sends nothing
      const queued = (await fx.jobs()).filter((j) => j.status === 'QUEUED');
      expect(queued.length).toBeGreaterThan(0);
      await fx.setCustomerStatus('cus_hanbit', 'TERMINATED');
      sim.now = at(2);
      const r = await sim.tick(['notify']);
      expect(r.notify.skipped).toBe(queued.length);
      expect(sim.allSent()).toEqual([]);
      const after = await fx.jobs();
      expect(after.every((j) => j.status === 'SKIPPED' && j.lastError === 'SKIPPED_CUSTOMER_INACTIVE')).toBe(true);
    });

    it('back to ACTIVE: an incident opened while suspended is NOT paged late; the next event opens a new incident that IS paged', async () => {
      const sim = await open(world('SUSPENDED'));
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.run(5, [], true);
      const silent = await sim.incident();
      expect(silent.pagingSuppressed).toBe('CUSTOMER_SUSPENDED');

      await fx.setCustomerStatus('cus_mirae', 'ACTIVE');
      await sim.run(300);
      expect(await fx.jobs()).toEqual([]);
      expect(sim.allSent()).toEqual([]);
      expect((await fx.incidents())[0]).toMatchObject({ id: silent.id, pagingSuppressed: 'CUSTOMER_SUSPENDED', escalationStep: 0 });

      // the alert fires again after reactivation: not swallowed by the silent incident
      sim.now = at(301);
      await sim.group({ customerId: 'cus_mirae', at: at(301), alerts: [{ id: 'al_1' }] });
      const r = await sim.tick();
      expect(r.group).toMatchObject({ opened: 1, merged: 0 });
      const incs = await fx.incidents();
      expect(incs).toHaveLength(2);
      const fresh = incs.find((i) => i.id !== silent.id)!;
      expect(fresh.pagingSuppressed ?? null).toBeNull();
      expect(fresh.isMergeTarget).toBe(true);
      expect(incs.find((i) => i.id === silent.id)!.isMergeTarget).toBe(false);
      expect((await fx.jobs(fresh.id)).length).toBeGreaterThan(0);
      expect(await fx.jobs(silent.id)).toEqual([]);
    });

    it('an incident that was marked when the customer was suspended stays unpaged after reactivation', async () => {
      const sim = await open(world());
      await sim.group({ customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
      await sim.run(1, [], true);
      await fx.setCustomerStatus('cus_mirae', 'SUSPENDED');
      sim.now = at(10);
      await sim.tick(['escalation']); // marks and parks it
      await fx.setCustomerStatus('cus_mirae', 'ACTIVE');
      const jobsBefore = (await fx.jobs()).length;
      await sim.run(400);
      expect((await fx.jobs()).length).toBe(jobsBefore);
      expect(await sim.incident()).toMatchObject({ pagingSuppressed: 'CUSTOMER_SUSPENDED', escalationStep: 1 });
    });
  });
}
