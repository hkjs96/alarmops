/**
 * Console ↔ backend alignment and the fixes of "Console Call order 점검 — 2026-11-11" (QA P1-A, P2-A, P2-B, security 권고 1–6).
 * Reference for the shapes: API-CONTRACT §2 (errors, limits), §8.1, §8.3 and the backend's packages/api.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApiError, createHttpApi, isNotFoundLike } from "./api/client";
import { MOCK_USERS, createMockApi, createStore } from "./api/mock/mock-api";
import { directoryOf } from "./api/mock/paging-mock";
import { fail } from "./action-result";
import { FAIL_REASON, errorLine, errorText, parseField } from "./errors";
import { assertAddResponder, assertPagingInput, assertReachable } from "./call-order/input";
import { LIMITS_TEXT, MAX_STEPS, capViolation, estimateSends } from "./call-order/limits";
import { addStep, planSteps, toInput, validateConfig } from "./call-order/model";
import { parsePlanLabel, planLabel, snapshotPlanLabel } from "./call-order/plan-label";
import type { PagingConfigInput, PagingStep } from "./api/types";

const all = (atMin: number, ...channels: PagingStep["channels"]): PagingStep => ({ atMin, targetType: "ALL_RESPONDERS", channels });
const many = (n: number): PagingStep[] => Array.from({ length: n }, (_, i) => all(i * 5, "VOICE"));
/** six steps a minute apart, call + SMS to everyone: 60 per pass with 5 people (the limit), and every repeat lands in the same hour */
const fast = (): PagingStep[] => Array.from({ length: 6 }, (_, i) => all(i, "SMS", "VOICE"));
const idOf = async (api: ReturnType<typeof createMockApi>, slug: string) => (await api.scopeTree()).customers.find((c) => c.slug === slug)!;

describe("P2-A one wording for ordering + plan, on both screens", () => {
  it("the wording", () => {
    expect(planLabel({ style: "CUSTOM", plan: "URGENT", edited: true })).toBe("Custom, started from Urgent (edited)");
    expect(planLabel({ style: "SHARED_ROTATION", plan: "STANDARD", edited: false })).toBe("Shared rotation, started from Standard");
  });
  it("reads the server's own string, and prefers the structured fields when they are sent", () => {
    expect(parsePlanLabel("Custom steps · Urgent (edited)")).toEqual({ style: "CUSTOM", plan: "URGENT", edited: true });
    expect(parsePlanLabel("Shared MSP rotation · Quiet")).toEqual({ style: "SHARED_ROTATION", plan: "QUIET", edited: false });
    expect(parsePlanLabel("something else")).toBeNull();
    expect(snapshotPlanLabel({ planLabel: "All at once · Standard" })).toBe("All at once, started from Standard");
    expect(snapshotPlanLabel({ planLabel: "Some future wording" })).toBe("Some future wording");
    expect(snapshotPlanLabel(null)).toBeNull();
  });
  it("Mirae Pay: the incident panel and Call order say the same plan (was Urgent vs Standard)", async () => {
    const api = createMockApi(createStore());
    const inc = await api.getIncident((await api.listIncidents({ customer: "mirae" })).items[0]!.id);
    const path = await api.pagingPath({ customer: "mirae" });
    const here = planLabel({ style: path.style!, plan: path.plan!, edited: path.edited });
    expect(here).toBe("Custom, started from Urgent (edited)");
    expect(snapshotPlanLabel(inc.assignmentSnapshot)).toBe(here);
    // and the frozen steps are the stored steps: same people, minutes and ways to send
    expect(inc.assignmentSnapshot!.steps.map((s) => [s.atMin, s.targetType, s.channels.join("+")])).toEqual(path.steps.map((s) => [s.atMin, s.targetType, s.channels.join("+")]));
    expect(inc.assignmentSnapshot!.pagingConfigId).toBe(path.pagingConfigId);
  });
});

