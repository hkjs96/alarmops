"use server";
import { getPublicApi } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import type { VerifyChannel } from "@/lib/api/types";
import { isVerifyToken } from "@/lib/verify-token";

export type ConfirmResult = { ok: true; channel: VerifyChannel } | { ok: false; code: "EXPIRED" | "UNAVAILABLE" };

/**
 * The public Confirm button (no session: the token in the path is the credential). POST /verify/{token} consumes the token
 * once. Anything that is not a live token is the one answer EXPIRED, however it came about (unknown, used, expired,
 * malformed). The token is never logged: an unexpected failure writes the route with `[token]` in its place.
 */
export async function confirmVerificationAction(token: string): Promise<ConfirmResult> {
  if (!isVerifyToken(token)) return { ok: false, code: "EXPIRED" };
  try {
    const r = await getPublicApi().confirmVerify(token);
    return { ok: true, channel: r.channel };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { ok: false, code: "EXPIRED" };
    console.error("[verify] POST /verify/[token] failed", e instanceof ApiError ? { status: e.status, code: e.code, requestId: e.requestId } : { error: "unexpected" });
    return { ok: false, code: "UNAVAILABLE" };
  }
}
