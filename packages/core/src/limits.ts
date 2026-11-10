/**
 * Safety limits and policy switches of the paging pipeline. Numbers marked PROPOSED are not in a decision yet
 * (security review of feat/tick-escalation, R-1/R-2/R-3/R-7, N-2); changing one is a one-line change here.
 */

// ── pending decisions: each is ONE flag, default = the safe value ──
/**
 * Q-1: do portal (customer) users see MSP staff by name? false → every staff member is shown as "MSP on-call".
 * Internal identifiers (contactId, userId, rotation id/name, pagingConfigId) are stripped for portal users either way.
 */
export const PORTAL_SHOWS_STAFF_NAMES = false;
/**
 * Q-2 (Q-DM-16): are SMS / voice sent only to verified phone numbers? true → an unverified number is skipped,
 * with a timeline event and a paging-health problem. Slack DM and email are not affected.
 */
export const SMS_VOICE_REQUIRE_VERIFIED = true;
export const STAFF_ALIAS = 'MSP on-call';

// ── call order shape (API-CONTRACT §8.3) ──
export const MAX_STEPS = 12;
export const MAX_AT_MIN = 24 * 60;
export const MAX_REPEAT = 5;

// ── send caps (PROPOSED, R-1) ──
/** Max notifications one incident may produce in one pass of its ladder (steps × targets × channels). */
export const MAX_SENDS_PER_CYCLE = 60;
/** Max notifications one incident may produce in any 60-minute window (repeats included). */
export const MAX_SENDS_PER_HOUR = 120;
/** Max people an ALL_RESPONDERS step reaches. A PUT is rejected above it; the engine cuts at it. */
export const MAX_ALL_RESPONDERS = 20;
/** Max reminders after an ack (N-2). */
export const MAX_RENOTIFY = 12;

// ── outbox (PROPOSED, R-2/R-3) ──
/** A provider call is abandoned after this long. Must stay below the first retry delay (30 s). */
export const SEND_TIMEOUT_MS = 10_000;
/** A claimed job that was never sent nor released comes back after this long (tick budget 45 s + send timeout). */
export const CLAIM_LEASE_SEC = 60;
/** Part of the tick budget the earlier phases may not use, so the outbox is always drained (capped at budget / 4). */
export const NOTIFY_RESERVE_MS = 10_000;

// ── manual escalate (PROPOSED, R-7) ──
export const MANUAL_ESCALATE_MIN_GAP_SEC = 60;

// ── outbox lanes (PROPOSED, security review 2: R-11, N-11, N-12, N-17) ──
/** Provider calls in flight per lane (SLACK / SMS / VOICE / EMAIL). Lanes run side by side and never wait for each other. */
export const LANE_CONCURRENCY = 5;
/** Consecutive timeouts after which a lane's circuit breaker opens; the rest of its claimed jobs go back untouched. */
export const BREAKER_TIMEOUTS = 3;
/** How long an open breaker waits before one probe job is sent (half-open). Below one tick, so the next tick probes. */
export const BREAKER_OPEN_SEC = 45;
/** The wait doubles after every failed probe, up to this. */
export const BREAKER_MAX_OPEN_SEC = 300;
/** Share of each claim kept for non-SEV-1 jobs, oldest first, so a wall of SEV-1 tenants cannot starve them (N-17). */
export const NON_SEV1_RESERVE_PCT = 20;
/** A page held by a maintenance window is looked at again at least this often (a window may be revoked early) — N-13. */
export const MAINTENANCE_RECHECK_SEC = 300;

// ── provider text (R-13) ──
/** Provider error text is cut to this BEFORE any pattern runs. */
export const PROVIDER_ERROR_MAX_CHARS = 300;

// ── idempotency store (N-19) ──
/** Live Idempotency-Key entries one user may hold; the oldest is dropped when a new one is stored. */
export const IDEMPOTENCY_MAX_PER_USER = 200;