describe("P2-B limits: the contract's numbers, shown and enforced", () => {
  it("the limits line states every number", () => {
    for (const n of ["12 steps", "0–1,440", "repeat 0–5", "60 notifications", "120 in an hour", "20 people"]) expect(LIMITS_TEXT).toContain(n);
  });
  it("Add step stops at 12; 13 steps are an error that says so", async () => {
    let s = many(1);
    for (let i = 0; i < 30; i++) s = addStep(s);
    expect(s).toHaveLength(MAX_STEPS);
    const store = createStore();
    const dir = directoryOf(store.paging, store.customers.find((c) => c.slug === "daon")!);
    const v = validateConfig({ style: "CUSTOM", plan: "STANDARD", repeatCount: 0, steps: many(13) }, dir);
    expect(v.errors[0]!.message).toBe("A call order has at most 12 steps; this one has 13. Remove 1 step to save.");
  });
  it("the server's arithmetic for sends (packages/core estimateSends)", () => {
    // one message per person and person-channel, one for the Slack channel
    expect(estimateSends([all(0, "SLACK_CHANNEL", "VOICE", "SMS")], 0, 5)).toEqual({ perCycle: 11, perHour: 11 });
    expect(estimateSends(planSteps("STANDARD", { targetType: "ROTATION", targetId: "r" }), 1, 4)).toEqual({ perCycle: 7, perHour: 14 });
    // repeats further than an hour apart do not add up in the hour
    expect(estimateSends([all(0, "VOICE"), all(90, "VOICE")], 2, 3)).toEqual({ perCycle: 6, perHour: 3 });
    expect(estimateSends([], 3, 9)).toEqual({ perCycle: 0, perHour: 0 });
    expect(capViolation(many(12), 0, 5)).toBeNull(); // 60 exactly
    expect(capViolation(many(12), 0, 6)).toMatchObject({ code: "SEND_CAP_EXCEEDED", perCycle: 72 });
    expect(capViolation(fast(), 0, 5)).toBeNull();
    expect(capViolation(fast(), 2, 5)).toMatchObject({ code: "SEND_CAP_EXCEEDED", perCycle: 60, perHour: 180 });
    expect(capViolation([all(0, "VOICE")], 0, 21)).toEqual({ code: "RESPONDER_LIMIT_EXCEEDED", stepIndex: 0, responders: 21, limit: 20 });
  });
  it("the editor refuses what the API would refuse, in words", () => {
    const store = createStore();
    const dir = directoryOf(store.paging, store.customers.find((c) => c.slug === "mirae")!); // 5 pageable
    const cfg: PagingConfigInput = { style: "CUSTOM", plan: "STANDARD", repeatCount: 2, steps: fast() };
    expect(validateConfig(cfg, dir).errors[0]!.message).toMatch(/^This call order would send 180 notifications per incident within one hour, repeats included \(limit 120\)\. Use fewer steps/);
  });
  it("the API (mock) enforces them with the contract's codes and details", async () => {
    const api = createMockApi(createStore());
    const c = await idOf(api, "mirae");
    const cur = await api.getPaging(c.id);
    const put = (steps: PagingStep[], repeatCount = 0) => api.putPaging(c.id, { style: "CUSTOM", plan: "STANDARD", repeatCount, steps }, cur.version).catch((e) => e as ApiError);
    expect(await put(many(13))).toMatchObject({ status: 400, code: "VALIDATION_FAILED", details: { fields: [{ field: "steps", message: "steps must hold 1 to 12 steps." }] } });
    expect(await put([all(0, "VOICE"), all(0, "VOICE")])).toMatchObject({ status: 400, details: { fields: [{ field: "steps[1].atMin" }] } });
    expect(await put([all(0, "VOICE", "VOICE")])).toMatchObject({ status: 400, details: { fields: [{ field: "steps[0].channels" }] } });
    expect(await put([all(0, "VOICE")], 6)).toMatchObject({ status: 400, details: { fields: [{ field: "repeatCount" }] } });
    expect(await put(fast(), 2)).toMatchObject({ status: 422, code: "SEND_CAP_EXCEEDED", details: { perCycle: 60, perHour: 180, limits: { perCycle: 60, perHour: 120 } } });
    expect(cur.sendCap).toEqual({ perCycle: 8, perHour: 16, limits: { perCycle: 60, perHour: 120, allResponders: 20 }, exceeded: null });
    // all five ways to send are stored, sorted
    const ok = await api.putPaging(c.id, { style: "CUSTOM", plan: "STANDARD", repeatCount: 0, steps: [all(0, "EMAIL", "SLACK_DM", "SLACK_CHANNEL")] }, cur.version);
    expect(ok.steps[0]!.channels).toEqual(["SLACK_CHANNEL", "SLACK_DM", "EMAIL"]);
  });
  it("every server error becomes a sentence that says what to change — never a bare “Invalid steps”", () => {
    expect(errorText({ code: "VALIDATION_FAILED", message: "", details: { fields: [{ field: "steps", message: "steps must hold 1 to 12 steps." }] } })).toBe("A call order has 1 to 12 steps. Remove steps until there are 12 or fewer.");
    expect(errorText({ code: "VALIDATION_FAILED", message: "", details: { fields: [{ field: "steps[3].atMin", message: "Each step must start later than the step before it." }] } })).toBe("Step 4 must start later than step 3. Fix the minutes.");
    expect(errorText({ code: "VALIDATION_FAILED", message: "", details: { fields: [{ field: "steps[1].atMin", message: "atMin must be 0 to 1440 minutes." }] } })).toBe("Step 2: minutes must be a whole number from 0 to 1440.");
    expect(errorText({ code: "SEND_CAP_EXCEEDED", message: "x", details: { perCycle: 72, perHour: 72 } })).toMatch(/^Too many notifications: this call order would send 72 notifications per incident in one pass of the steps \(the limit is 60\)\. Use fewer/);
    expect(errorText({ code: "SEND_CAP_EXCEEDED", message: "x", details: { perCycle: 30, perHour: 180 } })).toMatch(/180 notifications per incident within one hour, repeats included \(the limit is 120\)/);
    expect(errorText({ code: "RESPONDER_LIMIT_EXCEEDED", message: "x", details: { field: "steps[2].targetType", responders: 23, limit: 20 } })).toBe("Step 3 calls everyone in Responders: 23 people, and the limit is 20. Call a rotation or named people instead, or reduce the Responders.");
    expect(errorText({ code: "NOT_PAGEABLE", message: "x", details: { field: "steps[0].targetId" } })).toMatch(/^Step 1: this person is Notify only/);
    expect(errorText({ code: "ROLE_REQUIRED", message: "x", details: { role: "ADMIN" } }, { what: "Changing the call order", where: "Mirae Pay" })).toBe("Changing the call order needs the Admin role. Nothing was changed for Mirae Pay. Ask an admin if you need it.");
    expect(errorText({ code: "RATE_LIMITED", message: "x", details: { retryAfterSec: 41.2 } })).toBe("That was done a moment ago. Try again in 42 s.");
    expect(errorText({ code: "MUTED_BY_MAINTENANCE", message: "x" })).toMatch(/muted by a maintenance window/);
    expect(errorText({ code: "SOMETHING_NEW", message: "The server said this." })).toBe("The server said this.");
    expect(errorLine({ code: "NOT_FOUND", message: "x", requestId: "req_1" })).toMatch(/\(requestId req_1\)$/);
    expect(parseField("steps[11].channels")).toEqual({ step: 12, field: "channels" });
    expect(Object.keys(FAIL_REASON).sort()).toEqual(["GAVE_UP", "INVALID_DESTINATION", "NOT_CONFIGURED", "PROVIDER_ERROR", "PROVIDER_REJECTED", "RATE_LIMITED", "TIMEOUT"]);
  });
});

