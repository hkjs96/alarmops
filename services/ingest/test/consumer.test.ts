import { describe, expect, it } from 'vitest';
import { normalizeCloudWatch, type CloudWatchEventBridgeEvent, type NormalizedEvent } from '@alarmops/core';
import { AccountCustomerCache } from '../src/accountCache.js';
import { makeConsumerHandler, processMessage } from '../src/consumer.js';
import { makeEventBridgeHandler } from '../src/eventbridge.js';
import { coreFixture, FakeQueue, store } from './helpers.js';

const cw = (over: (e: CloudWatchEventBridgeEvent) => void = () => {}, account = '123456789012'): NormalizedEvent => {
  const e = coreFixture<CloudWatchEventBridgeEvent>('cloudwatch-managed.json');
  e.account = account;
  over(e);
  return normalizeCloudWatch(e, { customerForAccount: (a) => (a === '123456789012' ? 'cus_1' : null), receivedAt: new Date(e.time) });
};
const at = (e: CloudWatchEventBridgeEvent, iso: string, id: string, value = 'ALARM', prev = 'OK') => {
  e.time = iso; e.id = id; e.detail.state = { ...e.detail.state, value, timestamp: iso }; e.detail.previousState = { value: prev };
};
const setup = (wall = '2026-11-09T03:12:01Z') => {
  const repo = store();
  const queue = new FakeQueue();
  return { repo, queue, deps: { repo, queue, now: () => new Date(wall) } };
};

describe('alert consumer', () => {
  it('first fire → NOTIFY, alert row, group opened, delayed GROUP_CLOSE queued', async () => {
    const { repo, queue, deps } = setup();
    const out = await processMessage(cw(), deps);
    expect(out).toMatchObject({ kind: 'PROCESSED', decision: 'NOTIFY', reason: 'notify', openedGroup: true });
    const alert = [...repo.alerts.values()][0]!;
    expect(alert).toMatchObject({ status: 'FIRING', episodeOpen: true, episodeNotified: true, fireCount: 1, customerId: 'cus_1', version: 1 });
    const g = [...repo.groups.values()][0]!;
    expect(g.groupKey).toBe('cus_1#SEV-3');
    const close = queue.take();
    expect(close).toHaveLength(1);
    expect(close[0]).toMatchObject({ delaySec: 30, body: { type: 'GROUP_CLOSE', groupId: g.id } });
    expect([...repo.rawEvents.values()][0]).toMatchObject({ decision: 'NOTIFY', decisionReason: 'notify', groupId: g.id });
  });

  it('SQS redelivery of the same event is a no-op (F-3, known-bugs 1-6)', async () => {
    const { repo, deps } = setup();
    const ev = cw();
    await processMessage(ev, deps);
    const before = structuredClone([...repo.alerts.values()][0]);
    for (let i = 0; i < 20; i++) expect((await processMessage(ev, deps)).kind).toBe('DUPLICATE');
    expect(repo.rawEvents.size).toBe(1);
    expect([...repo.alerts.values()][0]).toEqual(before);
  });

  it('parallel identical deliveries: 1 row, 1 notify', async () => {
    const { repo, deps } = setup();
    const ev = cw();
    const outs = await Promise.all(Array.from({ length: 20 }, () => processMessage(ev, deps)));
    expect(outs.filter((o) => o.kind === 'PROCESSED')).toHaveLength(1);
    expect(repo.alerts.size).toBe(1);
  });

  it('second alert of the axis joins the open group', async () => {
    const { repo, deps } = setup();
    await processMessage(cw(), deps);
    const out = await processMessage(cw((e) => { e.id = 'bbbbbbbb-2'; e.detail.configuration!.description = e.detail.configuration!.description!.replace('i-0abc', 'i-0def'); }), deps);
    expect(out).toMatchObject({ openedGroup: false });
    expect(repo.groups.size).toBe(1);
  });

  it('GROUP_CLOSE closes only the OPEN group with that id', async () => {
    const { repo, queue, deps } = setup();
    await processMessage(cw(), deps);
    const [close] = queue.take();
    expect(await processMessage(close!.body, deps)).toEqual({ kind: 'GROUP_CLOSED', closed: true });
    expect(await processMessage(close!.body, deps)).toEqual({ kind: 'GROUP_CLOSED', closed: false });
    // after close a new fire opens a new group
    const out = await processMessage(cw((e) => { e.id = 'cccccccc'; e.detail.configuration!.description = e.detail.configuration!.description!.replace('i-0abc', 'i-0xyz'); }), deps);
    expect(out).toMatchObject({ openedGroup: true });
    expect(repo.groups.size).toBe(2);
  });

  it('clear after notify → NOTIFY/cleared, status RESOLVED, sparse OK keeps fields (known-bugs 1-5)', async () => {
    const { repo, deps } = setup();
    await processMessage(cw(), deps);
    const ok = cw((e) => { at(e, '2026-11-09T03:20:00Z', 'dddddddd', 'OK', 'ALARM'); delete e.detail.configuration!.metrics; });
    const out = await processMessage(ok, deps);
    expect(out).toMatchObject({ decision: 'NOTIFY', reason: 'cleared', groupId: null });
    expect([...repo.alerts.values()][0]).toMatchObject({ status: 'RESOLVED', episodeOpen: false, metricKey: 'CPUUtilization', namespace: 'AWS/EC2', region: 'ap-northeast-2' });
  });

  it('maintenance window: SEV-3 silenced (no group), SEV-1 still pages (D-17)', async () => {
    const { repo, deps } = setup();
    repo.windows.push({ id: 'mw', customerId: 'cus_1', scopeType: 'CUSTOMER', scopeId: 'cus_1', startsAt: new Date('2026-11-09T00:00:00Z'), endsAt: new Date('2026-11-09T06:00:00Z') });
    expect(await processMessage(cw(), deps)).toMatchObject({ decision: 'SUPPRESS', reason: 'silence', groupId: null });
    const sev1 = cw((e) => { e.id = 'eeeeeeee'; e.detail.configuration!.description = e.detail.configuration!.description!.replace('SEV-3', 'SEV-1').replace('i-0abc', 'i-0sev1'); });
    expect(await processMessage(sev1, deps)).toMatchObject({ decision: 'NOTIFY', reason: 'exempt_sev1', openedGroup: true });
    expect([...repo.groups.values()][0]!.groupKey).toBe('cus_1#SEV-1');
  });

  it('re-fire within 15 min after clear is deduped', async () => {
    const { deps } = setup();
    await processMessage(cw(), deps);
    await processMessage(cw((e) => at(e, '2026-11-09T03:15:00Z', 'f0000001', 'OK', 'ALARM')), deps);
    expect(await processMessage(cw((e) => at(e, '2026-11-09T03:20:00Z', 'f0000002')), deps)).toMatchObject({ decision: 'SUPPRESS', reason: 'dedup' });
  });

  it('unmapped accounts use separate axes (known-bugs 3-3)', async () => {
    const { repo, deps } = setup();
    await processMessage(cw(() => {}, '111111111111'), deps);
    await processMessage(cw((e) => { e.id = 'x2222222'; }, '222222222222'), deps);
    expect([...repo.groups.values()].map((g) => g.groupKey).sort()).toEqual(['acct:111111111111#SEV-3', 'acct:222222222222#SEV-3']);
    expect([...repo.alerts.values()].every((a) => a.customerId === null)).toBe(true);
  });

  it('version conflicts re-decide; 3 conflicts fall open to NOTIFY/state_contention (S-12)', async () => {
    const { repo, deps } = setup();
    repo.forceConflicts = 2;
    expect(await processMessage(cw(), deps)).toMatchObject({ decision: 'NOTIFY', reason: 'notify' });
    repo.forceConflicts = 3;
    const out = await processMessage(cw((e) => at(e, '2026-11-09T05:00:00Z', 'g0000001')), deps);
    expect(out).toMatchObject({ decision: 'NOTIFY', reason: 'state_contention' });
  });

  it('Prometheus re-send of an open firing alert does not re-page; ack sticks (S-9)', async () => {
    const { repo, deps } = setup();
    const ev: NormalizedEvent = { ...cw(), source: 'PROMETHEUS', sourceId: 'src_prom', previousState: null, fingerprint: 'prometheus:src_prom:abc', dedupKey: 'k1', awsAccountId: null };
    await processMessage(ev, deps);
    const a = repo.alerts.get('prometheus:src_prom:abc')!;
    a.status = 'ACKNOWLEDGED';
    const again = await processMessage({ ...ev, dedupKey: 'k2', occurredAt: '2026-11-09T04:12:00Z' }, deps);
    expect(again).toMatchObject({ decision: 'SUPPRESS', reason: 'not_actionable', groupId: null });
    expect(repo.alerts.get('prometheus:src_prom:abc')!.status).toBe('ACKNOWLEDGED');
  });

  it('handler reports only failing records (partial batch)', async () => {
    const { deps } = setup();
    const h = makeConsumerHandler(deps);
    const res = await h({ Records: [{ messageId: 'm1', body: JSON.stringify(cw()) }, { messageId: 'm2', body: '{not json' }, { messageId: 'm3', body: JSON.stringify({ schemaVersion: 2 }) }] });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }, { itemIdentifier: 'm3' }]);
  });
});

