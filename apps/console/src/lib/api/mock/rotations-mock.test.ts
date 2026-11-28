/**
 * The mock of the rotation API has the rules of packages/api (API-CONTRACT §8.3 `/rotations`, D-41, D-64): usage from the call orders,
 * the preview and its hash, PATCH's checks in their order (version before hash), DELETE's IN_USE, POST's validation, the roles, and
 * 503 BUSY. The e2e specs and the persona checks run on it, so these are the rules they rely on.
 *
 * Expected values are taken from the contract and the fixtures' own data (paging.byCustomer), not from what the mock answers.
 *
 * Assumed names (ConsoleApi, like the template ones): listRotations (members, version, handover, cadence, next, onShift),
 * getRotationUsage(id), getRotationShifts(id), createRotation(body), previewRotation(id, change),
 * saveRotation(id, change, { version, previewHash }), deleteRotation(id, { version }); callOrderList().rotations; `busyWrites` and the
 * hook that puts an Override request in after the first preview are on `store.rotationHooks`. The e2e variant (E2E_FIXTURE=blocked-saves)
 * adds the rotations "Stale desk" (its first preview is followed by a pending Override request), "Busy desk" and "Spare desk" (rot_e2e_spare).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ConsoleApi } from "../client";
import type { RotationSummary } from "../types";
import { MOCK_USERS, createMockApi, createStore } from "./mock-api";

type Store = ReturnType<typeof createStore>;
const as = (store: Store, who: keyof typeof MOCK_USERS = "usr-haeun"): ConsoleApi => createMockApi(store, undefined, MOCK_USERS[who]!);
const refusal = async (p: Promise<unknown>): Promise<{ status: number; code: string; details: Record<string, unknown> }> => {
  try { await p; } catch (e) { if (e instanceof ApiError) return { status: e.status, code: e.code, details: e.details }; throw e; }
  throw new Error("expected a refusal");
};
const rot = async (api: ConsoleApi, id: string): Promise<RotationSummary> => (await api.listRotations()).find((r) => r.id === id)!;
const byName = async (api: ConsoleApi, name: string): Promise<RotationSummary> => (await api.listRotations()).find((r) => r.name === name)!;
const ids = (r: RotationSummary) => r.members.map((m) => m.contactId);
const swap23 = (r: RotationSummary) => { const m = ids(r); return [m[0]!, m[2]!, m[1]!, ...m.slice(3)]; };
const HASH = "0".repeat(64);
const hooks = (store: Store) => (store as unknown as { rotationHooks: { busyWrites: number } }).rotationHooks;
const terminate = (store: Store, slug: string) => { store.customerStatus.status[`cus_${slug}`] = { status: "TERMINATED", changedAt: "2026-11-06T02:30:00Z", version: 1 }; };
const variantStore = () => { vi.stubEnv("E2E_FIXTURE", "blocked-saves"); return createStore(); };
afterEach(() => { vi.unstubAllEnvs(); });

/** what the call orders say, read from the fixture data: customer id → [level, scopeId, stepIndex(1-based)][] */
function expectedUsage(store: Store, rotationId: string) {
  const out = new Map<string, { level: string; scopeId: string; stepIndex: number }[]>();
  for (const [cid, p] of Object.entries(store.paging.byCustomer)) {
    for (const cfg of [...(p.config ? [p.config] : []), ...p.overrides]) {
      cfg.steps.forEach((s, n) => {
        if (s.targetType === "ROTATION" && s.targetId === rotationId) out.set(cid, [...(out.get(cid) ?? []), { level: cfg.scopeType, scopeId: cfg.scopeId, stepIndex: n + 1 }]);
      });
    }
  }
  return out;
}

