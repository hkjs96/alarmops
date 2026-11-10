import { buildTree, resolveSel, type ScopeSel } from "@alarmops/design-system";
import { createMockApi, createStore } from "./api/mock/mock-api";
import { MOCK_NOW } from "./api/mock/fixtures";
import { outsideCounts } from "./incidents";
import { parseQuery } from "./query";
import {
  clearLevel, incidentPanelPath, panelRouteMatches, parsePanelRoute, parseScopeParams, scopeQuery, slugify,
} from "./scope";

const NOW = Date.parse(MOCK_NOW);
const api = (customers: 14 | 34 = 14) => createMockApi(createStore({ customers }), () => NOW);

describe("scope URL helpers", () => {
  it("reads the filter from ?customer=&project=&service=", () => {
    expect(parseScopeParams({ customer: "mirae", project: "core", service: "checkout" })).toEqual({ sel: { customer: "mirae", project: "core", service: "checkout" }, malformed: false });
    expect(parseScopeParams(new URLSearchParams("customer=daon")).sel).toEqual({ customer: "daon" });
    expect(parseScopeParams({}).sel).toEqual({});
  });
  it("drops a level without its parent and lets a customer replace mine", () => {
    expect(parseScopeParams({ project: "core" }).sel).toEqual({});
    expect(parseScopeParams({ customer: "mirae", service: "checkout" }).sel).toEqual({ customer: "mirae" });
    expect(parseScopeParams({ mine: "1" }).sel).toEqual({ mine: true });
    expect(parseScopeParams({ mine: "1", customer: "mirae" }).sel).toEqual({ customer: "mirae" });
  });
  it("flags values that are not slugs", () => {
    expect(parseScopeParams({ customer: "../etc" }).malformed).toBe(true);
    expect(parseScopeParams({ customer: "Mirae Pay" }).malformed).toBe(true);
    expect(parseScopeParams({ customer: "mirae", project: "<x>" }).malformed).toBe(true);
  });
  it("writes the filter first and keeps the other params", () => {
    expect(scopeQuery({})).toBe("");
    expect(scopeQuery({ customer: "mirae", project: "core" })).toBe("?customer=mirae&project=core");
    expect(scopeQuery({ mine: true })).toBe("?mine=1");
    expect(scopeQuery({ customer: "daon" }, new URLSearchParams("customer=mirae&project=core&status=ACKNOWLEDGED&cursor=50"))).toBe("?customer=daon&status=ACKNOWLEDGED");
    expect(scopeQuery({}, "mine=1&severity=SEV_1")).toBe("?severity=SEV_1");
  });
  it("round-trips", () => {
    const sels: ScopeSel[] = [{}, { mine: true }, { customer: "a" }, { customer: "a", project: "b" }, { customer: "a", project: "b", service: "c" }];
    for (const s of sels) expect(parseScopeParams(new URLSearchParams(scopeQuery(s))).sel).toEqual(s);
  });
  it("× clears one level", () => {
    const s = { customer: "mirae", project: "core", service: "checkout" };
    expect(clearLevel(s, "service")).toEqual({ customer: "mirae", project: "core" });
    expect(clearLevel(s, "project")).toEqual({ customer: "mirae" });
    expect(clearLevel(s, "customer")).toEqual({});
  });
  it("feeds the list query", () => {
    expect(parseQuery({ customer: "mirae", project: "core", status: "ACKNOWLEDGED" })).toMatchObject({ customer: "mirae", project: "core", status: "ACKNOWLEDGED" });
    expect(parseQuery({ mine: "1" })).toMatchObject({ mine: true, customer: undefined });
  });
  it("slugifies names", () => {
    expect(slugify("Payments API")).toBe("payments-api");
    expect(slugify("  EKS  prod ")).toBe("eks-prod");
  });
});