describe('EventBridge normalizer λ', () => {
  it('queues normalized CloudWatch events; ignores other detail types', async () => {
    const repo = store();
    const queue = new FakeQueue();
    const h = makeEventBridgeHandler({ accounts: new AccountCustomerCache((a) => repo.customerForAccount(a)), queue });
    expect(await h(coreFixture('cloudwatch-managed.json'))).toEqual({ queued: 1 });
    expect(queue.sent[0]!.attributes).toEqual({ customerId: 'cus_1', source: 'CLOUDWATCH' });
    const other = { ...coreFixture('cloudwatch-managed.json'), 'detail-type': 'EC2 Instance State-change Notification' };
    expect(await h(other)).toEqual({ queued: 0 });
  });
  it('account cache: TTL refresh and keep previous mapping on lookup failure (known-bugs 1-8)', async () => {
    let now = 0;
    let mapping: string | null = 'cus_1';
    let fail = false;
    const c = new AccountCustomerCache(async () => { if (fail) throw new Error('db down'); return mapping; }, 300_000, () => now);
    expect(await c.get('1')).toBe('cus_1');
    mapping = 'cus_9';
    now = 299_000;
    expect(await c.get('1')).toBe('cus_1');
    now = 300_000;
    expect(await c.get('1')).toBe('cus_9');
    fail = true;
    now = 700_000;
    expect(await c.get('1')).toBe('cus_9');
    await expect(c.get('2')).rejects.toThrow('db down');
  });
});
