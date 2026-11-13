/**
 * Session cookie placeholder until Google SSO is wired (security review C-2).
 * Cookie = base64url(payload).base64url(HMAC-SHA256). Web Crypto only, so it runs in middleware (edge) and node.
 */
export const SESSION_COOKIE = "ao_session";
export const SESSION_TTL_S = 8 * 60 * 60;
const DEV_SECRET = "alarmops-dev-only-session-secret";

export interface SessionPayload {
  sub: string;
  email: string;
  name: string;
  exp: number; // unix seconds
}

type Env = Record<string, string | undefined>;

/** SESSION_SECRET (>=32 chars) is required; the dev constant is used only when mock mode is allowed. */
export function sessionSecret(env: Env, mockAllowed: boolean): string | null {
  const s = env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  return mockAllowed ? DEV_SECRET : null;
}

const enc = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function key(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(p: SessionPayload, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(p)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifySession(token: string | undefined, secret: string | null, nowS = Date.now() / 1000): Promise<SessionPayload | null> {
  if (!token || !secret) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await key(secret), fromB64url(sig) as BufferSource, enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SessionPayload;
    if (typeof p.exp !== "number" || p.exp <= nowS || typeof p.sub !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

export const DEV_USER = { sub: "usr-haeun", email: "haeun.kim@example.com", name: "Haeun Kim" };
/** Mock mode only: who /auth/dev-login?as=… signs in. The role belongs to the user in the (mock) API, not to the cookie. */
export const DEV_USERS: Record<string, typeof DEV_USER> = {
  admin: DEV_USER,
  operator: { sub: "usr-minjae", email: "minjae.lee@example.com", name: "Minjae Lee" },
  viewer: { sub: "usr-sora", email: "sora.yoon@example.com", name: "Sora Yoon" },
  /** a portal (customer) user, mock only */
  portal: { sub: "usr-portal", email: "yuna@mirae.example", name: "Yuna Seo" },
};
/** Live dev sign-in (LIVE_DEV_LOGIN=1, never production): the users db/prisma/seed.ts creates. */
export const LIVE_DEV_USERS: Record<string, string> = { admin: "usr_dev_admin", operator: "usr_dev_operator", viewer: "usr_dev_viewer" };
