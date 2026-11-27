/**
 * The mock of the Responder template API has the rules of packages/api/src/templatesApi.ts (API-CONTRACT §8.3, D-64): the roles, the
 * effects of a change, the preview hash, what a change must not do (no way around it), the 409/422 codes and 503 BUSY. The e2e specs and
 * the persona checks run on it, so these are the rules they rely on.
 */
import { describe, expect, it } from "vitest";
import { ApiError, type ConsoleApi } from "../client";
import type { Role } from "../types";
import { MOCK_USERS, createMockApi, createStore } from "./mock-api";

const as = (store: ReturnType<typeof createStore>, who: keyof typeof MOCK_USERS = "usr-haeun"): ConsoleApi => createMockApi(store, undefined, MOCK_USERS[who]!);
const code = async (p: Promise<unknown>): Promise<{ status: number; code: string; details: Record<string, unknown> }> => {
  try { await p; } catch (e) { if (e instanceof ApiError) return { status: e.status, code: e.code, details: e.details }; throw e; }
  throw new Error("expected a refusal");
};
const customerId = async (api: ConsoleApi, slug: string) => (await api.scopeTree()).customers.find((c) => c.slug === slug)!.id;
const tpl = async (api: ConsoleApi, name: string) => (await api.listResponderTemplates()).find((t) => t.name === name)!;

describe("roles", () => {
  it("every staff role reads the list, by name, with members and the customers that use it", async () => {
    for (const who of ["usr-haeun", "usr-minjae", "usr-sora"] as const) {
      const list = await as(createStore(), who).listResponderTemplates();
      expect(list.map((t) => t.name)).toEqual(["Data desk", "Infra core", "Night backup"]);
    }
    const core = await tpl(as(createStore()), "Infra core");
    expect(core.members.map((m) => m.name)).toEqual(["Haeun Kim", "Junho Park", "Minjae Lee"]);
    expect(core.customers.map((c) => c.name)).toContain("Mirae Pay");
    expect(core.version).toBe(1);
  });

  it("a portal user: 404, like a route that is not there", async () => {
    expect((await code(as(createStore(), "usr-portal").listResponderTemplates())).status).toBe(404);
  });

  it.each(["usr-minjae", "usr-sora"] as const)("%s cannot create, preview or save (403 ROLE_REQUIRED), nor attach", async (who) => {
    const store = createStore();
    const admin = as(store);
    const api = as(store, who);
    const core = await tpl(admin, "Infra core");
    const cid = await customerId(admin, "daon");
    expect((await code(api.createResponderTemplate({ name: "X", members: ["ct_haeun"] }))).code).toBe("ROLE_REQUIRED");
    expect((await code(api.previewResponderTemplate(core.id, { name: "Y" }))).code).toBe("ROLE_REQUIRED");
    expect((await code(api.saveResponderTemplate(core.id, { name: "Y" }, { version: 1, previewHash: "0".repeat(64) }))).code).toBe("ROLE_REQUIRED");
    expect((await code(api.previewCustomerTemplate(cid, core.id))).code).toBe("ROLE_REQUIRED");
    expect((await code(api.putCustomerTemplate(cid, core.id, { version: 1, previewHash: "0".repeat(64) }))).code).toBe("ROLE_REQUIRED");
  });
});

describe("create", () => {
  it("201-like: version 0, no customers; the name is unique; members are active staff only", async () => {
    const api = as(createStore());
    const t = await api.createResponderTemplate({ name: "  Weekend  ", members: ["ct_taemin", "ct_eunji"] });
    expect(t).toMatchObject({ name: "Weekend", version: 0, customers: [] });
    expect(t.members.map((m) => m.name)).toEqual(["Taemin Jung", "Eunji Kwon"]);
    expect((await code(api.createResponderTemplate({ name: "Weekend", members: ["ct_taemin"] }))).code).toBe("ALREADY_EXISTS");
    // a customer person, an unknown id, nobody, a repeat and a long name: 400 on the field
    for (const members of [["ct_yuna"], ["ct_nobody"], [], ["ct_taemin", "ct_taemin"]]) {
      const e = await code(api.createResponderTemplate({ name: "Other", members }));
      expect([e.status, e.code, (e.details.fields as { field: string }[])[0]!.field]).toEqual([400, "VALIDATION_FAILED", "members"]);
    }
    expect((await code(api.createResponderTemplate({ name: "x".repeat(81), members: ["ct_taemin"] }))).status).toBe(400);
  });
});

