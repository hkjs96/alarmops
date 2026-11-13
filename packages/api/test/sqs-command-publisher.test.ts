import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import { cworld } from './contract/apiContract.js';
import { memoryFixture } from '../../core/test/contract/fixture.js';
import { USERS, body } from './helpers.js';
import { createApi, MemoryApiStore } from '../src/index.js';
import { CommandPublishError, SqsCommandPublisher, commandPublisherFromEnv, type AlarmCommand, type SqsSender } from '../src/index.js';

const STD = 'https://sqs.ap-northeast-2.amazonaws.com/123456789012/alarm-commands';
const ACCT = '123456789012';
const FIFO = `${STD}.fifo`;
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const fixture = JSON.parse(read('./fixtures/offboard-account.command.json')) as AlarmCommand;

function fake(fail?: (c: SendMessageCommand) => boolean) {
  const sent: SendMessageCommand['input'][] = [];
  const client: SqsSender = {
    async send(c) {
      if (fail?.(c)) throw Object.assign(new Error(`boom ${STD}`), { name: 'AccessDenied' });
      sent.push(c.input);
      return { MessageId: 'm1' };
    },
  };
  return { client, sent };
}

describe('SqsCommandPublisher', () => {
  it('standard queue: body is the command JSON, no FIFO attributes', async () => {
    const { client, sent } = fake();
    await new SqsCommandPublisher(client, { queueUrl: STD, expectedAccount: ACCT }).publish(fixture);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.QueueUrl).toBe(STD);
    expect(JSON.parse(sent[0]!.MessageBody!)).toEqual(fixture);
    expect(sent[0]).not.toHaveProperty('MessageGroupId');
    expect(sent[0]).not.toHaveProperty('MessageDeduplicationId');
  });

  it('FIFO queue: dedup = commandId, group = customerId', async () => {
    const { client, sent } = fake();
    await new SqsCommandPublisher(client, { queueUrl: FIFO, expectedAccount: ACCT }).publish(fixture);
    expect(sent[0]!.MessageDeduplicationId).toBe(fixture.commandId);
    expect(sent[0]!.MessageGroupId).toBe(fixture.customerId);
  });

  it('send failure becomes CommandPublishError without queue url or aws text', async () => {
    const { client } = fake(() => true);
    const err = await new SqsCommandPublisher(client, { queueUrl: STD, expectedAccount: ACCT }).publish(fixture).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandPublishError);
    expect((err as Error).message).not.toContain('amazonaws');
    expect((err as CommandPublishError).reason).toBe('SEND_FAILED');
  });

  it('per-message capture: one failing account does not block the others', async () => {
    const { client, sent } = fake((c) => JSON.parse(c.input.MessageBody!).cloudAccountId === 'acc_2');
    const pub = new SqsCommandPublisher(client, { queueUrl: STD, expectedAccount: ACCT });
    const results = await Promise.allSettled(['acc_1', 'acc_2', 'acc_3'].map((a) => pub.publish({ ...fixture, cloudAccountId: a })));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(sent).toHaveLength(2);
  });

  it('rejects invalid commands, oversize bodies and bad FIFO ids before sending; fifo/url mismatch throws', async () => {
    const { client, sent } = fake();
    const pub = new SqsCommandPublisher(client, { queueUrl: FIFO, expectedAccount: ACCT });
    await expect(pub.publish({ ...fixture, commandId: '' })).rejects.toMatchObject({ reason: 'INVALID' });
    await expect(pub.publish({ ...fixture, commandId: 'has space' })).rejects.toMatchObject({ reason: 'INVALID' });
    await expect(new SqsCommandPublisher(client, { queueUrl: STD, expectedAccount: ACCT }).publish({ ...fixture, payload: { offboardingId: 'x'.repeat(300_000) } })).rejects.toMatchObject({ reason: 'INVALID' });
    expect(sent).toHaveLength(0);
    expect(() => new SqsCommandPublisher(client, { queueUrl: STD, expectedAccount: ACCT, fifo: true })).toThrow();
  });

  it('validates ids in standard mode too, refuses unknown types, and serializes allowlisted keys only', async () => {
    const { client, sent } = fake();
    const pub = new SqsCommandPublisher(client, { queueUrl: STD, expectedAccount: ACCT });
    await expect(pub.publish({ ...fixture, commandId: 'has space' })).rejects.toMatchObject({ reason: 'INVALID' });
    await expect(pub.publish({ ...fixture, customerId: '' })).rejects.toMatchObject({ reason: 'INVALID' });
    await expect(pub.publish({ ...fixture, type: 'EXECUTE_REMEDIATION' } as unknown as AlarmCommand)).rejects.toMatchObject({ reason: 'INVALID' });
    await pub.publish({ ...fixture, secret: 'x', requestedBy: { type: 'USER', id: 'u' } } as unknown as AlarmCommand);
    expect(JSON.parse(sent[0]!.MessageBody!)).not.toHaveProperty('secret');
    expect(sent).toHaveLength(1);
  });

  it('a response without MessageId counts as a failure', async () => {
    const client: SqsSender = { send: async () => ({}) };
    await expect(new SqsCommandPublisher(client, { queueUrl: STD, expectedAccount: ACCT }).publish(fixture)).rejects.toMatchObject({ reason: 'SEND_FAILED' });
  });
});

