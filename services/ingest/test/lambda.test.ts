import { describe, expect, it, vi } from 'vitest';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { NotConfiguredError } from '../src/config.js';
import type { SqlIngestStore } from '@alarmops/store-sql';
import { createRuntimeLoader, type IngestRuntime } from '../src/lambda/runtime.js';
import { onceAsync, readDatabaseUrl } from '../src/lambda/secret.js';
import { makeWebhookEntry } from '../src/lambda/webhookEntry.js';
import { makeEventBridgeEntry } from '../src/lambda/eventbridgeEntry.js';
import { makeConsumerEntry } from '../src/lambda/consumerEntry.js';
import { AccountCustomerCache } from '../src/accountCache.js';
import { FakeQueue, store as memStore, PROM_TOKEN, coreFixture } from './helpers.js';

const URL_SECRET = 'postgresql://engine:s3cr3t-pw@db.example.test:5432/postgres';
const ARN = 'arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:alarmops-ingest-db-AbCdEf';
const env = { DATABASE_URL_SECRET_ARN: ARN, ALERT_EVENTS_QUEUE_URL: 'https://sqs.ap-northeast-2.amazonaws.com/111111111111/alert-events' };

const secretsStub = (value: string | undefined) => {
  const calls: unknown[] = [];
  return { calls, send: vi.fn(async (cmd: unknown) => { calls.push(cmd); return { SecretString: value }; }) } as never as
    { calls: unknown[]; send: ReturnType<typeof vi.fn> } & Parameters<typeof readDatabaseUrl>[0];
};

describe('secret reading', () => {
  it('reads the bare connection string with the configured ARN', async () => {
    const s = secretsStub(`${URL_SECRET}\n`);
    await expect(readDatabaseUrl(s, env)).resolves.toBe(URL_SECRET);
    const cmd = s.calls[0] as GetSecretValueCommand;
    expect(cmd).toBeInstanceOf(GetSecretValueCommand);
    expect(cmd.input.SecretId).toBe(ARN);
  });
  it('accepts a JSON secret with url; empty or malformed → NotConfigured without echoing the value', async () => {
    await expect(readDatabaseUrl(secretsStub(JSON.stringify({ url: URL_SECRET })), env)).resolves.toBe(URL_SECRET);
    await expect(readDatabaseUrl(secretsStub(undefined), env)).rejects.toBeInstanceOf(NotConfiguredError);
    const bad = await readDatabaseUrl(secretsStub('{"password":"s3cr3t-pw"'), env).catch((e: Error) => e);
    expect(bad).toBeInstanceOf(NotConfiguredError);
    expect((bad as Error).message).not.toContain('s3cr3t');
    await expect(readDatabaseUrl(secretsStub(URL_SECRET), {})).rejects.toBeInstanceOf(NotConfiguredError);
  });
  it('onceAsync caches success for the container and retries after a failure', async () => {
    let n = 0;
    const get = onceAsync(async () => { n++; if (n === 1) throw new Error('boom'); return n; });
    await expect(get()).rejects.toThrow('boom');
    expect(await get()).toBe(2);
    expect(await get()).toBe(2);
    expect(n).toBe(2);
  });
});

describe('runtime loader', () => {
  it('fetches the secret once per cold start and builds the store from it; the URL is not logged', async () => {
    const secrets = secretsStub(URL_SECRET);
    const sent: unknown[] = [];
    const makeStore = vi.fn((url: string) => { expect(url).toBe(URL_SECRET); return memStore() as unknown as SqlIngestStore; });
    const load = createRuntimeLoader(env, { secrets, sqs: { send: (async (c: unknown) => { sent.push(c); return {}; }) as never } }, makeStore);
    const log = vi.spyOn(console, 'log'); const err = vi.spyOn(console, 'error');
    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBe(b);
    await load();
    expect(secrets.send).toHaveBeenCalledTimes(1);
    expect(makeStore).toHaveBeenCalledTimes(1);
    await a.queue.send([{ id: '0', body: { type: 'GROUP_CLOSE', schemaVersion: 1, groupId: 'g', groupKey: 'k' }, attributes: { customerId: 'c', source: 's' } }]);
    expect(sent[0]).toBeInstanceOf(SendMessageBatchCommand);
    expect((sent[0] as SendMessageBatchCommand).input.QueueUrl).toBe(env.ALERT_EVENTS_QUEUE_URL);
    for (const spy of [log, err]) expect(JSON.stringify(spy.mock.calls)).not.toContain('s3cr3t');
    log.mockRestore(); err.mockRestore();
  });
  it('missing queue URL fails closed before any secret call', async () => {
    const secrets = secretsStub(URL_SECRET);
    const load = createRuntimeLoader({ DATABASE_URL_SECRET_ARN: ARN }, { secrets }, () => { throw new Error('unreachable'); });
    await expect(load()).rejects.toBeInstanceOf(NotConfiguredError);
    expect(secrets.send).not.toHaveBeenCalled();
  });
});

const runtimeOf = (s = memStore(), q = new FakeQueue()): IngestRuntime =>
  ({ store: s as unknown as SqlIngestStore, queue: q, accounts: new AccountCustomerCache((id) => s.customerForAccount(id)) });
