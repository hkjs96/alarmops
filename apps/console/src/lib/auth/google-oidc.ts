/**
 * Google OpenID Connect, authorization-code flow with PKCE, server side. Node crypto + fetch only (no dependency).
 * Every network call takes an injectable `fetch`, so tests never reach Google.
 */
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type JsonWebKey } from "node:crypto";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const CLOCK_SKEW_S = 60;
const FETCH_TIMEOUT_MS = 5_000;

const b64u = (b: Buffer): string => b.toString("base64url");
const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/* ── state / nonce / PKCE, and the cookie that binds them to this browser ── */

export interface FlowSecrets { state: string; nonce: string; verifier: string }
export const newFlow = (): FlowSecrets => ({ state: b64u(randomBytes(32)), nonce: b64u(randomBytes(32)), verifier: b64u(randomBytes(48)) });
export const challengeOf = (verifier: string): string => b64u(createHash("sha256").update(verifier).digest());

export const FLOW_COOKIE = "ao_sso";
export const FLOW_TTL_S = 600;
export interface FlowCookie extends FlowSecrets { next: string; exp: number }

/** base64url(JSON).base64url(HMAC-SHA256), keyed from SESSION_SECRET with a purpose label (a session token is never a flow cookie). */
const flowKey = (secret: string): Buffer => createHmac("sha256", secret).update("alarmops:sso-flow:v1").digest();
export function sealFlow(c: FlowCookie, secret: string): string {
  const body = b64u(Buffer.from(JSON.stringify(c)));
  return `${body}.${b64u(createHmac("sha256", flowKey(secret)).update(body).digest())}`;
}
export function openFlow(raw: string | undefined, secret: string | null, nowS = Date.now() / 1000): FlowCookie | null {
  if (!raw || !secret) return null;
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!eq(parts[1], b64u(createHmac("sha256", flowKey(secret)).update(parts[0]).digest()))) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Partial<FlowCookie>;
    if (typeof c.state !== "string" || typeof c.nonce !== "string" || typeof c.verifier !== "string" || typeof c.next !== "string" || typeof c.exp !== "number") return null;
    if (c.exp <= nowS) return null;
    return c as FlowCookie;
  } catch { return null; }
}
/** the cookie state against the `state` query value: both present and equal */
export const stateMatches = (cookieState: string, queryState: string | null): boolean => !!queryState && eq(cookieState, queryState);

export function authorizationUrl(o: { clientId: string; redirectUri: string; flow: FlowSecrets }): string {
  const u = new URL(GOOGLE_AUTH_URL);
  const q = u.searchParams;
  q.set("client_id", o.clientId);
  q.set("redirect_uri", o.redirectUri);
  q.set("response_type", "code");
  q.set("scope", "openid email");
  q.set("state", o.flow.state);
  q.set("nonce", o.flow.nonce);
  q.set("code_challenge", challengeOf(o.flow.verifier));
  q.set("code_challenge_method", "S256");
  q.set("prompt", "select_account");
  return u.toString();
}

/* ── token endpoint ── */

export class SsoError extends Error {
  constructor(readonly code: string) { super(code); this.name = "SsoError"; }
}

export async function exchangeCode(o: { clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string; fetch?: typeof fetch }): Promise<string> {
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, client_id: o.clientId, client_secret: o.clientSecret, code_verifier: o.verifier }).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch { throw new SsoError("token_unreachable"); }
  if (!res.ok) throw new SsoError("token_rejected");
  let body: unknown;
  try { body = await res.json(); } catch { throw new SsoError("token_malformed"); }
  const id = (body as { id_token?: unknown } | null)?.id_token;
  if (typeof id !== "string" || !id) throw new SsoError("token_malformed");
  return id;
}

/* ── JWKS with caching ── */

interface JwksCache { keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>; expiresAt: number; fetchedAt: number }
const MIN_REFETCH_MS = 60_000;
const DEFAULT_TTL_MS = 60 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
let jwks: JwksCache | null = null;
export function resetJwksCache(): void { jwks = null; }

