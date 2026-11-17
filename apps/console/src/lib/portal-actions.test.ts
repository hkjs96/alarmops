/** A portal (customer) user only reads: every write server action refuses them before the API is touched, whatever role is stored for them. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleApi } from "./api/client";
import { MOCK_USERS, createMockApi, createStore } from "./api/mock/mock-api";

const state = vi.hoisted(() => ({ sub: "usr-portal" as string, api: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireSession: async () => ({ sub: state.sub, email: "", name: "", exp: 0, token: "t" }) }));
vi.mock("@/lib/api", () => ({ getApi: async () => state.api }));

import { addResponder, removeOwnSteps, removeResponder, saveCallOrder, setResponderRole } from "@/app/call-order/actions";
import { ackIncident, escalateIncident, executeBulk, previewBulk, resolveIncident, undoBulk } from "@/app/incidents/actions";
import { changeCustomerStatus, markOffboardingStep, setLegalHold } from "@/app/customers/actions";

const ro = { ok: false, code: "READ_ONLY", message: "This is a read-only view. Nothing was changed.", requestId: "" };
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  const api = createMockApi(createStore(), undefined, MOCK_USERS["usr-portal"]!) as unknown as Record<string, (...a: unknown[]) => unknown>;
  // every call except GET /me is noted; the guard may only ask who the user is
  state.api = new Proxy(api, { get: (t, k: string) => (k === "me" || k === "then" ? t[k] : (...a: unknown[]) => { calls.push(k); return t[k]!(...a); }) }) as unknown as ConsoleApi;
});

describe("portal user: write actions are refused server-side", () => {
  it("incident actions", async () => {
    for (const send of [
      () => ackIncident("inc-1", 1), () => escalateIncident("inc-1", 1), () => resolveIncident("inc-1", 1),
      () => previewBulk("ack", [{ id: "inc-1", version: 1 }]), () => executeBulk("ack", [{ id: "inc-1", version: 1 }]), () => undoBulk("undo_1"),
    ]) expect(await send()).toEqual(ro);
    expect(calls).toEqual([]);
  });
  it("call order and Responders actions", async () => {
    const body = { style: "CUSTOM", plan: "STANDARD", repeatCount: 0, steps: [] };
    for (const send of [
      () => saveCallOrder({ customer: "mirae" }, body, 1), () => removeOwnSteps({ customer: "mirae", project: "core" }, 1),
      () => addResponder("mirae", { name: "X Y", role: "NOTIFY_ONLY" }, 1), () => setResponderRole("mirae", "ct_yuna", "NOTIFY_ONLY", 1), () => removeResponder("mirae", "ct_yuna", 1),
    ]) expect(await send()).toEqual(ro);
    expect(calls).toEqual([]);
  });
  it("customer status, legal hold, offboarding actions", async () => {
    for (const send of [
      () => changeCustomerStatus("cus_mirae", { status: "SUSPENDED", reason: "x" }, 1), () => setLegalHold("cus_mirae", true, "x"), () => markOffboardingStep("cus_mirae", "ALARMS_DELETED", "x"),
    ]) expect(await send()).toEqual(ro);
    expect(calls).toEqual([]);
  });
});
