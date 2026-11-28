import { commandPublisherFromEnv, parseQueueUrl, partitionFromEnv, type CommandPublisher, type Partition } from "@alarmops/api";
import { retentionConfigFromEnv, type RetentionConfig } from "@alarmops/core";
import { sqsClientFromEnv } from "./sqs-client";

type Env = Record<string, string | undefined>;
const g = globalThis as unknown as { __aoRetention?: RetentionConfig };

/**
 * D-45 retention periods, built once per process from RETENTION_* and shared: `createApi({ retention })` (export window,
 * schedule shown with the purge log) and the tick's `runTick({ retention })` (what the daily job deletes) must use the
 * same object, or the screen would promise a date the job does not keep.
 */
export function retention(env: Env = process.env): RetentionConfig {
  return (g.__aoRetention ??= retentionConfigFromEnv(env, (w) => console.warn(`[retention config] ${w}`)));
}

/**
 * VERIFY_HASH_SECRET (Sensitive, runtime only, >= 32 characters): keys the per-destination send cap of the verification
 * links (HMAC-SHA-256, API-CONTRACT 8.4 "구현 메모 #62"). Unset or too short -> undefined: the API answers 503
 * NOT_CONFIGURED to a link request (nothing is sent, nothing is stored). The value is never logged.
 */
export function verificationSecret(env: Env = process.env): string | undefined {
  const v = env.VERIFY_HASH_SECRET?.trim();
  if (!v) return undefined;
  if (v.length < 32) { console.warn("[api config] VERIFY_HASH_SECRET is shorter than 32 characters: verification links stay unavailable"); return undefined; }
  return v;
}

/** ALARM_COMMANDS_QUEUE_URL unset -> undefined (503 COMMANDS_UNAVAILABLE). Set without AWS_ROLE_ARN -> undefined too (fail closed). */
export function commands(env: Env = process.env): CommandPublisher | undefined {
  if (!env.ALARM_COMMANDS_QUEUE_URL?.trim()) return undefined;
  const client = sqsClientFromEnv(env);
  if (!client) { console.warn("[api config] ALARM_COMMANDS_QUEUE_URL is set but AWS_ROLE_ARN is not: terminating a customer stays unavailable"); return undefined; }
  return commandPublisherFromEnv(env, { client });
}

/**
 * AWS partition for the role ARNs the API derives (D-58). `AWS_PARTITION` when set, else the partition of the queue URL,
 * else `aws`. Both present and different -> throws at start-up: a `.com.cn` queue with `AWS_PARTITION` unset must not
 * silently build `arn:aws:` roles (aws and aws-us-gov share a host form, so the URL alone cannot prove it either).
 * An unknown `AWS_PARTITION` value or a malformed queue URL also throws.
 */
export function resolvePartition(env: Env = process.env): Partition {
  const fromEnv = env.AWS_PARTITION?.trim() ? partitionFromEnv(env) : undefined;
  const url = env.ALARM_COMMANDS_QUEUE_URL?.trim();
  const parsed = url ? parseQueueUrl(url) : undefined;
  if (url && !parsed) throw new Error("ALARM_COMMANDS_QUEUE_URL must be https://sqs.<region>.amazonaws.com[.cn]/<account>/<queue>[.fifo]");
  if (fromEnv && parsed && fromEnv !== parsed.partition) throw new Error("AWS_PARTITION does not match the partition of ALARM_COMMANDS_QUEUE_URL");
  return fromEnv ?? parsed?.partition ?? "aws";
}
