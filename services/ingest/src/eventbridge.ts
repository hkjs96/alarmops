import { normalizeCloudWatch, type CloudWatchEventBridgeEvent } from '@alarmops/core';
import type { AccountCustomerCache } from './accountCache.js';
import type { QueueSender, SourceRepository } from './ports.js';
import { messageAttributes } from './sqs.js';

const HANDLED = new Set(['CloudWatch Alarm State Change', 'CloudWatch Alarm Configuration Change']);

/**
 * B1 ingest-normalizer λ: central bus rule target. Customer comes from the envelope `account`
 * (bus policy only admits allow-listed customer accounts, D-07). Unmapped accounts are still queued
 * with customerId=null (DATA-MODEL §0 테넌트 예외). SUSPENDED customers' events are queued like any other (the tick
 * records the incident without paging); TERMINATED customers' events are only counted (D-43).
 */
export function makeEventBridgeHandler(deps: { accounts: AccountCustomerCache; queue: QueueSender; sources: Pick<SourceRepository, 'customerStatus' | 'recordResidual'>; now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void; metric?: (name: string, dims: Record<string, string>) => void }) {
  // Only TERMINATED is cached (a termination is final, so a stale "yes" cannot be wrong); ACTIVE/SUSPENDED are read each time.
  const terminatedUntil = new Map<string, number>();
  const TERMINATED_TTL_MS = 45_000;
  return async (event: CloudWatchEventBridgeEvent): Promise<{ queued: number }> => {
    if (!HANDLED.has(event['detail-type']) || event.source !== 'aws.cloudwatch') return { queued: 0 };
    const customerId = await deps.accounts.get(event.account);
    const receivedAt = deps.now?.() ?? new Date();
    // D-43: the account is mapped (bus policy + CloudAccount) before the status is looked at. A TERMINATED customer's
    // events are not queued: no alert, no incident, only the residual count ("cleanup needed").
    // The status lookup is not worth losing a page for: if it fails the event is queued (the tick and the send-time
    // recheck are the real gate for non-ACTIVE customers) and the failure is logged and counted.
    let terminated = false;
    if (customerId) {
      const t = Date.now();
      if ((terminatedUntil.get(customerId) ?? 0) > t) terminated = true;
      else {
        try {
          terminated = (await deps.sources.customerStatus(customerId)) === 'TERMINATED';
          if (terminated) terminatedUntil.set(customerId, t + TERMINATED_TTL_MS);
        } catch (err) {
          deps.log?.('warn', 'customer_status_lookup_failed', { customerId, error: String(err) });
          deps.metric?.('IngestStatusLookupFailed', { source: 'CLOUDWATCH' });
        }
      }
    }
    if (customerId && terminated) {
      await deps.sources.recordResidual({ customerId, sourceKey: `aws:${event.account}`, at: receivedAt, count: 1 });
      return { queued: 0 };
    }
    const ev = normalizeCloudWatch(event, { customerForAccount: () => customerId, receivedAt });
    await deps.queue.send([{ id: '0', body: ev, attributes: messageAttributes(ev.customerId, ev.source) }]);
    return { queued: 1 };
  };
}
