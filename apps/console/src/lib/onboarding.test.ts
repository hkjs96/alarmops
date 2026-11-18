import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleApi } from "./api/client";
import { MOCK_USERS, createMockApi, createStore } from "./api/mock/mock-api";
import { ApiError } from "./api/client";
import { parseLoginDomains, kitMissing, kitParams, kitText, roleLine, connectionOf, onboardingError, retryTime } from "./onboarding";
import { pollUntilChecked } from "./onboarding-poll";
import { isVerifyToken, loggablePath, VERIFY_PATH } from "./verify-token";
import { verificationSecret } from "./server/wiring";
import { centralValues } from "./server/central";

const state = vi.hoisted(() => ({ sub: "usr-haeun" as string | null, api: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => {
    if (!state.sub) throw Object.assign(new Error("Sign in required."), { code: "UNAUTHORIZED" });
    return { sub: state.sub, email: "", name: "", exp: 0, token: "t" };
  },
}));
vi.mock("@/lib/api", () => ({ getApi: async () => (state.api as (s: string) => ConsoleApi)(state.sub!), getPublicApi: () => (state.api as (s: string) => ConsoleApi)("usr-sora") }));

import * as A from "@/app/customers/onboarding-actions";
import { confirmVerificationAction } from "@/app/verify/[token]/actions";

let store: ReturnType<typeof createStore>;
beforeEach(() => {
  store = createStore();
  state.api = (sub: string) => createMockApi(store, undefined, MOCK_USERS[sub]!);
  state.sub = "usr-haeun";
});

describe("pure helpers", () => {
  it("login domains: clean, syntax, count", () => {
    expect(parseLoginDomains(" Oak.Example, @pay.oak.example\nOak.example ")).toEqual({ ok: true, domains: ["oak.example", "pay.oak.example"] });
    expect(parseLoginDomains("")).toEqual({ ok: true, domains: [] });
    expect(parseLoginDomains("nope!").ok).toBe(false);
    expect(parseLoginDomains(Array.from({ length: 11 }, (_, i) => `a${i}.example`).join(",")).ok).toBe(false);
  });
  it("kit: placeholders are labelled, Remediator adds its caller role, ExternalId is carried", () => {
    const p = kitParams({ externalId: "ao-x", alarmWriterEnabled: true, tagWriterEnabled: false, remediatorEnabled: false });
    expect(p.map((x) => x.name)).toEqual(["CentralRoleArn", "ExternalId", "CentralEventBusArn", "EnableAlarmWriter", "EnableTagWriter", "EnableRemediator"]);
    expect(p[0]!.placeholder && p[0]!.value).toContain("central deployment (deploy-central)");
    expect(kitText(p)).toContain("ExternalId=ao-x");
    expect(kitParams({ externalId: "x", alarmWriterEnabled: false, tagWriterEnabled: false, remediatorEnabled: true }).at(-1)!.name).toBe("RemediatorCallerRoleArn");
  });
  it("roles: words, not colour; next steps for failures", () => {
    expect(roleLine({ key: "reader", required: true, enabled: true, status: "DENIED", basis: "CHECK" }, true).next).toContain("ExternalId");
    expect(roleLine({ key: "tagWriter", required: false, enabled: false, status: "UNKNOWN", basis: "CHECK" }, true).label).toBe("Not enabled");
    expect(roleLine({ key: "eventForwarder", required: true, enabled: true, status: "OK", basis: "EVENTS" }, true).label).toBe("OK · events received");
    expect(connectionOf(null)).toBe("NOT_CHECKED");
  });
  it("errors: 429 says a clock time, 422 public mail, 503 verification", () => {
    expect(retryTime(Date.parse("2026-11-18T00:00:00Z"), 30)).toBe("at 09:00:30 KST");
    expect(onboardingError({ code: "RATE_LIMITED", message: "", details: { retryAfterSec: 30 } }, "check", Date.parse("2026-11-18T00:00:00Z"))).toContain("at 09:00:30 KST");
    expect(onboardingError({ code: "VALIDATION_FAILED", message: "A public mail domain cannot be a login domain.", details: { fields: [{ field: "loginDomains", message: "Public mail domain." }] } }, "customer")).toContain("public mail domain");
    expect(onboardingError({ code: "VERIFICATION_UNAVAILABLE", message: "" }, "verify")).toContain("by hand");
  });
  it("verify token: shape and masking", () => {
    expect(isVerifyToken("vf_abc-123")).toBe(true);
    expect(isVerifyToken("a/b")).toBe(false);
    expect(loggablePath("/verify/vf_secret?x=1")).toBe("/verify/[token]?x=1");
    expect(VERIFY_PATH.test("/verify/vf_abc")).toBe(true);
    expect(VERIFY_PATH.test("/verify/vf_abc/extra")).toBe(false);
  });
  it("central values: valid ARNs are used, invalid ones are missing (one warning, never the value), the kit counts what is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = centralValues({ CENTRAL_ROLE_ARN: "arn:aws:iam::111122223333:role/AlarmOpsCentral-Engine", CENTRAL_EVENT_BUS_ARN: "arn:aws:events:ap-northeast-2:111122223333:event-bus/alarmops-central" });
    expect(ok).toMatchObject({ centralRoleArn: expect.any(String), centralBusArn: expect.any(String), remediatorCallerRoleArn: null });
    const bad = centralValues({ CENTRAL_ROLE_ARN: "arn:aws:iam::111122223333:root", CENTRAL_EVENT_BUS_ARN: "arn:aws:events:us-east-1:111122223333:event-bus/x", REMEDIATOR_CALLER_ROLE_ARN: "secret-looking-value" });
    expect(bad).toEqual({ centralRoleArn: null, centralBusArn: null, remediatorCallerRoleArn: null });
    expect(warn.mock.calls.flat().join(" ")).not.toContain("secret-looking-value");
    warn.mockRestore();
    const a = { externalId: "ao-x", alarmWriterEnabled: false, tagWriterEnabled: false, remediatorEnabled: false };
    expect(kitMissing(kitParams(a, ok))).toBe(0);
    expect(kitMissing(kitParams(a))).toBe(2);
    expect(kitMissing(kitParams({ ...a, remediatorEnabled: true }, ok))).toBe(1);
  });
  it("VERIFY_HASH_SECRET: unset or short -> undefined, >= 32 -> used", () => {
    expect(verificationSecret({})).toBeUndefined();
    expect(verificationSecret({ VERIFY_HASH_SECRET: "short" })).toBeUndefined();
    expect(verificationSecret({ VERIFY_HASH_SECRET: "x".repeat(32) })).toBe("x".repeat(32));
  });
});

