/**
 * security 재검토 권고 2: the server actions check the role of the session's user before the API is asked to change
 * anything. Each test sends an action as an admin, then sends the very same call again under an operator's and a
 * viewer's session — the replay the reviewer did against the running console — and looks at what reached the API.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleApi } from "./api/client";
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

import { addResponder, removeOwnSteps, removeResponder, saveCallOrder, setResponderRole } from "@/app/call-order/actions";
import { ackIncident, escalateIncident, executeBulk, previewBulk, resolveIncident, undoBulk } from "@/app/incidents/actions";

const WRITES = ["putPaging", "putPagingOverride", "deletePagingOverride", "addResponder", "patchResponder", "removeResponder", "ack", "resolve", "escalate", "bulkPreview", "bulkExecute", "bulkUndo"] as const;
const READS = ["scopeTree", "getResponders", "listRotations", "listStaff"] as const;
let calls: string[] = [];
let store: ReturnType<typeof createStore>;
const as = (who: "admin" | "operator" | "viewer" | "nobody") => { state.sub = { admin: "usr-haeun", operator: "usr-minjae", viewer: "usr-sora", nobody: null }[who]; };

beforeEach(() => {
  calls = [];
  store = createStore();
  // the mock API answers as the session's user, like the real one reads the token; every call that reaches it is noted
  state.api = (sub: string) => {
    const api = createMockApi(store, undefined, MOCK_USERS[sub]!) as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of [...WRITES, ...READS]) { const real = api[m]!.bind(api); api[m] = (...a: unknown[]) => { calls.push(m); return real(...a); }; }
    return api as unknown as ConsoleApi;
  };
  as("admin");
});

const responders = async () => { as("admin"); const api = (state.api as (s: string) => ConsoleApi)("usr-haeun"); const c = (await api.scopeTree()).customers.find((x) => x.slug === "hanbit")!; return api.getResponders(c.id); };
const refused = { ok: false, code: "ROLE_REQUIRED", message: "This action needs the ADMIN role.", requestId: "", details: { role: "ADMIN" } };

describe("call order and Responders writes are for admins", () => {
  it("the roles the fixtures sign in as", () => {
    expect([MOCK_USERS["usr-haeun"]!.role, MOCK_USERS["usr-minjae"]!.role, MOCK_USERS["usr-sora"]!.role]).toEqual(["ADMIN", "OPERATOR", "VIEWER"]);
  });

  it.each(["operator", "viewer"] as const)("an admin's Responders requests replayed under a %s session are refused before the API is touched", async (who) => {
    const before = await responders();
    const person = before.people.find((p) => p.role === "PAGEABLE") ?? before.people[0]!;
    const staff = before.staff.find((p) => p.source === "DIRECT")!;
    const requests = [
      () => setResponderRole("hanbit", person.contactId, person.role === "PAGEABLE" ? "NOTIFY_ONLY" : "PAGEABLE", before.version, true),
      () => removeResponder("hanbit", staff.contactId, before.version, true),
      () => addResponder("hanbit", { name: "New Person", email: "new.person@example.com", phone: "", role: "NOTIFY_ONLY" }, before.version),
    ];
    as(who);
    calls = [];
    for (const send of requests) expect(await send()).toEqual(refused);
    // nothing reached the API: not the write, and not the lookups that would tell whether the customer or the person exists
    expect(calls).toEqual([]);
    expect(await responders()).toEqual(before);
    // the same requests, sent by the admin they came from, go through
    as("admin");
    calls = [];
    expect(await requests[2]!()).toMatchObject({ ok: true });
    expect(calls).toContain("addResponder");
    expect((await responders()).people.map((p) => p.name)).toContain("New Person");
  });

  it.each(["operator", "viewer"] as const)("saving and removing steps under a %s session is refused the same way — also for a customer that does not exist", async (who) => {
    as(who);
    const body = { style: "CUSTOM", plan: "STANDARD", repeatCount: 0, steps: [] };
    expect(await saveCallOrder({ customer: "hanbit" }, body, 1)).toEqual(refused);
    expect(await removeOwnSteps({ customer: "hanbit", project: "fulfilment", service: "orders-api" }, 1)).toEqual(refused);
    // role before anything else: a made-up customer and a malformed body get the same answer as a real one
    expect(await saveCallOrder({ customer: "no-such-customer" }, body, 1)).toEqual(refused);
    expect(await removeResponder("no-such-customer", "con-nobody", 1)).toEqual(refused);
    expect(await setResponderRole("hanbit", "not an id", "ADMIN", -1)).toEqual(refused);
    expect(calls).toEqual([]);
  });

  it("without a session nothing is asked at all", async () => {
    as("nobody");
    expect(await removeResponder("hanbit", "con-x", 1)).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(await ackIncident("inc_1", 1)).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(calls).toEqual([]);
  });
});

describe("acknowledge, escalate, resolve are for operators and admins", () => {
  const need = { ok: false, code: "ROLE_REQUIRED", message: "This action needs the OPERATOR role.", requestId: "", details: { role: "OPERATOR" } };
  const open = () => store.incidents.find((i) => i.status === "TRIGGERED")!;

  it("an operator's requests replayed under a viewer session are refused before the API is touched", async () => {
    const i = open();
    const requests = [
      () => ackIncident(i.id, i.version), () => escalateIncident(i.id, i.version), () => resolveIncident(i.id, i.version),
      () => previewBulk("ack", [{ id: i.id, version: i.version }]), () => executeBulk("ack", [{ id: i.id, version: i.version }]), () => undoBulk("undo_1"),
    ];
    as("viewer");
    for (const send of requests) expect(await send()).toEqual(need);
    expect(calls).toEqual([]);
    expect(open().id).toBe(i.id);
    expect(i.status).toBe("TRIGGERED");
  });

  it.each(["operator", "admin"] as const)("%s acknowledges", async (who) => {
    const i = open();
    as(who);
    const r = await ackIncident(i.id, i.version);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["ack"]);
    expect(i.status).toBe("ACKNOWLEDGED");
  });

  it("if GET /me cannot be read, nothing is let through", async () => {
    const real = state.api as (s: string) => ConsoleApi;
    state.api = (sub: string) => Object.assign(real(sub), { me: async () => { throw new Error("down"); } });
    const i = open();
    expect(await ackIncident(i.id, i.version)).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(calls).toEqual([]);
  });
});
