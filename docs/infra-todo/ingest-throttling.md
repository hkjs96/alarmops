# Infra TODO: ingest throttling and token-safe access logs

From security review B-1 / B-2 (2026-11-10). Owner: infra (`infra/`). Backend side is done in `services/ingest`.

## 1. API Gateway route throttling (B-1)
- The webhook Lambda no longer writes `IngestRejection` rows for missing/malformed/unknown tokens; it only emits
  the `IngestUnauthenticated{kind,reason}` metric and a redacted warn log.
- The in-handler per-source limit (`SourceRateLimiter`, default 600 req/min per source, 429 `RATE_LIMITED`) is
  per Lambda instance, so it is best effort. The hard limit must be API Gateway stage/route throttling on
  `POST /ingest/v1/{source}` (proposal: rate 50 rps, burst 100) plus Lambda reserved concurrency.
- Alarm on `IngestUnauthenticated` and `IngestRateLimited` spikes.
- Open question: the specs mention "폭주 제한" but give no number. 600/min is a placeholder; confirm with the user.

## 2. Access logs must not contain tokens (B-2)
- `?token=` is now accepted only for sources with `IntegrationSource.allowQueryToken = true` (default false).
- API Gateway access-log format must use `$context.path` / `$context.routeKey`, never the raw query string.
  If CloudFront is in front, disable query-string logging or redact `token`.
