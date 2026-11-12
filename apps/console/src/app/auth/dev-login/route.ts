import { NextResponse, type NextRequest } from "next/server";
import { liveDevLogin, mockMode } from "@/lib/mode";
import { authForSession } from "@/lib/server/backend";
import { safeNextPath } from "@/lib/safe-next";
import { LOGIN_ENDED } from "@/lib/auth/ended-flags";
import { DEV_USER, DEV_USERS, LIVE_DEV_USERS, SESSION_COOKIE, SESSION_TTL_S, sessionSecret, signSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Mock mode, or live mode with LIVE_DEV_LOGIN=1 outside production (liveDevLogin): issues a dev session. */
export async function GET(req: NextRequest) {
  let mock = false;
  try {
    mock = mockMode();
  } catch {
    mock = false;
  }
  const live = !mock && liveDevLogin();
  const secret = sessionSecret(process.env, mock);
  if ((!mock && !live) || !secret) return new NextResponse("Not found", { status: 404 });

  // ?as=admin (default) | operator | viewer — anything else is the default user
  const as = req.nextUrl.searchParams.get("as") ?? "";
  let user = (Object.hasOwn(DEV_USERS, as) ? DEV_USERS[as] : undefined) ?? DEV_USER;
  if (live) {
    // the seeded users of db/prisma/seed.ts; the user must exist and be ACTIVE in the database
    const id = (Object.hasOwn(LIVE_DEV_USERS, as) ? LIVE_DEV_USERS[as] : undefined) ?? LIVE_DEV_USERS.admin!;
    const auth = await authForSession(id);
    // dev login is on but the store refuses this user (suspended customer, disabled user): back to /login with the
    // calm "you were signed out" notice, not a bare 404. Dev login off stays 404 above.
    if (!auth) return new NextResponse(null, { status: 303, headers: { Location: LOGIN_ENDED, "Cache-Control": "no-store" } });
    user = { sub: id, email: "", name: auth.name ?? id };
  }
  const token = await signSession({ ...user, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }, secret);
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  const res = NextResponse.redirect(new URL(next, req.nextUrl.origin));
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: SESSION_TTL_S,
  });
  return res;
}