describe('commandPublisherFromEnv', () => {
  const { client } = fake();
  it('unset or blank -> undefined (503 stays fail-closed)', () => {
    expect(commandPublisherFromEnv({}, { client })).toBeUndefined();
    expect(commandPublisherFromEnv({ ALARM_COMMANDS_QUEUE_URL: '  ' }, { client })).toBeUndefined();
  });
  it('valid url -> publisher', () => {
    expect(commandPublisherFromEnv({ ALARM_COMMANDS_QUEUE_URL: STD, ALARM_COMMANDS_EXPECTED_ACCOUNT: ACCT }, { client })).toBeInstanceOf(SqsCommandPublisher);
    expect(commandPublisherFromEnv({ ALARM_COMMANDS_QUEUE_URL: FIFO, ALARM_COMMANDS_EXPECTED_ACCOUNT: ACCT }, { client })).toBeInstanceOf(SqsCommandPublisher);
  });
  it.each([undefined, '', '12345', '999999999999'])('expected account missing or not matching the url account throws: %s', (acct) => {
    expect(() => commandPublisherFromEnv({ ALARM_COMMANDS_QUEUE_URL: STD, ALARM_COMMANDS_EXPECTED_ACCOUNT: acct }, { client })).toThrow();
  });
  it.each([
    'not a url',
    'http://sqs.ap-northeast-2.amazonaws.com/123456789012/q',
    'https://sqs.us-east-1.amazonaws.com/123456789012/q',
    'https://sqs.ap-northeast-2.amazonaws.com.evil.com/123456789012/q',
    'https://sqs.ap-northeast-2.amazonaws.com/123/q',
    'https://sqs.ap-northeast-2.amazonaws.com/123456789012/q?x=1',
  ])('malformed or wrong region throws: %s', (url) => {
    expect(() => commandPublisherFromEnv({ ALARM_COMMANDS_QUEUE_URL: url, ALARM_COMMANDS_EXPECTED_ACCOUNT: ACCT }, { client })).toThrow();
  });
});

describe('contract fixture shared with services/alarm-engine/tests', () => {
  it('the Python-side copy is identical and the sent body has exactly the fixture keys', async () => {
    expect(JSON.parse(read('../../../services/alarm-engine/tests/fixtures/offboard-account.command.json'))).toEqual(fixture);
    const { client, sent } = fake();
    await new SqsCommandPublisher(client, { queueUrl: STD, expectedAccount: ACCT }).publish(fixture);
    expect(Object.keys(JSON.parse(sent[0]!.MessageBody!)).sort()).toEqual(Object.keys(fixture).sort());
  });
});

describe('PATCH /customers/{id}/status with SqsCommandPublisher', () => {
  it('AWS error name and queue url never reach the response body', async () => {
    const w = await cworld(async (seed) => memoryFixture(seed as MemoryApiStore));
    try {
      const { client } = fake(() => true); // throws name 'AccessDenied' with the queue url in its message
      const api = createApi({ repo: w.fx.repo, now: () => w.sim.now, commands: new SqsCommandPublisher(client, { queueUrl: STD, expectedAccount: ACCT }) });
      const name = body(await w.call(USERS.minjae, 'GET', '/scope-tree')).customers.find((c: any) => c.id === 'cus_mirae').name;
      const r = await api.handle({ method: 'PATCH', path: '/customers/cus_mirae/status', auth: USERS.minjae, headers: { 'if-match': '0' }, body: { status: 'TERMINATED', reason: 'x', confirmName: name }, requestId: 'r1' });
      expect(r.status).toBe(200);
      expect(body(r).commandsFailed).toHaveLength(1);
      const text = JSON.stringify(r.body);
      for (const leak of ['AccessDenied', 'amazonaws', 'alarm-commands', 'SEND_FAILED', '123456789012/']) expect(text).not.toContain(leak);
    } finally { await w.fx.close(); }
  });
});
