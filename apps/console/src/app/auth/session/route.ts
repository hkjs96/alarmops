import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionState } from "@/lib/server/session-check";

import { clientIp, hit, type Limit } from "@/lib/server/rate-limit";
import { mockMode } from "@/lib/mode";
import { sessionSecret, verifySession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
const WINDOW_MS = 60_000;
const IP_LIMIT = 120;
const ACCOUNT_LIMIT = 30;

/**
 * "Is this tab still signed in?" — 204 or 401, nothing else: no name, no role, no body. The page asks it when a server
 * action got no answer it can read, to tell "your session ended" from "the server did not answer" (lib/session-ended.ts).
 * Public in the middleware, because the question is asked exactly when there may be no session.
 * A valid cookie is not enough: the user must still resolve to a principal (a suspended portal user, a disabled user
 * → 401). 503 when the store did not answer — the page reads anything but 401 as "cannot say".
 */
export async function GET(req: NextRequest) {
  // Rate limit (hardening 2b), before anything is looked up: per address, and per account once the cookie VERIFIES
  // (a forged or random cookie only ever counts against its address: rotating cookies cannot fill the table). Fixed 60 s
  // windows, in memory and so per instance (lib/server/rate-limit.ts). The page asks rarely, so normal use is far below.
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  const byIp = hit(`session:ip:${clientIp(req.headers)}`, IP_LIMIT, WINDOW_MS);
  let byAcct: Limit = { ok: true, retryAfterSec: 0 };
  if (byIp.ok && cookie) {
    let mock = false;
    try { mock = mockMode(); } catch { mock = false; }
    const sess = await verifySession(cookie, sessionSecret(process.env, mock));
    if (sess) byAcct = hit(`session:acct:${sess.sub}`, ACCOUNT_LIMIT, WINDOW_MS);
  }
  if (!byIp.ok || !byAcct.ok) {
    const retryAfterSec = Math.max(byIp.ok ? 0 : byIp.retryAfterSec, byAcct.ok ? 0 : byAcct.retryAfterSec);
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly.", details: { retryAfterSec }, requestId: `req_${crypto.randomUUID()}` } },
      { status: 429, headers: { "Retry-After": String(retryAfterSec), "Cache-Control": "no-store" } },
    );
  }
  const state = await sessionState(req.cookies.get(SESSION_COOKIE)?.value);
  const status = state === "signed-in" ? 204 : state === "signed-out" ? 401 : 503;
  return new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });
}
