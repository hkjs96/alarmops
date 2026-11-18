import { NextResponse, type NextRequest } from "next/server";
import { mockMode } from "@/lib/mode";
import { consoleOrigin } from "@/lib/auth/origin";
import { sessionSecret } from "@/lib/auth/session";
import { ssoConfig } from "@/lib/auth/sso-config";
import { FLOW_COOKIE, FLOW_TTL_S, authorizationUrl, newFlow, sealFlow } from "@/lib/auth/google-oidc";
import { safeNextPath } from "@/lib/safe-next";
import { clientIp, hit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

const to = (path: string) => new NextResponse(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });

/**
 * Starts Google sign-in: new state + nonce + PKCE verifier, sealed into a short-lived HttpOnly SameSite=Lax cookie
 * (Secure whenever the console is served over https), then a redirect to Google. The redirect URI comes from
 * CONSOLE_ORIGIN, never from request headers (outside production without it: the request's own origin, for local runs).
 * Config missing → /login?sso=unavailable (fail closed).
 */
export async function GET(req: NextRequest) {
  const cfg = ssoConfig();
  let mock = false;
  try { mock = mockMode(); } catch { mock = false; }
  const secret = sessionSecret(process.env, mock);
  let origin: string | null;
  try { origin = consoleOrigin() ?? req.nextUrl.origin; } catch { return to("/login?sso=unavailable"); }
  if (!cfg.ok || !secret) {
    console.warn(`[sso] start unavailable: ${cfg.ok ? "SESSION_SECRET missing" : cfg.reason}`);
    return to("/login?sso=unavailable");
  }
  if (!hit(`sso:start:${clientIp(req.headers)}`, 30, 60_000).ok) return to("/login?sso=failed");

  const flow = newFlow();
  const next = safeNextPath(req.nextUrl.searchParams.get("next"), "");
  const res = NextResponse.redirect(authorizationUrl({ clientId: cfg.config.clientId, redirectUri: `${origin}/auth/google/callback`, flow }), 302);
  res.cookies.set(FLOW_COOKIE, sealFlow({ ...flow, next, exp: Math.floor(Date.now() / 1000) + FLOW_TTL_S }, secret), {
    httpOnly: true, sameSite: "lax", secure: origin.startsWith("https:"), path: "/auth/google", maxAge: FLOW_TTL_S,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
