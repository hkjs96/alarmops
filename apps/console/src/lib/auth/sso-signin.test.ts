// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { FREE_MAIL_DOMAINS, decideSignIn, isFreeMailDomain, type SignInUser } from "./sso-signin";

const cfg = { domains: ["mz.co.kr"], emails: ["dev@example.com"] };
const staff: SignInUser = { id: "usr_staff", name: "Staff", kind: "INTERNAL" };
const portal: SignInUser = { id: "usr_portal", name: "Customer", kind: "CUSTOMER" };
const users: Record<string, SignInUser> = {
  "ops@mz.co.kr": staff, "dev@example.com": staff, "outsider@evil.com": staff, "someone@customer.example": portal,
};
const lookup = vi.fn(async (e: string) => users[e] ?? null);

describe("decideSignIn", () => {
  it("staff inside an allowed domain with a user row: allowed", async () => {
    expect(await decideSignIn("Ops@MZ.co.kr", cfg, lookup)).toEqual({ ok: true, user: staff });
  });
  it("exception address with a user row: allowed", async () => {
    expect((await decideSignIn("dev@example.com", cfg, lookup)).ok).toBe(true);
  });
  it("exception address WITHOUT a user row: refused (eligibility alone is never enough)", async () => {
    expect(await decideSignIn("dev2@example.com", { ...cfg, emails: ["dev2@example.com"] }, lookup)).toEqual({ ok: false, reason: "no_user" });
  });
  it("allowed domain without a user row (unknown or inactive): refused", async () => {
    expect(await decideSignIn("new@mz.co.kr", cfg, lookup)).toEqual({ ok: false, reason: "no_user" });
  });
  it("INTERNAL user whose address is outside the fence: refused", async () => {
    expect(await decideSignIn("outsider@evil.com", cfg, lookup)).toEqual({ ok: false, reason: "staff_outside_fence" });
  });
  it("customer portal user with an outside domain: allowed, as a CUSTOMER (portal scope only)", async () => {
    const r = await decideSignIn("someone@customer.example", cfg, lookup);
    expect(r).toEqual({ ok: true, user: portal });
    expect(r.ok && r.user.kind).toBe("CUSTOMER");
  });
  it("portal user is allowed even with empty lists; staff then is not", async () => {
    const empty = { domains: [], emails: [] };
    expect((await decideSignIn("someone@customer.example", empty, lookup)).ok).toBe(true);
    expect((await decideSignIn("ops@mz.co.kr", empty, lookup)).ok).toBe(false);
  });
  it("blank address: refused without asking the store", async () => {
    lookup.mockClear();
    expect((await decideSignIn("  ", cfg, lookup)).ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("per-customer login domain (enrolByDomain hook)", () => {
  const enrol = vi.fn(async (d: string) => (d === "acme.example" ? portal : null));
  const run = (e: string, c = cfg) => decideSignIn(e, c, lookup, enrol);
  it("without the hook (what the console wires today) an unregistered person is refused", async () => {
    expect(await decideSignIn("new@acme.example", cfg, lookup)).toEqual({ ok: false, reason: "no_user" });
  });
  it("a domain registered on one customer enrols as that customer's portal user", async () => {
    expect(await run("new@ACME.example")).toEqual({ ok: true, user: portal });
    expect(enrol).toHaveBeenCalledWith("acme.example", "new@acme.example");
  });
  it("unregistered or ambiguous domain (hook returns null): refused", async () => {
    expect(await run("new@other.example")).toEqual({ ok: false, reason: "no_user" });
  });
  it("free-mail domains never match, even if the hook would say yes; the hook is not asked", async () => {
    enrol.mockClear();
    for (const d of FREE_MAIL_DOMAINS) expect(await decideSignIn(`x@${d}`, cfg, lookup, async () => portal)).toEqual({ ok: false, reason: "free_mail_domain" });
    expect(isFreeMailDomain("Gmail.com")).toBe(true);
    expect(isFreeMailDomain("gmail.com.evil.example")).toBe(false);
  });
  it("staff rule wins: an address inside the staff fence is never auto-enrolled", async () => {
    enrol.mockClear();
    const r = await decideSignIn("new@mz.co.kr", cfg, lookup, async () => portal);
    expect(r).toEqual({ ok: false, reason: "no_user" });
    expect((await decideSignIn("dev@example.com", { domains: [], emails: ["dev@example.com"] }, async () => null, async () => portal)).ok).toBe(false);
  });
  it("the hook cannot hand out a staff user", async () => {
    expect((await decideSignIn("new@acme.example", cfg, lookup, async () => staff)).ok).toBe(false);
  });
  it("an existing row still decides first (a registered staff user at a customer domain follows the staff rule)", async () => {
    expect(await decideSignIn("outsider@evil.com", cfg, lookup, async () => portal)).toEqual({ ok: false, reason: "staff_outside_fence" });
  });
});

describe("address guard before any lookup", () => {
  it.each(["a@mz.co.Kr", "Kevin@customer.example", "someone@customer.example\n", "some one@customer.example", "a@b@customer.example", "nobody"])("%j: refused, the store is not asked", async (e) => {
    const spy = vi.fn(async () => portal);
    const enrol = vi.fn(async () => portal);
    expect(await decideSignIn(e, cfg, spy, enrol)).toEqual({ ok: false, reason: "no_user" });
    expect(spy).not.toHaveBeenCalled();
    expect(enrol).not.toHaveBeenCalled();
  });
});

describe("Google sub binding hook (not wired in the route until #69)", () => {
  const opts = (r: "ok" | "mismatch") => { const bind = vi.fn(async () => r); return { bind, o: { sub: "g-1", bindGoogleSub: bind } }; };
  it("ok: allowed, called with the user id and the verified sub", async () => {
    const { bind, o } = opts("ok");
    expect((await decideSignIn("ops@mz.co.kr", cfg, lookup, undefined, o)).ok).toBe(true);
    expect(bind).toHaveBeenCalledWith("usr_staff", "g-1");
  });
  it("mismatch: refused with sub_mismatch, for staff and for portal users", async () => {
    expect(await decideSignIn("ops@mz.co.kr", cfg, lookup, undefined, opts("mismatch").o)).toEqual({ ok: false, reason: "sub_mismatch" });
    expect(await decideSignIn("someone@customer.example", cfg, lookup, undefined, opts("mismatch").o)).toEqual({ ok: false, reason: "sub_mismatch" });
  });
  it("not asked when the user was refused anyway", async () => {
    const { bind, o } = opts("ok");
    await decideSignIn("outsider@evil.com", cfg, lookup, undefined, o);
    await decideSignIn("new@mz.co.kr", cfg, lookup, undefined, o);
    expect(bind).not.toHaveBeenCalled();
  });
  it("without the hook (today) nothing changes", async () => {
    expect((await decideSignIn("ops@mz.co.kr", cfg, lookup, undefined, { sub: "g-1" })).ok).toBe(true);
  });
});