describe("preview: what a change does to each customer", () => {
  it("a person added: JOINS where there is no row, ALREADY_DIRECT where they were added directly; every customer that uses it is listed", async () => {
    const api = as(createStore());
    const core = await tpl(api, "Infra core");
    const p = await api.previewResponderTemplate(core.id, { members: [...core.members.map((m) => m.contactId), "ct_taemin"] });
    expect(p.totals.customers).toBe(core.customers.length);
    expect(p.customers.map((c) => c.name)).toEqual([...p.customers.map((c) => c.name)].sort((a, b) => a.localeCompare(b)));
    const mirae = p.customers.find((c) => c.name === "Mirae Pay")!;
    expect(mirae.effects).toEqual([{ kind: "ALREADY_DIRECT", contactId: "ct_taemin", name: "Taemin Jung" }]);
    const ara = p.customers.find((c) => c.name === "Ara Games")!;
    expect(ara.effects).toEqual([{ kind: "JOINS", contactId: "ct_taemin", name: "Taemin Jung" }]);
    expect(p.totals.joins).toBe(core.customers.length - 1);
    expect(p.totals.affected).toBe(core.customers.length - 1);
    expect(p.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.blocking).toEqual([]);
    expect(p.version).toBe(1);
  });

  it("a person removed: LEAVES; a person who was also added directly STAYS_DIRECT after the template gave them to the customer", async () => {
    const store = createStore();
    const api = as(store);
    const core = await tpl(api, "Infra core");
    const without = core.members.map((m) => m.contactId).filter((i) => i !== "ct_minjae");
    const p = await api.previewResponderTemplate(core.id, { members: without });
    expect(p.customers.find((c) => c.name === "Ara Games")!.effects).toEqual([{ kind: "LEAVES", contactId: "ct_minjae", name: "Minjae Lee" }]);
    // a customer that has the person directly: Mirae Pay gets Taemin directly and via the template (ALREADY_DIRECT), then he leaves the template
    const withT = [...core.members.map((m) => m.contactId), "ct_taemin"];
    const a = await api.previewResponderTemplate(core.id, { members: withT });
    await api.saveResponderTemplate(core.id, { members: withT }, { version: 1, previewHash: a.previewHash });
    const core2 = await tpl(api, "Infra core");
    const b = await api.previewResponderTemplate(core2.id, { members: core.members.map((m) => m.contactId) });
    expect(b.customers.find((c) => c.name === "Mirae Pay")!.effects).toEqual([{ kind: "STAYS_DIRECT", contactId: "ct_taemin", name: "Taemin Jung" }]);
    expect(b.customers.find((c) => c.name === "Ara Games")!.effects).toEqual([{ kind: "LEAVES", contactId: "ct_taemin", name: "Taemin Jung" }]);
  });

  it("a person who leaves but is named by a step of the customer: STEP_NAMES with the 1-based step (it does not block)", async () => {
    const store = createStore();
    const api = as(store);
    const mirae = store.customers.find((c) => c.slug === "mirae")!;
    // Mirae Pay's step 2 names Yuna (a customer person); make it name Haeun, who is in Infra core
    store.paging.byCustomer[mirae.id]!.config!.steps[1] = { atMin: 10, targetType: "PERSON", targetId: "ct_haeun", channels: ["VOICE"] };
    const core = await tpl(api, "Infra core");
    const p = await api.previewResponderTemplate(core.id, { members: ["ct_junho", "ct_minjae"] });
    expect(p.customers.find((c) => c.name === "Mirae Pay")!.effects).toEqual([
      { kind: "LEAVES", contactId: "ct_haeun", name: "Haeun Kim" },
      { kind: "STEP_NAMES", contactId: "ct_haeun", name: "Haeun Kim", stepIndex: 2 },
    ]);
    expect(p.totals.warnings).toBe(1);
    expect(p.blocking).toEqual([]);
  });

  it("the preview needs a name or members, and writes nothing", async () => {
    const api = as(createStore());
    const core = await tpl(api, "Infra core");
    expect((await code(api.previewResponderTemplate(core.id, {}))).status).toBe(400);
    expect((await code(api.previewResponderTemplate("tpl_nope", { name: "A" }))).status).toBe(404);
    await api.previewResponderTemplate(core.id, { name: "Renamed" });
    expect((await tpl(api, "Infra core")).version).toBe(1);
  });
});

