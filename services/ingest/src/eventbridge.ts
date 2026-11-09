import { normalizeCloudWatch, type CloudWatchEventBridgeEvent } from '@alarmops/core';
import type { AccountCustomerCache } from './accountCache.js';
import type { QueueSender } from './ports.js';
import { messageAttributes } from './sqs.js';

const HANDLED = new Set(['CloudWatch Alarm State Change', 'CloudWatch Alarm Configuration Change']);

/**
 * B1 ingest-normalizer λ: central bus rule target. Customer comes from the envelope `account`
 * (bus policy only admits allow-listed customer accounts, D-07). Unmapped accounts are still queued
 * with customerId=null (DATA-MODEL §0 테넌트 예외).
 */
export function makeEventBridgeHandler(deps: { accounts: AccountCustomerCache; queue: QueueSender; now?: () => Date }) {
  return async (event: CloudWatchEventBridgeEvent): Promise<{ queued: number }> => {
    if (!HANDLED.has(event['detail-type']) || event.source !== 'aws.cloudwatch') return { queued: 0 };
    const customerId = await deps.accounts.get(event.account);
    const ev = normalizeCloudWatch(event, { customerForAccount: () => customerId, receivedAt: deps.now?.() ?? new Date() });
    await deps.queue.send([{ id: '0', body: ev, attributes: messageAttributes(ev.customerId, ev.source) }]);
    return { queued: 1 };
  };
}
