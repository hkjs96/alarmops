# services/ingest

Ingest Lambdas for the central account (API-CONTRACT §3-4): webhook receiver (HTTP API v2), EventBridge normalizer, and the
`alert-events` SQS consumer. The logic is in `src/{webhook,eventbridge,consumer}.ts` (+ `@alarmops/core`); the Lambda entry
points in `src/lambda/` only wire it to real dependencies.

| Entry (`dist/<name>/index.mjs`, export `handler`) | Trigger | Source |
|---|---|---|
| `webhook` | HTTP API `POST /ingest/v1/{source}` | `src/lambda/webhook.ts` -> `makeWebhookHandler` |
| `eventbridge` | central-bus rule (CloudWatch alarm events) | `src/lambda/eventbridge.ts` -> `makeEventBridgeHandler` |
| `consumer` | SQS `alert-events`, `ReportBatchItemFailures` | `src/lambda/consumer.ts` -> `makeConsumerHandler` |

## Build

```
npm run build:lambda -w @alarmops/ingest
```

esbuild (devDependency, exact version) bundles each entry with its dependencies (AWS SDK v3 clients pinned exact, `pg`,
`@alarmops/store-sql`) into `dist/{webhook,eventbridge,consumer}/index.mjs` (ESM, node22, ~1.4 MB each; `pg-native` is not
shipped). `dist/` is git-ignored. `test/artifacts.test.ts` runs the build and imports each bundle.

## Runtime

- `ALERT_EVENTS_QUEUE_URL`: `alert-events` queue (SendMessageBatch; also GROUP_CLOSE delayed messages from the consumer).
- `DATABASE_URL_SECRET_ARN`: Secrets Manager secret with the Postgres connection string of the ingest DB user. Read once
  per container (a failed read is retried on the next invocation). The value is never logged; errors are logged by name only.
- Webhook: unset config -> 503 `NOT_CONFIGURED`; any other failure -> 500 `INTERNAL` without detail (the provider retries).
  Customer comes only from the token (`IntegrationSource`); the body is not trusted. The per-source rate limit is per
  container (best effort); the HTTP API throttle in the template is the hard limit.
- EventBridge: errors propagate (Lambda async retry, then the rule's DLQ).
- Consumer: one bad record does not fail the batch; if the runtime cannot start, every record is reported failed (nothing lost).
- Metrics are CloudWatch EMF lines (`AlarmOps/Ingest`).

IAM needed (already in `infra/aws/central.yaml`): `sqs:SendMessage` on `alert-events`, `secretsmanager:GetSecretValue` on the
ingest DB secret. The consumer needs no `sqs:ReceiveMessage` grant of its own (the event source mapping adds it).
