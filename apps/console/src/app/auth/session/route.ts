import { NextResponse, type NextRequest } from "next/server";
import { mockMode } from "@/lib/mode";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * "Is this tab still signed in?" — 204 or 401, nothing else: no name, no role, no body. The page asks it when a server
 * action got no answer it can read, to tell "your session ended" from "the server did not answer" (lib/session-ended.ts).
 * Public in the middleware, because the question is asked exactly when there may be no session.
 */
export async function GET(req: NextRequest) {
  let mock = false;
  try { mock = mockMode(); } catch { mock = false; }
  const ok = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, sessionSecret(process.env, mock));
  return new NextResponse(null, { status: ok ? 204 : 401, headers: { "Cache-Control": "no-store" } });
}
