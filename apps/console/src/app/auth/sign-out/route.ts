import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Sign out: the session cookie is removed and the browser goes to /login. POST only, and only from this origin, so a
 * link or an image on another site cannot sign a user out. The page clears its own `ao-…` sessionStorage (drafts)
 * before it posts here (components/AccountMenu.tsx) — the server cannot reach that.
 * Needs no session: signing out with an expired one must still remove the cookie.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  // behind a proxy the request URL may carry the internal host: compare with what the browser addressed
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === host; } catch { ok = false; }
    if (!ok) return new NextResponse("Forbidden", { status: 403 });
  } else if (req.headers.get("sec-fetch-site") && req.headers.get("sec-fetch-site") !== "same-origin") {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const res = new NextResponse(null, { status: 303, headers: { Location: "/login?signedOut=1" } });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: 0 });
  return res;
}
