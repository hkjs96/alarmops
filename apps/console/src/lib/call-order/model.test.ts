import { describe, expect, it } from "vitest";
import type { ScopeCustomerNode } from "@alarmops/design-system";
import type { PagingConfigInput, PagingStep } from "../api/types";
import { createMockApi, createStore } from "../api/mock/mock-api";
import { directoryOf } from "../api/mock/paging-mock";
import {
  addStep, computeHealth, diffConfig, firstOfStyle, isEdited, moveStep, pagedNow, partsText, planSteps, reachOf, reachText, removeStep, repeatText, resolveStep,
  resolveStored, sameConfig, scopeKey, parseScopeKey, sentenceParts, sentenceText, sourceOf, toInput, validateConfig, callOrderPath, type Directory,
} from "./model";
import { howText } from "./model";
import { assertAddResponder, assertPagingInput, assertScope } from "./input";

const store = createStore();
const cust = (slug: string) => store.customers.find((c) => c.slug === slug)!;
const dirOf = (slug: string): Directory => directoryOf(store.paging, cust(slug));
const cfgOf = (slug: string) => store.paging.byCustomer[cust(slug).id]!;
const steps = (slug: string) => cfgOf(slug).config!.steps.map((s) => resolveStep(s, dirOf(slug)));
async function tree(slug: string): Promise<ScopeCustomerNode> {
  return (await createMockApi(createStore()).scopeTree()).customers.find((c) => c.slug === slug)!;
}

describe("sentence builder", () => {
  it("writes the four ordering patterns of the mockup with real names and minute marks", () => {
    expect(sentenceText(steps("mirae"), 1, "Mirae Pay")).toBe(
      "Slack + call on shift in MSP night desk (Haeun now) now → Call Yuna Seo (Mirae Pay) at 10 min → Call everyone in Responders (5) at 15 min → repeat once.");
    expect(sentenceText(steps("daon"), 1, "Daon Retail")).toBe(
      "Slack everyone in Responders (3) now → SMS everyone in Responders (3) at 2 min → Call everyone in Responders (3) at 7 min → repeat once.");
    expect(sentenceText(steps("hanbit"), 1, "Hanbit Logistics")).toBe(
      "Slack on shift in Hanbit on-call (Junho now) now → SMS on shift in Hanbit on-call (Junho now) at 2 min → Call on shift in Hanbit on-call (Junho now) at 7 min → Call everyone in Responders (4) at 12 min → repeat once.");
    expect(sentenceText(steps("ara"), 1, "Ara Games")).toContain("Slack on shift in MSP night desk (Haeun now) now → SMS on shift in MSP night desk (Haeun now) at 2 min");
  });
  it("names a customer person with the customer, a staff member without", () => {
    const d = dirOf("mirae");
    expect(partsText(sentenceParts([resolveStep({ atMin: 0, targetType: "PERSON", targetId: "ct_yuna", channels: ["VOICE"] }, d)], 0, "Mirae Pay"))).toBe("Call Yuna Seo (Mirae Pay) now → no repeat.");
    expect(sentenceText([resolveStep({ atMin: 0, targetType: "PERSON", targetId: "ct_minjae", channels: ["SMS", "SLACK_DM"] }, d)], 2, "Mirae Pay")).toBe("Slack DM + SMS Minjae Lee now → repeat twice.");
    // the server's words: "Slack" is the customer's channel, "Slack DM" the person, and the order is fixed
    expect(howText(["EMAIL", "VOICE", "SLACK_CHANNEL", "SMS", "SLACK_DM"])).toBe("Slack + Slack DM + SMS + call + email");
  });
  it("repeat wording", () => {
    expect([0, 1, 2, 3].map(repeatText)).toEqual(["no repeat", "repeat once", "repeat twice", "repeat 3 times"]);
  });
  it("marks a changed minute as new and keeps the old value, struck through", () => {
    const before = steps("mirae");
    const after = before.map((s, i) => (i === 1 ? { ...s, atMin: 8 } : s));
    const parts = sentenceParts(after, 1, "Mirae Pay", { steps: before, repeatCount: 1 });
    expect(parts.filter((p) => p.k === "new").map((p) => p.t)).toEqual(["8 min"]);
    expect(parts.filter((p) => p.k === "old").map((p) => p.t)).toEqual(["10 min"]);
    expect(partsText(parts)).toContain("Call Yuna Seo (Mirae Pay) at 8 min →");
    expect(partsText(parts)).not.toContain("10 min");
  });
  it("marks a changed target, channel and repeat; an added step is new, a removed one is old", () => {
    const d = dirOf("mirae");
    const before = steps("mirae");
    const changed = [before[0]!, resolveStep({ atMin: 10, targetType: "PERSON", targetId: "ct_junho", channels: ["SMS"] }, d)];
    const parts = sentenceParts(changed, 0, "Mirae Pay", { steps: before, repeatCount: 1 });
    expect(parts.filter((p) => p.k === "old").map((p) => p.t)).toEqual(["Call", "Yuna Seo (Mirae Pay)", "Call everyone in Responders (5) at 15 min", "repeat once"]);
    expect(parts.filter((p) => p.k === "new").map((p) => p.t)).toEqual(["SMS", "Junho Park", "no repeat"]);
    const added = sentenceParts([...before, resolveStep({ atMin: 20, targetType: "ALL_RESPONDERS", channels: ["SMS"] }, d)], 1, "Mirae Pay", { steps: before, repeatCount: 1 });
    expect(added.filter((p) => p.k === "new").map((p) => p.t)).toEqual(["SMS everyone in Responders (5) at 20 min"]);
  });
  it("no change → no marks", () => {
    const s = steps("hanbit");
    expect(sentenceParts(s, 1, "Hanbit Logistics", { steps: s, repeatCount: 1 }).some((p) => p.k === "new" || p.k === "old")).toBe(false);
  });
  it("pagedNow lists everyone once, in step order", () => {
    expect(pagedNow(steps("mirae")).map((p) => p.name)).toEqual(["Haeun Kim", "Yuna Seo", "Junho Park", "Minjae Lee", "Taemin Jung"]);
  });
  it("a rotation with nobody on shift says so", () => {
    const d: Directory = { ...dirOf("hanbit"), rotations: [{ id: "rot_x", scope: "MSP", name: "Empty desk", onShift: null }] };
    expect(sentenceText([resolveStep({ atMin: 0, targetType: "ROTATION", targetId: "rot_x", channels: ["VOICE"] }, d)], 1, "X")).toBe("Call on shift in Empty desk (nobody now) now → repeat once.");
  });
});

