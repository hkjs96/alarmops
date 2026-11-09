import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutgoingMessage, QueueSender } from './ports.js';

/** SQS sender for `alert-events`. Batches of 10 (SQS limit). Any failed entry → throw (retryable). */
export class SqsQueueSender implements QueueSender {
  constructor(private readonly client: Pick<SQSClient, 'send'>, private readonly queueUrl: string) {}

  async send(messages: OutgoingMessage[]): Promise<void> {
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      const res = await this.client.send(new SendMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries: chunk.map((m) => ({
          Id: m.id,
          MessageBody: JSON.stringify(m.body),
          DelaySeconds: m.delaySec,
          MessageAttributes: Object.fromEntries(Object.entries(m.attributes).map(([k, v]) => [k, { DataType: 'String', StringValue: v }])),
        })),
      }));
      if (res.Failed && res.Failed.length > 0) {
        throw new Error(`SQS rejected ${res.Failed.length} message(s): ${res.Failed.map((f) => f.Code).join(',')}`);
      }
    }
  }
}

export const messageAttributes = (customerId: string | null, source: string): Record<string, string> =>
  ({ customerId: customerId ?? 'UNMAPPED', source });
