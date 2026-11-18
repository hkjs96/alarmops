import { NextResponse, type NextRequest } from "next/server";
import { mockMode } from "@/lib/mode";
import { consoleOrigin } from "@/lib/auth/origin";
import { SESSION_COOKIE, SESSION_TTL_S, sessionSecret, signSession } from "@/lib/auth/session";
import { ssoConfig } from "@/lib/auth/sso-config";
import { decideSignIn } from "@/lib/auth/sso-signin";
import { FLOW_COOKIE, SsoError, exchangeCode, openFlow, stateMatches, verifyIdToken } from "@/lib/auth/google-oidc";
import { bindGoogleAccount, enrolByLoginDomain, signInUserByEmail, touchLastLogin } from "@/lib/server/backend";
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
  // the origin first: the Secure attribute follows the configured origin, not what the (proxied) request looks like
  let origin: string | null = null;
  try { origin = consoleOrigin() ?? req.nextUrl.origin; } catch { origin = null; }
  const secure = (origin ?? req.nextUrl.origin).startsWith("https:");
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
  if (!origin) return fail("console origin not configured", "unavailable");
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
  let enrolRefusal = null as string | null;
  let bound = null as string | null;
  try {
    decision = await decideSignIn(
      claims.email, cfg.config, signInUserByEmail,
      // asked only when there is no user row and the address is outside the staff fence (decideSignIn); the refusal code
      // (never an address) is kept for the log, the visitor sees the same refusal as for any identity reason
      async (_domain, addr) => {
        const r = await enrolByLoginDomain(addr);
        if ("refused" in r) { enrolRefusal = r.refused; return null; }
        return r.user;
      },
      {
        sub: claims.sub,
        bindGoogleSub: async (userId, sub) => {
          bound = await bindGoogleAccount(userId, sub);
          return bound === "bound" || bound === "ok" ? "ok" : "mismatch"; // mismatch and NOT_FOUND: no session
        },
      },
    );
  } catch {
    return fail("user store did not answer", "unavailable");
  }
  if (!decision.ok) return fail(enrolRefusal ? `${decision.reason} (enrol ${enrolRefusal})` : bound === "NOT_FOUND" ? "sub_mismatch (user not found)" : decision.reason, "refused");
  // last sign-in is informational: a failure must not block the sign-in
  try { await touchLastLogin(decision.user.id); } catch { console.warn("[sso] touchLastLogin failed (sign-in continues)"); }

  const token = await signSession({ sub: decision.user.id, email: "", name: decision.user.name, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }, secret);
  return done(safeNextPath(flow.next), token); // re-checked here: the cookie is signed, but the check costs nothing
}
