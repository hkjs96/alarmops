import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionState } from "@/lib/server/session-check";

export const dynamic = "force-dynamic";

/**
 * Where the layout sends a signed-cookie request whose user the API no longer accepts (GET /me → 401: suspended
 * customer, disabled user). The cookie is removed ONLY when the server itself finds the session dead, so a link
 * from another site cannot sign anyone out (sign-out proper stays POST + same-origin). Then /login — which would
 * otherwise send a still-signed cookie straight back to the page (redirect loop).
 */
export async function GET(req: NextRequest) {
  const state = await sessionState(req.cookies.get(SESSION_COOKIE)?.value);
  const to = (path: string) => new NextResponse(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
  if (state === "signed-in") return to("/incidents");
  if (state === "unknown") return new NextResponse("The server could not check your session. Try again in a moment.", { status: 503, headers: { "content-type": "text/plain", "Cache-Control": "no-store" } });
  const res = to("/login");
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: 0 });
  return res;
}
