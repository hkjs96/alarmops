import type { ActionFailure } from "./action-result";
import type { AccountStatus } from "./api/types";

export const POLL_INTERVAL_MS = 2000;
/** 30 polls of 2 s: after a minute the page stops asking and says the engine has not answered */
export const POLL_MAX = 30;

export type PollResult =
  | { kind: "done"; status: AccountStatus }
  | { kind: "timeout"; last: AccountStatus | null }
  | { kind: "error"; failure: ActionFailure }
  | { kind: "cancelled" };

/**
 * After POST /accounts/{id}/check (202) the engine writes the result into the database: ask GET /accounts/{id}/status
 * until `lastCheckedAt` is different from what it was before the press (API-CONTRACT 8.4 "POST /accounts/{id}/check").
 * Bounded, and the caller can cancel (leaving the page). Pure: time and the call are given.
 */
export async function pollUntilChecked(o: {
  baseline: string | null;
  fetchStatus: () => Promise<{ ok: true; data: AccountStatus } | ActionFailure>;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxPolls?: number;
  cancelled?: () => boolean;
}): Promise<PollResult> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: AccountStatus | null = null;
  for (let i = 0; i < (o.maxPolls ?? POLL_MAX); i++) {
    await sleep(o.intervalMs ?? POLL_INTERVAL_MS);
    if (o.cancelled?.()) return { kind: "cancelled" };
    const r = await o.fetchStatus();
    if (o.cancelled?.()) return { kind: "cancelled" };
    if (!r.ok) return { kind: "error", failure: r };
    last = r.data;
    if (r.data.lastCheckedAt !== o.baseline) return { kind: "done", status: r.data };
  }
  return { kind: "timeout", last };
}