describe("security 권고 4·5: the server action checks as strictly as the editor", () => {
  const ok: PagingConfigInput = { style: "CUSTOM", plan: "STANDARD", repeatCount: 1, steps: [all(0, "SLACK_CHANNEL"), all(5, "VOICE")] };
  it("minutes in order, first at 0, at most 12 steps, each channel once and at most five", () => {
    expect(assertPagingInput(ok)).toEqual(ok);
    expect(() => assertPagingInput({ ...ok, steps: [all(0, "VOICE"), all(0, "VOICE")] })).toThrow("Step 2 (0 min) would not come after step 1 (0 min). Fix the minutes to save.");
    expect(() => assertPagingInput({ ...ok, steps: [all(9, "VOICE"), all(7, "VOICE")] })).toThrow(/Step 1 starts at 0 min/);
    expect(() => assertPagingInput({ ...ok, steps: many(13) })).toThrow("A call order has at most 12 steps; this one has 13. Remove 1 to save.");
    expect(() => assertPagingInput({ ...ok, steps: [{ ...all(0), channels: Array(5000).fill("SMS") }] })).toThrow(/can be chosen once/);
    expect(() => assertPagingInput({ ...ok, steps: [all(0, "SMS", "SMS")] })).toThrow(/can be chosen once/);
    expect(() => assertPagingInput({ ...ok, steps: [{ ...all(0), channels: [] }] })).toThrow(/at least one way to send/);
    expect(() => assertPagingInput({ ...ok, steps: [{ ...all(0), channels: ["FAX"] }] })).toThrow();
    expect(() => assertPagingInput({ ...ok, repeatCount: 6 })).toThrow(/0 to 5/);
    // unknown keys never travel on
    expect(Object.keys(assertPagingInput({ ...ok, version: 9, edited: false, customerId: "cus_x" } as unknown)).sort()).toEqual(["plan", "repeatCount", "steps", "style"]);
  });
  it("a reachable target: checked against the customer as it is now", () => {
    const store = createStore();
    const dir = (slug: string) => directoryOf(store.paging, store.customers.find((c) => c.slug === slug)!);
    expect(() => assertReachable(ok, dir("mirae"))).not.toThrow();
    expect(() => assertReachable(ok, dir("kumho"))).toThrow(/Nobody would be called/);
    expect(() => assertReachable({ ...ok, steps: [{ atMin: 0, targetType: "PERSON", targetId: "ct_seojun", channels: ["SMS"] }] }, dir("mirae"))).toThrow(/Notify only/);
    expect(() => assertReachable({ ...ok, steps: [{ atMin: 0, targetType: "ROTATION", targetId: "rot_hanbit", channels: ["VOICE"] }] }, dir("mirae"))).toThrow(/choose a rotation/);
    expect(() => assertReachable({ ...ok, steps: [{ atMin: 0, targetType: "PERSON", targetId: "ct_soyeon", channels: ["VOICE"] }] }, dir("daon"))).toThrow(/Nobody would be reached/);
  });
  it("a new person: email and phone formats, no control characters in the name", () => {
    const p = { name: "Ari Go", role: "NOTIFY_ONLY" };
    expect(assertAddResponder({ ...p, email: " ari@daon.example ", phone: "+82 10-1234-5678" })).toEqual({ name: "Ari Go", email: "ari@daon.example", phone: "+82 10-1234-5678", role: "NOTIFY_ONLY" });
    expect(assertAddResponder({ ...p, phone: "01012345678", email: "" })).toMatchObject({ phone: "01012345678", email: undefined });
    for (const email of ["ari", "ari@", "@daon.example", "ari@daon", "a b@daon.example", "ari@daon.example\nBcc: x@evil.example", "ari@@daon.example", "<ari@daon.example>"]) {
      expect(() => assertAddResponder({ ...p, email }), email).toThrow(/email address does not look right/);
    }
    for (const phone of ["12345", "phone", "010-1234-5678 ext 9", "+82 (10) 1234", "0".repeat(16), "+"]) {
      expect(() => assertAddResponder({ ...p, phone }), phone).toThrow(/phone number does not look right/);
    }
    for (const name of ["Ari\nGo", "Ari\u0000", "Ari\u202eoG", "Ari\tGo", "Ari\u2028Go"]) expect(() => assertAddResponder({ name, email: "a@x.example", role: "PAGEABLE" }), JSON.stringify(name)).toThrow(/cannot be used/);
    expect(() => assertAddResponder({ ...p, email: { toString: () => "a@x.example" } })).toThrow();
    // APPROVER / PORTAL_USER cannot be granted through this action
    expect(assertAddResponder({ ...p, email: "a@x.example", extras: ["APPROVER"], scope: { level: "CUSTOMER" } })).toEqual({ name: "Ari Go", email: "a@x.example", phone: undefined, role: "NOTIFY_ONLY" });
  });
});

