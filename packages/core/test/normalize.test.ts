import { describe, expect, it } from 'vitest';
import { capRaw, cloudwatchDedupKey, detectWebhookKind, sha256, normalizeCloudWatch, normalizeWebhook, RAW_MAX_BYTES, type CloudWatchEventBridgeEvent } from '../src/index.js';
import { clone, fixture, t } from './helpers.js';

const cwCtx = { customerForAccount: (a: string) => (a === '123456789012' ? 'cus_1' : null), receivedAt: t('2026-11-09T03:12:02Z') };

describe('CloudWatch EventBridge → normalized (API-CONTRACT §3)', () => {
  it('maps a managed alarm per contract example', () => {
    const e = normalizeCloudWatch(fixture('cloudwatch-managed.json'), cwCtx);
    expect(e).toMatchObject({
      schemaVersion: 1, source: 'CLOUDWATCH', sourceId: null, customerId: 'cus_1', customerResolvedBy: 'ACCOUNT_MAP',
      awsAccountId: '123456789012', region: 'ap-northeast-2', fingerprint: 'cloudwatch:123456789012:i-0abc#CPUUtilization',
      fingerprintVersion: 1, state: 'FIRING', previousState: 'OK', eventType: 'STATE_CHANGE', severity: 'SEV_3', severityRaw: 'SEV-3',
      resource: { type: 'EC2', key: 'i-0abc', name: 'web-1' }, metric: { key: 'CPUUtilization', namespace: 'AWS/EC2' },
      alarm: { managed: true }, occurredAt: '2026-11-09T03:12:00Z', receivedAt: '2026-11-09T03:12:02.000Z', parseError: null,
    });
    expect(e.dedupKey).toBe(sha256(`cloudwatch:${e.awsAccountId}:${fixture<any>('cloudwatch-managed.json').id}`));
  });

  it('B-3: two accounts, same timestamp and same event-id prefix → different dedupKeys', () => {
    const a = fixture<CloudWatchEventBridgeEvent>('cloudwatch-managed.json');
    const b = clone(a);
    b.account = '210987654321';
    const ea = normalizeCloudWatch(a, cwCtx);
    const eb = normalizeCloudWatch(b, cwCtx);
    expect(ea.occurredAt).toBe(eb.occurredAt);
    expect(ea.dedupKey).not.toBe(eb.dedupKey);
    // same account, ids sharing the first 8 chars no longer collide either
    expect(cloudwatchDedupKey('1', 'a1b2c3d4-0000')).not.toBe(cloudwatchDedupKey('1', 'a1b2c3d4-1111'));
  });

  it('customer comes from the envelope account only; unknown account → UNMAPPED', () => {
    const ev = fixture<CloudWatchEventBridgeEvent>('cloudwatch-managed.json');
    ev.account = '999999999999';
    const e = normalizeCloudWatch(ev, cwCtx);
    expect(e.customerId).toBeNull();
    expect(e.customerResolvedBy).toBe('UNMAPPED');
  });

  it('OK → RESOLVED, INSUFFICIENT_DATA kept, config change is not a state change', () => {
    const ev = fixture<CloudWatchEventBridgeEvent>('cloudwatch-managed.json');
    ev.detail.state!.value = 'OK';
    ev.detail.previousState!.value = 'ALARM';
    expect(normalizeCloudWatch(ev, cwCtx).state).toBe('RESOLVED');
    ev.detail.state!.value = 'INSUFFICIENT_DATA';
    expect(normalizeCloudWatch(ev, cwCtx).state).toBe('INSUFFICIENT_DATA');
    ev['detail-type'] = 'CloudWatch Alarm Configuration Change';
    expect(normalizeCloudWatch(ev, cwCtx).eventType).toBe('CONFIG_CHANGE');
  });

  it('unmanaged alarm is kept with parseError and ARN fingerprint (F-2, known-bugs 1-3)', () => {
    const e = normalizeCloudWatch(fixture('cloudwatch-unmanaged.json'), cwCtx);
    expect(e.parseError).toBe('unmanaged alarm format');
    expect(e.alarm?.managed).toBe(false);
    expect(e.fingerprint).toBe('cloudwatch:123456789012:arn:aws:cloudwatch:ap-northeast-2:123456789012:alarm:customer-own-latency#p99');
    expect(e.severity).toBe('SEV_3'); // unmapped default (Q-DM-08 open)
  });

  it('name-format alarm lacking metadata resolves identity but is NOT managed (f376969)', () => {
    const ev = fixture<CloudWatchEventBridgeEvent>('cloudwatch-managed.json');
    delete ev.detail.configuration!.description;
    const e = normalizeCloudWatch(ev, cwCtx);
    expect(e.alarm?.managed).toBe(false);
    expect(e.resource?.key).toBe('i-0abc');
    expect(e.fingerprint).toBe('cloudwatch:123456789012:i-0abc#CPUUtilization');
  });

  it('out-of-range metadata severity is ignored → registry (V-4)', () => {
    const ev = fixture<CloudWatchEventBridgeEvent>('cloudwatch-managed.json');
    ev.detail.configuration!.description = ev.detail.configuration!.description!.replace('SEV-3', 'urgent').replace('CPUUtilization', 'StatusCheckFailed');
    expect(normalizeCloudWatch(ev, cwCtx).severity).toBe('SEV_1');
  });
});