/** a staff member nobody can reach (no verified channel at all) and N staff who can be called, in the store */
function addStaff(store: ReturnType<typeof createStore>, ids: string[], reachable: boolean) {
  for (const id of ids) store.paging.contacts[id] = { id, kind: "STAFF", name: `Staff ${id}`, title: "", channels: reachable ? { SMS: "VERIFIED", VOICE: "VERIFIED", SLACK: "VERIFIED" } : {} };
}

describe("blocking (D-64): nobody left to call, or a limit crossed — refused, no way around it", () => {
  async function blockedSetup() {
    const store = createStore();
    addStaff(store, ["ct_ghost"], false);
    // no Slack channel to post in: for these two the people are the only way to reach anybody
    for (const slug of ["cheong", "jeil"]) store.paging.byCustomer[store.customers.find((c) => c.slug === slug)!.id]!.slackChannel = "NOT_SET";
    const api = as(store);
    const core = await tpl(api, "Infra core");
    // Cheong Water and Jeil Foods page "everyone in Responders" and have nobody but the template: with a person nobody can reach, they would reach nobody
    const p = await api.previewResponderTemplate(core.id, { members: ["ct_ghost"] });
    return { store, api, core, p };
  }

  it("the preview lists the customers that would become UNREACHABLE, by customer id; customers with a rotation still reach somebody", async () => {
    const { p, api } = await blockedSetup();
    const ids = [await customerId(api, "cheong"), await customerId(api, "jeil")].sort();
    expect(p.blocking).toEqual(ids.map((customerId) => ({ customerId, reason: "UNREACHABLE" })));
  });

  it("the save is refused with 409 WOULD_BE_UNREACHABLE and the customer ids, and writes nothing", async () => {
    const { api, core, p } = await blockedSetup();
    const e = await code(api.saveResponderTemplate(core.id, { members: ["ct_ghost"] }, { version: core.version, previewHash: p.previewHash }));
    expect([e.status, e.code]).toEqual([409, "WOULD_BE_UNREACHABLE"]);
    expect(e.details.customerIds).toEqual([...new Set(p.blocking.map((b) => b.customerId))]);
    const after = await tpl(api, "Infra core");
    expect([after.version, after.members.length]).toEqual([1, 3]);
  });

  it("a customer that is UNREACHABLE already is not blocked (a customer with no call order yet can get a template)", async () => {
    const store = createStore();
    addStaff(store, ["ct_ghost"], false);
    const api = as(store);
    const daon = store.customers.find((c) => c.slug === "daon")!;
    store.paging.byCustomer[daon.id]!.config = null;
    store.paging.byCustomer[daon.id]!.staff = [];
    const t = await api.createResponderTemplate({ name: "Ghost", members: ["ct_ghost"] });
    expect((await api.previewCustomerTemplate(daon.id, t.id)).blocking).toEqual([]);
  });

  /** Cheong Water pages everyone in Responders; give it `direct` fake staff next to the 3 of Infra core, and no customer people */
  function crowded(store: ReturnType<typeof createStore>, direct: number) {
    const cheong = store.customers.find((c) => c.slug === "cheong")!;
    const ids = Array.from({ length: direct }, (_, i) => `ct_s${i}`);
    addStaff(store, ids, true);
    store.paging.byCustomer[cheong.id]!.staff = ids;
    return cheong;
  }

  it("D-38: a template that would take everyone past 20 is 422 RESPONDER_LIMIT_EXCEEDED with the customer ids", async () => {
    const store = createStore();
    const cheong = crowded(store, 16); // 16 + 3 = 19: one more person is at the limit (20), allowed
    addStaff(store, ["ct_t1", "ct_t2"], true);
    const api = as(store);
    const core = await tpl(api, "Infra core");
    const base = core.members.map((m) => m.contactId);
    expect((await api.previewResponderTemplate(core.id, { members: [...base, "ct_t1"] })).blocking.filter((b) => b.customerId === cheong.id)).toEqual([]);
    const members = [...base, "ct_t1", "ct_t2"]; // 21 → over
    const p = await api.previewResponderTemplate(core.id, { members });
    expect(p.blocking.filter((b) => b.customerId === cheong.id)).toEqual([{ customerId: cheong.id, reason: "RESPONDER_LIMIT_EXCEEDED" }]);
    const e = await code(api.saveResponderTemplate(core.id, { members }, { version: 1, previewHash: p.previewHash }));
    expect([e.status, e.code]).toEqual([422, "RESPONDER_LIMIT_EXCEEDED"]);
    expect(e.details.customerIds).toContain(cheong.id);
    expect((await tpl(api, "Infra core")).members.length).toBe(3);
  });

  it("a limit that was crossed already is not blocked again", async () => {
    const store = createStore();
    const cheong = crowded(store, 19); // 22 already
    addStaff(store, ["ct_t1"], true);
    const api = as(store);
    const core = await tpl(api, "Infra core");
    const p = await api.previewResponderTemplate(core.id, { members: [...core.members.map((m) => m.contactId), "ct_t1"] });
    expect(p.blocking.filter((b) => b.customerId === cheong.id)).toEqual([]);
  });
});

