import { describe, expect, it } from 'vitest';
import { makeWebhookHandler, MAX_BODY_BYTES, type HttpEvent } from '../src/webhook.js';
import { coreFixture, FakeQueue, GRAF_TOKEN, PROM_TOKEN, store } from './helpers.js';

const req = (source: string, body: unknown, headers: Record<string, string> = {}, query: Record<string, string> | null = null): HttpEvent => ({
  pathParameters: { source }, headers, queryStringParameters: query, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const setup = () => {
  const s = store();
  const q = new FakeQueue();
  return { s, q, h: makeWebhookHandler({ sources: s, queue: q, now: () => new Date('2026-11-09T03:06:00Z') }) };
};

describe('webhook receiver (API-CONTRACT §4)', () => {
  it('202 and one SQS message per alert with tenant attributes', async () => {
    const { h, q, s } = setup();
    const r = await h(req('prometheus', coreFixture('alertmanager-v4.json'), { Authorization: `Bearer ${PROM_TOKEN}` }));
    expect(r.statusCode).toBe(202);
    expect(JSON.parse(r.body)).toEqual({ accepted: 3, rejected: 0 });
    expect(q.sent).toHaveLength(3);
    expect(q.sent[0]!.attributes).toEqual({ customerId: 'cus_1', source: 'PROMETHEUS' });
    expect(s.touched[0]!.sourceId).toBe('src_prom');
  });
  it('?token= fallback accepted', async () => {
    const { h } = setup();
    expect((await h(req('grafana', coreFixture('grafana-unified.json'), {}, { token: GRAF_TOKEN }))).statusCode).toBe(202);
  });
  it('missing / wrong token → 401 + IngestRejection, nothing queued (no shared token)', async () => {
    const { h, q, s } = setup();
    expect((await h(req('prometheus', coreFixture('alertmanager-v4.json')))).statusCode).toBe(401);
    expect((await h(req('prometheus', coreFixture('alertmanager-v4.json'), { authorization: `Bearer in_${'c'.repeat(40)}` }))).statusCode).toBe(401);
    expect((await h(req('prometheus', '{}', { authorization: 'Bearer garbage' }))).statusCode).toBe(401);
    expect(q.sent).toHaveLength(0);
    expect(s.rejections.map((r) => r.reason)).toEqual(['missing_token', 'bad_token', 'bad_token']);
  });
  it('tenant is decided by token, not by body (org-tenant R5-5)', async () => {
    const { h, q } = setup();
    const body = { ...coreFixture('alertmanager-v4.json'), customerId: 'cus_2', commonLabels: { customer: 'cus_2' } };
    await h(req('prometheus', body, { authorization: `Bearer ${PROM_TOKEN}` }));
    expect(q.sent.every((m) => (m.body as any).customerId === 'cus_1')).toBe(true);
  });
  it('disabled source → 401', async () => {
    const { h, s } = setup();
    s.sources[0]!.enabled = false;
    expect((await h(req('prometheus', coreFixture('alertmanager-v4.json'), { authorization: `Bearer ${PROM_TOKEN}` }))).statusCode).toBe(401);
    expect(s.rejections[0]!.reason).toBe('source_disabled');
  });
  it('path/kind mismatch → 400; grafana body on prometheus path → 400', async () => {
    const { h } = setup();
    expect((await h(req('grafana', coreFixture('grafana-unified.json'), { authorization: `Bearer ${PROM_TOKEN}` }))).statusCode).toBe(400);
    expect((await h(req('prometheus', coreFixture('grafana-unified.json'), { authorization: `Bearer ${PROM_TOKEN}` }))).statusCode).toBe(400);
  });
  it('> 1MB → 413 (known-bugs 1-7); bad JSON → 400; unknown source → 404', async () => {
    const { h } = setup();
    const auth = { authorization: `Bearer ${PROM_TOKEN}` };
    expect((await h(req('prometheus', 'x'.repeat(MAX_BODY_BYTES + 1), auth))).statusCode).toBe(413);
    expect((await h(req('prometheus', '{nope', auth))).statusCode).toBe(400);
    expect((await h(req('pagerduty', '{}', auth))).statusCode).toBe(404);
  });
  it('alerts lacking alertname are counted as rejected', async () => {
    const { h, s } = setup();
    const body = { version: '4', alerts: [{ status: 'firing', labels: { x: '1' } }, { status: 'firing', labels: { alertname: 'A' } }] };
    const r = await h(req('prometheus', body, { authorization: `Bearer ${PROM_TOKEN}` }));
    expect(JSON.parse(r.body)).toEqual({ accepted: 1, rejected: 1 });
    expect(s.rejections.at(-1)!.reason).toBe('missing_alertname');
  });
  it('SQS failure propagates (retryable 5xx from the gateway), nothing acknowledged', async () => {
    const { h, q } = setup();
    q.failNext = true;
    await expect(h(req('prometheus', coreFixture('alertmanager-v4.json'), { authorization: `Bearer ${PROM_TOKEN}` }))).rejects.toThrow(/SQS/);
  });
});
