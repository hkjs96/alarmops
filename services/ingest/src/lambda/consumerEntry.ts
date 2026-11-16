import { makeConsumerHandler, type SqsBatchResponse, type SqsEvent } from '../consumer.js';
import { jsonLog, type IngestRuntime, type Logger } from './runtime.js';

/**
 * SQS consumer entry (alert-events, ReportBatchItemFailures). If the runtime cannot start (secret not set yet,
 * DB unreachable) every record is reported as failed, so the messages go back to the queue instead of being lost.
 */
export function makeConsumerEntry(load: () => Promise<IngestRuntime>, log: Logger = jsonLog) {
  let inner: ReturnType<typeof makeConsumerHandler> | undefined;
  return async (event: SqsEvent): Promise<SqsBatchResponse> => {
    try {
      if (!inner) {
        const rt = await load();
        inner = makeConsumerHandler({ repo: rt.store, queue: rt.queue, log });
      }
    } catch (e) {
      log('error', 'consumer_init_failed', { name: e instanceof Error ? e.name : 'unknown' });
      return { batchItemFailures: event.Records.map((r) => ({ itemIdentifier: r.messageId })) };
    }
    return inner(event);
  };
}
