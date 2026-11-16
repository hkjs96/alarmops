import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient } from '@aws-sdk/client-sqs';
import { pgClient, SqlIngestStore } from '@alarmops/store-sql';
import { AccountCustomerCache } from '../accountCache.js';
import { requireEnv } from '../config.js';
import type { QueueSender } from '../ports.js';
import { SqsQueueSender } from '../sqs.js';
import { onceAsync, readDatabaseUrl, type SecretsClient } from './secret.js';

export type Logger = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;

/** One JSON line per call (CloudWatch Logs). Callers pass values that are already free of tokens and secrets. */
export const jsonLog: Logger = (level, msg, data) => {
  const line = JSON.stringify({ level, msg, ...data });
  if (level === 'error') console.error(line); else if (level === 'warn') console.warn(line); else console.log(line);
};

/** CloudWatch Embedded Metric Format line (namespace AlarmOps/Ingest). */
export const emfMetric = (name: string, dims: Record<string, string>): void => {
  console.log(JSON.stringify({
    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'AlarmOps/Ingest', Dimensions: [Object.keys(dims)], Metrics: [{ Name: name, Unit: 'Count' }] }] },
    ...dims, [name]: 1,
  }));
};

export interface IngestRuntime {
  store: SqlIngestStore;
  queue: QueueSender;
  accounts: AccountCustomerCache;
}

export interface RuntimeParts { secrets: SecretsClient; sqs: ConstructorParameters<typeof SqsQueueSender>[0] }

/** Builds the dependencies once per container: DB URL from Secrets Manager, pg pool, SQS sender. Exported for tests. */
export function createRuntimeLoader(env: Record<string, string | undefined> = process.env, parts?: Partial<RuntimeParts>,
  makeStore: (url: string) => SqlIngestStore = (url) => new SqlIngestStore(pgClient({ connectionString: url, max: 2 }))) {
  return onceAsync(async (): Promise<IngestRuntime> => {
    const region = env.AWS_REGION ?? 'ap-northeast-2';
    const queueUrl = requireEnv('ALERT_EVENTS_QUEUE_URL', env);
    const url = await readDatabaseUrl(parts?.secrets ?? new SecretsManagerClient({ region }), env);
    const store = makeStore(url);
    const queue = new SqsQueueSender(parts?.sqs ?? new SQSClient({ region }), queueUrl);
    return { store, queue, accounts: new AccountCustomerCache((id) => store.customerForAccount(id)) };
  });
}
