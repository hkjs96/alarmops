/**
 * D-43 customer status and offboarding: the mock answers like packages/api/src/customerApi.ts, and the server actions
 * are for admins only (the same replay as action-roles.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ConsoleApi } from "./api/client";
import { MOCK_USERS, createMockApi, createStore } from "./api/mock/mock-api";

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

import { changeCustomerStatus, markOffboardingStep } from "@/app/customers/actions";

let store: ReturnType<typeof createStore>;
let admin: ConsoleApi;
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? `${e.status} ${e.code}` : String(e); } };

beforeEach(() => {
  store = createStore();
  admin = createMockApi(store, undefined, MOCK_USERS["usr-haeun"]!);
  state.sub = "usr-haeun";
  state.api = (sub: string) => createMockApi(store, undefined, MOCK_USERS[sub]!);
});

describe("mock: PATCH /customers/{id}/status", () => {
  it("suspend then resume, each change moves the version by one", async () => {
    const s0 = await admin.getCustomerStatus("cus_gaon");
    expect(s0).toMatchObject({ status: "ACTIVE", statusChangedAt: null, version: 0 });
    const s1 = await admin.patchCustomerStatus("cus_gaon", { status: "SUSPENDED", reason: "Invoice overdue" }, 0);
    expect(s1).toMatchObject({ status: "SUSPENDED", version: 1 });
    expect(s1.statusChangedAt).toEqual(expect.any(String));
    expect((await admin.scopeTree()).customers.find((c) => c.id === "cus_gaon")!.status).toBe("SUSPENDED");
    expect(await admin.patchCustomerStatus("cus_gaon", { status: "ACTIVE", reason: "Paid" }, 1)).toMatchObject({ status: "ACTIVE", version: 2 });
  });
  it("needs a reason, and for TERMINATED the exact name (400 on the field)", async () => {
    const e1 = await admin.patchCustomerStatus("cus_gaon", { status: "SUSPENDED", reason: "  " }, 0).catch((e: ApiError) => e);
    expect((e1 as ApiError).details).toEqual({ fields: [{ field: "reason", message: expect.any(String) }] });
    const e2 = await admin.patchCustomerStatus("cus_gaon", { status: "TERMINATED", reason: "Contract ended", confirmName: "gaon energy" }, 0).catch((e: ApiError) => e);
    expect([(e2 as ApiError).status, (e2 as ApiError).details]).toEqual([400, { fields: [{ field: "confirmName", message: expect.any(String) }] }]);
    expect((await admin.getCustomerStatus("cus_gaon")).status).toBe("ACTIVE");
  });
  it("a stale version is 409 VERSION_CONFLICT; a terminated customer cannot change (409 CUSTOMER_TERMINATED)", async () => {
    expect(await code(admin.patchCustomerStatus("cus_gaon", { status: "SUSPENDED", reason: "x" }, 5))).toBe("409 VERSION_CONFLICT");
    expect(await code(admin.patchCustomerStatus("cus_iruda", { status: "ACTIVE", reason: "x" }, 1))).toBe("409 CUSTOMER_TERMINATED");
  });
  it("terminating creates the checklist (paging stopped, alarms pending, three manual); a missing command queue is 503 and changes nothing", async () => {
    expect(await code(admin.patchCustomerStatus("cus_dasol", { status: "TERMINATED", reason: "Ended", confirmName: "Dasol Health" }, 0))).toBe("503 COMMANDS_UNAVAILABLE");
    expect(await admin.getCustomerStatus("cus_dasol")).toMatchObject({ status: "ACTIVE", version: 0 });
    expect(await code(admin.getOffboarding("cus_dasol"))).toBe("404 NOT_FOUND");
    const r = await admin.patchCustomerStatus("cus_haneul", { status: "TERMINATED", reason: "Ended", confirmName: "Haneul Air" }, 0);
    expect(r).toMatchObject({ status: "TERMINATED", offboardingId: expect.any(String) });
    expect((await admin.getOffboarding("cus_haneul")).steps.map((s) => `${s.key}:${s.state}`)).toEqual([
      "PAGING_STOPPED:DONE", "ALARMS_DELETED:PENDING", "CUSTOMER_STACK_REMOVED:MANUAL", "ACCOUNTS_DISABLED:MANUAL", "BUS_ALLOWLIST_REMOVED:MANUAL",
    ]);
  });
  it("incidents opened for a customer that is suspended stay marked after it returns", async () => {
    const open = (await admin.listIncidents({ customer: "hanbit" })).items;
    expect(open.every((i) => !i.pagingSuppressed)).toBe(true);
    await admin.patchCustomerStatus("cus_hanbit", { status: "SUSPENDED", reason: "x" }, 0);
    await admin.patchCustomerStatus("cus_hanbit", { status: "ACTIVE", reason: "y" }, 1);
    expect((await admin.listIncidents({ customer: "hanbit" })).items.every((i) => i.pagingSuppressed === "CUSTOMER_SUSPENDED")).toBe(true);
  });
});

describe("mock: PATCH /customers/{id}/offboarding", () => {
  it("ALARMS_DELETED needs a note when MANUAL (400) and is refused when PENDING (409 STEP_NOT_MANUAL); DONE is not overwritten", async () => {
    expect(await code(admin.markOffboardStep("cus_iruda", { key: "ALARMS_DELETED", state: "DONE" }))).toBe("400 VALIDATION_FAILED");
    const done = await admin.markOffboardStep("cus_iruda", { key: "ALARMS_DELETED", state: "DONE", detail: "Checked the console of account 4812…, no ManagedBy=AlarmOps alarms left." });
    expect(done.steps.find((s) => s.key === "ALARMS_DELETED")).toMatchObject({ state: "DONE", detail: expect.stringContaining("Checked") });
    const again = await admin.markOffboardStep("cus_iruda", { key: "ALARMS_DELETED", state: "DONE", detail: "other" });
    expect(again.steps.find((s) => s.key === "ALARMS_DELETED")!.detail).toContain("Checked");
    await admin.patchCustomerStatus("cus_haneul", { status: "TERMINATED", reason: "Ended", confirmName: "Haneul Air" }, 0);
    expect(await code(admin.markOffboardStep("cus_haneul", { key: "ALARMS_DELETED", state: "DONE", detail: "x" }))).toBe("409 STEP_NOT_MANUAL");
  });
  it("status and offboarding are for admins: 403 ROLE_REQUIRED for the others", async () => {
    for (const u of ["usr-minjae", "usr-sora"]) {
      const api = createMockApi(store, undefined, MOCK_USERS[u]!);
      expect(await code(api.getCustomerStatus("cus_gaon"))).toBe("403 ROLE_REQUIRED");
      expect(await code(api.patchCustomerStatus("cus_gaon", { status: "SUSPENDED", reason: "x" }, 0))).toBe("403 ROLE_REQUIRED");
      expect(await code(api.getOffboarding("cus_iruda"))).toBe("403 ROLE_REQUIRED");
    }
  });
});

describe("server actions: admins only, before the API is touched", () => {
  it.each(["usr-minjae", "usr-sora"])("%s is refused and nothing changes", async (sub) => {
    state.sub = sub;
    const input = { status: "SUSPENDED" as const, reason: "x" };
    expect(await changeCustomerStatus("cus_gaon", input, 0)).toMatchObject({ ok: false, code: "ROLE_REQUIRED" });
    expect(await markOffboardingStep("cus_iruda", "CUSTOMER_STACK_REMOVED")).toMatchObject({ ok: false, code: "ROLE_REQUIRED" });
    expect((await admin.getCustomerStatus("cus_gaon")).version).toBe(0);
    expect((await admin.getOffboarding("cus_iruda")).steps.find((s) => s.key === "CUSTOMER_STACK_REMOVED")!.state).toBe("MANUAL");
  });
  it("no session is UNAUTHORIZED; bad input is INVALID_INPUT; an admin's change goes through", async () => {
    state.sub = null;
    expect(await changeCustomerStatus("cus_gaon", { status: "SUSPENDED", reason: "x" }, 0)).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    state.sub = "usr-haeun";
    expect(await changeCustomerStatus("cus_gaon", { status: "GONE" as never, reason: "x" }, 0)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await changeCustomerStatus("../x", { status: "SUSPENDED", reason: "x" }, 0)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await changeCustomerStatus("cus_gaon", { status: "SUSPENDED", reason: "x" }, 0)).toMatchObject({ ok: true, data: { status: "SUSPENDED", version: 1 } });
    expect(await changeCustomerStatus("cus_dasol", { status: "TERMINATED", reason: "x", confirmName: "Dasol Health" }, 0)).toMatchObject({ ok: false, code: "COMMANDS_UNAVAILABLE" });
  });
});
