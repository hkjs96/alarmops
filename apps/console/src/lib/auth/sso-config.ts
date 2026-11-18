/**
 * Google SSO configuration (D-55). Pure: takes env, so it can be unit tested.
 *
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   the OAuth client
 *   SSO_ALLOWED_DOMAINS                      comma-separated e-mail domains that may sign in (mz.co.kr, megazone.com, …)
 *   SSO_ALLOWED_EMAILS                       comma-separated exact addresses outside those domains (optional)
 *
 * The lists are configuration, not code. They only decide ELIGIBILITY: role and visible customers come from the user row
 * in the database, and only a pre-registered, active user gets a session.
 *
 * Fail closed: anything missing, empty or unparsable means "sign-in unavailable", never "allow all". An entry that is not
 * strictly valid (wildcard, space, "@", non-ASCII, bad label) is dropped and reported once — it can only narrow, never widen.
 */
type Env = Record<string, string | undefined>;

export interface SsoConfig {
  clientId: string;
  clientSecret: string;
  domains: readonly string[];
  emails: readonly string[];
}
export type SsoConfigResult = { ok: true; config: SsoConfig; warnings: string[] } | { ok: false; reason: string; warnings: string[] };

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const EMAIL_RE = new RegExp(`^[a-z0-9.!#$%&'+/=?^_\`{|}~-]{1,64}@${LABEL}(?:\\.${LABEL})+$`);

export function isValidDomain(d: string): boolean { return d.length <= 253 && DOMAIN_RE.test(d); }
export function isValidAddress(a: string): boolean { return a.length <= 254 && EMAIL_RE.test(a); }

const split = (raw: string | undefined): string[] => (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Never put an entry's value in a warning: addresses live only in configuration. */
export function parseSsoConfig(env: Env): SsoConfigResult {
  const warnings: string[] = [];
  const domains: string[] = [];
  split(env.SSO_ALLOWED_DOMAINS).forEach((d, i) => {
    if (isValidDomain(d)) { if (!domains.includes(d)) domains.push(d); }
    else warnings.push(`SSO_ALLOWED_DOMAINS entry #${i + 1} ignored (not a plain domain such as example.com; no wildcards, spaces or "@")`);
  });
  const emails: string[] = [];
  split(env.SSO_ALLOWED_EMAILS).forEach((a, i) => {
    if (isValidAddress(a)) { if (!emails.includes(a)) emails.push(a); }
    else warnings.push(`SSO_ALLOWED_EMAILS entry #${i + 1} ignored (not an exact e-mail address)`);
  });
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId) return { ok: false, reason: "GOOGLE_CLIENT_ID is not set", warnings };
  if (!clientSecret) return { ok: false, reason: "GOOGLE_CLIENT_SECRET is not set", warnings };
  if (domains.length === 0 && emails.length === 0) return { ok: false, reason: "no valid SSO_ALLOWED_DOMAINS or SSO_ALLOWED_EMAILS", warnings };
  return { ok: true, config: { clientId, clientSecret, domains, emails }, warnings };
}

let warned = false;
/** parseSsoConfig, logging its warnings once per process. */
export function ssoConfig(env: Env = process.env): SsoConfigResult {
  const r = parseSsoConfig(env);
  if (!warned && r.warnings.length) { warned = true; for (const w of r.warnings) console.warn(`[sso config] ${w}`); }
  return r;
}
export function resetSsoConfigWarning(): void { warned = false; }

/**
 * Is this (already Google-verified) address eligible? Exact domain match on the part after the single "@", or the exact
 * address in the exception list. ASCII only: a non-ASCII address is refused outright, so case folding cannot turn a
 * look-alike (Kelvin sign, full-width letters) into an allowed domain. No suffix matching: `evilmz.co.kr`,
 * `mz.co.kr.evil.com` and `sub.mz.co.kr` are not `mz.co.kr`.
 */
export function emailEligible(email: unknown, cfg: Pick<SsoConfig, "domains" | "emails">): boolean {
  if (typeof email !== "string" || email.length === 0 || email.length > 254) return false;
  if (/[^\x21-\x7e]/.test(email)) return false; // non-ASCII, whitespace and control characters
  const e = email.toLowerCase();
  const at = e.indexOf("@");
  if (at < 1 || at !== e.lastIndexOf("@")) return false;
  if (cfg.emails.includes(e)) return true;
  return cfg.domains.includes(e.slice(at + 1));
}