describe("usage: who refers to a rotation (GET /rotations/{id}/usage)", () => {
  it("is read from paging.byCustomer: config steps and PROJECT / SERVICE override steps (34 customers)", async () => {
    const store = createStore({ customers: 34 });
    const api = as(store);
    for (const id of ["rot_night", "rot_data"]) {
      const u = await api.getRotationUsage(id);
      const want = expectedUsage(store, id);
      expect(u.rotationId).toBe(id);
      expect(u.customers.map((c) => c.id).sort()).toEqual([...want.keys()].sort());
      for (const c of u.customers) {
        const key = (x: { scopeId: string; stepIndex: number }) => `${x.scopeId}#${x.stepIndex}`;
        const got = c.steps.map((s) => ({ level: s.level, scopeId: s.scopeId, stepIndex: s.stepIndex })).sort((a, b) => key(a).localeCompare(key(b)));
        expect(got, c.id).toEqual([...want.get(c.id)!].sort((a, b) => key(a).localeCompare(key(b))));
        expect(c.steps.every((s) => s.shared === true)).toBe(true);
        expect(c.slug).toBe(c.id.replace(/^cus_/, ""));
      }
    }
    expect(store.customers).toHaveLength(34);
  });

  it("rot_night: ara, bora, dasol, gaon, haneul on their call order, and mirae on step 1", async () => {
    const u = await as(createStore({ customers: 34 })).getRotationUsage("rot_night");
    const slugs = u.customers.map((c) => c.slug);
    for (const s of ["ara", "bora", "dasol", "gaon", "haneul", "mirae"]) expect(slugs, s).toContain(s);
    expect(u.customers.find((c) => c.slug === "mirae")!.steps).toEqual([expect.objectContaining({ level: "CUSTOMER", stepIndex: 1 })]);
    expect(slugs).not.toContain("hanbit");
  });

  it("rot_data: mirae's Data platform PROJECT override step is there", async () => {
    const store = createStore({ customers: 34 });
    const u = await as(store).getRotationUsage("rot_data");
    const mirae = store.customers.find((c) => c.slug === "mirae")!;
    const project = mirae.projects.find((p) => p.slug === "data-platform")!;
    expect(u.customers.find((c) => c.slug === "mirae")!.steps).toContainEqual(expect.objectContaining({ level: "PROJECT", scopeId: project.id, stepIndex: 1 }));
  });

  it("a terminated customer is in the usage, with its status", async () => {
    const store = createStore({ customers: 34 });
    terminate(store, "ara");
    const u = await as(store).getRotationUsage("rot_night");
    expect(u.customers.find((c) => c.slug === "ara")).toMatchObject({ status: "TERMINATED" });
    expect(u.customers.find((c) => c.slug === "bora")).toMatchObject({ status: "ACTIVE" });
  });
});

describe("preview: customers are the usage customers that are not terminated", () => {
  it("the same list as usage minus TERMINATED, and the totals count them", async () => {
    const store = createStore({ customers: 34 });
    terminate(store, "ara");
    const api = as(store);
    const night = await rot(api, "rot_night");
    const usage = await api.getRotationUsage("rot_night");
    const p = await api.previewRotation("rot_night", { members: swap23(night) });
    const live = usage.customers.filter((c) => c.status !== "TERMINATED");
    expect(p.customers.map((c) => c.id).sort()).toEqual(live.map((c) => c.id).sort());
    expect(p.customers.map((c) => c.id)).not.toContain("cus_ara");
    expect(p.totals.customers).toBe(live.length);
  });
  it("every rotation with a terminated customer in its usage leaves that customer out", async () => {
    const store = createStore({ customers: 34 });
    terminate(store, "ara"); terminate(store, "mirae");
    const api = as(store);
    for (const r of (await api.listRotations({ scope: "MSP" }))) {
      const usage = await api.getRotationUsage(r.id);
      const gone = usage.customers.filter((c) => c.status === "TERMINATED").map((c) => c.id);
      const p = await api.previewRotation(r.id, { members: swap23(r) });
      for (const g of gone) expect(p.customers.map((c) => c.id), `${r.id} / ${g}`).not.toContain(g);
    }
  });
  it("the shape: rows with before/after/kept/changed, nextShift, previewHash (64 hex); swapping 2 and 3 keeps the shift now", async () => {
    const api = as(createStore());
    const night = await rot(api, "rot_night");
    const p = await api.previewRotation("rot_night", { members: swap23(night) });
    expect(p.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.version).toBe(night.version);
    expect(p.rows).toHaveLength(8);
    expect(p.rows[0]).toMatchObject({ kept: true });
    expect(p.nextShift).toEqual({ before: "Junho Park", after: "Jiwoo Han" });
  });
});

