// @vitest-environment node
/** /auth/google/start and /callback, with a stubbed Google (token endpoint + JWKS) and a stubbed user store. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
const signInUserByEmail = vi.fn();
const bindGoogleAccount = vi.fn();
const enrolByLoginDomain = vi.fn();
const touchLastLogin = vi.fn();
vi.mock("@/lib/server/backend", () => ({
  signInUserByEmail: (e: string) => signInUserByEmail(e),
  bindGoogleAccount: (u: string, s: string) => bindGoogleAccount(u, s),
  enrolByLoginDomain: (e: string) => enrolByLoginDomain(e),
  touchLastLogin: (u: string) => touchLastLogin(u),
}));

import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth/session";
import { FLOW_COOKIE, resetJwksCache } from "@/lib/auth/google-oidc";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { GET as start } from "./start/route";
import { GET as callback } from "./callback/route";

const SECRET = "x".repeat(40);
const CLIENT = "client-1.apps.example";
const ORIGIN = "https://console.example.com";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (nonce: string, over: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "RS256", kid: "k1" });
  const b = b64({ iss: "https://accounts.google.com", aud: CLIENT, sub: "g-1", email: "ops@mz.co.kr", email_verified: true, nonce, iat: now, exp: now + 3000, ...over });
  return `${h}.${b}.${createSign("RSA-SHA256").update(`${h}.${b}`).sign(pair.privateKey).toString("base64url")}`;
};

let tokenBody: (nonce: string) => string;
beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("MOCK_API", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CONSOLE_ORIGIN", ORIGIN);
  vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "s3cret");
  vi.stubEnv("SSO_ALLOWED_DOMAINS", "mz.co.kr,megazone.com");
  vi.stubEnv("SSO_ALLOWED_EMAILS", "");
  signInUserByEmail.mockReset();
  bindGoogleAccount.mockReset().mockResolvedValue("bound");
  enrolByLoginDomain.mockReset().mockResolvedValue({ refused: "DOMAIN_UNKNOWN" });
  touchLastLogin.mockReset().mockResolvedValue(undefined);
  resetRateLimits();
  resetJwksCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/certs")) return Response.json({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" }] });
    return Response.json({ id_token: tokenBody(currentNonce) });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

let currentNonce = "";
/** run /start, return the flow cookie and the state Google would echo */
async function begin(next?: string) {
  const res = await start(new NextRequest(`http://internal.invalid/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ""}`));
  const loc = new URL(res.headers.get("location")!);
  currentNonce = loc.searchParams.get("nonce")!;
  return { res, loc, cookie: res.cookies.get(FLOW_COOKIE)!.value, state: loc.searchParams.get("state")! };
}
const cb = (q: Record<string, string>, cookie?: string) =>
  callback(new NextRequest(`${ORIGIN}/auth/google/callback?${new URLSearchParams(q)}`, { headers: cookie ? { cookie: `${FLOW_COOKIE}=${cookie}` } : {} }));
const where = (r: Response) => r.headers.get("location");

describe("GET /auth/google/start", () => {
  it("redirects to Google with PKCE, state, nonce; redirect URI from CONSOLE_ORIGIN (not the Host header)", async () => {
    const { res, loc } = await begin();
    expect(res.status).toBe(302);
    expect(loc.origin).toBe("https://accounts.google.com");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("client_id")).toBe(CLIENT);
  });
  it("sets the flow cookie HttpOnly, SameSite=Lax, Secure (https origin), short-lived, scoped to /auth/google", async () => {
    const c = (await begin()).res.cookies.get(FLOW_COOKIE)!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/auth/google", maxAge: 600 });
  });
  it.each([["GOOGLE_CLIENT_ID"], ["GOOGLE_CLIENT_SECRET"], ["SSO_ALLOWED_DOMAINS"]])("without %s: /login?sso=unavailable, no cookie, no redirect to Google", async (k) => {
    vi.stubEnv(k, "");
    const res = await start(new NextRequest("http://internal.invalid/auth/google/start"));
    expect(where(res)).toBe("/login?sso=unavailable");
    expect(res.cookies.get(FLOW_COOKIE)).toBeUndefined();
  });
  it("production without CONSOLE_ORIGIN: unavailable (never the Host header)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONSOLE_ORIGIN", "");
    expect(where(await start(new NextRequest("http://evil.example/auth/google/start")))).toBe("/login?sso=unavailable");
  });
});

