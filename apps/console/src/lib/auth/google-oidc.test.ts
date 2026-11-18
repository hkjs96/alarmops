// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import { FLOW_TTL_S, SsoError, authorizationUrl, challengeOf, exchangeCode, newFlow, openFlow, resetJwksCache, sealFlow, stateMatches, verifyIdToken } from "./google-oidc";

const CLIENT = "client-1.apps.example";
const NONCE = "nonce-abc";
const NOW = 1_800_000_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwkOf = (k: typeof pair, kid: string) => ({ ...k.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function token(over: Record<string, unknown> = {}, o: { key?: typeof pair; kid?: string; alg?: string } = {}): string {
  const head = b64({ alg: o.alg ?? "RS256", kid: o.kid ?? "k1", typ: "JWT" });
  const body = b64({ iss: "https://accounts.google.com", aud: CLIENT, sub: "123", email: "a@mz.co.kr", email_verified: true, nonce: NONCE, iat: NOW / 1000 - 10, exp: NOW / 1000 + 3000, ...over });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign((o.key ?? pair).privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}
const jwksFetch = (keys = [jwkOf(pair, "k1")], headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(JSON.stringify({ keys }), { status: 200, headers }));
const verify = (t: string, f = jwksFetch(), now = NOW) => verifyIdToken(t, { clientId: CLIENT, nonce: NONCE, fetch: f as unknown as typeof fetch, now });
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof SsoError ? e.code : "other"));

beforeEach(() => resetJwksCache());

describe("verifyIdToken", () => {
  it("accepts a good token and returns sub + verified e-mail", async () => {
    expect(await verify(token())).toEqual({ sub: "123", email: "a@mz.co.kr", emailVerified: true });
  });
  it("accepts the bare issuer form", async () => { expect(await code(verify(token({ iss: "accounts.google.com" })))).toBe("ok"); });
  it("refuses a bad signature (signed by another key, same kid)", async () => { expect(await code(verify(token({}, { key: other })))).toBe("signature_invalid"); });
  it("refuses a tampered payload", async () => {
    const [h, , s] = token().split(".");
    expect(await code(verify(`${h}.${b64({ iss: "https://accounts.google.com", aud: CLIENT, sub: "1", email: "evil@mz.co.kr", email_verified: true, nonce: NONCE, exp: NOW / 1000 + 99 })}.${s}`))).toBe("signature_invalid");
  });
  it.each([["none"], ["HS256"], ["RS384"]])("refuses alg %s", async (alg) => { expect(await code(verify(token({}, { alg })))).toBe("alg_not_allowed"); });
  it("refuses an empty signature (alg none style)", async () => {
    const [h, b] = token().split(".");
    expect(await code(verify(`${h}.${b}.`))).toBe("token_malformed");
  });
  it("refuses an unknown kid", async () => { expect(await code(verify(token({}, { kid: "nope" })))).toBe("kid_unknown"); });
  it("refuses a wrong audience, and a list without matching azp", async () => {
    expect(await code(verify(token({ aud: "someone-else" })))).toBe("aud_invalid");
    expect(await code(verify(token({ aud: [CLIENT, "x"] })))).toBe("aud_invalid");
    expect(await code(verify(token({ aud: [CLIENT, "x"], azp: CLIENT })))).toBe("ok");
  });
  it("refuses a wrong issuer", async () => {
    expect(await code(verify(token({ iss: "https://evil.example" })))).toBe("iss_invalid");
    expect(await code(verify(token({ iss: "https://accounts.google.com.evil.example" })))).toBe("iss_invalid");
  });
  it("refuses an expired token (beyond 60 s skew), accepts within skew", async () => {
    expect(await code(verify(token({ exp: NOW / 1000 - 61 })))).toBe("token_expired");
    expect(await code(verify(token({ exp: NOW / 1000 - 30 })))).toBe("ok");
    expect(await code(verify(token({ exp: "9999999999" })))).toBe("token_expired");
  });
  it("refuses an iat in the future", async () => { expect(await code(verify(token({ iat: NOW / 1000 + 600 })))).toBe("iat_invalid"); });
  it("refuses a nonce mismatch or a missing nonce", async () => {
    expect(await code(verify(token({ nonce: "other" })))).toBe("nonce_mismatch");
    expect(await code(verify(token({ nonce: undefined })))).toBe("nonce_mismatch");
  });
  it("refuses an unverified e-mail: false, missing, or the string 'true'", async () => {
    expect(await code(verify(token({ email_verified: false })))).toBe("email_unverified");
    expect(await code(verify(token({ email_verified: undefined })))).toBe("email_unverified");
    expect(await code(verify(token({ email_verified: "true" })))).toBe("email_unverified");
  });
  it("does not trust hd: a matching hd with an outside address still returns the address", async () => {
    expect((await verify(token({ hd: "mz.co.kr", email: "x@evil.com" }))).email).toBe("x@evil.com");
  });
  it.each(["", "a.b", "a.b.c.d", "!!.!!.!!"])("refuses a malformed token %j", async (t) => { expect(await code(verify(t))).toBe("token_malformed"); });
});

describe("JWKS cache", () => {
  it("fetches once for many verifications (max-age honoured)", async () => {
    const f = jwksFetch([jwkOf(pair, "k1")], { "cache-control": "public, max-age=3600" });
    await verify(token(), f); await verify(token(), f); await verify(token(), f);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("refetches after expiry", async () => {
    const f = jwksFetch([jwkOf(pair, "k1")], { "cache-control": "max-age=120" });
    await verify(token(), f, NOW); await verify(token(), f, NOW + 121_000);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("an unknown kid refetches once (rotation), but not more than once a minute", async () => {
    const f = jwksFetch([jwkOf(pair, "k1")], { "cache-control": "max-age=3600" });
    await verify(token(), f, NOW);
    expect(await code(verify(token({}, { kid: "k2" }), f, NOW + 5_000))).toBe("kid_unknown");
    expect(f).toHaveBeenCalledTimes(1); // inside the minute: no refetch
    f.mockImplementation(async () => new Response(JSON.stringify({ keys: [jwkOf(pair, "k1"), jwkOf(other, "k2")] }), { status: 200 }));
    expect(await code(verify(token({}, { key: other, kid: "k2" }), f, NOW + 61_000))).toBe("ok");
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("an unreachable JWKS endpoint refuses (no skipping the signature check)", async () => {
    const f = vi.fn(async () => { throw new Error("down"); });
    expect(await code(verify(token(), f as never))).toBe("jwks_unreachable");
  });
});

describe("state / nonce / PKCE cookie", () => {
  const secret = "s".repeat(40);
  const flow = () => ({ ...newFlow(), next: "/incidents", exp: Math.floor(Date.now() / 1000) + FLOW_TTL_S });
  it("round-trips", () => {
    const f = flow();
    expect(openFlow(sealFlow(f, secret), secret)).toEqual(f);
  });
  it("rejects another secret, tampering, expiry, junk and no secret", () => {
    const f = flow();
    const sealed = sealFlow(f, secret);
    expect(openFlow(sealed, "t".repeat(40))).toBeNull();
    const [b, s] = sealed.split(".");
    expect(openFlow(`${Buffer.from(JSON.stringify({ ...f, next: "//evil" })).toString("base64url")}.${s}`, secret)).toBeNull();
    expect(openFlow(`${b}x.${s}`, secret)).toBeNull();
    expect(openFlow(sealed, secret, f.exp + 1)).toBeNull();
    expect(openFlow("junk", secret)).toBeNull();
    expect(openFlow(undefined, secret)).toBeNull();
    expect(openFlow(sealed, null)).toBeNull();
  });
  it("state compare: equal only", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches("abc", null)).toBe(false);
    expect(stateMatches("abc", "")).toBe(false);
  });
  it("randomness differs per flow; the challenge is S256 of the verifier", () => {
    const a = newFlow(), b = newFlow();
    expect(a.state).not.toBe(b.state);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    // RFC 7636 appendix B vector
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("authorization URL carries code flow, PKCE, state, nonce and the given redirect", () => {
    const f = newFlow();
    const u = new URL(authorizationUrl({ clientId: CLIENT, redirectUri: "https://console.example.com/auth/google/callback", flow: f }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = u.searchParams;
    expect([p.get("response_type"), p.get("code_challenge_method"), p.get("state"), p.get("nonce"), p.get("code_challenge"), p.get("redirect_uri"), p.get("scope")])
      .toEqual(["code", "S256", f.state, f.nonce, challengeOf(f.verifier), "https://console.example.com/auth/google/callback", "openid email"]);
    expect(p.has("hd")).toBe(false);
  });
});

describe("exchangeCode (stubbed token endpoint)", () => {
  const args = { clientId: CLIENT, clientSecret: "s3cret", redirectUri: "https://c.example/auth/google/callback", code: "c0de", verifier: "v".repeat(50) };
  it("posts the code with the PKCE verifier and returns the id_token", async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const b = new URLSearchParams(String(init?.body));
      expect([b.get("grant_type"), b.get("code"), b.get("code_verifier"), b.get("redirect_uri")]).toEqual(["authorization_code", "c0de", args.verifier, args.redirectUri]);
      return Response.json({ id_token: "T" });
    });
    expect(await exchangeCode({ ...args, fetch: f as never })).toBe("T");
    expect(f.mock.calls[0]![0]).toBe("https://oauth2.googleapis.com/token");
  });
  it("refuses an error status, no id_token, a network error", async () => {
    expect(await code(exchangeCode({ ...args, fetch: (async () => new Response("{}", { status: 400 })) as never }))).toBe("token_rejected");
    expect(await code(exchangeCode({ ...args, fetch: (async () => Response.json({})) as never }))).toBe("token_malformed");
    expect(await code(exchangeCode({ ...args, fetch: (async () => { throw new Error("x"); }) as never }))).toBe("token_unreachable");
  });
});
