import { describe, expect, it } from "vitest";
import type { UserItem } from "./api/types";
import { newUserProblems, normalizeEmail, outsideFence, rowRules, staffFenceDomains, userErrorText } from "./users";

const u = (over: Partial<UserItem>): UserItem => ({
  id: "usr_x", name: "X", kind: "INTERNAL", customerId: null, role: "OPERATOR", status: "ACTIVE", emailMasked: "x•••@example.com", googleBound: true, lastLoginAt: null, createdAt: "2026-10-01T00:00:00Z", ...over,
});

describe("staff fence as the console knows it", () => {
  it("reads SSO_ALLOWED_DOMAINS; drops wildcards, spaces, duplicates and non-domains", () => {
    expect(staffFenceDomains({ SSO_ALLOWED_DOMAINS: " MZ.co.kr, megazone.com,*.evil.com,bad domain.com,@x.com,mz.co.kr,single" })).toEqual(["mz.co.kr", "megazone.com"]);
    expect(staffFenceDomains({})).toEqual([]);
  });
  it("outside = exact domain not listed (no suffix match); nothing configured = nothing to warn about", () => {
    const d = ["mz.co.kr"];
    expect(outsideFence("a@mz.co.kr", d)).toBe(false);
    expect(outsideFence("a@sub.mz.co.kr", d)).toBe(true);
    expect(outsideFence("a@evilmz.co.kr", d)).toBe(true);
    expect(outsideFence("a@gmail.com", d)).toBe(true);
    expect(outsideFence("a@gmail.com", [])).toBe(false);
  });
});

describe("the add form blocks what the API would refuse", () => {
  const ok = { kind: "INTERNAL" as const, email: "a@example.com", name: "A", role: "VIEWER" as const, customerId: "" };
  it("a complete draft has no problems", () => {
    expect(newUserProblems(ok)).toEqual({});
    expect(newUserProblems({ kind: "CUSTOMER", email: "a@example.com", name: "A", role: "", customerId: "cus_daon" })).toEqual({});
  });
  it.each(["", "a", "a@b", "a b@example.com", "@example.com", "a@@example.com"])("e-mail %j", (email) => {
    expect(newUserProblems({ ...ok, email }).email).toBeTruthy();
    expect(normalizeEmail(email)).toBeNull();
  });
  it("name 1..80, staff need a role, portal users need a customer", () => {
    expect(newUserProblems({ ...ok, name: "" }).name).toBeTruthy();
    expect(newUserProblems({ ...ok, name: "x".repeat(81) }).name).toBeTruthy();
    expect(newUserProblems({ ...ok, role: "" }).role).toBeTruthy();
    expect(newUserProblems({ ...ok, kind: "CUSTOMER", role: "", customerId: "" }).customerId).toBeTruthy();
  });
});

describe("row rules (explained before the click)", () => {
  const ctx = { meId: "usr_me", activeAdmins: 2 };
  it("your own row: role, disable and Google link are off, with the reason", () => {
    const r = rowRules(u({ id: "usr_me", role: "ADMIN" }), ctx);
    expect(r.role).toMatch(/your own role/);
    expect(r.status).toMatch(/your own role/);
    expect(r.google).toMatch(/your own/);
    expect(r.notes).toHaveLength(1);
  });
  it("the last active admin: role and disable are off (the filter does not change the count passed in)", () => {
    const r = rowRules(u({ role: "ADMIN" }), { meId: "usr_me", activeAdmins: 1 });
    expect(r.role).toMatch(/last active admin/);
    expect(r.status).toMatch(/last active admin/);
    expect(r.google).toBeNull();
  });
  it("another admin while there are two is free to change; a disabled admin is not 'the last'", () => {
    expect(rowRules(u({ role: "ADMIN" }), ctx)).toMatchObject({ role: null, status: null });
    expect(rowRules(u({ role: "ADMIN", status: "DISABLED" }), { meId: "usr_me", activeAdmins: 1 }).role).toBeNull();
  });
  it("portal users: role fixed, move offered; staff: move off; no Google link yet: clearing is off", () => {
    expect(rowRules(u({ kind: "CUSTOMER", customerId: "c" }), ctx)).toMatchObject({ role: expect.stringMatching(/read-only/), move: null });
    expect(rowRules(u({}), ctx).move).toMatch(/only a portal user/i);
    expect(rowRules(u({ googleBound: false }), ctx).google).toMatch(/No Google account/);
  });
});

describe("words for the API's refusals", () => {
  const f = (code: string, extra: object = {}) => ({ code, message: "m", requestId: "", ...extra });
  it("say what happened, that nothing changed, and what to do", () => {
    expect(userErrorText(f("LAST_ADMIN"), { what: "x", name: "Haeun" })).toMatch(/^Nothing was changed\. Haeun is the last active admin.*first/);
    expect(userErrorText(f("CONTACT_LINKED"), { what: "x", name: "Yuna" })).toMatch(/Yuna is linked to a contact/);
    expect(userErrorText(f("ALREADY_EXISTS"), { what: "x" })).toMatch(/already exists/);
    expect(userErrorText(f("FORBIDDEN"), { what: "x" })).toMatch(/your own/);
    expect(userErrorText(f("VALIDATION_FAILED", { details: { fields: [{ field: "email", message: "email must be a valid address." }] } }), { what: "x" })).toBe("email must be a valid address. Nothing was changed.");
    expect(userErrorText(f("SESSION_ENDED"), { what: "x" })).toMatch(/session ended/);
  });
});
