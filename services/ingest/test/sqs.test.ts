import { describe, expect, it } from 'vitest';
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { SqsQueueSender } from '../src/sqs.js';
import { assertBudget, requireEnv } from '../src/config.js';
import { digestEquals, extractToken } from '../src/token.js';

describe('SqsQueueSender (mocked client, no AWS)', () => {
  it('chunks by 10 and maps attributes/delay', async () => {
    const calls: SendMessageBatchCommand[] = [];
    const client = { send: async (c: any) => { calls.push(c); return { Successful: [], Failed: [] }; } };
    const s = new SqsQueueSender(client as any, 'https://sqs.ap-northeast-2.amazonaws.com/000000000000/alert-events');
    await s.send(Array.from({ length: 23 }, (_, i) => ({ id: String(i), body: { type: 'GROUP_CLOSE', schemaVersion: 1, groupId: 'g', groupKey: 'k' } as const, attributes: { source: 'X' }, delaySec: 30 })));
    expect(calls.map((c) => c.input.Entries!.length)).toEqual([10, 10, 3]);
    expect(calls[0]!.input.Entries![0]).toMatchObject({ DelaySeconds: 30, MessageAttributes: { source: { DataType: 'String', StringValue: 'X' } } });
  });
  it('throws when any entry fails', async () => {
    const client = { send: async () => ({ Failed: [{ Id: '0', Code: 'Throttled', SenderFault: false }] }) };
    await expect(new SqsQueueSender(client as any, 'q').send([{ id: '0', body: { type: 'GROUP_CLOSE', schemaVersion: 1, groupId: 'g', groupKey: 'k' }, attributes: {} }])).rejects.toThrow(/Throttled/);
  });
});

describe('config & token helpers', () => {
  it('missing required setting fails closed (known-bugs 6-5)', () => {
    expect(() => requireEnv('ALERT_EVENTS_QUEUE_URL', {})).toThrow(/ALERT_EVENTS_QUEUE_URL/);
    expect(requireEnv('X', { X: 'v' })).toBe('v');
  });
  it('consumer budget below visibility timeout (known-bugs 6-9)', () => {
    expect(() => assertBudget(30, 30_000)).toThrow();
    expect(() => assertBudget(60, 50_000)).not.toThrow();
  });
  it('bearer preferred over query; digest compare is length-safe', () => {
    expect(extractToken({ authorization: 'Bearer a' }, { token: 'b' })).toBe('a');
    expect(extractToken({}, { token: 'b' })).toBe('b');
    expect(extractToken({}, null)).toBeNull();
    expect(digestEquals('ab', 'ab')).toBe(true);
    expect(digestEquals('ab', 'abcd')).toBe(false);
  });
});
