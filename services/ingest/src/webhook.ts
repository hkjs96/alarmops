import { detectWebhookKind, normalizeWebhook, type WebhookPayload } from '@alarmops/core';
import type { QueueSender, SourceRepository } from './ports.js';
import { messageAttributes } from './sqs.js';
import { SourceRateLimiter } from './rateLimit.js';
import { digestEquals, extractToken, hashToken, redactToken, TOKEN_RE } from './token.js';

/** Minimal API Gateway HTTP API (payload v2) shapes — no @types/aws-lambda dependency. */
export interface HttpEvent {
  rawPath?: string;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  headers: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { requestId?: string };
}
export interface HttpResult { statusCode: number; headers: Record<string, string>; body: string }

export const MAX_BODY_BYTES = 1024 * 1024; // API-CONTRACT §4: 413 over 1MB

const json = (statusCode: number, body: unknown): HttpResult => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const error = (statusCode: number, code: string, message: string, requestId?: string) =>
  json(statusCode, { error: { code, message, details: {}, requestId: requestId ?? null } });

export interface WebhookDeps {
  sources: SourceRepository;
  queue: QueueSender;
  now?: () => Date;
  /** Security B-1: per-source flood limit; defaults to one limiter per handler instance. */
  limiter?: SourceRateLimiter;
  /** Structured log; values are already token-redacted. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
  /** Counter for unauthenticated rejections (EMF/CloudWatch metric in prod). No DB row is written for these. */
  metric?: (name: string, dims: Record<string, string>) => void;
}

/**
 * B2 `POST /ingest/v1/{source}`. Customer is decided ONLY by the per-customer token → IntegrationSource
 * (backend 지침, org-tenant R5-5); body values are never trusted. Synchronous only up to the SQS send.
 */
export function makeWebhookHandler(deps: WebhookDeps) {
  return async (event: HttpEvent): Promise<HttpResult> => {
    const now = deps.now?.() ?? new Date();
    const limiter = deps.limiter ?? defaultLimiter;
    const reqId = event.requestContext?.requestId;
    const pathSource = (event.pathParameters?.source ?? event.rawPath?.split('/').pop() ?? '').toLowerCase();
    const kind = pathSource === 'prometheus' ? 'PROMETHEUS' : pathSource === 'grafana' ? 'GRAFANA' : null;
    if (!kind) return error(404, 'NOT_FOUND', 'Unknown ingest source.', reqId);

    const rawBody = event.body ?? '';
    const bodyBytes = event.isBase64Encoded ? Buffer.from(rawBody, 'base64') : Buffer.from(rawBody, 'utf8');
    // Token is checked before anything else is parsed so unauthenticated callers learn nothing.
    const extracted = extractToken(lower(event.headers), event.queryStringParameters);
    // Security B-1: no DB write for callers that never matched a source (anyone could flood IngestRejection).
    const unauth = (reason: string) => {
      deps.metric?.('IngestUnauthenticated', { kind, reason });
      deps.log?.('warn', 'ingest_unauthenticated', { kind, reason, requestId: reqId ?? null, path: redactToken(event.rawPath ?? '') });
      return error(401, 'UNAUTHENTICATED', 'Missing or invalid ingest token.', reqId);
    };
    if (!extracted || !TOKEN_RE.test(extracted.token)) return unauth(extracted ? 'bad_token' : 'missing_token');
    const tokenHash = hashToken(extracted.token);
    const src = await deps.sources.findSourceByTokenHash(tokenHash);
    if (!src || !src.tokenHash || !digestEquals(src.tokenHash, tokenHash)) return unauth('bad_token');
    if (!src.enabled) {
      await deps.sources.recordRejection({ kind, reason: 'source_disabled', sourceId: src.id, customerId: src.customerId });
      return error(401, 'UNAUTHENTICATED', 'Missing or invalid ingest token.', reqId);
    }
    if (extracted.via === 'query' && !src.allowQueryToken) {
      // Security B-2: the token is valid but leaked into a URL; refuse so the provider moves to the header.
      await deps.sources.recordRejection({ kind, reason: 'query_token_not_allowed', sourceId: src.id, customerId: src.customerId });
      return error(401, 'UNAUTHENTICATED', 'Send the ingest token in the Authorization header.', reqId);
    }
    const rl = limiter.check(src.id, now);
    if (rl !== 'OK') {
      deps.metric?.('IngestRateLimited', { kind, sourceId: src.id });
      // One audit row per source per window, not one per request.
      if (rl === 'LIMITED_FIRST') await deps.sources.recordRejection({ kind, reason: 'rate_limited', sourceId: src.id, customerId: src.customerId });
      return { ...error(429, 'RATE_LIMITED', 'Too many requests for this integration.', reqId), headers: { 'content-type': 'application/json', 'retry-after': String(60 - now.getUTCSeconds()) } };
    }
    if (bodyBytes.byteLength > MAX_BODY_BYTES) {
      await deps.sources.recordRejection({ kind, reason: 'too_large', sourceId: src.id, customerId: src.customerId });
      return error(413, 'PAYLOAD_TOO_LARGE', 'Payload exceeds 1 MB.', reqId);
    }
    if (src.kind !== kind) {
      await deps.sources.recordRejection({ kind, reason: 'source_kind_mismatch', sourceId: src.id, customerId: src.customerId });
      return error(400, 'VALIDATION_FAILED', `This token belongs to a ${src.kind.toLowerCase()} integration.`, reqId);
    }
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(bodyBytes.toString('utf8')) as WebhookPayload;
    } catch {
      await deps.sources.recordRejection({ kind, reason: 'bad_json', sourceId: src.id, customerId: src.customerId });
      return error(400, 'VALIDATION_FAILED', 'Body is not valid JSON.', reqId);
    }
    const detected = detectWebhookKind(payload);
    if (detected && detected !== kind) {
      await deps.sources.recordRejection({ kind, reason: 'payload_kind_mismatch', sourceId: src.id, customerId: src.customerId });
      return error(400, 'VALIDATION_FAILED', `Payload looks like ${detected.toLowerCase()}, not ${pathSource}.`, reqId);
    }

    const { events, rejected } = normalizeWebhook(kind, payload, {
      sourceId: src.id, customerId: src.customerId, receivedAt: now, severityTable: await deps.sources.severityTable(),
    });
    for (const r of rejected) {
      await deps.sources.recordRejection({ kind, reason: r.reason, sourceId: src.id, customerId: src.customerId });
    }
    // D-43: token, kind and payload were checked above, whatever the status. A TERMINATED customer's events are
    // answered 202 (the provider must not retry) but never queued: no alert, no incident, only the residual count.
    if ((await deps.sources.customerStatus(src.customerId)) === 'TERMINATED') {
      await deps.sources.recordResidual({ customerId: src.customerId, sourceKey: `integration:${src.id}`, at: now, count: Math.max(1, events.length) });
      await deps.sources.touchSource(src.id, now);
      return json(202, { accepted: events.length, rejected: rejected.filter((r) => r.index >= 0).length });
    }
    if (events.length) {
      await deps.queue.send(events.map((e, i) => ({ id: String(i), body: e, attributes: messageAttributes(e.customerId, e.source) })));
    }
    await deps.sources.touchSource(src.id, now);
    return json(202, { accepted: events.length, rejected: rejected.filter((r) => r.index >= 0).length });
  };
}

const defaultLimiter = new SourceRateLimiter();
const lower = (h: Record<string, string | undefined>) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