describe("save", () => {
  it("applies the change: version +1, `affected` customers, the customers' Responders follow", async () => {
    const store = createStore();
    const api = as(store);
    const core = await tpl(api, "Infra core");
    const members = [...core.members.map((m) => m.contactId), "ct_dohyun"];
    const p = await api.previewResponderTemplate(core.id, { name: "Infra core 2", members });
    const r = await api.saveResponderTemplate(core.id, { name: "Infra core 2", members }, { version: 1, previewHash: p.previewHash });
    expect(r).toMatchObject({ name: "Infra core 2", version: 2, affected: p.totals.affected });
    const ara = await customerId(api, "ara");
    expect((await api.getResponders(ara)).staff.map((s) => s.name)).toContain("Dohyun Kang");
  });

  it("If-Match: another version is 409 VERSION_CONFLICT with currentVersion, before anything else is looked at", async () => {
    const api = as(createStore());
    const core = await tpl(api, "Infra core");
    const e = await code(api.saveResponderTemplate(core.id, { name: "A" }, { version: 7, previewHash: "0".repeat(64) }));
    expect([e.status, e.code, e.details.currentVersion]).toEqual([409, "VERSION_CONFLICT", 1]);
  });

  it("the preview hash: missing or malformed is 400; a preview that no longer holds is 409 PREVIEW_STALE and nothing is written", async () => {
    const store = createStore();
    const api = as(store);
    const core = await tpl(api, "Infra core");
    const members = [...core.members.map((m) => m.contactId), "ct_dohyun"];
    expect((await code(api.saveResponderTemplate(core.id, { members }, { version: 1, previewHash: "nope" }))).status).toBe(400);
    const p = await api.previewResponderTemplate(core.id, { members });
    // meanwhile another customer starts using Infra core: the list of effects is not the one that was previewed
    const eden = await customerId(api, "eden");
    const pa = await api.previewCustomerTemplate(eden, core.id);
    await api.putCustomerTemplate(eden, core.id, { version: pa.version, previewHash: pa.previewHash });
    const e = await code(api.saveResponderTemplate(core.id, { members }, { version: 1, previewHash: p.previewHash }));
    expect([e.status, e.code]).toEqual([409, "PREVIEW_STALE"]);
    expect((await tpl(api, "Infra core")).members.length).toBe(3);
  });

  it("the same name or members as now: nothing is written (200, version unchanged, affected 0)", async () => {
    const api = as(createStore());
    const core = await tpl(api, "Infra core");
    const r = await api.saveResponderTemplate(core.id, { name: "Infra core" }, { version: 1, previewHash: "0".repeat(64) });
    expect([r.version, r.affected]).toEqual([1, 0]);
  });

  it("a name another template has: 409 ALREADY_EXISTS", async () => {
    const api = as(createStore());
    const core = await tpl(api, "Infra core");
    const p = await api.previewResponderTemplate(core.id, { name: "Data desk" });
    expect((await code(api.saveResponderTemplate(core.id, { name: "Data desk" }, { version: 1, previewHash: p.previewHash }))).code).toBe("ALREADY_EXISTS");
  });
});

