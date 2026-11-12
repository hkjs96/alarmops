/**
 * Contract of the ingest repositories (SourceRepository + AlertRepository): the SAME tests run against MemoryStore
 * (test/contract.memory.test.ts) and the SQL store (packages/store-sql/test/contract.ingest.test.ts).
 * Direct repository semantics first (dedup, tenant identity, versions, one OPEN group per key), then the real
 * consumer (processMessage) end to end on the store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeCloudWatch, type CloudWatchEventBridgeEvent, type GroupRow, type MaintenanceWindow, type NormalizedEvent, type Severity } from '@alarmops/core';
import { processMessage } from '../../src/consumer.js';
import type { AlertRepository, AlertRow, IntegrationSourceRow, SourceRepository } from '../../src/ports.js';
import { coreFixture, FakeQueue, sha } from '../helpers.js';

export interface IngestSeed {
  customers: string[];
  sources: IntegrationSourceRow[];
  accounts: Array<[awsAccountId: string, customerId: string]>;
  severity: Record<string, Severity>;
  windows: MaintenanceWindow[];
}
export interface IngestFixture {
  repo: AlertRepository & SourceRepository;
  counts(): Promise<{ rawEvents: number; alerts: number; groups: number; rejections: number }>;
  rawEvent(id: string): Promise<{ decision: string | null; decisionReason: string | null; groupId: string | null; alertId: string } | null>;
  sourceLastReceivedAt(id: string): Promise<Date | null>;
  close(): Promise<void>;
}
export type MakeIngestFixture = (seed: IngestSeed) => Promise<IngestFixture>;

const TOKEN = 'in_' + 'c'.repeat(40);
const SEED: IngestSeed = {
  customers: ['cus_1', 'cus_2'],
  sources: [
    { id: 'src_prom', customerId: 'cus_1', kind: 'PROMETHEUS', tokenHash: sha(TOKEN), enabled: true, allowQueryToken: false },
    { id: 'src_off', customerId: 'cus_2', kind: 'GRAFANA', tokenHash: sha('in_' + 'd'.repeat(40)), enabled: false, allowQueryToken: true },
  ],
  accounts: [['123456789012', 'cus_1']],
  severity: { critical: 'SEV_2', warning: 'SEV_3' },
  windows: [],
};

const cw = (id = 'ev-1', account = '123456789012', iso = '2026-11-09T03:12:00Z'): NormalizedEvent => {
  const e = coreFixture<CloudWatchEventBridgeEvent>('cloudwatch-managed.json');
  e.account = account; e.id = id; e.time = iso;
  e.detail.state = { ...e.detail.state, value: 'ALARM', timestamp: iso };
  e.detail.previousState = { value: 'OK' };
  return normalizeCloudWatch(e, { customerForAccount: (a) => (a === '123456789012' ? 'cus_1' : null), receivedAt: new Date(iso) });
};
const alertOf = (ev: NormalizedEvent, id: string): AlertRow => ({
  id, fingerprint: ev.fingerprint, fingerprintVersion: ev.fingerprintVersion, customerId: ev.customerId, sourceId: ev.sourceId, source: ev.source,
  awsAccountId: ev.awsAccountId, region: ev.region, resourceType: ev.resource?.type ?? null, metricKey: ev.metric?.key ?? null, namespace: ev.metric?.namespace ?? null,
  title: ev.title, status: 'FIRING', severity: ev.severity, severityRaw: ev.severityRaw, value: 91.5, threshold: 80, comparison: 'GreaterThanThreshold',
  lastNotifiedAt: null, episodeOpen: false, episodeStartedAt: null, episodeNotified: false, recentEpisodes: [], quarantinedUntil: null,
  fireCount: 0, firstSeenAt: new Date('2026-11-09T03:12:00Z'), lastEventAt: new Date('2026-11-09T03:12:00Z'), version: 0,
});
const group = (id: string, key: string, customerId: string | null): GroupRow => ({
  id, groupKey: key, customerId, severity: 'SEV_3', status: 'OPEN', openedAt: new Date('2026-11-09T03:12:00Z'), groupWaitSec: 30,
  closeAt: new Date('2026-11-09T03:12:30Z'), closedAt: null, pauseUntil: null, staleAfter: new Date('2026-11-09T03:20:00Z'), deliveredAt: null, version: 0,
});

export function ingestContract(make: MakeIngestFixture): void {
  let fx: IngestFixture;
  afterEach(async () => { await fx?.close(); });

  describe('SourceRepository', () => {
    it('finds a source by token hash only; unknown hash → null; account map; severity table; rejections; touch', async () => {
      fx = await make(SEED);
      expect(await fx.repo.findSourceByTokenHash(sha(TOKEN))).toEqual(SEED.sources[0]);
      expect(await fx.repo.findSourceByTokenHash(sha('nope'))).toBeNull();
      expect((await fx.repo.findSourceByTokenHash(SEED.sources[1]!.tokenHash!))?.enabled).toBe(false);
      expect(await fx.repo.customerForAccount('123456789012')).toBe('cus_1');
      expect(await fx.repo.customerForAccount('999999999999')).toBeNull();
      expect(await fx.repo.severityTable()).toMatchObject({ critical: 'SEV_2', warning: 'SEV_3' });
      await fx.repo.recordRejection({ customerId: null, sourceId: null, kind: 'WEBHOOK', reason: 'bad_token', title: 'x' });
      expect((await fx.counts()).rejections).toBe(1);
      const t = new Date('2026-11-09T03:13:00Z');
      await fx.repo.touchSource('src_prom', t);
      expect((await fx.sourceLastReceivedAt('src_prom'))?.toISOString()).toBe(t.toISOString());
    });
  });

  describe('AlertRepository', () => {
    it('alert identity is (customer, fingerprint): the same fingerprint in another scope is another alert, unmapped included', async () => {
      fx = await make(SEED);
      const ev = cw();
      const a = await fx.repo.createAlert(alertOf(ev, 'al_a'));
      expect(a).toMatchObject({ id: 'al_a', customerId: 'cus_1', value: 91.5, threshold: 80 });
      expect(await fx.repo.createAlert(alertOf(ev, 'al_a2'))).toBe('EXISTS');
      const unmapped = { ...alertOf(ev, 'al_u'), customerId: null };
      expect(await fx.repo.createAlert(unmapped)).not.toBe('EXISTS');
      expect(await fx.repo.createAlert({ ...unmapped, id: 'al_u2' })).toBe('EXISTS'); // NULLS NOT DISTINCT
      expect((await fx.repo.findAlert(null, ev.fingerprint))?.id).toBe('al_u');
      expect((await fx.repo.findAlert('cus_2', ev.fingerprint))).toBeNull();
      expect(await fx.repo.findAlertInOtherScope('cus_2', ev.fingerprint)).not.toBeNull();
    });

    it('updates are versioned; dates and arrays survive the round trip', async () => {
      fx = await make(SEED);
      const ev = cw();
      const a = (await fx.repo.createAlert(alertOf(ev, 'al_a'))) as AlertRow;
      const ep = new Date('2026-11-09T03:12:00Z');
      const next = await fx.repo.updateAlert({ ...a, episodeOpen: true, episodeStartedAt: ep, recentEpisodes: [ep], lastNotifiedAt: ep, fireCount: 1 }, 0);
      expect(next).toMatchObject({ version: 1, episodeOpen: true, fireCount: 1 });
      expect(await fx.repo.updateAlert({ ...a, fireCount: 9 }, 0)).toBe('CONFLICT');
      const read = await fx.repo.findAlert('cus_1', ev.fingerprint);
      expect(read?.recentEpisodes.map((d) => d.toISOString())).toEqual([ep.toISOString()]);
      expect(read?.episodeStartedAt?.toISOString()).toBe(ep.toISOString());
      // B-4: an update cannot move an alert to another customer
      expect(await fx.repo.updateAlert({ ...read!, customerId: 'cus_2' }, 1)).toBe('CONFLICT');
    });

    it('raw events are inserted once per dedup key; decisions are recorded', async () => {
      fx = await make(SEED);
      const ev = cw();
      await fx.repo.createAlert(alertOf(ev, 'al_a'));
      const r = await fx.repo.insertRawEvent(ev, 'al_a');
      expect(r).not.toBe('DUPLICATE');
      expect(await fx.repo.insertRawEvent(ev, 'al_a')).toBe('DUPLICATE');
      const id = (r as { id: string }).id;
      await fx.repo.setRawEventDecision(id, { decision: 'SUPPRESS', decisionReason: 'dedup', groupId: null });
      expect(await fx.rawEvent(id)).toMatchObject({ decision: 'SUPPRESS', decisionReason: 'dedup', groupId: null, alertId: 'al_a' });
    });

    it('one OPEN group per key; close only while OPEN; stale replacement', async () => {
      fx = await make(SEED);
      expect(await fx.repo.createGroup(group('g-1', 'cus_1#SEV-3', 'cus_1'))).toMatchObject({ id: 'g-1' });
      expect(await fx.repo.createGroup(group('g-2', 'cus_1#SEV-3', 'cus_1'))).toBe('EXISTS');
      expect(await fx.repo.groupIdExists('g-1')).toBe(true);
      expect(await fx.repo.groupIdExists('g-2')).toBe(false);
      expect((await fx.repo.findOpenGroup('cus_1#SEV-3'))?.id).toBe('g-1');
      expect(await fx.repo.createGroup(group('g-3', 'cus_1#SEV-3', 'cus_1'), 'g-1')).toMatchObject({ id: 'g-3' });
      expect((await fx.repo.findOpenGroup('cus_1#SEV-3'))?.id).toBe('g-3');
      const t = new Date('2026-11-09T03:12:31Z');
      expect(await fx.repo.closeGroup('g-3', t)).toBe(true);
      expect(await fx.repo.closeGroup('g-3', t)).toBe(false);
      expect(await fx.repo.findOpenGroup('cus_1#SEV-3')).toBeNull();
    });

    it('policy and maintenance windows load', async () => {
      const w: MaintenanceWindow = { id: 'mw_1', customerId: 'cus_1', scopeType: 'CUSTOMER', scopeId: 'cus_1', resourceType: null, startsAt: new Date('2026-11-09T03:00:00Z'), endsAt: new Date('2026-11-09T04:00:00Z'), revokedAt: null } as MaintenanceWindow;
      fx = await make({ ...SEED, windows: [w] });
      expect((await fx.repo.loadPolicy()).groupWaitSec).toBeGreaterThan(0);
      const ws = await fx.repo.activeMaintenance('cus_1', new Date('2026-11-09T03:30:00Z'));
      expect(ws.map((x) => x.id)).toEqual(['mw_1']);
      expect(await fx.repo.activeMaintenance('cus_2', new Date('2026-11-09T03:30:00Z'))).toEqual([]);
    });
  });

  describe('consumer on the store', () => {
    it('first fire → NOTIFY + group; redelivery is a no-op; an unmapped account opens its own alert', async () => {
      fx = await make(SEED);
      const queue = new FakeQueue();
      const deps = { repo: fx.repo, queue, now: () => new Date('2026-11-09T03:12:01Z') };
      const ev = cw();
      const out = await processMessage(ev, deps);
      expect(out).toMatchObject({ kind: 'PROCESSED', decision: 'NOTIFY', openedGroup: true });
      expect((await processMessage(ev, deps)).kind).toBe('DUPLICATE');
      expect(await fx.counts()).toMatchObject({ rawEvents: 1, alerts: 1, groups: 1 });
      const alert = await fx.repo.findAlert('cus_1', ev.fingerprint);
      expect(alert).toMatchObject({ status: 'FIRING', episodeOpen: true, fireCount: 1, version: 1 });
      const other = await processMessage(cw('ev-2', '999999999999'), deps);
      expect(other).toMatchObject({ kind: 'PROCESSED' });
      expect((await fx.counts()).alerts).toBe(2);
      expect(queue.take().filter((m) => 'type' in m.body && m.body.type === 'GROUP_CLOSE').length).toBeGreaterThanOrEqual(1);
    });
  });
}