describe("pollUntilChecked", () => {
  const st = (at: string | null) => ({ ok: true as const, data: { accountId: "a", customerId: "c", awsAccountId: "1", roles: [], lastCheckedAt: at, firstEventAt: null, lastEventAt: null, stackVersion: null, disabled: false } });
  it("stops when lastCheckedAt changes, is bounded, cancels, reports errors", async () => {
    const seq = [st(null), st(null), st("t1")];
    const done = await pollUntilChecked({ baseline: null, sleep: async () => {}, fetchStatus: async () => seq.shift()! });
    expect(done.kind).toBe("done");
    const n = vi.fn(async () => st(null));
    expect((await pollUntilChecked({ baseline: null, sleep: async () => {}, maxPolls: 3, fetchStatus: n })).kind).toBe("timeout");
    expect(n).toHaveBeenCalledTimes(3);
    expect((await pollUntilChecked({ baseline: null, sleep: async () => {}, cancelled: () => true, fetchStatus: n })).kind).toBe("cancelled");
    expect((await pollUntilChecked({ baseline: null, sleep: async () => {}, fetchStatus: async () => ({ ok: false, code: "UNKNOWN", message: "", requestId: "" }) })).kind).toBe("error");
  });
});

describe("mock contract: customers, accounts, contacts", () => {
  it("customer: 409 with existingCustomerId, 422 free mail, 400 syntax, 409 domain taken", async () => {
    const api = createMockApi(store, undefined, MOCK_USERS["usr-haeun"]!);
    const c = await api.createCustomer({ name: "Oak Systems", loginDomains: ["oak.example"] });
    expect(c.slug).toBe("oak-systems");
    await expect(api.createCustomer({ name: "oak systems" })).rejects.toMatchObject({ status: 409, details: { existingCustomerId: c.id } });
    await expect(api.createCustomer({ name: "X1", loginDomains: ["mail.gmail.com"] })).rejects.toMatchObject({ status: 422 });
    await expect(api.createCustomer({ name: "X2", loginDomains: ["bad"] })).rejects.toMatchObject({ status: 400 });
    await expect(api.createCustomer({ name: "X3", loginDomains: ["oak.example"] })).rejects.toMatchObject({ status: 409 });
    expect((await api.scopeTree()).customers.some((x) => x.slug === "oak-systems")).toBe(true);
  });
  it("account: ExternalId deterministic shape, 400 for server-made keys, cooldown 429, 503, role results", async () => {
    const api = createMockApi(store, undefined, MOCK_USERS["usr-haeun"]!);
    const c = await api.createCustomer({ name: "Fir Co" });
    await expect(api.createAccount(c.id, { awsAccountId: "123" })).rejects.toMatchObject({ status: 400 });
    await expect(api.createAccount(c.id, { awsAccountId: "123456789012", externalId: "x" } as never)).rejects.toMatchObject({ status: 400 });
    const a = await api.createAccount(c.id, { awsAccountId: "123456789402", alarmWriterEnabled: true });
    expect(a.externalId).toMatch(/^ao-[0-9a-f]{64}$/);
    expect(a.remediatorEnabled).toBe(false);
    await expect(api.createAccount(c.id, { awsAccountId: "123456789402" })).rejects.toMatchObject({ status: 409 });
    await api.checkAccount(a.id);
    await expect(api.checkAccount(a.id)).rejects.toMatchObject({ status: 429, details: { retryAfterSec: expect.any(Number) } });
    expect((await api.getAccountStatus(a.id)).lastCheckedAt).toBeNull();
    await new Promise((r) => setTimeout(r, 1600));
    const s = await api.getAccountStatus(a.id);
    expect(s.lastCheckedAt).not.toBeNull();
    expect(s.roles.find((r) => r.key === "alarmWriter")).toMatchObject({ status: "DENIED", enabled: true });
    expect(s.roles.find((r) => r.key === "tagWriter")!.enabled).toBe(false);
    const b = await api.createAccount(c.id, { awsAccountId: "123456789503" });
    await expect(api.checkAccount(b.id)).rejects.toMatchObject({ status: 503, code: "COMMANDS_UNAVAILABLE" });
  });
  it("contacts: masked, SMS link 503, manual, public token consumed once", async () => {
    const api = createMockApi(store, undefined, MOCK_USERS["usr-haeun"]!);
    const c = await api.createCustomer({ name: "Elm Co" });
    const p = await api.createContact({ customerId: c.id, name: "Yuna", email: "yuna@elm.example", phone: "010-1234-4821" });
    expect(JSON.stringify(p)).not.toContain("yuna@elm");
    expect(p.emailMasked).toBe("y•••@elm.example");
    expect((await api.verifyContact(p.id, { channel: "EMAIL", method: "link" })).status).toBe("LINK_SENT");
    await expect(api.verifyContact(p.id, { channel: "EMAIL", method: "link" })).rejects.toMatchObject({ status: 429 });
    await expect(api.verifyContact(p.id, { channel: "SMS", method: "link" })).rejects.toMatchObject({ status: 503, code: "VERIFICATION_UNAVAILABLE" });
    await api.verifyContact(p.id, { channel: "SMS", method: "manual", note: "called" });
    const [after] = (await api.listContacts({ customerId: c.id })).items;
    expect(after!.channels.SMS.status).toBe("VERIFIED");
    await expect(createMockApi(store, undefined, MOCK_USERS["usr-minjae"]!).verifyContact(p.id, { channel: "EMAIL", method: "manual" })).rejects.toMatchObject({ status: 403 });
    expect(await api.peekVerify("vf_demo_email_3")).toEqual({ pending: true, channel: "EMAIL" });
    expect(await api.peekVerify("vf_demo_email_3")).toEqual({ pending: true, channel: "EMAIL" });
    await api.confirmVerify("vf_demo_email_3");
    await expect(api.peekVerify("vf_demo_email_3")).rejects.toBeInstanceOf(ApiError);
    await expect(api.confirmVerify("vf_demo_email_3")).rejects.toMatchObject({ status: 404 });
  });
});