describe("save: one truth in listRotations and /oncall/now", () => {
  it("both answer the same members, version and next after a save; onShift is not changed", async () => {
    const store = createStore();
    const api = as(store);
    const before = await rot(api, "rot_night");
    const p = await api.previewRotation("rot_night", { members: swap23(before) });
    const saved = await api.saveRotation("rot_night", { members: swap23(before) }, { version: before.version, previewHash: p.previewHash });
    expect(saved.version).toBe(before.version + 1);
    const a = await rot(api, "rot_night");
    const b = (await api.callOrderList()).rotations.find((r) => r.id === "rot_night")!;
    expect(ids(a)).toEqual(swap23(before));
    for (const r of [a, b]) {
      expect([ids(r), r.version, r.next]).toEqual([swap23(before), before.version + 1, "Jiwoo Han"]);
      expect(r.onShift).toEqual(before.onShift);
    }
    expect(a).toEqual(b);
  });
});

describe("PATCH: the checks, in order", () => {
  it("a different version is 409 VERSION_CONFLICT with currentVersion, even when the hash is wrong too, and nothing changes", async () => {
    const api = as(createStore());
    const before = await rot(api, "rot_night");
    const e = await refusal(api.saveRotation("rot_night", { members: swap23(before) }, { version: before.version + 5, previewHash: HASH }));
    expect([e.status, e.code, e.details.currentVersion]).toEqual([409, "VERSION_CONFLICT", before.version]);
    expect(await rot(api, "rot_night")).toEqual(before);
  });

  it("PREVIEW_STALE only with the same version and a request for cover that came after the preview; nothing changes; a new preview's hash saves", async () => {
    const store = variantStore();
    const api = as(store);
    const stale = await byName(api, "Stale desk");
    const first = await api.previewRotation(stale.id, { members: swap23(stale) });
    // the request for cover came in after the preview: the mock's hook (rotationHooks afterFirstPreview Override) did it
    const e = await refusal(api.saveRotation(stale.id, { members: swap23(stale) }, { version: stale.version, previewHash: first.previewHash }));
    expect([e.status, e.code]).toEqual([409, "PREVIEW_STALE"]);
    expect(e.details.currentVersion).toBe(stale.version);
    const after = await rot(api, stale.id);
    expect([after.version, ids(after)]).toEqual([stale.version, ids(stale)]);
    // looked at again, the hash is the new one and the save is 200
    const again = await api.previewRotation(stale.id, { members: swap23(stale) });
    expect(again.previewHash).not.toBe(first.previewHash);
    const ok = await api.saveRotation(stale.id, { members: swap23(stale) }, { version: stale.version, previewHash: again.previewHash });
    expect(ok.version).toBe(stale.version + 1);
  });

  it("a rotation without that hook never answers PREVIEW_STALE for the same version", async () => {
    const api = as(createStore());
    const night = await rot(api, "rot_night");
    const p = await api.previewRotation("rot_night", { members: swap23(night) });
    expect((await api.saveRotation("rot_night", { members: swap23(night) }, { version: night.version, previewHash: p.previewHash })).version).toBe(night.version + 1);
  });

  it("another cadence or an unknown key is 400 VALIDATION_FAILED", async () => {
    const api = as(createStore());
    const night = await rot(api, "rot_night");
    const p = await api.previewRotation("rot_night", { members: swap23(night) });
    for (const body of [{ cadence: night.cadence === "DAILY" ? "WEEKLY" : "DAILY" }, { color: "red" }, { scope: "CUSTOMER" }, { customerId: "cus_mirae" }]) {
      const e = await refusal(api.saveRotation("rot_night", body as never, { version: night.version, previewHash: p.previewHash }));
      expect([e.status, e.code], JSON.stringify(body)).toEqual([400, "VALIDATION_FAILED"]);
    }
    expect(await rot(api, "rot_night")).toEqual(night);
  });

  it("an MSP rotation's members or handover without a previewHash is 400", async () => {
    const api = as(createStore());
    const night = await rot(api, "rot_night");
    for (const body of [{ members: swap23(night) }, { handover: { minute: night.handover.minute + 60 } }]) {
      const e = await refusal(api.saveRotation("rot_night", body, { version: night.version }));
      expect([e.status, e.code], JSON.stringify(body)).toEqual([400, "VALIDATION_FAILED"]);
    }
    expect(await rot(api, "rot_night")).toEqual(night);
  });
});