const silent = () => undefined;

describe('webhook entry (HTTP API v2)', () => {
  it('routes an API Gateway v2 event through the receiver to SQS', async () => {
    const q = new FakeQueue();
    const h = makeWebhookEntry(async () => runtimeOf(memStore(), q), silent, silent);
    const r = await h({
      rawPath: '/ingest/v1/prometheus', pathParameters: { source: 'prometheus' }, headers: { authorization: `Bearer ${PROM_TOKEN}` },
      body: JSON.stringify(coreFixture('alertmanager-v4.json')), isBase64Encoded: false, requestContext: { requestId: 'r1' },
    });
    expect(r.statusCode).toBe(202);
    expect(q.sent.length).toBeGreaterThan(0);
  });
  it('unauthenticated → 401 and nothing queued', async () => {
    const q = new FakeQueue();
    const h = makeWebhookEntry(async () => runtimeOf(memStore(), q), silent, silent);
    const r = await h({ pathParameters: { source: 'prometheus' }, headers: {}, body: '{}' });
    expect(r.statusCode).toBe(401);
    expect(q.sent).toHaveLength(0);
  });
  it('unset secret → 503 NOT_CONFIGURED; other failure → 500 with no detail and no secret in the log', async () => {
    const logs: string[] = [];
    const log = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
    const ev = { pathParameters: { source: 'prometheus' }, headers: {}, body: '{}', requestContext: { requestId: 'r2' } };
    const r503 = await makeWebhookEntry(async () => { throw new NotConfiguredError('DATABASE_URL_SECRET_ARN'); }, log, silent)(ev);
    expect(r503.statusCode).toBe(503);
    expect(JSON.parse(r503.body).error.code).toBe('NOT_CONFIGURED');
    const r500 = await makeWebhookEntry(async () => { throw new Error(`connect failed ${URL_SECRET}`); }, log, silent)(ev);
    expect(r500.statusCode).toBe(500);
    expect(r500.body).not.toContain('s3cr3t');
    expect(logs.join('')).not.toContain('s3cr3t');
  });
});

const cwEvent = (account: string) => ({
  version: '0', id: 'e1', 'detail-type': 'CloudWatch Alarm State Change', source: 'aws.cloudwatch', account, time: '2026-11-09T03:06:00Z',
  region: 'ap-northeast-2', resources: [`arn:aws:cloudwatch:ap-northeast-2:${account}:alarm:x-CPUUtilization`],
  detail: {
    alarmName: 'x-CPUUtilization', state: { value: 'ALARM', reason: 'r', timestamp: '2026-11-09T03:06:00.000+0000' },
    previousState: { value: 'OK', reason: 'r', timestamp: '2026-11-09T03:00:00.000+0000' },
    configuration: { metrics: [{ id: 'm', metricStat: { metric: { namespace: 'AWS/EC2', name: 'CPUUtilization', dimensions: { InstanceId: 'i-1' } }, period: 300, stat: 'Average' } }] },
  },
}) as never;

describe('eventbridge entry', () => {
  it('queues a CloudWatch alarm event', async () => {
    const q = new FakeQueue();
    const h = makeEventBridgeEntry(async () => runtimeOf(memStore(), q), silent, silent);
    const out = await h(cwEvent('123456789012'));
    expect(out).toEqual({ queued: 1 });
    expect(q.sent).toHaveLength(1);
  });
  it('ignores other event types and rethrows init failures (async retry + rule DLQ)', async () => {
    const h = makeEventBridgeEntry(async () => runtimeOf(), silent, silent);
    expect(await h({ ...(cwEvent('1') as object), source: 'aws.ec2' } as never)).toEqual({ queued: 0 });
    const bad = makeEventBridgeEntry(async () => { throw new Error('db down'); }, silent, silent);
    await expect(bad(cwEvent('1'))).rejects.toThrow('db down');
  });
});

describe('consumer entry (SQS partial batch)', () => {
  const rec = (messageId: string, body: string) => ({ messageId, body });
  it('maps only the failing records to batchItemFailures', async () => {
    const h = makeConsumerEntry(async () => runtimeOf(), silent);
    const res = await h({ Records: [rec('m1', '{not json'), rec('m2', JSON.stringify({ type: 'GROUP_CLOSE', schemaVersion: 1, groupId: 'g1', groupKey: 'k' })), rec('m3', JSON.stringify({ schemaVersion: 9 }))] });
    expect(res.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(['m1', 'm3']);
  });
  it('init failure reports every record as failed so nothing is lost, and retries init next time', async () => {
    let n = 0;
    const h = makeConsumerEntry(async () => { if (++n === 1) throw new NotConfiguredError('DATABASE_URL_SECRET_ARN'); return runtimeOf(); }, silent);
    const ev = { Records: [rec('a', '{}'), rec('b', '{}')] };
    expect((await h(ev)).batchItemFailures).toEqual([{ itemIdentifier: 'a' }, { itemIdentifier: 'b' }]);
    expect((await h({ Records: [rec('c', JSON.stringify({ type: 'GROUP_CLOSE', schemaVersion: 1, groupId: 'g', groupKey: 'k' }))] })).batchItemFailures).toEqual([]);
  });
});
