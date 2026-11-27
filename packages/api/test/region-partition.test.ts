import { describe, expect, it } from 'vitest';
import { cworld } from './contract/apiContract.js';
import { memoryFixture } from '../../core/test/contract/fixture.js';
import { USERS, body } from './helpers.js';
import { SqsCommandPublisher, commandPublisherFromEnv, partitionFromEnv, type MemoryApiStore, type SqsSender } from '../src/index.js';
import { roleArn } from '../src/onboardingApi.js';

// D-58: the central account can move to another region or partition. Placeholder account id as in the other SQS tests.
const ACCT = '123456789012';
const client: SqsSender = { async send() { return { MessageId: 'm1' }; } };
const make = (queueUrl: string, extra: Record<string, unknown> = {}) => new SqsCommandPublisher(client, { queueUrl, expectedAccount: ACCT, ...extra });
const q = (host: string, account = ACCT) => `https://${host}/${account}/alarm-commands`;

describe('queue URL: region and partition forms (D-58)', () => {
  it('Seoul / aws still works and the region is read from the URL', () => {
    const p = make(q('sqs.ap-northeast-2.amazonaws.com'));
    expect([p.region, p.partition]).toEqual(['ap-northeast-2', 'aws']);
  });

  it('another region passes (us-east-1, eu-west-3), FIFO too', () => {
    expect(make(q('sqs.us-east-1.amazonaws.com')).region).toBe('us-east-1');
    expect(make(`${q('sqs.eu-west-3.amazonaws.com')}.fifo`).region).toBe('eu-west-3');
  });

  it('aws-us-gov and aws-cn host forms pass with the right partition', () => {
    const gov = make(q('sqs.us-gov-west-1.amazonaws.com'));
    expect([gov.region, gov.partition]).toEqual(['us-gov-west-1', 'aws-us-gov']);
    const cn = make(q('sqs.cn-north-1.amazonaws.com.cn'));
    expect([cn.region, cn.partition]).toEqual(['cn-north-1', 'aws-cn']);
  });

  it('rejects other hosts, ports, userinfo, http, odd regions and the wrong TLD for the region', () => {
    for (const host of [
      'evil.example.com', 'sqs.us-east-1.amazonaws.com.evil.io', 'sqs.us-east-1.amazonaws.com:8443', 'user@sqs.us-east-1.amazonaws.com',
      'sqs.us-east-1.amazonaws.org', 'sqs.mars.amazonaws.com', 'sqs.US-EAST-1.amazonaws.com', 'sqs.us-east-1.vpce.amazonaws.com',
      'sqs.cn-north-1.amazonaws.com', 'sqs.us-east-1.amazonaws.com.cn', 'sqs.us-gov-west-1.amazonaws.com.cn',
    ]) expect(() => make(q(host)), host).toThrow('invalid alarm-commands queue url');
    expect(() => make(q('sqs.us-east-1.amazonaws.com').replace('https', 'http'))).toThrow('invalid');
  });

  it('a queue in a foreign account is refused in any region or partition', () => {
    expect(() => make(q('sqs.us-east-1.amazonaws.com', '999999999999'))).toThrow('account');
    expect(() => make(q('sqs.cn-north-1.amazonaws.com.cn', '999999999999'))).toThrow('account');
  });

  it('a configured region or partition that disagrees with the URL is rejected', () => {
    expect(() => make(q('sqs.us-east-1.amazonaws.com'), { region: 'ap-northeast-2' })).toThrow('region');
    expect(() => make(q('sqs.us-east-1.amazonaws.com'), { region: 'us-east-1', partition: 'aws' })).not.toThrow();
    expect(() => make(q('sqs.us-east-1.amazonaws.com'), { partition: 'aws-us-gov' })).toThrow('partition');
    expect(() => make(q('sqs.cn-north-1.amazonaws.com.cn'), { partition: 'aws' })).toThrow('partition');
  });

  it('commandPublisherFromEnv: other regions pass, AWS_PARTITION is cross-checked, foreign host / account throws', () => {
    const env = (url: string, more: Record<string, string> = {}) => ({ ALARM_COMMANDS_QUEUE_URL: url, ALARM_COMMANDS_EXPECTED_ACCOUNT: ACCT, ...more });
    expect(commandPublisherFromEnv(env(q('sqs.ap-northeast-2.amazonaws.com')), { client })).toBeDefined();
    expect(commandPublisherFromEnv(env(q('sqs.us-east-1.amazonaws.com')), { client })).toBeDefined();
    expect(commandPublisherFromEnv(env(q('sqs.cn-north-1.amazonaws.com.cn'), { AWS_PARTITION: 'aws-cn' }), { client })).toBeDefined();
    expect(commandPublisherFromEnv(env(q('sqs.us-gov-east-1.amazonaws.com'), { AWS_PARTITION: 'aws-us-gov' }), { client })).toBeDefined();
    expect(() => commandPublisherFromEnv(env(q('sqs.us-east-1.amazonaws.com'), { AWS_PARTITION: 'aws-cn' }), { client })).toThrow('partition');
    expect(() => commandPublisherFromEnv(env(q('evil.example.com')), { client })).toThrow('ALARM_COMMANDS_QUEUE_URL');
    expect(() => commandPublisherFromEnv(env(q('sqs.us-east-1.amazonaws.com', '999999999999')), { client })).toThrow('account');
  });
});

