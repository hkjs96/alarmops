import { describe, expect, it } from 'vitest';
import {
  cloudwatchFingerprint, DEFAULT_SEVERITY_TABLE, mapExternalSeverity, mergeSeverity, parseSevPattern, registrySeverity, cloudwatchSeverity,
} from '../src/index.js';

describe('fingerprint (F-1, known-bugs 1-3)', () => {
  it('stable across alarm renames when resource is resolved (threshold change keeps fingerprint, D-08)', () => {
    const a = cloudwatchFingerprint({ account: '1', resourceKey: 'i-1', alarmName: '[EC2] a CPU > 80%', metricKey: 'CPU' });
    const b = cloudwatchFingerprint({ account: '1', resourceKey: 'i-1', alarmName: '[EC2] a CPU > 90%', metricKey: 'CPU' });
    expect(a).toBe(b);
  });
  it('two unmanaged alarms in the same account get different fingerprints', () => {
    const a = cloudwatchFingerprint({ account: '1', resourceKey: '', alarmArn: 'arn:x:alarm:a', metricKey: 'm' });
    const b = cloudwatchFingerprint({ account: '1', resourceKey: null, alarmArn: 'arn:x:alarm:b', metricKey: 'm' });
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/:1:#/);
  });
  it('falls back to alarm name when ARN is missing', () => {
    expect(cloudwatchFingerprint({ account: '1', alarmName: 'n', metricKey: null })).toBe('cloudwatch:1:n#');
  });
});

describe('severity (D-18, D-25, V-4, V-6)', () => {
  it('sev pattern 1..5 only', () => {
    expect(parseSevPattern('SEV-1')).toBe('SEV_1');
    expect(parseSevPattern('sev 2')).toBe('SEV_2');
    expect(parseSevPattern('Sev3')).toBe('SEV_3');
    expect(parseSevPattern('SEV_4')).toBe('SEV_4');
    expect(parseSevPattern('SEV-0')).toBeNull();
    expect(parseSevPattern('SEV-9')).toBeNull();
    expect(parseSevPattern('severe')).toBeNull();
  });
  it('D-25: critical maps to SEV-2, never SEV-1', () => {
    expect(DEFAULT_SEVERITY_TABLE.critical).toBe('SEV_2');
    expect(mapExternalSeverity('CRITICAL').severity).toBe('SEV_2');
    expect(Object.values(DEFAULT_SEVERITY_TABLE)).not.toContain('SEV_1');
  });
  it('pattern beats table; table is case-insensitive; unknown → default with raw kept', () => {
    expect(mapExternalSeverity('sev-1')).toMatchObject({ severity: 'SEV_1', matchedBy: 'PATTERN' });
    expect(mapExternalSeverity('Warning')).toMatchObject({ severity: 'SEV_3', matchedBy: 'TABLE' });
    expect(mapExternalSeverity('p1')).toMatchObject({ severity: 'SEV_3', matchedBy: 'DEFAULT', severityRaw: 'p1' });
    expect(mapExternalSeverity(undefined)).toMatchObject({ matchedBy: 'DEFAULT', severityRaw: null });
  });
  it('custom table (DB rows) is honored as one table for all sources', () => {
    expect(mapExternalSeverity('critical', { critical: 'SEV_1' }).severity).toBe('SEV_1');
  });
  it('registry: Disk_ prefix SEV-3, ClusterStatusRed SEV-1, unknown SEV-5', () => {
    expect(registrySeverity('Disk_root')).toBe('SEV_3');
    expect(registrySeverity('ClusterStatusRed')).toBe('SEV_1');
    expect(registrySeverity('Whatever')).toBe('SEV_5');
    expect(cloudwatchSeverity(undefined, 'Whatever', true).severity).toBe('SEV_5');
  });
  it('weak follow-up never overwrites a known severity with the default (fd67c37)', () => {
    expect(mergeSeverity('SEV_2', mapExternalSeverity(undefined))).toBe('SEV_2');
    expect(mergeSeverity('SEV_2', mapExternalSeverity('info'))).toBe('SEV_5');
  });
});
