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
export function makeEventBridgeHandler(deps: { accounts: AccountCustomerCache; queue: QueueSender; sources: Pick<SourceRepository, 'customerStatus' | 'recordResidual'>; now?: () => Date }) {
  return async (event: CloudWatchEventBridgeEvent): Promise<{ queued: number }> => {
    if (!HANDLED.has(event['detail-type']) || event.source !== 'aws.cloudwatch') return { queued: 0 };
    const customerId = await deps.accounts.get(event.account);
    const receivedAt = deps.now?.() ?? new Date();
    // D-43: the account is mapped (bus policy + CloudAccount) before the status is looked at. A TERMINATED customer's
    // events are not queued: no alert, no incident, only the residual count ("cleanup needed").
    if (customerId && (await deps.sources.customerStatus(customerId)) === 'TERMINATED') {
      await deps.sources.recordResidual({ customerId, sourceKey: `aws:${event.account}`, at: receivedAt, count: 1 });
      return { queued: 0 };
    }
    const ev = normalizeCloudWatch(event, { customerForAccount: () => customerId, receivedAt });
    await deps.queue.send([{ id: '0', body: ev, attributes: messageAttributes(ev.customerId, ev.source) }]);
    return { queued: 1 };
  };
}
