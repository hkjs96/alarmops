import type { SqsSender } from "@alarmops/api";

/**
 * The SQS client that publishes `alarm-commands` (API-CONTRACT §6, D-49): credentials come from Vercel OIDC by
 * assuming `AWS_ROLE_ARN` (permission: `sqs:SendMessage` on that one queue). No long-lived access keys exist.
 * Region is fixed to ap-northeast-2.
 *
 * The AWS SDK and the OIDC helper are imported on the first `send`, so mock mode, tests and a console without a queue
 * never load them. `createApi` is built synchronously, hence the thin lazy wrapper.
 *
 * `awsCredentialsProvider` is from `@vercel/functions/oidc` (3.11.3). That subpath is marked deprecated in favour of
 * `@vercel/oidc-aws-credentials-provider`; same call shape, switch when that package is approved.
 * Without AWS_ROLE_ARN there is no client (undefined): the caller then leaves the publisher undefined, so a
 * termination stays 503 COMMANDS_UNAVAILABLE.
 */
export function sqsClientFromEnv(env: Record<string, string | undefined> = process.env): SqsSender | undefined {
  const roleArn = env.AWS_ROLE_ARN?.trim();
  if (!roleArn) return undefined;
  let client: Promise<SqsSender> | undefined;
  const load = (): Promise<SqsSender> => (client ??= (async () => {
    const [{ SQSClient }, { awsCredentialsProvider }] = await Promise.all([import("@aws-sdk/client-sqs"), import("@vercel/functions/oidc")]);
    return new SQSClient({ region: "ap-northeast-2", credentials: awsCredentialsProvider({ roleArn }) }) as unknown as SqsSender;
  })().catch((e) => { client = undefined; throw e; }));
  return { send: async (command) => (await load()).send(command) };
}
