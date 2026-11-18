import { NextResponse, type NextRequest } from "next/server";
import { mockMode } from "@/lib/mode";
import { consoleOrigin } from "@/lib/auth/origin";
import { SESSION_COOKIE, SESSION_TTL_S, sessionSecret, signSession } from "@/lib/auth/session";
import { ssoConfig } from "@/lib/auth/sso-config";
import { decideSignIn } from "@/lib/auth/sso-signin";
import { FLOW_COOKIE, SsoError, exchangeCode, openFlow, stateMatches, verifyIdToken } from "@/lib/auth/google-oidc";
import { signInUserByEmail } from "@/lib/server/backend";
import { safeNextPath } from "@/lib/safe-next";
import { clientIp, hit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Google redirects back here with ?code&state. In order: the flow cookie must verify and its state equal the query
 * state; the code is exchanged (PKCE verifier from the cookie); the ID token is verified (google-oidc.verifyIdToken);
 * then decideSignIn (user row + domain fence for staff). Every refusal for an identity reason is the same
 * /login?sso=refused — the reason code goes to the server log, without the address. The flow cookie is single use.
 */
export async function GET(req: NextRequest) {
  const secure = req.nextUrl.protocol === "https:";
  const done = (path: string, session?: string) => {
    const res = new NextResponse(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
    res.cookies.set(FLOW_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: "/auth/google", maxAge: 0 });
    if (session) res.cookies.set(SESSION_COOKIE, session, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SESSION_TTL_S });
    return res;
  };
  const fail = (reason: string, page: "failed" | "refused" | "unavailable") => {
    console.warn(`[sso] sign-in ${page}: ${reason}`);
    return done(`/login?sso=${page}`);
  };

  const cfg = ssoConfig();
  let mock = false;
  try { mock = mockMode(); } catch { mock = false; }
  const secret = sessionSecret(process.env, mock);
  let origin: string;
  try { origin = consoleOrigin() ?? req.nextUrl.origin; } catch { return fail("console origin not configured", "unavailable"); }
  if (!cfg.ok || !secret) return fail(cfg.ok ? "SESSION_SECRET missing" : cfg.reason, "unavailable");
  if (!hit(`sso:cb:${clientIp(req.headers)}`, 30, 60_000).ok) return fail("rate limited", "failed");

  const q = req.nextUrl.searchParams;
  if (q.get("error")) return fail(`google error ${/^[a-z_]{1,40}$/.test(q.get("error")!) ? q.get("error") : "other"}`, "failed");
  const flow = openFlow(req.cookies.get(FLOW_COOKIE)?.value, secret);
  if (!flow) return fail("flow cookie missing, expired or tampered", "failed");
  const code = q.get("code");
  if (!stateMatches(flow.state, q.get("state")) || !code || code.length > 2048) return fail("state mismatch or no code", "failed");

  let claims;
  try {
    const idToken = await exchangeCode({ clientId: cfg.config.clientId, clientSecret: cfg.config.clientSecret, redirectUri: `${origin}/auth/google/callback`, code, verifier: flow.verifier });
    claims = await verifyIdToken(idToken, { clientId: cfg.config.clientId, nonce: flow.nonce });
  } catch (e) {
    const code2 = e instanceof SsoError ? e.code : "unexpected";
    // an unverified address is an identity reason (same calm refusal); the rest is the flow failing
    return fail(`token: ${code2}`, code2 === "email_unverified" ? "refused" : code2.endsWith("_unreachable") ? "unavailable" : "failed");
  }

  let decision;
  try {
    decision = await decideSignIn(claims.email, cfg.config, signInUserByEmail);
  } catch {
    return fail("user store did not answer", "unavailable");
  }
  if (!decision.ok) return fail(decision.reason, "refused");

  const token = await signSession({ sub: decision.user.id, email: "", name: decision.user.name, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }, secret);
  return done(safeNextPath(flow.next), token); // re-checked here: the cookie is signed, but the check costs nothing
}