describe("a customer attaches, detaches or switches its template", () => {
  it("attach: new members JOIN, people added directly stay (ALREADY_DIRECT); the write moves the Responders version", async () => {
    const store = createStore();
    const api = as(store);
    const core = await tpl(api, "Infra core");
    const daon = await customerId(api, "daon"); // direct: Junho, Minjae
    const p = await api.previewCustomerTemplate(daon, core.id);
    expect(p).toMatchObject({ from: null, to: { name: "Infra core" }, totals: { joins: 1, leaves: 0, warnings: 0 }, blocking: [] });
    expect(p.effects.map((e) => `${e.kind}:${e.name}`)).toEqual(["JOINS:Haeun Kim", "ALREADY_DIRECT:Junho Park", "ALREADY_DIRECT:Minjae Lee"]);
    const r = await api.putCustomerTemplate(daon, core.id, { version: p.version, previewHash: p.previewHash });
    expect(r).toMatchObject({ templateId: core.id, version: p.version + 1, joins: 1, leaves: 0 });
    const res = await api.getResponders(daon);
    expect(res.templateId).toBe(core.id);
    expect(res.staff.map((s) => `${s.name}:${s.source}`)).toEqual(["Haeun Kim:TEMPLATE", "Junho Park:DIRECT", "Minjae Lee:DIRECT"]);
    expect((await tpl(api, "Infra core")).customers.map((c) => c.name)).toContain("Daon Retail");
  });

  it("detach: the template's rows leave, the direct ones stay (STAYS_DIRECT); detaching again changes nothing", async () => {
    const store = createStore();
    const api = as(store);
    const core = await tpl(api, "Infra core");
    const daon = await customerId(api, "daon");
    const a = await api.previewCustomerTemplate(daon, core.id);
    await api.putCustomerTemplate(daon, core.id, { version: a.version, previewHash: a.previewHash });
    const p = await api.previewCustomerTemplate(daon, null);
    expect(p.effects.map((e) => `${e.kind}:${e.name}`)).toEqual(["LEAVES:Haeun Kim", "STAYS_DIRECT:Junho Park", "STAYS_DIRECT:Minjae Lee"]);
    const r = await api.putCustomerTemplate(daon, null, { version: p.version, previewHash: p.previewHash });
    expect([r.templateId, r.leaves]).toEqual([null, 1]);
    const again = await api.previewCustomerTemplate(daon, null);
    expect(again.effects).toEqual([]);
    const noop = await api.putCustomerTemplate(daon, null, { version: again.version, previewHash: again.previewHash });
    expect([noop.joins, noop.leaves, noop.version]).toEqual([0, 0, again.version]);
  });

  it("switch: people in both templates keep their row (no effect)", async () => {
    const store = createStore();
    const api = as(store);
    const ara = await customerId(api, "ara"); // Infra core
    const night = await tpl(api, "Night backup");
    const p = await api.previewCustomerTemplate(ara, night.id);
    expect(p.from?.name).toBe("Infra core");
    expect(p.effects.filter((e) => e.kind === "LEAVES").map((e) => e.name)).toEqual(["Haeun Kim", "Junho Park", "Minjae Lee"]);
    expect(p.effects.filter((e) => e.kind === "JOINS").map((e) => e.name)).toEqual(["Jiwoo Han", "Sora Yoon"]);
  });

  it("a switch that would leave nobody to call is blocked, with the customer in the list", async () => {
    const store = createStore();
    const api = as(store);
    const ara = await customerId(api, "cheong");
    store.paging.byCustomer[ara]!.slackChannel = "NOT_SET";
    addStaff(store, ["ct_ghost"], false);
    const t = await api.createResponderTemplate({ name: "Ghost", members: ["ct_ghost"] });
    const p = await api.previewCustomerTemplate(ara, t.id);
    expect(p.blocking).toEqual([{ customerId: ara, reason: "UNREACHABLE" }]);
    const e = await code(api.putCustomerTemplate(ara, t.id, { version: p.version, previewHash: p.previewHash }));
    expect([e.status, e.code, e.details.customerIds]).toEqual([409, "WOULD_BE_UNREACHABLE", [ara]]);
    expect((await api.getResponders(ara)).templateId).toBe((await tpl(api, "Infra core")).id);
  });

  it("errors: unknown template 400, a terminated customer 409 CUSTOMER_TERMINATED, a suspended one is allowed, stale version / hash 409", async () => {
    const store = createStore();
    const api = as(store);
    const core = await tpl(api, "Infra core");
    const daon = await customerId(api, "daon");
    expect((await code(api.previewCustomerTemplate(daon, "tpl_nope"))).status).toBe(400);
    expect((await code(api.previewCustomerTemplate(await customerId(api, "iruda"), core.id))).code).toBe("CUSTOMER_TERMINATED");
    expect((await api.previewCustomerTemplate(await customerId(api, "eden"), core.id)).to?.id).toBe(core.id); // eden is SUSPENDED
    const p = await api.previewCustomerTemplate(daon, core.id);
    expect((await code(api.putCustomerTemplate(daon, core.id, { version: p.version + 5, previewHash: p.previewHash }))).code).toBe("VERSION_CONFLICT");
    expect((await code(api.putCustomerTemplate(daon, core.id, { version: p.version, previewHash: "f".repeat(64) }))).code).toBe("PREVIEW_STALE");
    expect((await api.getResponders(daon)).templateId).toBeNull();
  });

  it("a terminated customer is not counted in the effects of a template", async () => {
    const store = createStore();
    const api = as(store);
    store.paging.byCustomer[await customerId(api, "iruda")]!.templateId = (await tpl(api, "Infra core")).id;
    const core = await tpl(api, "Infra core");
    expect(core.customers.map((c) => c.name)).not.toContain("Iruda Studio");
    const p = await api.previewResponderTemplate(core.id, { members: ["ct_haeun"] });
    expect(p.customers.map((c) => c.id)).not.toContain(await customerId(api, "iruda"));
  });
});

describe("503 BUSY: sent again once, after Retry-After", () => {
  it("one BUSY is retried and the call goes through; a second is the caller's error", async () => {
    const store = createStore();
    const api = as(store);
    const core = await tpl(api, "Infra core");
    store.templates.busy = 1;
    expect((await api.previewResponderTemplate(core.id, { name: "Other" })).templateId).toBe(core.id);
    store.templates.busy = 2;
    const e = await code(api.previewResponderTemplate(core.id, { name: "Other" }));
    expect([e.status, e.code]).toEqual([503, "BUSY"]);
    store.templates.busy = 0;
    expect((await tpl(api, "Infra core")).version).toBe(1);
  });
});

// the roles in one place, so a change of the fixtures' users shows up here
it("the fixture users the specs sign in as", () => {
  const roles: Role[] = [MOCK_USERS["usr-haeun"]!.role, MOCK_USERS["usr-minjae"]!.role, MOCK_USERS["usr-sora"]!.role];
  expect(roles).toEqual(["ADMIN", "OPERATOR", "VIEWER"]);
});