describe("security 권고 2·3·6: Responders writes", () => {
  it("If-Match: a stale version is 409 and nothing changes; each write returns the new version", async () => {
    const api = createMockApi(createStore());
    const daon = (await idOf(api, "daon")).id;
    const v0 = (await api.getResponders(daon)).version;
    const a = await api.addResponder(daon, { contactId: "ct_jiwoo" }, { version: v0 });
    expect(a.version).toBe(v0 + 1);
    // a second tab that still has v0: add, role and remove are all refused
    for (const w of [api.addResponder(daon, { contactId: "ct_taemin" }, { version: v0 }), api.patchResponder(daon, "ct_soyeon", { role: "NOTIFY_ONLY" }, { version: v0 }), api.removeResponder(daon, "ct_junho", { version: v0 })]) {
      await expect(w).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT", details: { currentVersion: v0 + 1 } });
    }
    const now = await api.getResponders(daon);
    expect([now.version, now.staff.map((s) => s.contactId), now.people.find((p) => p.contactId === "ct_soyeon")!.role]).toEqual([v0 + 1, ["ct_junho", "ct_minjae", "ct_jiwoo"], "PAGEABLE"]);
  });
  it("a change that leaves nobody reachable is refused until the request says the user was told", async () => {
    const api = createMockApi(createStore());
    const daon = (await idOf(api, "daon")).id;
    let v = (await api.getResponders(daon)).version;
    v = (await api.removeResponder(daon, "ct_junho", { version: v })).version;
    v = (await api.removeResponder(daon, "ct_minjae", { version: v })).version; // Soyeon is left: the Slack channel still reaches her
    expect((await api.pagingHealth(daon)).level).toBe("AT_RISK");
    await expect(api.patchResponder(daon, "ct_soyeon", { role: "NOTIFY_ONLY" }, { version: v })).rejects.toMatchObject({ status: 409, code: "WOULD_BE_UNREACHABLE" });
    await expect(api.removeResponder(daon, "ct_soyeon", { version: v })).rejects.toMatchObject({ code: "WOULD_BE_UNREACHABLE" });
    expect((await api.getResponders(daon)).version).toBe(v);
    v = (await api.removeResponder(daon, "ct_soyeon", { version: v, confirmUnreachable: true })).version;
    expect((await api.pagingHealth(daon)).level).toBe("UNREACHABLE");
    // Undo of each removal, in any order: the customer person comes back with her scope and extras
    v = (await api.addResponder(daon, { contactId: "ct_soyeon", role: "PAGEABLE" }, { version: v })).version;
    v = (await api.addResponder(daon, { contactId: "ct_junho" }, { version: v })).version;
    await api.addResponder(daon, { contactId: "ct_minjae" }, { version: v });
    const back = await api.getResponders(daon);
    expect(back.staff.map((s) => s.contactId).sort()).toEqual(["ct_junho", "ct_minjae"]);
    expect(back.people.find((p) => p.contactId === "ct_soyeon")).toMatchObject({ role: "PAGEABLE", extras: ["APPROVER", "PORTAL_USER"], scope: { level: "CUSTOMER" } });
    expect((await api.pagingHealth(daon)).level).toBe("OK");
  });
  it("CROSS_CUSTOMER reaches the page as Not found, like an id that does not exist", () => {
    const cross = fail(new ApiError(422, "CROSS_CUSTOMER", "This contact belongs to another customer.", "req_9"));
    const missing = fail(new ApiError(404, "NOT_FOUND", "Not found.", "req_9"));
    expect(cross).toEqual(missing);
    expect(isNotFoundLike(new ApiError(422, "CROSS_CUSTOMER", "x", ""))).toBe(true);
    // in a step it names the step, still without saying that the id is real somewhere else
    const step = fail(new ApiError(422, "CROSS_CUSTOMER", "A customer person can only be paged for their own customer.", "r", { field: "steps[1].targetId" }));
    expect(step).toMatchObject({ code: "CROSS_CUSTOMER", message: "Not found." });
    expect(errorText(step as never)).toBe("Step 2: the person or rotation it calls was not found for this customer. Choose who it calls.");
    // only known, plain detail values cross to the browser
    expect(fail(new ApiError(400, "VALIDATION_FAILED", "m", "r", { fields: [{ field: "steps", message: "m", internal: { sql: "…" } }], stack: "at …", perCycle: 3 })).details).toEqual({ perCycle: 3, fields: [{ field: "steps", message: "m" }] });
    expect(fail(new Error("boom: /var/task/secret"))).toEqual({ ok: false, code: "UNKNOWN", message: "Something went wrong.", requestId: "" });
  });
});

