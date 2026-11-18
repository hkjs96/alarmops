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
