import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionState } from "@/lib/server/session-check";

export const dynamic = "force-dynamic";

/**
 * "Is this tab still signed in?" — 204 or 401, nothing else: no name, no role, no body. The page asks it when a server
 * action got no answer it can read, to tell "your session ended" from "the server did not answer" (lib/session-ended.ts).
 * Public in the middleware, because the question is asked exactly when there may be no session.
 * A valid cookie is not enough: the user must still resolve to a principal (a suspended portal user, a disabled user
 * → 401). 503 when the store did not answer — the page reads anything but 401 as "cannot say".
 */
export async function GET(req: NextRequest) {
  const state = await sessionState(req.cookies.get(SESSION_COOKIE)?.value);
  const status = state === "signed-in" ? 204 : state === "signed-out" ? 401 : 503;
  return new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });
}
