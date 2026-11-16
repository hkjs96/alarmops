import { makeEventBridgeHandler } from '../eventbridge.js';
import { emfMetric, jsonLog, type IngestRuntime, type Logger } from './runtime.js';

/**
 * EventBridge entry. Errors propagate so Lambda's async retry + the rule's DLQ (RetryPolicy) keep the event;
 * only the safe error name is logged.
 */
export function makeEventBridgeEntry(load: () => Promise<IngestRuntime>, log: Logger = jsonLog, metric = emfMetric) {
  let inner: ReturnType<typeof makeEventBridgeHandler> | undefined;
  return async (event: Parameters<ReturnType<typeof makeEventBridgeHandler>>[0]): Promise<{ queued: number }> => {
    try {
      if (!inner) {
        const rt = await load();
        inner = makeEventBridgeHandler({ accounts: rt.accounts, queue: rt.queue, sources: rt.store, log, metric });
      }
      return await inner(event);
    } catch (e) {
      log('error', 'eventbridge_failed', { name: e instanceof Error ? e.name : 'unknown' });
      throw e;
    }
  };
}
