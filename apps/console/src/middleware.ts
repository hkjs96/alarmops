import { NextResponse, type NextRequest } from "next/server";
import { mockMode } from "@/lib/mode";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth/session";

/** Default deny (security review C-2): everything except /login and static assets needs a valid session. */
const PUBLIC = [/^\/login(\/|$)/, /^\/auth\/dev-login$/, /^\/auth\/sign-out$/];

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((r) => r.test(pathname))) return NextResponse.next();

  let mock = false;
  try {
    mock = mockMode();
  } catch {
    return new NextResponse("Misconfigured: mock mode in production.", { status: 503 });
  }
  const secret = sessionSecret(process.env, mock);
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret);
  if (session) return NextResponse.next();

  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  const next = pathname + search;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/).*)"],
};
