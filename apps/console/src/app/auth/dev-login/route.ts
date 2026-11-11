import { NextResponse, type NextRequest } from "next/server";
import { mockMode } from "@/lib/mode";
import { safeNextPath } from "@/lib/safe-next";
import { DEV_USER, DEV_USERS, SESSION_COOKIE, SESSION_TTL_S, sessionSecret, signSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Mock mode only (never production, see mockMode): issues a dev session for the mock user. */
export async function GET(req: NextRequest) {
  let mock = false;
  try {
    mock = mockMode();
  } catch {
    mock = false;
  }
  const secret = sessionSecret(process.env, mock);
  if (!mock || !secret) return new NextResponse("Not found", { status: 404 });

  // ?as=admin (default) | operator | viewer — anything else is the default user
  const as = req.nextUrl.searchParams.get("as") ?? "";
  const user = (Object.hasOwn(DEV_USERS, as) ? DEV_USERS[as] : undefined) ?? DEV_USER;
  const token = await signSession({ ...user, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }, secret);
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  const res = NextResponse.redirect(new URL(next, req.nextUrl.origin));
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: SESSION_TTL_S,
  });
  return res;
}
