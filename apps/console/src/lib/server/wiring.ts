import { commandPublisherFromEnv, type CommandPublisher } from "@alarmops/api";
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
