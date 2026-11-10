import { NextResponse, type NextRequest } from "next/server";
import { mockMode } from "@/lib/mode";
import { safeNextPath } from "@/lib/safe-next";
import { DEV_USER, SESSION_COOKIE, SESSION_TTL_S, sessionSecret, signSession } from "@/lib/auth/session";

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

  const token = await signSession({ ...DEV_USER, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }, secret);
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  const res = NextResponse.redirect(new URL(next, req.nextUrl.origin));
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: SESSION_TTL_S,
  });
  return res;
}