describe('partition of derived role ARNs (D-58)', () => {
  it('roleArn defaults to aws and takes another partition from config', () => {
    expect(roleArn('333333333333', 'reader')).toBe('arn:aws:iam::333333333333:role/AlarmOps-Reader');
    expect(roleArn('333333333333', 'reader', 'aws-cn')).toBe('arn:aws-cn:iam::333333333333:role/AlarmOps-Reader');
    expect(roleArn('333333333333', 'remediator', 'aws-us-gov')).toBe('arn:aws-us-gov:iam::333333333333:role/AlarmOps-Remediator');
  });

  it('partitionFromEnv: unset or blank = aws, valid values pass, anything else throws', () => {
    expect(partitionFromEnv({})).toBe('aws');
    expect(partitionFromEnv({ AWS_PARTITION: '  ' })).toBe('aws');
    expect(partitionFromEnv({ AWS_PARTITION: 'aws-cn' })).toBe('aws-cn');
    expect(() => partitionFromEnv({ AWS_PARTITION: 'aws-iso' })).toThrow('AWS_PARTITION');
    expect(() => partitionFromEnv({ AWS_PARTITION: 'AWS' })).toThrow('AWS_PARTITION');
  });

  it('POST /accounts and a capability toggle use the configured partition; default stays aws', async () => {
    const w = await cworld(async (seed) => memoryFixture(seed as MemoryApiStore), () => undefined, { partition: 'aws-cn' });
    try {
      const r = await w.call(USERS.minjae, 'POST', '/customers/cus_mirae/accounts', { body: { awsAccountId: '333333333333', alarmWriterEnabled: true } });
      expect(r.status).toBe(201);
      const a = body(r);
      expect(a.readerRoleArn).toBe('arn:aws-cn:iam::333333333333:role/AlarmOps-Reader');
      expect(a.alarmWriterRoleArn).toBe('arn:aws-cn:iam::333333333333:role/AlarmOps-AlarmWriter');
      const p = await w.call(USERS.minjae, 'PATCH', `/accounts/${a.id}`, { body: { tagWriterEnabled: true } });
      expect(body(p).tagWriterRoleArn).toBe('arn:aws-cn:iam::333333333333:role/AlarmOps-TagWriter');
    } finally { await w.fx.close(); }
    const d = await cworld(async (seed) => memoryFixture(seed as MemoryApiStore));
    try {
      const r = await d.call(USERS.minjae, 'POST', '/customers/cus_mirae/accounts', { body: { awsAccountId: '333333333333' } });
      expect(body(r).readerRoleArn).toBe('arn:aws:iam::333333333333:role/AlarmOps-Reader');
    } finally { await d.fx.close(); }
  });
});
