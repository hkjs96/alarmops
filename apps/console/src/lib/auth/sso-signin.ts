import { emailEligible, type SsoConfig } from "./sso-config";

export interface SignInUser { id: string; name: string; kind: "INTERNAL" | "CUSTOMER" }
/** Free-mail domains never count as a customer's login domain (defensive copy of the backend's write-time reject list). */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com", "naver.com", "daum.net", "hanmail.net", "kakao.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "proton.me", "protonmail.com",
];
export const isFreeMailDomain = (domain: string): boolean => FREE_MAIL_DOMAINS.includes(domain.toLowerCase());

export type SignInDecision = { ok: true; user: SignInUser } | { ok: false; reason: "no_user" | "staff_outside_fence" | "free_mail_domain" | "sub_mismatch" };

/**
 * Wired in the callback (#74, store bindGoogleSub): bind the verified Google `sub` to the user row on first sign-in and
 * compare on every later one. "mismatch" = the row is bound to another Google account → refused (`sub_mismatch`).
 */
export type BindGoogleSub = (userId: string, sub: string) => Promise<"ok" | "mismatch">;
export interface SignInOptions { sub?: string; bindGoogleSub?: BindGoogleSub }

/**
 * Who gets a session once Google has said who it is (D-55 and the 11/18 addition).
 *   - the user must be a pre-registered, active user the API would accept (`lookup`, null otherwise)
 *   - MSP staff (INTERNAL, whatever the stored role): the verified address must also be in the allowed domains or the
 *     exception list. The fence protects the privileged roles.
 *   - a customer portal user (CUSTOMER, scoped to one customer): the registration by an ADMIN is the approval, the
 *     domain fence does not apply. The session still resolves to portal scope only (AuthContext kind CUSTOMER).
 *   - no user row at all: refused — unless the caller passes `enrolByDomain` (per-customer login domain, org-tenant R4-3).
 *     It is asked only when the address is NOT in the staff fence (the staff rule wins, no auto-enrolment), the domain is
 *     not a free-mail domain, and it must return the VIEWER portal user of the ONE customer that registered that domain
 *     (null when none or more than one). The callback passes it (store enrolPortalUserByDomain, #74).
 * The caller shows the same calm refusal for every `reason`; the reason is for the server log only.
 */
export async function decideSignIn(email: string, cfg: Pick<SsoConfig, "domains" | "emails">, lookup: (email: string) => Promise<SignInUser | null>, enrolByDomain?: (domain: string, email: string) => Promise<SignInUser | null>, opts: SignInOptions = {}): Promise<SignInDecision> {
  const d = await decideEligibility(email, cfg, lookup, enrolByDomain);
  if (!d.ok) return d;
  // fail closed: no binding hook or no verified sub means the Google account cannot be tied to the row, so no session
  if (!opts.bindGoogleSub || !opts.sub) return { ok: false, reason: "sub_mismatch" };
  return (await opts.bindGoogleSub(d.user.id, opts.sub)) === "ok" ? d : { ok: false, reason: "sub_mismatch" };
}

async function decideEligibility(email: string, cfg: Pick<SsoConfig, "domains" | "emails">, lookup: (email: string) => Promise<SignInUser | null>, enrolByDomain?: (domain: string, email: string) => Promise<SignInUser | null>): Promise<SignInDecision> {
  // Before any lookup: plain printable ASCII with exactly one "@". CUSTOMER rows have no fence and User.email is citext,
  // so a look-alike (Kelvin sign …) must not reach the database.
  if (/[^\x21-\x7e]/.test(email) || email.split("@").length !== 2) return { ok: false, reason: "no_user" };
  const addr = email.trim().toLowerCase();
  if (!addr) return { ok: false, reason: "no_user" };
  const user = await lookup(addr);
  if (!user) {
    const domain = addr.slice(addr.lastIndexOf("@") + 1);
    if (!enrolByDomain || addr.indexOf("@") < 1 || addr.indexOf("@") !== addr.lastIndexOf("@") || !/^[a-z0-9.-]+$/.test(domain)) return { ok: false, reason: "no_user" };
    if (emailEligible(addr, cfg)) return { ok: false, reason: "no_user" }; // staff rule wins; staff are never auto-enrolled
    if (isFreeMailDomain(domain)) return { ok: false, reason: "free_mail_domain" };
    const enrolled = await enrolByDomain(domain, addr);
    return enrolled && enrolled.kind === "CUSTOMER" ? { ok: true, user: enrolled } : { ok: false, reason: "no_user" };
  }
  if (user.kind === "CUSTOMER") return { ok: true, user };
  return emailEligible(addr, cfg) ? { ok: true, user } : { ok: false, reason: "staff_outside_fence" };
}