describe('Alertmanager v4 → normalized', () => {
  const ctx = { sourceId: 'src_prom', customerId: 'cus_1', receivedAt: t('2026-11-09T03:06:00Z') };
  it('splits a batch into one event per alert with native fingerprints', () => {
    const { events, rejected } = normalizeWebhook('PROMETHEUS', fixture('alertmanager-v4.json'), ctx);
    expect(rejected).toEqual([]);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.fingerprint)).toEqual([
      'prometheus:src_prom:7a1c0e3b9f2d4e11', 'prometheus:src_prom:8b2d1f4c0a3e5f22', 'prometheus:src_prom:9c3e2a5d1b4f6a33',
    ]);
    expect(events.every((e) => e.customerId === 'cus_1' && e.customerResolvedBy === 'SOURCE_TOKEN')).toBe(true);
  });
  it('D-25: critical → SEV-2; explicit sev-1 → SEV-1; warning → SEV-3', () => {
    const { events } = normalizeWebhook('PROMETHEUS', fixture('alertmanager-v4.json'), ctx);
    expect(events.map((e) => e.severity)).toEqual(['SEV_2', 'SEV_3', 'SEV_1']);
    expect(events[0]!.severityRaw).toBe('critical');
  });
  it('resolved alert uses endsAt as occurredAt; dedupKey differs by status', () => {
    const { events } = normalizeWebhook('PROMETHEUS', fixture('alertmanager-v4.json'), ctx);
    expect(events[2]).toMatchObject({ state: 'RESOLVED', occurredAt: '2026-11-09T03:05:00Z' });
    const p = fixture('alertmanager-v4.json');
    p.alerts[0].status = 'resolved';
    p.alerts[0].endsAt = '2026-11-09T03:10:00Z';
    const r = normalizeWebhook('PROMETHEUS', p, ctx).events[0]!;
    expect(r.dedupKey).not.toBe(events[0]!.dedupKey);
  });
  it('same payload twice → identical dedupKeys (idempotent redelivery)', () => {
    const a = normalizeWebhook('PROMETHEUS', fixture('alertmanager-v4.json'), ctx).events.map((e) => e.dedupKey);
    const b = normalizeWebhook('PROMETHEUS', fixture('alertmanager-v4.json'), { ...ctx, receivedAt: t('2026-11-09T04:00:00Z') }).events.map((e) => e.dedupKey);
    expect(a).toEqual(b);
  });
  it('missing fingerprint → label hash that separates devices (fingerprint 충돌 4)', () => {
    const p = fixture('alertmanager-v4.json');
    delete p.alerts[0].fingerprint;
    delete p.alerts[1].fingerprint;
    const [a, b] = normalizeWebhook('PROMETHEUS', p, ctx).events;
    expect(a!.fingerprint).toMatch(/^prometheus:src_prom:h[0-9a-f]{16}$/);
    expect(a!.fingerprint).not.toBe(b!.fingerprint);
    // severity label change does not split the series
    const p2 = fixture('alertmanager-v4.json');
    delete p2.alerts[0].fingerprint;
    p2.alerts[0].labels.severity = 'warning';
    expect(normalizeWebhook('PROMETHEUS', p2, ctx).events[0]!.fingerprint).toBe(a!.fingerprint);
  });
  it('alert without alertname and summary is rejected (F-6); body customer fields are ignored', () => {
    const p = { version: '4', customerId: 'evil', alerts: [{ status: 'firing', labels: { foo: 'x' }, annotations: {} }] } as any;
    const r = normalizeWebhook('PROMETHEUS', p, ctx);
    expect(r.events).toHaveLength(0);
    expect(r.rejected[0]!.reason).toBe('missing_alertname');
  });
  it('two tenants with identical fingerprints do not collide', () => {
    const a = normalizeWebhook('PROMETHEUS', fixture('alertmanager-v4.json'), ctx).events[0]!.fingerprint;
    const b = normalizeWebhook('PROMETHEUS', fixture('alertmanager-v4.json'), { ...ctx, sourceId: 'src_other' }).events[0]!.fingerprint;
    expect(a).not.toBe(b);
  });
});

describe('Grafana unified → normalized', () => {
  const ctx = { sourceId: 'src_graf', customerId: 'cus_2', receivedAt: t('2026-11-09T05:02:00Z') };
  it('prefix grafana, nodata → INSUFFICIENT_DATA (ec8caf4)', () => {
    const { events } = normalizeWebhook('GRAFANA', fixture('grafana-unified.json'), ctx);
    expect(events[0]).toMatchObject({ source: 'GRAFANA', fingerprint: 'grafana:src_graf:d00dfeed00000001', state: 'FIRING', severity: 'SEV_3', title: 'Checkout p99 latency high' });
    expect(events[1]!.state).toBe('INSUFFICIENT_DATA');
  });
  it('body shape detection matches path', () => {
    expect(detectWebhookKind(fixture('grafana-unified.json'))).toBe('GRAFANA');
    expect(detectWebhookKind(fixture('alertmanager-v4.json'))).toBe('PROMETHEUS');
    expect(detectWebhookKind({} as any)).toBeNull();
  });
});

describe('raw cap (known-bugs 1-4)', () => {
  it('large payload stays valid JSON with truncated marker under 64KB', () => {
    const big = { alerts: Array.from({ length: 5000 }, (_, i) => ({ i, text: 'x'.repeat(50) + '한글' })) };
    const capped = capRaw(big) as any;
    const s = JSON.stringify(capped);
    expect(JSON.parse(s)._truncated).toBe(true);
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(RAW_MAX_BYTES);
    expect(capped.originalBytes).toBeGreaterThan(RAW_MAX_BYTES);
  });
  it('small payload untouched', () => {
    const v = clone({ a: 1 });
    expect(capRaw(v)).toEqual({ a: 1 });
  });
});