describe("503 BUSY (busyWrites)", () => {
  it("busyWrites 1: the call inside the mock is sent again and succeeds", async () => {
    const store = createStore();
    const api = as(store);
    const night = await rot(api, "rot_night");
    const p = await api.previewRotation("rot_night", { members: swap23(night) });
    hooks(store).busyWrites = 1;
    const r = await api.saveRotation("rot_night", { members: swap23(night) }, { version: night.version, previewHash: p.previewHash });
    expect(r.version).toBe(night.version + 1);
    expect(hooks(store).busyWrites).toBe(0);
  });
  it("busyWrites 2: the first call is 503 BUSY and changes nothing, the second succeeds", async () => {
    const store = createStore();
    const api = as(store);
    const night = await rot(api, "rot_night");
    const p = await api.previewRotation("rot_night", { members: swap23(night) });
    hooks(store).busyWrites = 2;
    const e = await refusal(api.saveRotation("rot_night", { members: swap23(night) }, { version: night.version, previewHash: p.previewHash }));
    expect([e.status, e.code]).toEqual([503, "BUSY"]);
    expect((await rot(api, "rot_night")).version).toBe(night.version);
    expect(ids(await rot(api, "rot_night"))).toEqual(ids(night));
    const r = await api.saveRotation("rot_night", { members: swap23(night) }, { version: night.version, previewHash: p.previewHash });
    expect(r.version).toBe(night.version + 1);
  });
});

describe("DELETE", () => {
  it("a rotation a call order uses is 409 IN_USE; details.usage is the GET usage; nothing is deleted", async () => {
    const api = as(createStore());
    const night = await rot(api, "rot_night");
    const e = await refusal(api.deleteRotation("rot_night", { version: night.version }));
    expect([e.status, e.code]).toEqual([409, "IN_USE"]);
    expect(e.details.usage).toEqual(await api.getRotationUsage("rot_night"));
    expect(await rot(api, "rot_night")).toEqual(night);
  });
  it("rot_e2e_spare (nobody uses it) is deleted: 200 {id, deleted: true}, and gone from the list", async () => {
    const api = as(variantStore());
    const spare = await rot(api, "rot_e2e_spare");
    expect(spare.name).toBe("Spare desk");
    expect(await api.deleteRotation("rot_e2e_spare", { version: spare.version })).toEqual({ id: "rot_e2e_spare", deleted: true });
    expect((await api.listRotations()).map((r) => r.id)).not.toContain("rot_e2e_spare");
    expect((await refusal(api.getRotationUsage("rot_e2e_spare"))).status).toBe(404);
  });
});

