import { NextResponse, type NextRequest } from "next/server";
import { mockMode } from "@/lib/mode";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth/session";
import { SESSION_ENDED } from "@/lib/session-ended";
import { buildCsp, newNonce } from "@/lib/csp";
import { consoleOrigin } from "@/lib/auth/origin";

/** Default deny (security review C-2): everything except /login and static assets needs a valid session. */
const PUBLIC = [/^\/login(\/|$)/, /^\/auth\/dev-login$/, /^\/auth\/sign-out$/, /^\/auth\/session$/, /^\/auth\/ended$/,
  // the 1-minute tick: no session, its own shared secret (app/api/internal/tick, fail closed without TICK_SECRET)
  /^\/api\/internal\/tick$/];

/**
 * Every response carries the Content-Security-Policy with a nonce made for this request (lib/csp.ts). The nonce also goes
 * to the page as the request header `x-nonce` (layout.tsx puts it on its two inline scripts) and as
 * `content-security-policy` (Next reads the nonce from it and puts it on the scripts it streams).
 */
export async function middleware(req: NextRequest) {
  const nonce = newNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV === "production");
  const fwd = new Headers(req.headers);
  fwd.set("x-nonce", nonce);
  fwd.set("content-security-policy", csp);
  const res = await gate(req, () => NextResponse.next({ request: { headers: fwd } }));
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

async function gate(req: NextRequest, next: () => NextResponse): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;
  // production without a valid CONSOLE_ORIGIN: fail closed on every request, not a silent fallback to the Host header
  try {
    consoleOrigin();
  } catch {
    return new NextResponse("Misconfigured: CONSOLE_ORIGIN is required in production.", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (PUBLIC.some((r) => r.test(pathname))) return next();

  let mock = false;
  try {
    mock = mockMode();
  } catch {
    return new NextResponse("Misconfigured: mock mode in production.", { status: 503 });
  }
  const secret = sessionSecret(process.env, mock);
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret);
  if (session) return next();

  // The REST API answers in its own format (401 UNAUTHENTICATED), not with a redirect to a page.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue.", details: {}, requestId: "" } }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  // A server action (ack, save, remove…) sent from a tab whose session is gone. A redirect to /login is something the
  // page cannot read — it used to leave "Saving…" on the screen for ever (QA 최종 점검 P2-D). 401 with this body is
  // what the page's action wrapper turns into "Your session ended — sign in again" (lib/session-ended.ts).
  if (req.method === "POST" && req.headers.has("next-action")) {
    return new NextResponse(SESSION_ENDED, { status: 401, headers: { "content-type": "text/plain", "Cache-Control": "no-store" } });
  }

  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  const back = pathname + search;
  if (back !== "/") login.searchParams.set("next", back);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/).*)"],
};