describe("roles: /me decides what is offered, the API what is allowed (403 ROLE_REQUIRED)", () => {
  it("an operator acknowledges and cannot change who is called; a viewer does neither; reading is the same", async () => {
    const store = createStore();
    const [admin, op, viewer] = ["usr-haeun", "usr-minjae", "usr-sora"].map((u) => createMockApi(store, undefined, MOCK_USERS[u]));
    expect([(await admin!.me()).role, (await op!.me()).role, (await viewer!.me()).role]).toEqual(["ADMIN", "OPERATOR", "VIEWER"]);
    const daon = (await idOf(op!, "daon")).id;
    const path = await op!.pagingPath({ customer: "daon" });
    const body = toInput({ ...path, style: path.style!, plan: path.plan! });
    const r = await op!.getResponders(daon);
    for (const w of [op!.putPaging(daon, body, path.version), op!.removeResponder(daon, "ct_junho", { version: r.version }), op!.addResponder(daon, { contactId: "ct_jiwoo" }, { version: r.version }), op!.getPaging(daon)]) {
      await expect(w).rejects.toMatchObject({ status: 403, code: "ROLE_REQUIRED", details: { role: "ADMIN" } });
    }
    expect((await op!.getResponders(daon)).version).toBe(r.version);
    const inc = (await viewer!.listIncidents({ status: "TRIGGERED" })).items[0]!;
    await expect(viewer!.ack(inc.id, inc.version)).rejects.toMatchObject({ status: 403, code: "ROLE_REQUIRED", details: { role: "OPERATOR" } });
    // an id that does not exist is 404 before the role is looked at
    await expect(viewer!.ack("inc-nope", 1)).rejects.toMatchObject({ status: 404 });
    const acked = await op!.ack(inc.id, inc.version);
    // the undo token belongs to the person who acknowledged: for anyone else it is the same 404 as an unknown one
    await expect(admin!.bulkUndo(acked.undoToken)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(op!.bulkUndo("undo_nope")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});

describe("shapes aligned with the backend", () => {
  it("escalation is always an object with a state; no summary", async () => {
    const api = createMockApi(createStore());
    const items = (await api.listIncidents({})).items;
    for (const i of items) {
      expect(Object.keys(i.escalation).sort()).toEqual(["baseAt", "doneAt", "firedSteps", "mutedByMaintenance", "nextAt", "nextLabel", "renotifyAt", "repeat", "repeatCount", "state", "step", "stoppedAt", "totalSteps"]);
    }
    expect([...new Set(items.map((i) => i.escalation.state))].sort()).toEqual(["NEVER_ESCALATING", "PAGING", "STOPPED_ACKED"]);
    expect([...new Set((await api.listIncidents({ status: "RESOLVED" })).items.map((i) => i.escalation.state))]).toEqual(["STOPPED_RESOLVED"]);
    const open = items.find((i) => i.escalation.state === "PAGING")!;
    const { incident, undoToken } = await api.ack(open.id, open.version);
    expect(incident.escalation).toMatchObject({ state: "STOPPED_ACKED", nextAt: null, nextLabel: null, stoppedAt: expect.any(String) });
    expect((await api.resolve(open.id, incident.version, {})).escalation.state).toBe("STOPPED_RESOLVED");
    // undo: { restored, skipped } — the incident was resolved since, so it is skipped, not put back
    expect(await api.bulkUndo(undoToken)).toEqual({ restored: [], skipped: [{ id: open.id, code: "VERSION_CONFLICT" }] });
    await expect(api.bulkUndo(undoToken)).rejects.toMatchObject({ status: 404 }); // once
    const unmapped = items.find((i) => i.unmapped)!;
    await expect(api.escalate(unmapped.id, unmapped.version)).rejects.toMatchObject({ status: 409, code: "INVALID_TRANSITION" });
  });
  it("undo of an untouched acknowledgement restores it", async () => {
    const api = createMockApi(createStore());
    const open = (await api.listIncidents({ status: "TRIGGERED" })).items[0]!;
    const { undoToken } = await api.ack(open.id, open.version);
    expect(await api.bulkUndo(undoToken)).toEqual({ restored: [open.id], skipped: [] });
    expect((await api.getIncident(open.id)).escalation).toEqual(open.escalation);
  });
  it("bulk preview answers with codes; notifications carry reason and attempt", async () => {
    const api = createMockApi(createStore());
    const items = (await api.listIncidents({})).items;
    const acked = items.find((i) => i.status === "ACKNOWLEDGED")!;
    const p = await api.bulkPreview("ack", [{ id: acked.id, version: acked.version }, { id: "inc-nope", version: 1 }, { id: items[0]!.id, version: 99 }]);
    expect(p.skipped.map((s) => s.reason).sort()).toEqual(["INVALID_TRANSITION", "NOT_FOUND", "VERSION_CONFLICT"]);
    const n = (await api.getNotifications(items.find((i) => i.org.customer?.slug === "mirae" && i.status === "TRIGGERED")!.id)).items;
    expect(n.length).toBeGreaterThan(0);
    for (const x of n) expect(x).toMatchObject({ reason: null, attempt: 1 });
  });
  it("paging: no steps yet → GET version 0, id null, steps []; the first PUT goes with If-Match 0", async () => {
    const store = createStore();
    const api = createMockApi(store);
    const jeil = await idOf(api, "jeil");
    store.paging.byCustomer[jeil.id]!.config = null;
    const empty = await api.getPaging(jeil.id);
    expect(empty).toMatchObject({ id: null, version: 0, steps: [], edited: false, overrides: [] });
    expect(await api.pagingPath({ customer: "jeil" })).toMatchObject({ inheritedFrom: null, own: false, style: null, plan: null, pagingConfigId: null, version: 0, steps: [], warning: "NO_CALL_ORDER" });
    expect((await api.pagingHealth(jeil.id)).level).toBe("UNREACHABLE");
    expect((await api.callOrderList({ customer: "jeil" })).rows[0]).toMatchObject({ key: "jeil", steps: [], health: { level: "UNREACHABLE" } });
    const body: PagingConfigInput = { style: "ALL_AT_ONCE", plan: "STANDARD", repeatCount: 1, steps: planSteps("STANDARD", { targetType: "ALL_RESPONDERS" }) };
    await expect(api.putPaging(jeil.id, body, 3)).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT", details: { currentVersion: 0 } });
    const made = await api.putPaging(jeil.id, body, 0);
    expect(made).toMatchObject({ version: 1, edited: false, id: expect.any(String) });
    await expect(api.putPaging(jeil.id, body, 0)).rejects.toMatchObject({ status: 409 });
    expect(await api.pagingPath({ customer: "jeil" })).toMatchObject({ own: true, version: 1, style: "ALL_AT_ONCE" });
  });
  it("the HTTP client: If-Match on every Responders write, If-Match 0 creates (201), error details are kept, portal shapes parse", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answers: Response[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return answers.shift()!; });
    const api = createHttpApi({ baseUrl: "https://api.test", fetch: f as unknown as typeof fetch });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    answers.push(json(200, { contactId: "c1", version: 8 }), json(200, { contactId: "c1", version: 9 }), json(200, { contactId: "c1", version: 10 }), json(201, { version: 1 }), json(201, { version: 1 }));
    await api.addResponder("cus_1", { contactId: "c1" }, { version: 7 });
    await api.patchResponder("cus_1", "c1", { role: "NOTIFY_ONLY" }, { version: 8, confirmUnreachable: true });
    await api.removeResponder("cus_1", "c1", { version: 9 });
    const body: PagingConfigInput = { style: "CUSTOM", plan: "STANDARD", repeatCount: 0, steps: [all(0, "VOICE")] };
    expect((await api.putPaging("cus_1", body, 0)).version).toBe(1);
    await api.putPagingOverride("cus_1", "SERVICE", "svc_1", body, 0);
    const h = (n: number) => calls[n]!.init.headers as Record<string, string>;
    expect(calls.map((c, n) => [c.init.method, c.url.replace("https://api.test/api/v1", ""), h(n)["If-Match"]])).toEqual([
      ["POST", "/customers/cus_1/responders", "7"],
      ["PATCH", "/customers/cus_1/responders/c1?confirmUnreachable=true", "8"],
      ["DELETE", "/customers/cus_1/responders/c1", "9"],
      ["PUT", "/customers/cus_1/paging", "0"],
      ["PUT", "/customers/cus_1/paging-overrides/SERVICE/svc_1", "0"],
    ]);
    expect(calls.every((c, n) => !("If-None-Match" in h(n)))).toBe(true);
    answers.push(json(422, { error: { code: "SEND_CAP_EXCEEDED", message: "too many", details: { perCycle: 72, perHour: 72, limits: { perCycle: 60, perHour: 120 } }, requestId: "req_7" } }));
    const e = await api.putPaging("cus_1", body, 1).catch((x) => x as ApiError);
    expect(e).toMatchObject({ status: 422, code: "SEND_CAP_EXCEEDED", requestId: "req_7", details: { perCycle: 72 } });
    // a portal user's incident: names only, no ids, no account numbers, notification without the internal keys
    answers.push(json(200, { id: "i", assignee: { name: "MSP on-call" }, acknowledgedBy: { name: "Soyeon Choi" }, awsAccountIds: [], escalation: { state: "PAGING" },
      assignmentSnapshot: { capturedAt: "2026-11-08T18:12:04Z", planLabel: "Custom steps · Urgent (edited)", level: "CUSTOMER", repeatCount: 1, steps: [{ index: 0, atMin: 0, targetType: "ROTATION", resolved: [{ name: "MSP on-call" }], channels: ["SLACK_CHANNEL", "VOICE"] }] } }),
      json(200, { items: [{ id: "n", at: "2026-11-08T18:12:06Z", channel: "SMS", status: "FAILED", targetSummary: "MSP on-call", escalationStep: 0, reason: "INVALID_DESTINATION", attempt: 2 }], nextCursor: null }));
    const inc = await api.getIncident("i");
    expect(inc.assignee?.contactId).toBeUndefined();
    expect(snapshotPlanLabel(inc.assignmentSnapshot)).toBe("Custom, started from Urgent (edited)");
    const n = (await api.getNotifications("i")).items[0]!;
    expect([n.reason, n.error, FAIL_REASON[n.reason!]]).toEqual(["INVALID_DESTINATION", undefined, "the address or number is not valid"]);
  });
});

describe("P1-A the rule for every list: each list action is covered by assertNoRowShift in e2e", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const root = join(__dirname, "..", "..");
  const src = [...walk(join(root, "src")), ...walk(join(root, "..", "..", "packages", "design-system", "src"))].filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f));
  const text = src.map((f) => readFileSync(f, "utf8")).join("\n");
  const actions = [...new Set([...text.matchAll(/(?:data-list-action=|action[:=] ?)"([a-z]+\.[a-z-]+)"/g)].map((m) => m[1]!))].sort();
  const e2e = walk(join(root, "e2e")).filter((f) => /\.spec\.ts$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  const covered = new Set([...e2e.matchAll(/assertNoRowShift\(\s*page,\s*\{\s*name:\s*"([^"]+)"/g)].map((m) => m[1]!));
  it("the list actions the console has", () => {
    expect(actions).toEqual([
      "incident.ack", "incident.panel-ack", "incident.panel-escalate", "incident.panel-resolve", "incident.panel-undo-ack", "incident.reload", "incident.undo-ack",
      "responder.add", "responder.add-person", "responder.remove", "responder.role", "responder.undo-remove",
    ]);
  });
  it.each(actions)("%s is exercised with assertNoRowShift", (a) => { expect(covered.has(a), `no e2e calls assertNoRowShift(page, { name: "${a}" … })`).toBe(true); });
  it("the Call order list (changed from its panel) is covered too", () => {
    for (const a of ["callorder.save", "callorder.create-own", "callorder.remove-own"]) expect(covered.has(a), a).toBe(true);
  });
  it("lists are built on the shared hook, not on a private copy of the rule", () => {
    for (const f of ["src/app/incidents/IncidentsTable.tsx", "src/app/call-order/CallOrderTable.tsx", "src/app/call-order/RespondersCard.tsx"]) {
      expect(readFileSync(join(root, f), "utf8"), f).toMatch(/useStableRows\(/);
    }
  });
});