describe("POST", () => {
  const body = (o: Record<string, unknown> = {}) => ({ scope: "MSP" as const, name: "E2E desk", cadence: "DAILY" as const, handover: { minute: 540 }, members: ["ct_haeun", "ct_junho"], ...o });
  const create = (api: ConsoleApi, o?: Record<string, unknown>) => api.createRotation(body(o) as never);

  it("creates: version 0, the first member on shift", async () => {
    const api = as(createStore());
    const r = await create(api, { name: "  E2E desk " });
    expect(r).toMatchObject({ name: "E2E desk", scope: "MSP", cadence: "DAILY", version: 0 });
    expect(ids(r)).toEqual(["ct_haeun", "ct_junho"]);
    expect(r.onShift!.contactId).toBe("ct_haeun");
    expect((await api.listRotations()).map((x) => x.name)).toContain("E2E desk");
  });
  it("the same name is 409 ALREADY_EXISTS", async () => {
    const api = as(createStore());
    await create(api);
    expect((await refusal(create(api))).code).toBe("ALREADY_EXISTS");
    expect((await refusal(create(api, { name: "MSP night desk" }))).code).toBe("ALREADY_EXISTS");
  });
  it("an MSP rotation never answers CUSTOMER_TERMINATED, whatever customerId it is given", async () => {
    const api = as(createStore());
    const e = await refusal(create(api, { customerId: "cus_iruda" }));
    expect(e.code).not.toBe("CUSTOMER_TERMINATED");
    expect([e.status, e.code]).toEqual([400, "VALIDATION_FAILED"]);
  });
  it("0 members, 51 members, a repeat, an inactive person, DAILY with a weekday: 400 VALIDATION_FAILED", async () => {
    const store = createStore();
    store.paging.contacts["ct_taemin"]!.active = false;
    const api = as(store);
    const many = Array.from({ length: 51 }, (_, n) => (["ct_haeun", "ct_junho", "ct_jiwoo", "ct_minjae", "ct_sora", "ct_eunji", "ct_dohyun"])[n % 7]!);
    const cases: [string, Record<string, unknown>][] = [
      ["no members", { members: [] }], ["51 members", { members: many }], ["a repeat", { members: ["ct_haeun", "ct_haeun"] }],
      ["an inactive person", { members: ["ct_haeun", "ct_taemin"] }], ["DAILY with dow", { handover: { minute: 540, dow: 1 } }],
    ];
    for (const [what, o] of cases) {
      const e = await refusal(create(api, { name: `Bad ${what}`, ...o }));
      expect([e.status, e.code], what).toEqual([400, "VALIDATION_FAILED"]);
    }
    expect((await api.listRotations()).map((r) => r.name).filter((n) => n.startsWith("Bad "))).toEqual([]);
  });
});

describe("roles", () => {
  it.each(["usr-minjae", "usr-sora"] as const)("%s: every write is 403 ROLE_REQUIRED (role ADMIN) and changes nothing", async (who) => {
    const store = createStore();
    const admin = as(store);
    const api = as(store, who);
    const before = await admin.listRotations();
    const night = before.find((r) => r.id === "rot_night")!;
    const writes = [
      () => api.createRotation({ scope: "MSP", name: "No desk", cadence: "DAILY", handover: { minute: 540 }, members: ["ct_haeun"] }),
      () => api.previewRotation("rot_night", { members: swap23(night) }),
      () => api.saveRotation("rot_night", { members: swap23(night) }, { version: night.version, previewHash: HASH }),
      () => api.deleteRotation("rot_night", { version: night.version }),
    ];
    for (const w of writes) { const e = await refusal(w()); expect([e.status, e.code, e.details.role]).toEqual([403, "ROLE_REQUIRED", "ADMIN"]); }
    expect(await admin.listRotations()).toEqual(before);
  });
  it("a portal user: reads and writes are 404, like a route that is not there", async () => {
    const store = createStore();
    const api = as(store, "usr-portal");
    const reads = [() => api.listRotations(), () => api.getRotationUsage("rot_night"), () => api.getRotationShifts("rot_night")];
    for (const r of reads) expect((await refusal(r())).status).toBe(404);
    const writes = [
      () => api.createRotation({ scope: "MSP", name: "X", cadence: "DAILY", handover: { minute: 540 }, members: ["ct_haeun"] }),
      () => api.previewRotation("rot_night", { name: "Y" }),
      () => api.saveRotation("rot_night", { name: "Y" }, { version: 1, previewHash: HASH }),
      () => api.deleteRotation("rot_night", { version: 1 }),
    ];
    for (const w of writes) expect((await refusal(w())).status).toBe(404);
  });
  it.each(["usr-haeun", "usr-minjae", "usr-sora"] as const)("%s reads the shifts and the usage", async (who) => {
    const api = as(createStore(), who);
    const shifts = await api.getRotationShifts("rot_night");
    expect(shifts.rotationId).toBe("rot_night");
    expect(shifts.rows.length).toBeGreaterThanOrEqual(8);
    expect((await api.getRotationUsage("rot_night")).customers.length).toBeGreaterThan(0);
  });
});
