/** D-35 mock rules, as API-CONTRACT §8.4 states them: 404 first, NORMAL for the customer's Responder, EMERGENCY (typed reason) for an Admin who is not, 403 for the rest, one log row per call, never the value in the log. */
import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client";
import { MOCK_USERS, createMockApi, createStore } from "./api/mock/mock-api";

const as = (store: ReturnType<typeof createStore>, who: string) => createMockApi(store, undefined, MOCK_USERS[who]!);
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? `${e.status} ${e.code}` : "?"; } };

describe("POST /contacts/{id}/reveal (mock)", () => {
  it("Responder: NORMAL, logged without the value; reason optional", async () => {
    const s = createStore();
    const r = await as(s, "usr-minjae").revealContact("ct_hyunwoo", { channel: "PHONE" });
    expect(r).toMatchObject({ mode: "NORMAL", channel: "PHONE" });
    expect(r.value).toMatch(/^010-\d{4}-\d{4}$/);
    expect(JSON.stringify(s.reveals.log)).not.toContain(r.value);
    expect(s.reveals.log[0]).toMatchObject({ id: r.auditId, mode: "NORMAL", reason: null, notified: [] });
  });
  it("Admin who is not a Responder: reason required (422), then EMERGENCY with the primary responder told", async () => {
    const s = createStore();
    const api = as(s, "usr-haeun");
    const n = s.reveals.log.length;
    expect(await code(api.revealContact("ct_eunbi", { channel: "PHONE" }))).toBe("422 EMERGENCY_REASON_REQUIRED");
    expect(await code(api.revealContact("ct_eunbi", { channel: "PHONE", reason: "   " }))).toBe("422 EMERGENCY_REASON_REQUIRED");
    expect(s.reveals.log.length).toBe(n);
    const r = await api.revealContact("ct_eunbi", { channel: "PHONE", reason: "  SEV-1, nobody answers  " });
    expect(r.mode).toBe("EMERGENCY");
    expect(s.reveals.log[0]).toMatchObject({ mode: "EMERGENCY", reason: "SEV-1, nobody answers" });
    expect(s.reveals.log[0]!.notified.length).toBe(1);
    expect(await code(api.revealContact("ct_eunbi", { channel: "PHONE", reason: "x".repeat(501) }))).toBe("400 VALIDATION_FAILED");
  });
  it("an Admin who is a Responder gets NORMAL; staff contacts have no emergency path", async () => {
    const s = createStore();
    expect((await as(s, "usr-haeun").revealContact("ct_yuna", { channel: "EMAIL" })).mode).toBe("NORMAL");
    expect(await code(as(s, "usr-haeun").revealContact("ct_dohyun", { channel: "PHONE", reason: "need it" }))).toBe("403 NOT_A_RESPONDER");
  });
  it("Operator who is not a Responder, and a Viewer: 403, nothing logged", async () => {
    const s = createStore();
    const n = s.reveals.log.length;
    expect(await code(as(s, "usr-minjae").revealContact("ct_kyungmin", { channel: "PHONE", reason: "x" }))).toBe("403 NOT_A_RESPONDER");
    expect(await code(as(s, "usr-sora").revealContact("ct_hyunwoo", { channel: "PHONE" }))).toBe("403 NOT_A_RESPONDER");
    expect(s.reveals.log.length).toBe(n);
  });
  it("unknown id and a portal user's other customer are the same 404; a portal user opens their own customer's people", async () => {
    const s = createStore();
    expect(await code(as(s, "usr-haeun").revealContact("ct_nobody", { channel: "PHONE" }))).toBe("404 NOT_FOUND");
    expect(await code(as(s, "usr-portal").revealContact("ct_hyunwoo", { channel: "PHONE", reason: "x" }))).toBe("404 NOT_FOUND");
    expect(await code(as(s, "usr-portal").revealContact("ct_haeun", { channel: "PHONE" }))).toBe("404 NOT_FOUND");
    expect((await as(s, "usr-portal").revealContact("ct_seojun", { channel: "EMAIL" })).mode).toBe("NORMAL");
  });
  it("rate limit: 10 emergency reveals an hour", async () => {
    const s = createStore();
    const api = as(s, "usr-haeun");
    for (let i = 0; i < 10; i++) await api.revealContact("ct_eunbi", { channel: "PHONE", reason: "r" });
    expect(await code(api.revealContact("ct_eunbi", { channel: "PHONE", reason: "r" }))).toBe("429 RATE_LIMITED");
  });
});

describe("GET /contact-reveals (mock)", () => {
  it("Admin all, Operator own customers, Viewer 403, portal 404; filters; no values", async () => {
    const s = createStore();
    const em = await as(s, "usr-haeun").listContactReveals({ mode: "EMERGENCY" });
    expect(em.items.length).toBeGreaterThan(0);
    expect(em.items.every((e) => e.mode === "EMERGENCY")).toBe(true);
    const all = await as(s, "usr-haeun").listContactReveals({});
    expect((await as(s, "usr-haeun").listContactReveals({ customer: "daon" })).items.every((e) => e.org.customer?.slug === "daon")).toBe(true);
    expect(await code(as(s, "usr-minjae").listContactReveals({ customer: "lumen" }))).toBe("404 NOT_FOUND");
    expect(await code(as(s, "usr-sora").listContactReveals({}))).toBe("403 ROLE_REQUIRED");
    expect(await code(as(s, "usr-portal").listContactReveals({}))).toBe("404 NOT_FOUND");
    expect(JSON.stringify(all)).not.toMatch(/010-\d{4}-\d{4}/);
  });
});
