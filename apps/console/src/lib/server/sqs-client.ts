import { parseQueueUrl, type SqsSender } from "@alarmops/api";

/**
 * The SQS client that publishes `alarm-commands` (API-CONTRACT §6, D-49): credentials come from Vercel OIDC by
 * assuming `AWS_ROLE_ARN` (permission: `sqs:SendMessage` on that one queue). No long-lived access keys exist.
 * The region comes from the queue URL (`parseQueueUrl(ALARM_COMMANDS_QUEUE_URL).region`, D-58), never a constant.
 *
 * The AWS SDK and the OIDC helper are imported on the first `send`, so mock mode, tests and a console without a queue
 * never load them. `createApi` is built synchronously, hence the thin lazy wrapper.
 *
 * `awsCredentialsProvider` is from `@vercel/oidc-aws-credentials-provider` (pinned; it replaces the deprecated
 * `@vercel/functions/oidc` with the same call shape).
 * Without AWS_ROLE_ARN there is no client (undefined): the caller then leaves the publisher undefined, so a
 * termination stays 503 COMMANDS_UNAVAILABLE.
 */
export function sqsClientFromEnv(env: Record<string, string | undefined> = process.env): SqsSender | undefined {
  const roleArn = env.AWS_ROLE_ARN?.trim();
  if (!roleArn) return undefined;
  const queueUrl = env.ALARM_COMMANDS_QUEUE_URL?.trim();
  if (!queueUrl) return undefined; // no queue: no publisher, requests stay 503 COMMANDS_UNAVAILABLE
  const parsed = parseQueueUrl(queueUrl);
  if (!parsed) throw new Error("ALARM_COMMANDS_QUEUE_URL must be https://sqs.<region>.amazonaws.com[.cn]/<account>/<queue>[.fifo]");
  const { region } = parsed;
  let client: Promise<SqsSender> | undefined;
  const load = (): Promise<SqsSender> => (client ??= (async () => {
    const [{ SQSClient }, { awsCredentialsProvider }] = await Promise.all([import("@aws-sdk/client-sqs"), import("@vercel/oidc-aws-credentials-provider")]);
    return new SQSClient({ region, credentials: awsCredentialsProvider({ roleArn }) }) as unknown as SqsSender;
  })().catch((e) => { client = undefined; throw e; }));
  return { send: async (command) => (await load()).send(command) };
}
