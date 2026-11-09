import { describe, expect, it } from 'vitest';
import { makeWebhookHandler, MAX_BODY_BYTES, type HttpEvent } from '../src/webhook.js';
import { SourceRateLimiter } from '../src/rateLimit.js';
import { redactToken } from '../src/token.js';
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
  it('?token= fallback accepted only for a source with allowQueryToken (B-2)', async () => {
    const { h, s } = setup();
    expect((await h(req('grafana', coreFixture('grafana-unified.json'), {}, { token: GRAF_TOKEN }))).statusCode).toBe(202);
    const r = await h(req('prometheus', coreFixture('alertmanager-v4.json'), {}, { token: PROM_TOKEN }));
    expect(r.statusCode).toBe(401);
    expect(s.rejections.map((x) => x.reason)).toEqual(['query_token_not_allowed']);
  });
  it('redactToken strips tokens from query strings, bearer headers and bare tokens (B-2)', () => {
    const out = redactToken(`/ingest/v1/grafana?a=1&token=${GRAF_TOKEN}&b=2 Bearer ${PROM_TOKEN} ${PROM_TOKEN}`);
    expect(out).not.toContain(GRAF_TOKEN);
    expect(out).not.toContain(PROM_TOKEN);
    expect(out).toContain('token=[REDACTED]&b=2');
  });
  it('missing / wrong token → 401, metric only, no IngestRejection row, nothing queued (B-1)', async () => {
    const s = store();
    const q = new FakeQueue();
    const metrics: string[] = [];
    const logs: string[] = [];
    const h = makeWebhookHandler({ sources: s, queue: q, metric: (n, d) => metrics.push(`${n}:${d.reason}`), log: (_l, m, d) => logs.push(JSON.stringify({ m, d })) });
    expect((await h(req('prometheus', coreFixture('alertmanager-v4.json')))).statusCode).toBe(401);
    expect((await h(req('prometheus', coreFixture('alertmanager-v4.json'), { authorization: `Bearer in_${'c'.repeat(40)}` }))).statusCode).toBe(401);
    expect((await h(req('prometheus', '{}', { authorization: 'Bearer garbage' }))).statusCode).toBe(401);
    expect((await h({ ...req('prometheus', '{}', {}, { token: `in_${'d'.repeat(40)}` }), rawPath: `/ingest/v1/prometheus?token=in_${'d'.repeat(40)}` })).statusCode).toBe(401);
    expect(q.sent).toHaveLength(0);
    expect(s.rejections).toHaveLength(0);
    expect(metrics).toEqual(['IngestUnauthenticated:missing_token', 'IngestUnauthenticated:bad_token', 'IngestUnauthenticated:bad_token', 'IngestUnauthenticated:bad_token']);
    expect(logs.join('\n')).not.toMatch(/in_d{40}/);
  });
  it('per-source rate limit → 429, one audit row per window, other sources unaffected (B-1)', async () => {
    const s = store();
    const q = new FakeQueue();
    let now = new Date('2026-11-09T03:06:00Z');
    const h = makeWebhookHandler({ sources: s, queue: q, now: () => now, limiter: new SourceRateLimiter(2) });
    const prom = () => h(req('prometheus', coreFixture('alertmanager-v4.json'), { authorization: `Bearer ${PROM_TOKEN}` }));
    expect((await prom()).statusCode).toBe(202);
    expect((await prom()).statusCode).toBe(202);
    const limited = await prom();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect((await prom()).statusCode).toBe(429);
    expect(s.rejections.map((r) => r.reason)).toEqual(['rate_limited']);
    expect((await h(req('grafana', coreFixture('grafana-unified.json'), { authorization: `Bearer ${GRAF_TOKEN}` }))).statusCode).toBe(202);
    now = new Date('2026-11-09T03:07:00Z');
    expect((await prom()).statusCode).toBe(202);
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
