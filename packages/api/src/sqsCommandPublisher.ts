import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AlarmCommand, CommandPublisher } from './customerApi.js';

/** The only SQS call the adapter makes. An `SQSClient` satisfies it; tests pass a fake. Credentials live in the injected client. */
export interface SqsSender { send(command: SendMessageCommand): Promise<{ MessageId?: string }> }

export const COMMANDS_REGION = 'ap-northeast-2';
const QUEUE_URL_RE = /^https:\/\/sqs\.ap-northeast-2\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]{1,80}(\.fifo)?$/;
const MAX_BODY_BYTES = 256 * 1024 - 1024; // SQS limit 256 KiB; keep headroom
const ID_RE = /^[A-Za-z0-9!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]{1,128}$/; // SQS MessageDeduplicationId / MessageGroupId charset

const accountOf = (url: string): string => url.split('/')[3] ?? '';
const SENDABLE_TYPES: readonly string[] = ['OFFBOARD_ACCOUNT'];

export interface SqsCommandPublisherOptions {
  queueUrl: string;
  /** 12-digit AWS account that must own the queue. A queue URL in another account is refused (misconfiguration or tampering). */
  expectedAccount: string;
  /** Default: inferred from the URL (the `.fifo` suffix is mandatory for FIFO queues). A value that contradicts the suffix throws. */
  fifo?: boolean;
}

/** Why a publish failed. `causeName` (AWS error class name) is for server logs only: it must never reach an API response. The message never carries the queue URL or AWS error text. */
export class CommandPublishError extends Error {
  constructor(readonly reason: 'INVALID' | 'SEND_FAILED', readonly causeName?: string) {
    super(`command publish failed: ${reason}${causeName ? ` (${causeName})` : ''}`);
    this.name = 'CommandPublishError';
  }
}

/**
 * SQS adapter for the `alarm-commands` queue (API-CONTRACT §6). One SendMessage per command, so a failure is
 * attributable to exactly one account (the caller maps it to `commandsFailed`). The body is the AlarmCommand JSON the
 * Python handler parses. FIFO queues: MessageDeduplicationId = commandId, MessageGroupId = customerId.
 */
export class SqsCommandPublisher implements CommandPublisher {
  private readonly fifo: boolean;
  constructor(private readonly client: SqsSender, private readonly opts: SqsCommandPublisherOptions) {
    if (!QUEUE_URL_RE.test(opts.queueUrl)) throw new Error('invalid alarm-commands queue url');
    if (!/^\d{12}$/.test(opts.expectedAccount) || accountOf(opts.queueUrl) !== opts.expectedAccount) throw new Error('alarm-commands queue account does not match the expected account');
    this.fifo = opts.fifo ?? opts.queueUrl.endsWith('.fifo');
    if (this.fifo !== opts.queueUrl.endsWith('.fifo')) throw new Error('fifo setting does not match the queue url suffix');
  }

  async publish(cmd: AlarmCommand): Promise<void> {
    if (cmd.schemaVersion !== 1 || !SENDABLE_TYPES.includes(cmd.type) || !cmd.cloudAccountId) throw new CommandPublishError('INVALID');
    if (!ID_RE.test(cmd.commandId ?? '') || !ID_RE.test(cmd.customerId ?? '')) throw new CommandPublishError('INVALID');
    // allowlisted keys only: extra properties on the object never reach the queue
    const body = JSON.stringify({
      schemaVersion: cmd.schemaVersion, commandId: cmd.commandId, type: cmd.type, customerId: cmd.customerId,
      cloudAccountId: cmd.cloudAccountId, requestedBy: cmd.requestedBy, requestedAt: cmd.requestedAt, payload: cmd.payload,
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new CommandPublishError('INVALID');
    let messageId: string | undefined;
    try {
      const out = await this.client.send(new SendMessageCommand({
        QueueUrl: this.opts.queueUrl,
        MessageBody: body,
        ...(this.fifo ? { MessageDeduplicationId: cmd.commandId, MessageGroupId: cmd.customerId } : {}),
      }));
      messageId = out?.MessageId;
    } catch (e) {
      throw new CommandPublishError('SEND_FAILED', e instanceof Error ? e.name : undefined);
    }
    if (!messageId) throw new CommandPublishError('SEND_FAILED', 'NoMessageId');
  }
}

/**
 * `ALARM_COMMANDS_QUEUE_URL` unset or blank -> undefined (createApi then answers 503 COMMANDS_UNAVAILABLE: fail closed).
 * When set, `ALARM_COMMANDS_EXPECTED_ACCOUNT` (12 digits) is required and must equal the account in the URL, else throws.
 * Set but malformed or not in ap-northeast-2 -> throws at start-up (a typo must not look like "not configured").
 * `deps.client` carries the credentials (Vercel OIDC role or keys: Q-API-03); this module never reads them.
 * `AWS_REGION` is deliberately ignored: Vercel sets it to the function region; the queue region comes from the URL.
 */
export function commandPublisherFromEnv(env: Record<string, string | undefined>, deps: { client: SqsSender }): CommandPublisher | undefined {
  const url = env.ALARM_COMMANDS_QUEUE_URL?.trim();
  if (!url) return undefined;
  if (!QUEUE_URL_RE.test(url)) throw new Error(`ALARM_COMMANDS_QUEUE_URL must be https://sqs.${COMMANDS_REGION}.amazonaws.com/<account>/<queue>[.fifo]`);
  const expectedAccount = env.ALARM_COMMANDS_EXPECTED_ACCOUNT?.trim() ?? '';
  if (!/^\d{12}$/.test(expectedAccount)) throw new Error('ALARM_COMMANDS_EXPECTED_ACCOUNT (12 digits) is required when ALARM_COMMANDS_QUEUE_URL is set');
  return new SqsCommandPublisher(deps.client, { queueUrl: url, expectedAccount });
}