async function loadJwks(f: typeof fetch, now: number): Promise<JwksCache> {
  let res: Response;
  try { res = await f(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" }); } catch { throw new SsoError("jwks_unreachable"); }
  if (!res.ok) throw new SsoError("jwks_unreachable");
  let body: { keys?: unknown };
  try { body = (await res.json()) as { keys?: unknown }; } catch { throw new SsoError("jwks_malformed"); }
  if (!Array.isArray(body.keys)) throw new SsoError("jwks_malformed");
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
  const ttl = maxAge ? Math.min(MAX_TTL_MS, Math.max(MIN_REFETCH_MS, Number(maxAge) * 1000)) : DEFAULT_TTL_MS;
  jwks = { keys: body.keys as JwksCache["keys"], expiresAt: now + ttl, fetchedAt: now };
  return jwks;
}

/** Cached until Cache-Control max-age; an unknown `kid` triggers ONE refetch (key rotation), at most once a minute. */
async function keyFor(kid: string, f: typeof fetch, now: number): Promise<JwksCache["keys"][number] | null> {
  const find = (c: JwksCache) => c.keys.find((k) => k.kid === kid && k.kty === "RSA" && (k.use === undefined || k.use === "sig")) ?? null;
  if (jwks && jwks.expiresAt > now) {
    const k = find(jwks);
    if (k) return k;
    if (now - jwks.fetchedAt < MIN_REFETCH_MS) return null;
  }
  return find(await loadJwks(f, now));
}

/* ── ID token ── */

export interface IdClaims { sub: string; email: string; emailVerified: true }

/**
 * Verifies a Google ID token; throws SsoError(code) otherwise.
 *   - structure: three base64url parts, header `alg` exactly RS256 (never "none", never HS*), a `kid`
 *   - signature: RSASSA-PKCS1-v1_5 / SHA-256 against the JWKS key with that `kid` (Node crypto)
 *   - `iss` is https://accounts.google.com or accounts.google.com
 *   - `aud` is our client id (a list must contain it AND `azp` must be it)
 *   - `exp` is in the future (60 s skew); `iat`, when present, is not in the future beyond the skew
 *   - `nonce` equals the one bound to this browser's flow cookie (constant time)
 *   - `email_verified` is boolean true (not "true", not missing) and `email` is a string; `sub` a string
 * The `hd` claim is never read: the caller decides eligibility from the verified address itself.
 */
export async function verifyIdToken(token: string, o: { clientId: string; nonce: string; fetch?: typeof fetch; now?: number }): Promise<IdClaims> {
  const nowMs = o.now ?? Date.now();
  const nowS = nowMs / 1000;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p))) throw new SsoError("token_malformed");
  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as typeof header;
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as typeof claims;
  } catch { throw new SsoError("token_malformed"); }
  if (!header || typeof header !== "object" || !claims || typeof claims !== "object") throw new SsoError("token_malformed");
  if (header.alg !== "RS256") throw new SsoError("alg_not_allowed");
  if (typeof header.kid !== "string" || !header.kid) throw new SsoError("kid_missing");

  const jwk = await keyFor(header.kid, o.fetch ?? fetch, nowMs);
  if (!jwk) throw new SsoError("kid_unknown");
  let ok = false;
  try {
    ok = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
  } catch { ok = false; }
  if (!ok) throw new SsoError("signature_invalid");

  if (typeof claims.iss !== "string" || !ISSUERS.includes(claims.iss)) throw new SsoError("iss_invalid");
  const aud = claims.aud;
  if (Array.isArray(aud)) {
    if (!aud.includes(o.clientId) || claims.azp !== o.clientId) throw new SsoError("aud_invalid");
  } else if (aud !== o.clientId) throw new SsoError("aud_invalid");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S <= nowS) throw new SsoError("token_expired");
  if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_S > nowS)) throw new SsoError("iat_invalid");
  if (typeof claims.nonce !== "string" || !eq(claims.nonce, o.nonce)) throw new SsoError("nonce_mismatch");
  if (claims.email_verified !== true) throw new SsoError("email_unverified");
  if (typeof claims.email !== "string" || !claims.email) throw new SsoError("email_missing");
  if (typeof claims.sub !== "string" || !claims.sub) throw new SsoError("sub_missing");
  return { sub: claims.sub, email: claims.email, emailVerified: true };
}
