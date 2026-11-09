import { describe, expect, it } from 'vitest';
import { cloudwatchFingerprint, groupKey, webhookFingerprint } from '../src/index.js';

/**
 * Security B-6 invariant (see TENANT SCOPE INVARIANT in fingerprint.ts): fingerprints and group keys always carry a
 * customer scope (account / IntegrationSource id / customerId), so lookups by fingerprint or groupKey alone
 * can never return another customer's Alert or Group.
 */
describe('tenant scope of fingerprint and groupKey (B-6)', () => {
  it('same labels from two customers’ sources → different fingerprints', () => {
    const labels = { alertname: 'HighCPU', instance: 'web-1' };
    expect(webhookFingerprint('PROMETHEUS', 'src_cus1', null, labels)).not.toBe(webhookFingerprint('PROMETHEUS', 'src_cus2', null, labels));
    expect(webhookFingerprint('GRAFANA', 'src_cus1', 'abc', labels)).not.toBe(webhookFingerprint('GRAFANA', 'src_cus2', 'abc', labels));
  });
  it('same alarm in two accounts → different fingerprints', () => {
    const a = { resourceKey: 'i-0abc', metricKey: 'CPUUtilization', alarmName: 'x' };
    expect(cloudwatchFingerprint({ account: '111111111111', ...a })).not.toBe(cloudwatchFingerprint({ account: '222222222222', ...a }));
  });
  it('group keys differ by customer, and unmapped accounts/sources never share an axis', () => {
    const sev = 'SEV_3' as const;
    expect(groupKey({ customerId: 'cus_1', awsAccountId: null, severity: sev })).not.toBe(groupKey({ customerId: 'cus_2', awsAccountId: null, severity: sev }));
    expect(groupKey({ customerId: null, awsAccountId: '1', severity: sev })).not.toBe(groupKey({ customerId: null, awsAccountId: '2', severity: sev }));
    expect(groupKey({ customerId: null, awsAccountId: null, sourceId: 's1', severity: sev })).not.toBe(groupKey({ customerId: null, awsAccountId: null, sourceId: 's2', severity: sev }));
  });
});