describe("inheritance resolution (service › project › customer, first with own steps)", () => {
  it("resolveStored picks the service override, then the project override, then the customer", () => {
    const m = cfgOf("mirae"), h = cfgOf("hanbit");
    const dp = cust("mirae").projects.find((p) => p.slug === "data-platform")!;
    const core = cust("mirae").projects.find((p) => p.slug === "core")!;
    expect(resolveStored(m.config!, m.overrides, { projectId: dp.id, serviceId: dp.services[0]!.id }).scopeType).toBe("PROJECT");
    expect(resolveStored(m.config!, m.overrides, { projectId: core.id, serviceId: core.services[0]!.id }).scopeType).toBe("CUSTOMER");
    const ful = cust("hanbit").projects.find((p) => p.slug === "fulfilment")!;
    expect(resolveStored(h.config!, h.overrides, { projectId: ful.id, serviceId: ful.services[0]!.id }).scopeType).toBe("SERVICE");
    expect(resolveStored(h.config!, h.overrides, { projectId: ful.id }).scopeType).toBe("CUSTOMER");
    expect(resolveStored(h.config!, h.overrides, {}).scopeType).toBe("CUSTOMER");
  });
  it("sourceOf follows the tree's ownSteps flags", async () => {
    const m = await tree("mirae");
    expect(sourceOf(m, { customer: "mirae", project: "core", service: "checkout" })).toEqual({ customer: "mirae" });
    expect(sourceOf(m, { customer: "mirae", project: "data-platform", service: "ledger" })).toEqual({ customer: "mirae", project: "data-platform" });
    expect(sourceOf(await tree("hanbit"), { customer: "hanbit", project: "fulfilment", service: "orders-api" })).toEqual({ customer: "hanbit", project: "fulfilment", service: "orders-api" });
  });
  it("reachOf: a level pages for the services below it that have no own steps in between", async () => {
    const m = await tree("mirae");
    const r = reachOf(m, { customer: "mirae" });
    expect(r.services).toEqual(["Core › Payments API", "Core › Settlement", "Core › Checkout", "Merchant › Merchant portal"]);
    expect(r.kept).toEqual(["Data platform"]);
    expect(reachText(r)).toBe("4 services (Data platform keeps own steps)");
    expect(reachOf(m, { customer: "mirae", project: "data-platform" }).services).toEqual(["Data platform › Ledger"]);
    expect(reachOf(m, { customer: "mirae", project: "core", service: "checkout" }).services).toEqual(["Core › Checkout"]);
    const h = await tree("hanbit");
    expect(reachOf(h, { customer: "hanbit" })).toEqual({ services: ["Tracking › Public API", "Ops › Batch"], kept: ["Fulfilment › Orders API"] });
    expect(reachOf(h, { customer: "hanbit", project: "fulfilment" })).toEqual({ services: [], kept: ["Fulfilment › Orders API"] });
    expect(reachText(reachOf(h, { customer: "hanbit", project: "fulfilment" }))).toBe("no service right now (Fulfilment › Orders API keeps own steps)");
  });
  it("the API resolves the same way: paging-path says where the steps come from", async () => {
    const api = createMockApi(createStore());
    const inh = await api.pagingPath({ customer: "mirae", project: "core", service: "checkout" });
    expect(inh.own).toBe(false);
    expect(inh.inheritedFrom).toMatchObject({ level: "CUSTOMER", name: "Mirae Pay" });
    expect(inh.sentence).toContain("Yuna Seo (Mirae Pay) at 10 min");
    expect(inh.customerNotified.map((n) => n.name)).toEqual(["Seojun Bae", "Hana Noh", "Hyejin Lim", "Dami Ko"]);
    const led = await api.pagingPath({ customer: "mirae", project: "data-platform", service: "ledger" });
    expect(led.inheritedFrom).toMatchObject({ level: "PROJECT", name: "Data platform" });
    expect(led.repeatCount).toBe(0);
    const own = await api.pagingPath({ customer: "hanbit", project: "fulfilment", service: "orders-api" });
    expect(own.own).toBe(true);
    expect(own.sentence).toBe("Call Hyunwoo Ahn (Hanbit Logistics) now → Call on shift in Hanbit on-call (Junho now) at 5 min → repeat once.");
    await expect(api.pagingPath({ customer: "mirae", project: "nope" })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(api.pagingPath({ customer: "nobody-here" })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
  it("scope keys and panel addresses", () => {
    expect(scopeKey({ customer: "hanbit", project: "fulfilment", service: "orders-api" })).toBe("hanbit/fulfilment/orders-api");
    expect(scopeKey({ customer: "hanbit", service: "x" })).toBe("hanbit");
    expect(parseScopeKey("mirae/core")).toEqual({ customer: "mirae", project: "core", service: undefined });
    expect(callOrderPath({ customer: "mirae" })).toBe("/c/mirae/call-order");
    expect(callOrderPath({ customer: "hanbit", project: "fulfilment", service: "orders-api" })).toBe("/c/hanbit/fulfilment/orders-api/call-order");
  });
});

describe("validation", () => {
  const base = (slug: string): PagingConfigInput => toInput(cfgOf(slug).config!);
  const withMin = (c: PagingConfigInput, i: number, atMin: number): PagingConfigInput => ({ ...c, steps: c.steps.map((s, n) => (n === i ? { ...s, atMin } : s)) });
  it("the stored fixtures are valid", () => {
    for (const slug of ["mirae", "daon", "hanbit", "ara", "lumen"]) expect(validateConfig(base(slug), dirOf(slug)).errors).toEqual([]);
  });
  it("minutes must strictly increase: equal or lower than the step before blocks the save", () => {
    const v = validateConfig(withMin(base("hanbit"), 1, 9), dirOf("hanbit"));
    expect(v.errors.map((e) => e.message)).toEqual(["Step 3 (7 min) would not come after step 2 (9 min). Fix the minutes to save."]);
    expect(v.errors[0]).toMatchObject({ stepIndex: 2, field: "atMin" });
    expect(validateConfig(withMin(base("hanbit"), 1, 7), dirOf("hanbit")).errors).toHaveLength(1);
    expect(validateConfig(withMin(base("hanbit"), 1, 4), dirOf("hanbit")).errors).toEqual([]);
  });
  it("an empty minute, a first step that is not at 0, no channel, no person, a bad repeat", () => {
    const d = dirOf("mirae");
    expect(validateConfig(withMin(base("mirae"), 1, -1), d).errors[0]!.message).toMatch(/Step 2: minutes must be a whole number/);
    expect(validateConfig(withMin(base("mirae"), 0, 3), d).errors[0]!.message).toMatch(/Step 1 starts at 0 min/);
    const noCh = { ...base("mirae"), steps: base("mirae").steps.map((s, n) => (n === 2 ? { ...s, channels: [] } : s)) };
    expect(validateConfig(noCh, d).errors[0]).toMatchObject({ stepIndex: 2, field: "channels" });
    const noPerson = { ...base("mirae"), steps: base("mirae").steps.map((s, n): PagingStep => (n === 1 ? { ...s, targetId: undefined } : s)) };
    expect(validateConfig(noPerson, d).errors[0]).toMatchObject({ stepIndex: 1, field: "target" });
    expect(validateConfig({ ...base("mirae"), repeatCount: 9 }, d).errors[0]).toMatchObject({ field: "repeat" });
    expect(validateConfig({ ...base("mirae"), steps: [] }, d).errors[0]!.message).toMatch(/at least one step/);
  });
  it("a Notify only person cannot be named in a step", () => {
    const c: PagingConfigInput = { ...base("mirae"), steps: [{ atMin: 0, targetType: "PERSON", targetId: "ct_seojun", channels: ["SMS"] }] };
    expect(validateConfig(c, dirOf("mirae")).errors[0]!.message).toMatch(/Seojun Bae is Notify only/);
  });
  it("at least one reachable target: only unverified contacts on every step blocks the save", () => {
    const c: PagingConfigInput = { style: "CUSTOM", plan: "URGENT", repeatCount: 1, steps: [{ atMin: 0, targetType: "PERSON", targetId: "ct_soyeon", channels: ["VOICE", "SMS"] }] };
    const v = validateConfig(c, dirOf("daon"));
    expect(v.errors.map((e) => e.message)).toEqual(["Nobody would be reached: no step has a person with a verified Slack, SMS, phone or email for the way it calls."]);
    expect(validateConfig(toInput(cfgOf("kumho").config!), dirOf("kumho")).errors[0]!.message).toMatch(/Nobody would be called/);
  });
  it("warns, without blocking, when one step targets only unverified contacts", () => {
    const c: PagingConfigInput = { style: "CUSTOM", plan: "URGENT", repeatCount: 1, steps: [
      { atMin: 0, targetType: "PERSON", targetId: "ct_soyeon", channels: ["VOICE"] }, { atMin: 5, targetType: "ALL_RESPONDERS", channels: ["VOICE"] }] };
    const v = validateConfig(c, dirOf("daon"));
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([{ stepIndex: 0, field: "target", message: "Step 1 reaches only contacts that are not verified for call: Soyeon Choi." }]);
    // Yuna's phone is verified for calls, not for SMS
    const sms: PagingConfigInput = { ...base("mirae"), steps: base("mirae").steps.map((s, n) => (n === 1 ? { ...s, channels: ["SMS"] } : s)) };
    expect(validateConfig(sms, dirOf("mirae")).warnings.map((w) => w.message)).toEqual(["Step 2 reaches only contacts that are not verified for SMS: Yuna Seo."]);
  });
  it("a rotation style needs a rotation step", () => {
    const c: PagingConfigInput = { style: "SHARED_ROTATION", plan: "STANDARD", repeatCount: 1, steps: [{ atMin: 0, targetType: "ALL_RESPONDERS", channels: ["VOICE"] }] };
    expect(validateConfig(c, dirOf("ara")).errors[0]).toMatchObject({ field: "style" });
  });
});

describe("paging health (D-32)", () => {
  const health = (slug: string) => computeHealth(cfgOf(slug).config!.steps, dirOf(slug), cfgOf(slug).extraProblems);
  it("the problem customers of the mockup", () => {
    expect(health("kumho")).toMatchObject({ level: "UNREACHABLE", problems: [{ code: "NO_PAGEABLE_RESPONDER" }] });
    const l = health("lumen");
    expect(l.level).toBe("AT_RISK");
    // step 1 is a post in the customer's Slack channel (connected): it is not a problem, and nobody is said to lack "Slack" (QA P3-H)
    expect(l.problems.map((p) => p.code)).toEqual(["STEP_UNVERIFIED_ONLY", "STEP_UNVERIFIED_ONLY", "ROTATION_GAP"]);
    expect(l.problems[0]!.message).toBe("Step 2 (SMS at 2 min) reaches only Kyungmin Oh, who has no verified SMS.");
    // … and it is one when the channel is not connected
    expect(computeHealth(cfgOf("lumen").config!.steps, { ...dirOf("lumen"), slackChannel: "NOT_SET" }).problems[0]!.message).toBe("Step 1 (Slack, first) reaches only Kyungmin Oh, who has no verified Slack.");
  });
  it("every other fixture customer is OK, so the tree keeps its five problem customers", async () => {
    const s34 = createStore({ customers: 34 });
    const bad = s34.customers.filter((c) => computeHealth(s34.paging.byCustomer[c.id]!.config!.steps, directoryOf(s34.paging, c), s34.paging.byCustomer[c.id]!.extraProblems).level !== "OK").map((c) => c.slug);
    expect(bad).toEqual(["kumho", "lumen"]);
    const t = (await createMockApi(createStore()).scopeTree()).customers;
    expect(t.filter((c) => c.callHealth !== "OK").map((c) => [c.slug, c.callHealth])).toEqual([["kumho", "UNREACHABLE"], ["lumen", "AT_RISK"]]);
    expect(t.flatMap((c) => c.projects.flatMap((p) => [p.ownSteps ? `${c.slug}/${p.slug}` : "", ...p.services.map((v) => (v.ownSteps ? `${c.slug}/${p.slug}/${v.slug}` : ""))])).filter(Boolean))
      .toEqual(["mirae/data-platform", "hanbit/fulfilment/orders-api"]);
  });
  it("no step reaches a verified contact → UNREACHABLE even with a pageable person", () => {
    const d = dirOf("daon");
    expect(computeHealth([{ atMin: 0, targetType: "PERSON", targetId: "ct_soyeon", channels: ["VOICE"] }], d)).toMatchObject({ level: "UNREACHABLE", problems: [{ code: "NO_VERIFIED_PHONE" }] });
  });
});

describe("plans, steps and diffs", () => {
  it("plan templates (DATA-MODEL): the last step goes to everyone; All at once leaves it out", () => {
    expect(planSteps("STANDARD", { targetType: "ROTATION", targetId: "rot_night" }).map((s) => [s.atMin, s.targetType, s.channels.join("+")])).toEqual(
      [[0, "ROTATION", "SLACK_CHANNEL"], [2, "ROTATION", "SMS"], [7, "ROTATION", "VOICE"], [12, "ALL_RESPONDERS", "VOICE"]]);
    expect(planSteps("STANDARD", { targetType: "ALL_RESPONDERS" }).map((s) => s.atMin)).toEqual([0, 2, 7]);
    expect(planSteps("URGENT", { targetType: "ROTATION", targetId: "r" }).map((s) => [s.atMin, s.targetType])).toEqual([[0, "ROTATION"], [5, "ALL_RESPONDERS"]]);
    expect(planSteps("QUIET", { targetType: "ALL_RESPONDERS" })).toEqual([{ atMin: 0, targetType: "ALL_RESPONDERS", channels: ["SLACK_CHANNEL"] }]);
  });
  it("firstOfStyle and isEdited", () => {
    expect(firstOfStyle("ALL_AT_ONCE", undefined, [])).toEqual({ targetType: "ALL_RESPONDERS" });
    expect(firstOfStyle("SHARED_ROTATION", undefined, [])).toBeNull();
    expect(firstOfStyle("SHARED_ROTATION", "rot_night", [])).toEqual({ targetType: "ROTATION", targetId: "rot_night" });
    expect(isEdited(toInput(cfgOf("hanbit").config!))).toBe(false);
    expect(isEdited(toInput(cfgOf("mirae").config!))).toBe(true);
  });
  it("add, remove and move keep the minutes in order", () => {
    const s = toInput(cfgOf("mirae").config!).steps;
    expect(addStep(s).map((x) => x.atMin)).toEqual([0, 10, 15, 20]);
    expect(removeStep(s, 0).map((x) => x.atMin)).toEqual([0, 15]);
    const moved = moveStep(s, 1, -1);
    expect(moved.map((x) => x.atMin)).toEqual([0, 10, 15]);
    expect(moved.map((x) => x.targetType)).toEqual(["PERSON", "ROTATION", "ALL_RESPONDERS"]);
    expect(moveStep(s, 0, -1)).toEqual(s);
  });
  it("diffConfig says what changed in words; sameConfig ignores channel order", () => {
    const a = toInput(cfgOf("mirae").config!);
    const b: PagingConfigInput = { ...a, repeatCount: 0, steps: a.steps.map((s, n) => (n === 1 ? { ...s, atMin: 8 } : s)).slice(0, 2) };
    expect(diffConfig(a, b, () => "x")).toEqual(["step 2 10 → 8 min", "step 3 removed", "repeat once → no repeat"]);
    expect(diffConfig(a, a, () => "x")).toEqual([]);
    expect(sameConfig(a, { ...a, steps: a.steps.map((s) => ({ ...s, channels: [...s.channels].reverse() })) })).toBe(true);
    expect(sameConfig(a, b)).toBe(false);
  });
});

describe("server action input checks", () => {
  it("scope: slugs only, a service needs a project", () => {
    expect(assertScope({ customer: "mirae", project: "core" })).toEqual({ customer: "mirae", project: "core", service: undefined });
    expect(() => assertScope({ customer: "../etc" })).toThrow();
    expect(() => assertScope({ customer: "mirae", service: "x" })).toThrow();
    expect(() => assertScope(null)).toThrow();
  });
  it("paging input: enums, whole minutes, known channels, ids", () => {
    const ok = toInput(cfgOf("mirae").config!);
    expect(assertPagingInput(ok)).toEqual(ok);
    expect(() => assertPagingInput({ ...ok, style: "NOPE" })).toThrow();
    expect(() => assertPagingInput({ ...ok, steps: [] })).toThrow();
    expect(() => assertPagingInput({ ...ok, steps: [{ atMin: 1.5, targetType: "ALL_RESPONDERS", channels: ["VOICE"] }] })).toThrow();
    expect(() => assertPagingInput({ ...ok, steps: [{ atMin: 0, targetType: "PERSON", targetId: "../x", channels: ["VOICE"] }] })).toThrow();
    expect(() => assertPagingInput({ ...ok, steps: [{ atMin: 0, targetType: "ALL_RESPONDERS", channels: ["FAX"] }] })).toThrow();
    expect(() => assertPagingInput({ ...ok, repeatCount: -1 })).toThrow();
  });
  it("add responder: an id, or a named person with a contact and a role", () => {
    expect(assertAddResponder({ contactId: "ct_jiwoo" })).toEqual({ contactId: "ct_jiwoo" });
    expect(assertAddResponder({ name: " Ari ", email: "a@x.example", role: "PAGEABLE" })).toEqual({ name: "Ari", email: "a@x.example", phone: undefined, role: "PAGEABLE" });
    expect(() => assertAddResponder({ name: "Ari", role: "PAGEABLE" })).toThrow(/email or a phone/);
    expect(() => assertAddResponder({ name: "Ari", email: "a@x.example", role: "OWNER" })).toThrow();
  });
});

describe("mock API contract semantics", () => {
  it("If-Match on save: a stale version is 409 VERSION_CONFLICT and nothing changes", async () => {
    const api = createMockApi(createStore());
    const c = (await api.scopeTree()).customers.find((x) => x.slug === "daon")!;
    const cur = await api.getPaging(c.id);
    const next = { ...toInput(cur), steps: cur.steps.map((s, n) => (n === 1 ? { ...s, atMin: 5 } : s)) };
    const saved = await api.putPaging(c.id, next, cur.version);
    expect(saved.version).toBe(cur.version + 1);
    expect(saved.edited).toBe(true);
    await expect(api.putPaging(c.id, toInput(cur), cur.version)).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect((await api.getPaging(c.id)).steps[1]!.atMin).toBe(5);
  });
  it("own steps: create (If-Match 0), 409 when they exist already, update with If-Match, delete → inherits again; the tree follows", async () => {
    const api = createMockApi(createStore());
    const c = (await api.scopeTree()).customers.find((x) => x.slug === "mirae")!;
    const svc = c.projects[0]!.services[2]!; // Core › Checkout
    const inh = await api.pagingPath({ customer: "mirae", project: "core", service: "checkout" });
    const body = toInput({ ...inh, style: inh.style!, plan: inh.plan! });
    const made = await api.putPagingOverride(c.id, "SERVICE", svc.id, body, 0);
    expect(made.version).toBe(1);
    await expect(api.putPagingOverride(c.id, "SERVICE", svc.id, body, 0)).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT", details: { currentVersion: 1 } });
    expect((await api.pagingPath({ customer: "mirae", project: "core", service: "checkout" })).own).toBe(true);
    expect((await api.scopeTree()).customers.find((x) => x.slug === "mirae")!.projects[0]!.services[2]!.ownSteps).toBe(true);
    expect((await api.callOrderList({ customer: "mirae" })).rows.map((r) => r.key)).toEqual(["mirae", "mirae/core/checkout", "mirae/data-platform"]);
    await expect(api.deletePagingOverride(c.id, "SERVICE", svc.id, 7)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await api.deletePagingOverride(c.id, "SERVICE", svc.id, made.version);
    expect((await api.pagingPath({ customer: "mirae", project: "core", service: "checkout" })).own).toBe(false);
  });
  it("the list: a row per customer and per own-steps level, problem customers first, plus the asked node", async () => {
    const api = createMockApi(createStore());
    const all = (await api.callOrderList()).rows;
    expect(all.slice(0, 2).map((r) => [r.key, r.health?.level])).toEqual([["kumho", "UNREACHABLE"], ["lumen", "AT_RISK"]]);
    expect(all.filter((r) => r.level !== "CUSTOMER").map((r) => r.key)).toEqual(["mirae/data-platform", "hanbit/fulfilment/orders-api"]);
    expect(all).toHaveLength(16);
    const asked = (await api.callOrderList({ customer: "mirae", project: "core", service: "checkout" })).rows;
    expect(asked.map((r) => [r.key, r.own])).toEqual([["mirae", true], ["mirae/core/checkout", false]]);
    expect(asked[1]!.inheritedFrom).toMatchObject({ level: "CUSTOMER" });
    expect((await api.callOrderList({ onlyProblems: true })).rows.filter((r) => r.level === "CUSTOMER").map((r) => r.key).sort()).toEqual(["daon", "hanbit", "kumho", "lumen", "mirae"]);
    expect((await api.callOrderList({ mine: true })).rows.filter((r) => r.level === "CUSTOMER")).toHaveLength(7);
    await expect(api.callOrderList({ customer: "no-such" })).rejects.toMatchObject({ status: 404 });
  });
  it("responders: masked contacts only, a named person cannot be removed or demoted, another customer's contact is refused", async () => {
    const api = createMockApi(createStore());
    const t = (await api.scopeTree()).customers;
    const mirae = t.find((x) => x.slug === "mirae")!.id, daon = t.find((x) => x.slug === "daon")!.id;
    const r = await api.getResponders(mirae);
    expect(r.staff.map((s) => [s.name, s.source])).toEqual([["Haeun Kim", "TEMPLATE"], ["Junho Park", "TEMPLATE"], ["Minjae Lee", "TEMPLATE"], ["Taemin Jung", "DIRECT"]]);
    // D-35: nothing that could be dialled or mailed leaves the API on this path
    for (const p of [...r.staff, ...r.people]) {
      if (p.emailMasked) expect(p.emailMasked).toMatch(/^.•••@/);
      if (p.phoneMasked) expect(p.phoneMasked).toMatch(/^010-••••-\d{4}$/);
    }
    expect(JSON.stringify(r)).not.toMatch(/\d{3}-\d{3,4}-\d{4}|"email"|"phone"/);
    expect(r.people.find((p) => p.name === "Yuna Seo")).toMatchObject({ role: "PAGEABLE", phoneMasked: expect.stringMatching(/^010-••••-\d{4}$/), emailMasked: "y•••@mirae.example" });
    const v = { version: r.version };
    await expect(api.removeResponder(mirae, "ct_yuna", v)).rejects.toMatchObject({ status: 409, code: "IN_USE" });
    await expect(api.patchResponder(mirae, "ct_yuna", { role: "NOTIFY_ONLY" }, v)).rejects.toMatchObject({ code: "IN_USE" });
    await expect(api.removeResponder(mirae, "ct_haeun", v)).rejects.toMatchObject({ code: "FROM_TEMPLATE" });
    // another customer's contact is the same 404 as an id that does not exist (security review 권고 3)
    const dv = { version: (await api.getResponders(daon)).version };
    const [other, none] = await Promise.all([api.addResponder(daon, { contactId: "ct_yuna" }, dv).catch((e) => e), api.addResponder(daon, { contactId: "ct_nobody" }, dv).catch((e) => e)]);
    expect([other.status, other.code, other.message]).toEqual([404, "NOT_FOUND", "Not found."]);
    expect([none.status, none.code, none.message]).toEqual([other.status, other.code, other.message]);
    await api.patchResponder(mirae, "ct_seojun", { role: "PAGEABLE" }, v);
    expect((await api.pagingPath({ customer: "mirae" })).steps[2]!.nowIds).toHaveLength(6);
    const added = await api.addResponder(daon, { name: "Ari Go", email: "ari@daon.example", phone: "010-1234-5678", role: "NOTIFY_ONLY" }, dv);
    const person = (await api.getResponders(daon)).people.find((p) => p.contactId === added.contactId)!;
    expect(person).toMatchObject({ name: "Ari Go", emailMasked: "a•••@daon.example", phoneMasked: "010-••••-5678" });
    expect(JSON.stringify(person)).not.toContain("1234");
    await api.removeResponder(daon, added.contactId, { version: added.version });
    expect((await api.getResponders(daon)).people.some((p) => p.contactId === added.contactId)).toBe(false);
  });
  it("a step may not name a contact or a rotation of another customer", async () => {
    const api = createMockApi(createStore());
    const daon = (await api.scopeTree()).customers.find((x) => x.slug === "daon")!.id;
    const cur = await api.getPaging(daon);
    await expect(api.putPaging(daon, { ...toInput(cur), steps: [{ atMin: 0, targetType: "PERSON", targetId: "ct_yuna", channels: ["VOICE"] }] }, cur.version)).rejects.toMatchObject({ status: 422, code: "CROSS_CUSTOMER" });
    await expect(api.putPaging(daon, { ...toInput(cur), steps: [{ atMin: 0, targetType: "ROTATION", targetId: "rot_hanbit", channels: ["VOICE"] }] }, cur.version)).rejects.toMatchObject({ code: "CROSS_CUSTOMER" });
    await expect(api.putPaging(daon, { ...toInput(cur), steps: [{ atMin: 0, targetType: "ALL_RESPONDERS", channels: ["VOICE"] }, { atMin: 0, targetType: "ALL_RESPONDERS", channels: ["VOICE"] }] }, cur.version)).rejects.toMatchObject({ status: 400 });
  });
});