describe("server actions", () => {
  it("writes are Admin only and refuse before the API is touched", async () => {
    state.sub = "usr-minjae";
    expect(await A.createCustomerAction({ name: "Nope" })).toMatchObject({ ok: false, code: "ROLE_REQUIRED" });
    state.sub = "usr-sora";
    expect(await A.checkAccountAction("acc_x")).toMatchObject({ ok: false, code: "ROLE_REQUIRED" });
    state.sub = "usr-portal";
    expect(await A.createContactAction("cus_mirae", { name: "x", email: "a@b.co" })).toMatchObject({ ok: false, code: "READ_ONLY" });
    state.sub = null;
    expect(await A.createCustomerAction({ name: "Nope" })).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  });
  it("input is checked: account id, name, domains, channel; 409 carries existingCustomerId across", async () => {
    expect(await A.createAccountAction("cus_mirae", { awsAccountId: "12345" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await A.createCustomerAction({ name: "  " })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await A.createCustomerAction({ name: "Ash", loginDomains: "not a domain" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await A.verifyContactAction("ct", "PIGEON" as never, "link")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await A.createCustomerAction({ name: "Ash", loginDomains: "gmail.com" })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    const ok = await A.createCustomerAction({ name: "Ash", loginDomains: "ash.example" });
    expect(ok).toMatchObject({ ok: true });
    const dup = await A.createCustomerAction({ name: "ash" });
    expect(dup).toMatchObject({ ok: false, code: "ALREADY_EXISTS", details: { existingCustomerId: "cus_ash" } });
  });
  it("account flow through actions, and the 429 reaches the page with retryAfterSec", async () => {
    const c = await A.createCustomerAction({ name: "Yew" });
    if (!c.ok) throw new Error("x");
    const a = await A.createAccountAction(c.data.id, { awsAccountId: "1234 5678 9401", alarmWriterEnabled: true });
    if (!a.ok) throw new Error(JSON.stringify(a));
    expect(a.data.awsAccountId).toBe("123456789401");
    expect((await A.setCapabilityAction(a.data.id, "tagWriterEnabled", true))).toMatchObject({ ok: true, data: { tagWriterEnabled: true } });
    expect(await A.checkAccountAction(a.data.id)).toMatchObject({ ok: true });
    expect(await A.checkAccountAction(a.data.id)).toMatchObject({ ok: false, code: "RATE_LIMITED", details: { retryAfterSec: expect.any(Number) } });
  });
  it("manual verification needs a note (5 to 300 characters); invisible characters are refused in names and notes", async () => {
    const c = await A.createCustomerAction({ name: "Cedar" });
    if (!c.ok) throw new Error("x");
    const p = await A.createContactAction(c.data.id, { name: "Yuna", email: "y@cedar.example" });
    if (!p.ok) throw new Error("x");
    for (const note of [undefined, "", "   ", "ok", "x".repeat(301)]) expect(await A.verifyContactAction(p.data.id, "EMAIL", "manual", note), String(note)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await A.verifyContactAction(p.data.id, "EMAIL", "manual", "  Confirmed by phone  ")).toMatchObject({ ok: true });
    for (const bad of ["Evil‮Name", "Zero​Width", "Bom﻿Name", "Iso⁦late"]) {
      expect(await A.createCustomerAction({ name: bad }), bad).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(await A.createProjectAction(c.data.id, bad)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(await A.createServiceAction("prj_x", bad)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(await A.createContactAction(c.data.id, { name: bad, email: "a@b.co" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(await A.verifyContactAction(p.data.id, "SMS", "manual", "Called​ them")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
  it("the public confirm action needs no session and answers one thing for every dead link", async () => {
    state.sub = null;
    expect(await confirmVerificationAction("vf_demo_email_4")).toEqual({ ok: true, channel: "EMAIL" });
    expect(await confirmVerificationAction("vf_demo_email_4")).toEqual({ ok: false, code: "EXPIRED" });
    expect(await confirmVerificationAction("bad token!")).toEqual({ ok: false, code: "EXPIRED" });
  });
});