describe("panel route", () => {
  const org = { customer: { slug: "mirae" }, project: { slug: "core" }, service: { slug: "payments-api" } };
  it("is one path: the incident's own scope", () => {
    expect(incidentPanelPath(org, "inc-1")).toBe("/c/mirae/core/payments-api/incident/inc-1");
    expect(incidentPanelPath({ customer: { slug: "mirae" }, project: { slug: "core" }, service: null }, "inc-1")).toBe("/c/mirae/core/incident/inc-1");
    expect(incidentPanelPath({ customer: null, project: null, service: null }, "inc-9")).toBe("/c/-/incident/inc-9");
  });
  it("parses and rejects", () => {
    expect(parsePanelRoute("mirae", ["core", "payments-api", "incident", "inc-1"])).toEqual({ customer: "mirae", project: "core", service: "payments-api", kind: "incident", id: "inc-1" });
    expect(parsePanelRoute("mirae", ["incident", "inc-1"])).toMatchObject({ customer: "mirae", project: undefined });
    expect(parsePanelRoute("-", ["incident", "inc-9"])).toMatchObject({ customer: null, id: "inc-9" });
    expect(parsePanelRoute("mirae", undefined)).toBeNull();
    expect(parsePanelRoute("mirae", ["core"])).toBeNull();
    expect(parsePanelRoute("mirae", ["core", "paging", "x"])).toBeNull();
    expect(parsePanelRoute("mirae", ["a", "b", "c", "incident", "x"])).toBeNull();
    expect(parsePanelRoute("-", ["core", "incident", "x"])).toBeNull();
    expect(parsePanelRoute("Mirae", ["incident", "x"])).toBeNull();
    expect(parsePanelRoute("mirae", ["incident", "a b"])).toBeNull();
  });
  it("matches only the incident's own scope, segment for segment", () => {
    const r = (c: string, p: string[]) => parsePanelRoute(c, [...p, "incident", "inc-1"])!;
    expect(panelRouteMatches(r("mirae", ["core", "payments-api"]), org)).toBe(true);
    expect(panelRouteMatches(r("mirae", ["core"]), org)).toBe(false);
    expect(panelRouteMatches(r("daon", ["core", "payments-api"]), org)).toBe(false);
    expect(panelRouteMatches(r("mirae", ["core", "checkout"]), org)).toBe(false);
    expect(panelRouteMatches(r("-", []), org)).toBe(false);
    expect(panelRouteMatches(r("-", []), { customer: null, project: null, service: null })).toBe(true);
  });
  it("every fixture incident has a parseable, matching panel path", async () => {
    const all = [...(await api().listIncidents({ status: "open" })).items, ...(await api().listIncidents({ status: "RESOLVED" })).items];
    expect(all.length).toBeGreaterThan(20);
    for (const i of all) {
      const segs = incidentPanelPath(i.org, i.id).split("/").slice(2);
      const route = parsePanelRoute(segs[0]!, segs.slice(1));
      expect(route, i.title).not.toBeNull();
      expect(panelRouteMatches(route!, i.org), i.title).toBe(true);
    }
  });
});

describe("mock scope tree", () => {
  it("has the mockup's 14 customers, or 34 with the toggle", async () => {
    const t14 = (await api().scopeTree()).customers;
    expect(t14).toHaveLength(14);
    expect(t14.filter((c) => c.mine).map((c) => c.slug)).toEqual(["mirae", "ara", "bora", "cheong", "dasol", "gaon", "jeil"]);
    const t34 = (await api(34).scopeTree()).customers;
    expect(t34).toHaveLength(34);
    expect(t34.filter((c) => c.mine)).toHaveLength(7);
  });
  it("counts open incidents per level, call health per customer, own steps below the customer", async () => {
    const t = (await api().scopeTree()).customers;
    const by = (s: string) => t.find((c) => c.slug === s)!;
    expect(by("mirae").openIncidents).toBe(1);
    expect(by("mirae").projects.find((p) => p.slug === "core")!.services.find((s) => s.slug === "payments-api")!.openIncidents).toBe(1);
    expect(by("mirae").projects.find((p) => p.slug === "core")!.services.find((s) => s.slug === "checkout")!.openIncidents).toBe(0);
    expect(by("bora").openIncidents).toBe(0); // acknowledged is not open
    expect(by("kumho").callHealth).toBe("UNREACHABLE");
    expect(by("lumen").callHealth).toBe("AT_RISK");
    expect(by("mirae").projects.find((p) => p.slug === "data-platform")!.ownSteps).toBe(true);
    expect(by("hanbit").projects.find((p) => p.slug === "fulfilment")!.services[0]!.ownSteps).toBe(true);
    expect(buildTree(t, { sel: {} }).problemCount).toBe(5); // mirae, daon, hanbit (open) + kumho, lumen (call health)
  });
  it("tree total of open incidents + unmapped = the badge", async () => {
    const a = api();
    const t = (await a.scopeTree()).customers;
    const all = await a.listIncidents({ status: "open" });
    const badge = all.counts.triggered + all.counts.escalated;
    const unmapped = all.items.filter((i) => i.unmapped && i.status === "TRIGGERED").length;
    expect(t.reduce((n, c) => n + c.openIncidents, 0) + unmapped).toBe(badge);
    expect(badge).toBe(4);
  });
  it("duplicate service names stay separate customers", async () => {
    const t = (await api().scopeTree()).customers;
    expect(resolveSel(t, { customer: "mirae", project: "core", service: "checkout" })!.service!.id).not.toBe(resolveSel(t, { customer: "daon", project: "commerce", service: "checkout" })!.service!.id);
  });
});

