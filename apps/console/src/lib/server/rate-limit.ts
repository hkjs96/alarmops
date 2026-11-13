import "server-only";

/**
 * Fixed-window request limiter, in memory (hardening 2b).
 *
 * PER INSTANCE: every server process counts for itself. With N instances behind a load balancer the effective limit is
 * up to N times higher, and a restart resets the counts. That is acceptable for the PoC; a shared counter (a database
 * row, an API gateway rule) replaces it when the console runs on more than one instance. Never uses Vercel storage.
 */
interface Slot { count: number; resetAt: number }
const slots = new Map<string, Slot>();
const MAX_KEYS = 10_000;

export interface Limit { ok: boolean; retryAfterSec: number }

/** Counts one request for `key`; `ok` is false once `limit` requests were seen in the current `windowMs` window. */
export function hit(key: string, limit: number, windowMs: number, now = Date.now()): Limit {
  if (slots.size >= MAX_KEYS) {
    for (const [k, v] of slots) if (v.resetAt <= now) slots.delete(k);
    // still full: evict the oldest keys (Map keeps insertion order), never everything: a flood of new keys must not wipe the others' counts
    for (const k of slots.keys()) { if (slots.size < MAX_KEYS) break; slots.delete(k); }
  }
  let s = slots.get(key);
  if (!s || s.resetAt <= now) { s = { count: 0, resetAt: now + windowMs }; slots.set(key, s); }
  s.count += 1;
  return { ok: s.count <= limit, retryAfterSec: Math.max(1, Math.ceil((s.resetAt - now) / 1000)) };
}

export function resetRateLimits(): void { slots.clear(); }

/**
 * The caller's address. `X-Forwarded-For` is believed only with TRUSTED_PROXY=1 (a proxy that sets it itself); without
 * it every caller shares the bucket "direct", which still caps the endpoint as a whole.
 */
export function clientIp(h: Headers, env: Record<string, string | undefined> = process.env): string {
  if (env.TRUSTED_PROXY === "1") {
    const parts = h.get("x-forwarded-for")?.split(",").map((x) => x.trim()).filter(Boolean);
    // the proxy appends the address it saw: the last entry is the one it vouches for
    if (parts?.length) return parts[parts.length - 1]!;
  }
  return "direct";
}
