import { createHash, timingSafeEqual } from "node:crypto";

/**
 * `Authorization: Bearer <TICK_SECRET>` (API-CONTRACT §5). Fail closed: no secret configured (or shorter than 32
 * characters) → "not configured", never "allowed". Compared in constant time over SHA-256 digests, so neither the
 * content nor the length of the secret shows in the timing.
 */
export function tickAuth(header: string | null, env: Record<string, string | undefined>): "OK" | "DENIED" | "NOT_CONFIGURED" {
  const secret = env.TICK_SECRET;
  if (!secret || secret.length < 32) return "NOT_CONFIGURED";
  const m = /^Bearer (.+)$/.exec(header ?? "");
  const given = m?.[1] ?? "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b) && given.length > 0 ? "OK" : "DENIED";
}
