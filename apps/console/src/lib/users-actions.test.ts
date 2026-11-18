/**
 * Settings › Users actions (#74): ADMIN only, refused before the API is touched for everybody else, input checked
 * before the API, and the contract's refusals (duplicate, last admin, your own account, linked contact) come back as
 * plain failures. The mock API answers as the session's user, like the real one reads the token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleApi } from "./api/client";
import { MOCK_USERS, createMockApi, createStore, type MockUser } from "./api/mock/mock-api";

const state = vi.hoisted(() => ({ sub: "usr-haeun" as string | null, api: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => {
    if (!state.sub) throw Object.assign(new Error("Sign in required."), { code: "UNAUTHORIZED" });
    return { sub: state.sub, email: "", name: "", exp: 0, token: "t" };
  },
}));
vi.mock("@/lib/api", () => ({ getApi: async () => (state.api as (sub: string) => ConsoleApi)(state.sub!) }));

import { addUserAccount, changeUserAccount } from "@/app/settings/users/actions";
import { userErrorText } from "./users";

let calls: string[] = [];
let store: ReturnType<typeof createStore>;
const as = (who: "admin" | "operator" | "viewer" | "portal" | "nobody") => { state.sub = { admin: "usr-haeun", operator: "usr-minjae", viewer: "usr-sora", portal: "usr-portal", nobody: null }[who]; };
const WRITES = ["createUser", "patchUser"];

beforeEach(() => {
  calls = [];
  store = createStore();
  state.api = (sub: string) => {
    const api = createMockApi(store, undefined, (MOCK_USERS[sub] ?? MOCK_USERS["usr-haeun"]) as MockUser) as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of [...WRITES, "listUsers"]) { const real = api[m]!.bind(api); api[m] = (...a: unknown[]) => { calls.push(m); return real(...a); }; }
    return api as unknown as ConsoleApi;
  };
  as("admin");
});
const rows = () => store.users.rows;
const staff = { email: "New.Person@Example.com", name: "New Person", kind: "INTERNAL" as const, role: "OPERATOR" as const };
const portal = { email: "pat@client.example.com", name: "Pat Client", kind: "CUSTOMER" as const, customerId: "cus_daon" };

describe("who may write", () => {
  const need = { ok: false, code: "ROLE_REQUIRED", message: "This action needs the ADMIN role.", requestId: "", details: { role: "ADMIN" } };
  it.each(["operator", "viewer"] as const)("a %s session is refused before the API is touched", async (who) => {
    as(who);
    expect(await addUserAccount(staff)).toEqual(need);
    expect(await changeUserAccount("usr_sora", { role: "ADMIN" })).toEqual(need);
    // role first: a malformed id or body gets the same answer as a real one
    expect(await changeUserAccount("not an id", { role: "x" as never })).toEqual(need);
    expect(calls).toEqual([]);
    expect(rows().some((r) => r.name === "New Person")).toBe(false);
  });
  it("a portal user is read-only: refused before the API is touched", async () => {
    as("portal");
    const ro = { ok: false, code: "READ_ONLY", message: "This is a read-only view. Nothing was changed.", requestId: "" };
    expect(await addUserAccount(staff)).toEqual(ro);
    expect(await changeUserAccount("usr_sora", { status: "DISABLED" })).toEqual(ro);
    expect(calls).toEqual([]);
  });
  it("without a session nothing is asked at all", async () => {
    as("nobody");
    expect(await addUserAccount(staff)).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(await changeUserAccount("usr_sora", { role: "VIEWER" })).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(calls).toEqual([]);
  });
});

describe("add user", () => {
  it("staff: kind INTERNAL with a role; the address is stored lower-case and comes back masked", async () => {
    const r = await addUserAccount(staff);
    expect(r).toMatchObject({ ok: true, data: { name: "New Person", kind: "INTERNAL", role: "OPERATOR", status: "ACTIVE", customerId: null, emailMasked: "n•••@example.com", googleBound: false, lastLoginAt: null } });
    expect(JSON.stringify(r)).not.toContain("new.person");
    expect(rows().find((x) => x.name === "New Person")!.email).toBe("new.person@example.com");
  });
  it("portal user: exactly one customer, always Viewer (no role is sent)", async () => {
    expect(await addUserAccount(portal)).toMatchObject({ ok: true, data: { kind: "CUSTOMER", role: "VIEWER", customerId: "cus_daon" } });
    expect(await addUserAccount({ ...portal, email: "other@client.example.com", role: "ADMIN" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await addUserAccount({ ...portal, email: "third@client.example.com", customerId: "" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
  it("a customer that does not exist (or is terminated) is a validation failure from the API", async () => {
    expect(await addUserAccount({ ...portal, customerId: "cus_nope" })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await addUserAccount({ ...portal, customerId: "cus_iruda" })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
  });
  it("a duplicate e-mail (any case) is 409 ALREADY_EXISTS with a plain message", async () => {
    const r = await addUserAccount({ ...staff, email: "HAEUN@msp.example" });
    expect(r).toMatchObject({ ok: false, code: "ALREADY_EXISTS" });
    expect(userErrorText(r as never, { what: "Adding a user" })).toMatch(/already exists.*enable it instead/i);
    expect(rows().filter((x) => x.email === "haeun@msp.example")).toHaveLength(1);
  });
  it.each([
    ["not an address", { ...staff, email: "nobody" }],
    ["no name", { ...staff, name: "  " }],
    ["a name over 80 characters", { ...staff, name: "x".repeat(81) }],
    ["staff without a role", { ...staff, role: undefined }],
    ["staff with a customer", { ...staff, customerId: "cus_daon" }],
    ["an unknown kind", { ...staff, kind: "GUEST" as never }],
    ["an unknown key", { ...staff, seeAll: true } as never],
  ])("input checked before the API: %s", async (_n, input) => {
    expect(await addUserAccount(input as never)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(calls).toEqual([]);
  });
});

describe("change a user", () => {
  it("role, disable, enable, clear the Google link", async () => {
    expect(await changeUserAccount("usr_minjae", { role: "VIEWER" })).toMatchObject({ ok: true, data: { role: "VIEWER" } });
    expect(await changeUserAccount("usr_minjae", { status: "DISABLED" })).toMatchObject({ ok: true, data: { status: "DISABLED" } });
    expect(await changeUserAccount("usr_minjae", { status: "ACTIVE" })).toMatchObject({ ok: true, data: { status: "ACTIVE" } });
    expect(await changeUserAccount("usr_minjae", { clearGoogleSub: true })).toMatchObject({ ok: true, data: { googleBound: false } });
    expect(await changeUserAccount("usr_dana", { status: "ACTIVE" })).toMatchObject({ ok: true, data: { status: "ACTIVE" } });
  });
  it("the same value is a 200 without a change", async () => {
    expect(await changeUserAccount("usr_minjae", { role: "OPERATOR" })).toMatchObject({ ok: true, data: { role: "OPERATOR" } });
  });
  it("your own role, status and Google link: 403 FORBIDDEN, worded for the screen", async () => {
    for (const patch of [{ role: "VIEWER" as const }, { status: "DISABLED" as const }, { clearGoogleSub: true as const }]) {
      const r = await changeUserAccount("usr_haeun", patch);
      expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(userErrorText(r as never, { what: "Changing a user" })).toMatch(/your own role or status.*Ask another admin/);
    }
    expect(rows().find((x) => x.id === "usr_haeun")).toMatchObject({ role: "ADMIN", status: "ACTIVE", googleBound: true });
  });
  it("the last active admin cannot be demoted or disabled: 409 LAST_ADMIN (a second admin acting from a stale page)", async () => {
    // Haeun is the only active admin left (Junho was demoted in another tab), and the session still acts as an admin
    rows().find((x) => x.id === "usr_junho")!.role = "VIEWER";
    state.api = () => createMockApi(store, undefined, { id: "usr_ghost", contactId: "", name: "Ghost", email: "g@msp.example", role: "ADMIN" } as MockUser);
    for (const patch of [{ role: "OPERATOR" as const }, { status: "DISABLED" as const }]) {
      const r = await changeUserAccount("usr_haeun", patch);
      expect(r).toMatchObject({ ok: false, code: "LAST_ADMIN" });
      expect(userErrorText(r as never, { what: "Changing a user", name: "Haeun Kim" })).toMatch(/last active admin.*Make another user an admin first/);
    }
    expect(rows().find((x) => x.id === "usr_haeun")).toMatchObject({ role: "ADMIN", status: "ACTIVE" });
  });
  it("with two admins one of them can be demoted", async () => {
    expect(await changeUserAccount("usr_junho", { role: "OPERATOR" })).toMatchObject({ ok: true });
  });
  it("moving a portal user: only to a live customer; 409 CONTACT_LINKED when a contact is linked", async () => {
    expect(await changeUserAccount("usr_jiho", { customerId: "cus_hanbit" })).toMatchObject({ ok: true, data: { customerId: "cus_hanbit" } });
    const linked = await changeUserAccount("usr_portal", { customerId: "cus_daon" });
    expect(linked).toMatchObject({ ok: false, code: "CONTACT_LINKED" });
    expect(userErrorText(linked as never, { what: "Changing a user", name: "Yuna Seo" })).toMatch(/Nothing was changed.*linked to a contact/);
    expect(await changeUserAccount("usr_jiho", { customerId: "cus_nope" })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await changeUserAccount("usr_minjae", { customerId: "cus_daon" })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
  });
  it("a portal user cannot get another role; an unknown user is 404", async () => {
    expect(await changeUserAccount("usr_jiho", { role: "ADMIN" })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await changeUserAccount("usr_nobody", { role: "VIEWER" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
  it.each([
    ["a bad id", "not an id", { role: "VIEWER" as const }],
    ["nothing to change", "usr_sora", {}],
    ["two changes at once", "usr_sora", { role: "ADMIN" as const, status: "DISABLED" as const }],
    ["a bad role", "usr_sora", { role: "ROOT" as never }],
    ["a bad status", "usr_sora", { status: "PENDING" as never }],
    ["clearGoogleSub false", "usr_sora", { clearGoogleSub: false as never }],
    ["an unknown key", "usr_sora", { kind: "INTERNAL" } as never],
  ])("input checked before the API: %s", async (_n, id, patch) => {
    expect(await changeUserAccount(id, patch)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(calls).toEqual([]);
  });
});

describe("the mock follows the contract for reads", () => {
  it("lists with filters; e-mails are masked; other staff get 403, a portal user 404", async () => {
    const api = (state.api as (s: string) => ConsoleApi)("usr-haeun");
    const all = (await api.listUsers()).items;
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all.every((u) => /^.•••@/.test(u.emailMasked))).toBe(true);
    expect(JSON.stringify(all)).not.toMatch(/googleSub|"email"/);
    expect((await api.listUsers({ kind: "CUSTOMER" })).items.every((u) => u.kind === "CUSTOMER" && u.role === "VIEWER")).toBe(true);
    expect((await api.listUsers({ status: "DISABLED" })).items.map((u) => u.id)).toEqual(["usr_dana"]);
    expect((await api.listUsers({ customerId: "cus_daon" })).items.map((u) => u.id)).toEqual(["usr_jiho"]);
    expect((await api.listUsers({ role: "ADMIN", status: "ACTIVE", kind: "INTERNAL" })).items).toHaveLength(2);
    expect((await api.listUsers({ q: "SORA" })).items.map((u) => u.id)).toEqual(["usr_sora"]);
    await expect((state.api as (s: string) => ConsoleApi)("usr-minjae").listUsers()).rejects.toMatchObject({ status: 403 });
    await expect((state.api as (s: string) => ConsoleApi)("usr-portal").listUsers()).rejects.toMatchObject({ status: 404 });
  });
});
