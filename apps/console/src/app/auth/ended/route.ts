import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionState } from "@/lib/server/session-check";
import { LOGIN_ENDED, isFromLayout } from "@/lib/auth/ended-flags";

export const dynamic = "force-dynamic";

/**
 * A plain page (no layout: the layout is what just failed) for a session this route finds alive while the layout's
 * GET /me said 401 — sending it back to /incidents would loop. Static text only; system colours (no design-system
 * stylesheet can load here), light and dark, 44px targets, no horizontal scroll at 390px.
 */
const STUCK_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Something went wrong — AlarmOps</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:420px;margin:0 auto;padding:72px 20px;box-sizing:border-box}
h1{font-size:22px;font-weight:600;margin:0 0 8px}
p{margin:0 0 20px;font-size:15px}
.row{display:flex;flex-wrap:wrap;gap:12px}
form{margin:0}
a,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:0 16px;font:inherit;font-size:15px;box-sizing:border-box}
a{color:LinkText}
button{background:ButtonFace;color:ButtonText;border:1px solid ButtonBorder;cursor:pointer}
a:focus-visible,button:focus-visible{outline:2px solid Highlight;outline-offset:2px}
</style></head>
<body><main>
<h1>Something went wrong — try again</h1>
<p>The console could not load your account just now.</p>
<div class="row">
<a href="/incidents">Try again</a>
<form method="post" action="/auth/sign-out"><button type="submit">Sign out</button></form>
</div>
</main></body></html>`;

/**
 * Where the layout sends a signed-cookie request whose user the API no longer accepts (GET /me → 401: suspended
 * customer, disabled user). The cookie is removed ONLY when the server itself finds the session dead, so a link
 * from another site cannot sign anyone out (sign-out proper stays POST + same-origin). Then /login?ended=1 — /login
 * would otherwise send a still-signed cookie straight back to the page (redirect loop).
 * Still signed in: a link from elsewhere goes to /incidents; but when the layout itself sent us here (?from=layout,
 * a fixed flag) the two checks disagree and /incidents would loop — a plain 200 page instead.
 */
export async function GET(req: NextRequest) {
  const state = await sessionState(req.cookies.get(SESSION_COOKIE)?.value);
  const to = (path: string) => new NextResponse(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
  if (state === "signed-in") {
    if (isFromLayout(req.nextUrl.searchParams.get("from"))) {
      return new NextResponse(STUCK_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    return to("/incidents");
  }
  if (state === "unknown") return new NextResponse("The server could not check your session. Try again in a moment.", { status: 503, headers: { "content-type": "text/plain", "Cache-Control": "no-store" } });
  const res = to(LOGIN_ENDED);
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: 0 });
  return res;
}