describe("GET /auth/google/callback", () => {
  beforeEach(() => { tokenBody = (n) => idToken(n); });
  const staff = { id: "usr_staff", name: "Ops", kind: "INTERNAL" };

  it("happy path: session cookie for the user row, redirect to next, flow cookie cleared", async () => {
    signInUserByEmail.mockResolvedValue(staff);
    const f = await begin("/incidents?x=1");
    const res = await cb({ code: "c", state: f.state }, f.cookie);
    expect(res.status).toBe(303);
    expect(where(res)).toBe("/incidents?x=1");
    const s = await verifySession(res.cookies.get(SESSION_COOKIE)!.value, sessionSecret(process.env, false));
    expect(s).toMatchObject({ sub: "usr_staff", name: "Ops" });
    expect(res.cookies.get(FLOW_COOKIE)).toMatchObject({ value: "", maxAge: 0 });
    expect(signInUserByEmail).toHaveBeenCalledWith("ops@mz.co.kr");
  });
  it("session cookie: HttpOnly, SameSite=Lax, Secure from the https CONSOLE_ORIGIN, path /, 8 h, no e-mail inside", async () => {
    signInUserByEmail.mockResolvedValue(staff);
    const f = await begin();
    // the request itself looks like plain http (a proxy ended TLS): Secure still follows the configured origin
    const res = await callback(new NextRequest(`http://internal.invalid/auth/google/callback?${new URLSearchParams({ code: "c", state: f.state })}`, { headers: { cookie: `${FLOW_COOKIE}=${f.cookie}` } }));
    const c = res.cookies.get(SESSION_COOKIE)!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 8 * 60 * 60 });
    const payload = JSON.parse(Buffer.from(c.value.split(".")[0]!, "base64url").toString());
    expect(payload.email).toBe("");
    expect(JSON.stringify(payload)).not.toContain("@");
  });
  it("a flow cookie cannot be used twice: it is cleared, and a replay (Google refuses the used code) gets no session", async () => {
    signInUserByEmail.mockResolvedValue(staff);
    const f = await begin();
    const first = await cb({ code: "c", state: f.state }, f.cookie);
    expect(first.cookies.get(FLOW_COOKIE)).toMatchObject({ value: "", maxAge: 0, httpOnly: true, secure: true });
    expect(first.cookies.get(SESSION_COOKIE)).toBeDefined();
    const noCookie = await cb({ code: "c", state: f.state });
    expect(where(noCookie)).toBe("/login?sso=failed");
    expect(noCookie.cookies.get(SESSION_COOKIE)).toBeUndefined();
    vi.mocked(fetch).mockImplementation((async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as never);
    const replay = await cb({ code: "c", state: f.state }, f.cookie);
    expect(where(replay)).toBe("/login?sso=failed");
    expect(replay.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
  it("open redirect: a hostile next never survives (dropped at start, and again at the callback)", async () => {
    signInUserByEmail.mockResolvedValue(staff);
    for (const next of ["//evil.example", "https://evil.example", "/%09/evil.example", "/\\evil.example"]) {
      resetRateLimits();
      const f = await begin(next);
      const res = await cb({ code: "c", state: f.state }, f.cookie);
      expect(where(res)).toBe("/incidents");
    }
  });
  it("a portal user with an outside domain gets a session (portal scope comes from the DB row)", async () => {
    tokenBody = (n) => idToken(n, { email: "someone@customer.example" });
    signInUserByEmail.mockResolvedValue({ id: "usr_portal", name: "Yuna", kind: "CUSTOMER" });
    const f = await begin();
    expect(res_ok(await cb({ code: "c", state: f.state }, f.cookie))).toBe(true);
  });
  it("INTERNAL user with an outside domain: refused, no session", async () => {
    tokenBody = (n) => idToken(n, { email: "outsider@evil.com" });
    signInUserByEmail.mockResolvedValue(staff);
    const f = await begin();
    const res = await cb({ code: "c", state: f.state }, f.cookie);
    expect(where(res)).toBe("/login?sso=refused");
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
  it("unknown / inactive user: the same refusal as any other identity reason; log has a reason code and no address", async () => {
    signInUserByEmail.mockResolvedValue(null);
    const warn = vi.mocked(console.warn);
    const f = await begin();
    const res = await cb({ code: "c", state: f.state }, f.cookie);
    expect(where(res)).toBe("/login?sso=refused");
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("no_user");
    expect(logged).not.toContain("mz.co.kr");
  });
  it("exception address: allowed only when a user row exists", async () => {
    vi.stubEnv("SSO_ALLOWED_EMAILS", "someone@example.com");
    tokenBody = (n) => idToken(n, { email: "someone@example.com" });
    signInUserByEmail.mockResolvedValueOnce(null);
    let f = await begin();
    expect(where(await cb({ code: "c", state: f.state }, f.cookie))).toBe("/login?sso=refused");
    signInUserByEmail.mockResolvedValueOnce(staff);
    resetRateLimits();
    f = await begin();
    expect(res_ok(await cb({ code: "c", state: f.state }, f.cookie))).toBe(true);
  });
  it("unverified e-mail: refused", async () => {
    tokenBody = (n) => idToken(n, { email_verified: false });
    const f = await begin();
    expect(where(await cb({ code: "c", state: f.state }, f.cookie))).toBe("/login?sso=refused");
    expect(signInUserByEmail).not.toHaveBeenCalled();
  });
  it("nonce mismatch / wrong audience: sign-in failed, the store is never asked", async () => {
    tokenBody = () => idToken("not-our-nonce");
    let f = await begin();
    expect(where(await cb({ code: "c", state: f.state }, f.cookie))).toBe("/login?sso=failed");
    tokenBody = (n) => idToken(n, { aud: "other" });
    f = await begin();
    expect(where(await cb({ code: "c", state: f.state }, f.cookie))).toBe("/login?sso=failed");
    expect(signInUserByEmail).not.toHaveBeenCalled();
  });
  it("state mismatch, missing cookie, tampered cookie, missing code, Google error: failed, no token request", async () => {
    const f = await begin();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    expect(where(await cb({ code: "c", state: "wrong" }, f.cookie))).toBe("/login?sso=failed");
    expect(where(await cb({ code: "c", state: f.state }))).toBe("/login?sso=failed");
    expect(where(await cb({ code: "c", state: f.state }, f.cookie + "x"))).toBe("/login?sso=failed");
    expect(where(await cb({ state: f.state }, f.cookie))).toBe("/login?sso=failed");
    expect(where(await cb({ error: "access_denied", state: f.state }, f.cookie))).toBe("/login?sso=failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("a flow cookie from another secret is refused", async () => {
    const f = await begin();
    vi.stubEnv("SESSION_SECRET", "y".repeat(40));
    expect(where(await cb({ code: "c", state: f.state }, f.cookie))).toBe("/login?sso=failed");
  });
  it("token endpoint refusing the code: failed", async () => {
    const f = await begin();
    vi.mocked(fetch).mockImplementation((async () => new Response("{}", { status: 400 })) as never);
    expect(where(await cb({ code: "c", state: f.state }, f.cookie))).toBe("/login?sso=failed");
  });
  it("the user store not answering: unavailable, no session", async () => {
    signInUserByEmail.mockRejectedValue(new Error("db down"));
    const f = await begin();
    const res = await cb({ code: "c", state: f.state }, f.cookie);
    expect(where(res)).toBe("/login?sso=unavailable");
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
  describe("Google account binding, login-domain enrolment, last sign-in (#74)", () => {
    const portal = { id: "usr_portal", name: "Yuna", kind: "CUSTOMER" };
    const refusedCleanly = async (code?: string) => {
      const f = await begin();
      const res = await cb({ code: "c", state: f.state }, f.cookie);
      expect(where(res)).toBe("/login?sso=refused");
      expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
      expect(touchLastLogin).not.toHaveBeenCalled();
      const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
      if (code) expect(logged).toContain(code);
      expect(logged).not.toContain("@");
      expect(logged).not.toContain("mz.co.kr");
      return res;
    };
    it.each(["bound", "ok"])("bind result %s: session, and lastLoginAt is stamped for that user", async (r) => {
      signInUserByEmail.mockResolvedValue(staff);
      bindGoogleAccount.mockResolvedValue(r);
      const f = await begin();
      expect(res_ok(await cb({ code: "c", state: f.state }, f.cookie))).toBe(true);
      expect(bindGoogleAccount).toHaveBeenCalledWith("usr_staff", "g-1");
      expect(touchLastLogin).toHaveBeenCalledWith("usr_staff");
    });
    it.each(["mismatch", "NOT_FOUND"])("bind result %s: the uniform refusal with reason sub_mismatch, no session", async (r) => {
      signInUserByEmail.mockResolvedValue(staff);
      bindGoogleAccount.mockResolvedValue(r);
      await refusedCleanly("sub_mismatch");
    });
    it("a staff user outside the fence is refused before the binding is asked", async () => {
      tokenBody = (n) => idToken(n, { email: "outsider@evil.com" });
      signInUserByEmail.mockResolvedValue(staff);
      await refusedCleanly("staff_outside_fence");
      expect(bindGoogleAccount).not.toHaveBeenCalled();
    });
    it("a user row exists: the enrolment is never asked", async () => {
      tokenBody = (n) => idToken(n, { email: "someone@customer.example" });
      signInUserByEmail.mockResolvedValue(portal);
      const f = await begin();
      expect(res_ok(await cb({ code: "c", state: f.state }, f.cookie))).toBe(true);
      expect(enrolByLoginDomain).not.toHaveBeenCalled();
    });
    it("no row, outside the fence, one customer's domain: enrolled portal user gets a session (bound and stamped)", async () => {
      tokenBody = (n) => idToken(n, { email: "new.person@customer.example" });
      signInUserByEmail.mockResolvedValue(null);
      enrolByLoginDomain.mockResolvedValue({ user: portal });
      const f = await begin();
      const res = await cb({ code: "c", state: f.state }, f.cookie);
      expect(res_ok(res)).toBe(true);
      expect(enrolByLoginDomain).toHaveBeenCalledWith("new.person@customer.example");
      const s = await verifySession(res.cookies.get(SESSION_COOKIE)!.value, sessionSecret(process.env, false));
      expect(s).toMatchObject({ sub: "usr_portal" });
      expect(bindGoogleAccount).toHaveBeenCalledWith("usr_portal", "g-1");
      expect(touchLastLogin).toHaveBeenCalledWith("usr_portal");
    });
    it.each(["DOMAIN_UNKNOWN", "AMBIGUOUS", "CUSTOMER_INACTIVE", "FREE_MAIL", "STAFF_EMAIL", "OTHER_CUSTOMER", "INVALID_EMAIL", "USER_INACTIVE", "NOT_ACTIVE_PORTAL_USER", "PRINCIPAL_REFUSED"])("enrolment refused %s: the same refusal, the code in the server log only", async (code) => {
      tokenBody = (n) => idToken(n, { email: "new.person@customer.example" });
      signInUserByEmail.mockResolvedValue(null);
      enrolByLoginDomain.mockResolvedValue({ refused: code });
      await refusedCleanly(code);
      expect(bindGoogleAccount).not.toHaveBeenCalled();
    });
    it("staff rule wins: no row and the address is inside the staff fence → no enrolment, even for a customer's domain", async () => {
      signInUserByEmail.mockResolvedValue(null); // ops@mz.co.kr, fenced
      enrolByLoginDomain.mockResolvedValue({ user: portal });
      await refusedCleanly("no_user");
      expect(enrolByLoginDomain).not.toHaveBeenCalled();
    });
    it("an address on the exception list with no user row never reaches the enrolment", async () => {
      vi.stubEnv("SSO_ALLOWED_EMAILS", "someone@example.com");
      tokenBody = (n) => idToken(n, { email: "someone@example.com" });
      signInUserByEmail.mockResolvedValue(null);
      enrolByLoginDomain.mockResolvedValue({ user: portal });
      await refusedCleanly("no_user");
      expect(enrolByLoginDomain).not.toHaveBeenCalled();
    });
    it("the enrolment answering with an INTERNAL user gives no session", async () => {
      tokenBody = (n) => idToken(n, { email: "new.person@customer.example" });
      signInUserByEmail.mockResolvedValue(null);
      enrolByLoginDomain.mockResolvedValue({ user: staff });
      await refusedCleanly("no_user");
      expect(bindGoogleAccount).not.toHaveBeenCalled();
    });
    it("enrolled, but the Google account does not match the binding: refused with sub_mismatch", async () => {
      tokenBody = (n) => idToken(n, { email: "new.person@customer.example" });
      signInUserByEmail.mockResolvedValue(null);
      enrolByLoginDomain.mockResolvedValue({ user: portal });
      bindGoogleAccount.mockResolvedValue("mismatch");
      await refusedCleanly("sub_mismatch");
    });
    it("the binding store throwing: unavailable, no session, no last sign-in", async () => {
      signInUserByEmail.mockResolvedValue(staff);
      bindGoogleAccount.mockRejectedValue(new Error("db down"));
      const f = await begin();
      const res = await cb({ code: "c", state: f.state }, f.cookie);
      expect(where(res)).toBe("/login?sso=unavailable");
      expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
      expect(touchLastLogin).not.toHaveBeenCalled();
    });
    it("a free-mail domain without a row never reaches the enrolment", async () => {
      tokenBody = (n) => idToken(n, { email: "someone@gmail.com" });
      signInUserByEmail.mockResolvedValue(null);
      await refusedCleanly("free_mail_domain");
      expect(enrolByLoginDomain).not.toHaveBeenCalled();
    });
    it("the enrolment store failing: unavailable, no session", async () => {
      tokenBody = (n) => idToken(n, { email: "new.person@customer.example" });
      signInUserByEmail.mockResolvedValue(null);
      enrolByLoginDomain.mockRejectedValue(new Error("db down"));
      const f = await begin();
      const res = await cb({ code: "c", state: f.state }, f.cookie);
      expect(where(res)).toBe("/login?sso=unavailable");
      expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    });
    it("touchLastLogin failing does not block the sign-in; the failure is logged with a tag and no address", async () => {
      signInUserByEmail.mockResolvedValue(staff);
      touchLastLogin.mockRejectedValue(new Error("boom ops@mz.co.kr"));
      const f = await begin();
      expect(res_ok(await cb({ code: "c", state: f.state }, f.cookie))).toBe(true);
      const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
      expect(logged).toContain("[sso] touchLastLogin failed");
      expect(logged).not.toContain("mz.co.kr");
    });
    it("a refused sign-in never stamps lastLoginAt", async () => {
      signInUserByEmail.mockResolvedValue(null);
      await refusedCleanly();
    });
  });
  it("no SSO config: unavailable, Google is never called", async () => {
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    vi.mocked(fetch).mockClear();
    expect(where(await cb({ code: "c", state: "s" }, "x"))).toBe("/login?sso=unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function res_ok(res: Response): boolean {
  return res.status === 303 && where(res) === "/incidents" && (res as unknown as { cookies: { get(n: string): unknown } }).cookies.get(SESSION_COOKIE) !== undefined;
}
