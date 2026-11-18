// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { emailEligible, parseSsoConfig, resetSsoConfigWarning, ssoConfig } from "./sso-config";

const base = { GOOGLE_CLIENT_ID: "id.apps.example", GOOGLE_CLIENT_SECRET: "s3cret", SSO_ALLOWED_DOMAINS: "mz.co.kr, MegaZone.com" };
const cfg = (domains: string[], emails: string[] = []) => ({ domains, emails });

describe("parseSsoConfig", () => {
  it("trims, lowercases and de-duplicates", () => {
    const r = parseSsoConfig({ ...base, SSO_ALLOWED_DOMAINS: " MZ.co.kr ,megazone.com,mz.co.kr", SSO_ALLOWED_EMAILS: " Someone@Example.com " });
    expect(r.ok && r.config.domains).toEqual(["mz.co.kr", "megazone.com"]);
    expect(r.ok && r.config.emails).toEqual(["someone@example.com"]);
  });
  it.each([["GOOGLE_CLIENT_ID"], ["GOOGLE_CLIENT_SECRET"]])("fails closed without %s", (k) => {
    expect(parseSsoConfig({ ...base, [k]: "" }).ok).toBe(false);
    expect(parseSsoConfig({ ...base, [k]: undefined }).ok).toBe(false);
  });
  it("fails closed with empty or missing lists (never allow-all)", () => {
    expect(parseSsoConfig({ ...base, SSO_ALLOWED_DOMAINS: "" }).ok).toBe(false);
    expect(parseSsoConfig({ ...base, SSO_ALLOWED_DOMAINS: undefined }).ok).toBe(false);
    expect(parseSsoConfig({ ...base, SSO_ALLOWED_DOMAINS: " , ," }).ok).toBe(false);
  });
  it("drops wildcards, spaces, '@', non-ASCII and single labels, with a warning that has no value in it", () => {
    const bad = ["*", "*.mz.co.kr", "@mz.co.kr", "mz co.kr", "localhost", "mz.co.kr/x", "müller.de", ".mz.co.kr", "mz..co.kr"];
    const r = parseSsoConfig({ ...base, SSO_ALLOWED_DOMAINS: [...bad, "ok.example"].join(",") });
    expect(r.ok && r.config.domains).toEqual(["ok.example"]);
    expect(r.warnings).toHaveLength(bad.length);
    expect(r.warnings.join(" ")).not.toMatch(/mz|müller/);
  });
  it("a list of only bad entries is unavailable, not allow-all", () => {
    expect(parseSsoConfig({ ...base, SSO_ALLOWED_DOMAINS: "*,*.com" }).ok).toBe(false);
  });
  it("invalid exception addresses are dropped without echoing them", () => {
    const r = parseSsoConfig({ ...base, SSO_ALLOWED_EMAILS: "*@example.com,a b@example.com,someone@example.com,someone" });
    expect(r.ok && r.config.emails).toEqual(["someone@example.com"]);
    expect(r.warnings.join(" ")).not.toContain("example.com");
  });
  it("exception addresses alone are enough to be available", () => {
    expect(parseSsoConfig({ ...base, SSO_ALLOWED_DOMAINS: "", SSO_ALLOWED_EMAILS: "someone@example.com" }).ok).toBe(true);
  });
});

describe("ssoConfig warns once", () => {
  afterEach(() => { vi.restoreAllMocks(); resetSsoConfigWarning(); });
  it("one log per process", () => {
    const w = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetSsoConfigWarning();
    ssoConfig({ ...base, SSO_ALLOWED_DOMAINS: "mz.co.kr,*" });
    ssoConfig({ ...base, SSO_ALLOWED_DOMAINS: "mz.co.kr,*" });
    expect(w).toHaveBeenCalledTimes(1);
  });
});

describe("emailEligible", () => {
  const c = cfg(["mz.co.kr", "megazone.com"], ["someone@example.com"]);
  it("accepts exact domains, case-insensitively", () => {
    expect(emailEligible("a@mz.co.kr", c)).toBe(true);
    expect(emailEligible("A.B@MZ.CO.KR", c)).toBe(true);
    expect(emailEligible("a@MegaZone.com", c)).toBe(true);
  });
  it.each(["a@evilmz.co.kr", "a@mz.co.kr.evil.com", "a@sub.mz.co.kr", "a@xmz.co.kr", "a@mz.co.kr.", "a@mz.co.kr ", "a@@mz.co.kr", "a@evil.com@mz.co.kr", "a@evil.com@mz.co.kr", "mz.co.kr", "@mz.co.kr", "a@", "", "a@mz.co.kr\n", "a%40mz.co.kr@evil.com"])("refuses %j", (e) => {
    expect(emailEligible(e, c)).toBe(false);
  });
  it("refuses unicode look-alikes (Kelvin sign, full-width, Cyrillic) instead of folding them", () => {
    expect(emailEligible("a@mz.co.Kr", c)).toBe(false); // KELVIN SIGN lowercases to k
    expect(emailEligible("a@ｍz.co.kr", c)).toBe(false);
    expect(emailEligible("a@mз.co.kr", c)).toBe(false);
    expect(emailEligible("é@mz.co.kr", c)).toBe(false);
  });
  it("exception list is an exact address, not a domain", () => {
    expect(emailEligible("Someone@Example.com", c)).toBe(true);
    expect(emailEligible("other@example.com", c)).toBe(false);
    expect(emailEligible("someone@example.com.evil.com", c)).toBe(false);
  });
  it("empty config and non-strings allow nothing", () => {
    expect(emailEligible("a@mz.co.kr", cfg([]))).toBe(false);
    expect(emailEligible(undefined, c)).toBe(false);
    expect(emailEligible(42, c)).toBe(false);
  });
});