describe("outside this view", () => {
  it("is null without a scope filter", async () => {
    expect((await api().listIncidents({ status: "open" })).outside).toBeNull();
    expect((await api().listIncidents({ status: "open", severity: "SEV_1" })).outside).toBeNull();
  });
  it("matches the mockup's numbers", async () => {
    const a = api();
    // default: 7 listed, badge 4
    expect((await a.listIncidents({ status: "open" })).items).toHaveLength(7);
    // My customers (Haeun): Mirae, Bora and the unmapped account stay → 2 open · 2 acknowledged outside
    const my = await a.listIncidents({ status: "open", mine: true });
    expect(my.items).toHaveLength(3);
    expect(my.outside).toEqual({ open: 2, unmapped: 0, acknowledged: 2 });
    // Mirae Pay: 3 open (1 from an unmapped account) · 3 acknowledged
    const mirae = await a.listIncidents({ status: "open", customer: "mirae" });
    expect(mirae.items).toHaveLength(1);
    expect(mirae.outside).toEqual({ open: 3, unmapped: 1, acknowledged: 3 });
    // Daon Retail › Commerce › Checkout: 4 open (1 unmapped) · 2 acknowledged
    const co = await a.listIncidents({ status: "open", customer: "daon", project: "commerce", service: "checkout" });
    expect(co.items.map((i) => i.title)).toEqual(["grafana: Checkout p95 latency above 800 ms"]);
    expect(co.outside).toEqual({ open: 4, unmapped: 1, acknowledged: 2 });
    // a customer with no incidents of its own hides everything
    expect((await a.listIncidents({ status: "open", customer: "ara" })).outside).toEqual({ open: 4, unmapped: 1, acknowledged: 3 });
  });
  it("open in view + open outside = badge, for every scope", async () => {
    const a = api(34);
    const t = (await a.scopeTree()).customers;
    const all = await a.listIncidents({ status: "open" });
    const badge = all.counts.triggered + all.counts.escalated;
    const scopes: { customer?: string; project?: string; service?: string; mine?: boolean }[] = [{ mine: true }];
    for (const c of t) {
      scopes.push({ customer: c.slug });
      for (const p of c.projects) {
        scopes.push({ customer: c.slug, project: p.slug });
        for (const s of p.services) scopes.push({ customer: c.slug, project: p.slug, service: s.slug });
      }
    }
    expect(scopes.length).toBeGreaterThan(100);
    for (const s of scopes) {
      const r = await a.listIncidents({ status: "open", ...s });
      const openInView = r.counts.triggered + r.counts.escalated;
      expect(openInView + r.outside!.open, JSON.stringify(s)).toBe(badge);
      expect(r.counts.acknowledged + r.outside!.acknowledged, JSON.stringify(s)).toBe(all.counts.acknowledged);
      expect(r.outside!.unmapped).toBeLessThanOrEqual(r.outside!.open);
    }
  });
  it("does not move with status, severity or search", async () => {
    const a = api();
    const base = (await a.listIncidents({ customer: "hanbit" })).outside;
    expect((await a.listIncidents({ customer: "hanbit", status: "RESOLVED" })).outside).toEqual(base);
    expect((await a.listIncidents({ customer: "hanbit", severity: "SEV_1", q: "zzz" })).outside).toEqual(base);
  });
  it("follows an acknowledge", async () => {
    const a = api();
    const before = (await a.listIncidents({ customer: "mirae" })).outside!;
    const hanbit = (await a.listIncidents({ customer: "hanbit" })).items.find((i) => i.status === "TRIGGERED")!;
    await a.ack(hanbit.id, hanbit.version);
    expect((await a.listIncidents({ customer: "mirae" })).outside).toEqual({ ...before, open: before.open - 1, acknowledged: before.acknowledged + 1 });
  });
  it("counts each hidden incident in one place and ignores resolved ones", () => {
    const mk = (status: "TRIGGERED" | "ACKNOWLEDGED" | "RESOLVED", unmapped = false) => ({ status, unmapped }) as never;
    const all = [mk("TRIGGERED"), mk("TRIGGERED", true), mk("ACKNOWLEDGED"), mk("RESOLVED")];
    expect(outsideCounts(all, () => false)).toEqual({ open: 2, unmapped: 1, acknowledged: 1 });
    expect(outsideCounts(all, () => true)).toEqual({ open: 0, unmapped: 0, acknowledged: 0 });
  });
  it("unknown or malformed scope is 404, same as an unknown incident", async () => {
    const a = api();
    const errs = await Promise.all([
      a.listIncidents({ customer: "nope" }), a.listIncidents({ customer: "mirae", project: "nope" }),
      a.listIncidents({ customer: "mirae", project: "core", service: "nope" }), a.listIncidents({ project: "core" }),
      a.listIncidents({ customer: "Mirae Pay" }), a.getIncident("nope"),
    ].map((p) => p.then(() => null, (e: { status: number; code: string; message: string }) => ({ status: e.status, code: e.code, message: e.message }))));
    expect(new Set(errs.map((e) => JSON.stringify(e)))).toEqual(new Set([JSON.stringify({ status: 404, code: "NOT_FOUND", message: "Not found." })]));
  });
});
