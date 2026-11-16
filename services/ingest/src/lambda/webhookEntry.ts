import { NotConfiguredError } from '../config.js';
import { makeWebhookHandler, type HttpEvent, type HttpResult } from '../webhook.js';
import { emfMetric, jsonLog, type IngestRuntime, type Logger } from './runtime.js';

const err = (statusCode: number, code: string, message: string, requestId?: string): HttpResult => ({
  statusCode, headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ error: { code, message, details: {}, requestId: requestId ?? null } }),
});

/** HTTP API v2 entry: wires makeWebhookHandler to the loaded runtime. Config/DB failures never leak details (503/500). */
export function makeWebhookEntry(load: () => Promise<IngestRuntime>, log: Logger = jsonLog, metric = emfMetric) {
  let inner: ReturnType<typeof makeWebhookHandler> | undefined;
  return async (event: HttpEvent): Promise<HttpResult> => {
    const reqId = event.requestContext?.requestId;
    try {
      if (!inner) {
        const rt = await load();
        inner = makeWebhookHandler({ sources: rt.store, queue: rt.queue, log, metric });
      }
      return await inner(event);
    } catch (e) {
      if (e instanceof NotConfiguredError) {
        log('error', 'not_configured', { setting: e.setting, requestId: reqId ?? null });
        return err(503, 'NOT_CONFIGURED', 'Ingest is not configured.', reqId);
      }
      // Never log the error object itself (a pg error can carry the connection string).
      log('error', 'webhook_failed', { requestId: reqId ?? null, name: e instanceof Error ? e.name : 'unknown' });
      return err(500, 'INTERNAL', 'Temporary failure, retry later.', reqId);
    }
  };
}
