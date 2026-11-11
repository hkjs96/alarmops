import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { sameOriginPost } from "@/lib/auth/origin";

export const dynamic = "force-dynamic";

/**
 * Sign out: the session cookie is removed and the browser goes to /login. POST only, and only from this origin, so a
 * link or an image on another site cannot sign a user out. The page clears its own `ao-…` sessionStorage (drafts)
 * before it posts here (lib/sign-out.ts) — the server cannot reach that.
 * Needs no session: signing out with an expired one must still remove the cookie.
 */
export async function POST(req: NextRequest) {
  const h = req.headers;
  // X-Forwarded-Host counts only with TRUSTED_PROXY=1 (lib/auth/origin.ts)
  if (!sameOriginPost({ origin: h.get("origin"), host: h.get("host"), forwardedHost: h.get("x-forwarded-host"), secFetchSite: h.get("sec-fetch-site") })) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const res = new NextResponse(null, { status: 303, headers: { Location: "/login?signedOut=1" } });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: 0 });
  return res;
}
