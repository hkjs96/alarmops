import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MOCK_USERS, createMockApi, createStore } from "@/lib/api/mock/mock-api";
import type { ConsoleApi } from "@/lib/api/client";

const state = vi.hoisted(() => ({ sub: "usr-haeun", calls: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => "/monitoring/resources", notFound: () => { throw new Error("notFound"); } }));
vi.mock("@/lib/auth", () => ({ requireSession: async () => ({ sub: state.sub }) }));
let store = createStore();
vi.mock("@/lib/api", () => ({
  isMock: () => true,
  nowMs: () => Date.parse("2026-11-08T18:16:16Z"),
  getApi: async (): Promise<ConsoleApi> => {
    const api = createMockApi(store, undefined, MOCK_USERS[state.sub]!);
    // count the calls the screen makes: the list reads must be a fixed number, never one per row
    return new Proxy(api, { get: (t, k: string) => (typeof t[k as keyof ConsoleApi] === "function" ? (...a: unknown[]) => { state.calls.push(k); return (t[k as keyof ConsoleApi] as (...x: unknown[]) => unknown)(...a); } : t[k as keyof ConsoleApi]) });
  },
}));

import { MonitoringScreen } from "./MonitoringScreen";
import type { MonitoringTab } from "@/lib/monitoring";

const render = async (tab: MonitoringTab, sp: Record<string, string> = {}) => renderToStaticMarkup(await MonitoringScreen({ tab, sp }));
beforeEach(() => { store = createStore(); state.sub = "usr-haeun"; state.calls = []; });

describe("Monitoring screen", () => {
  it("renders the five tabs with the counts of the same two lists, and the three tiles", async () => {
    const html = await render("resources");
    for (const t of ["Alarms", "Resources", "Needs review", "Coverage gaps", "Sync runs"]) expect(html).toContain(t);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Monitored");
    expect(html).toContain("Alarms in ALARM");
    const needs = store.monitoring.resources.filter((r) => r.monitoringState === "NEEDS_REVIEW").length;
    expect(html).toMatch(new RegExp(`data-testid="tile-needs-review"[^>]*>.*?<div class="v">${needs}</div>`));
    expect(html).toContain("checkout-alb");
  });

  it("reads the data in two list calls (plus /me) however many rows there are: no call per row", async () => {
    await render("needs-review");
    expect(state.calls.filter((c) => c === "listResources")).toHaveLength(1);
    expect(state.calls.filter((c) => c === "listManagedAlarms")).toHaveLength(1);
    expect(state.calls.length).toBeLessThanOrEqual(4);
  });

  it("Alarms tab shows a severity badge with shape and text, and the state as text", async () => {
    const html = await render("alarms");
    expect(html).toMatch(/SEV-\d/);
    expect(html).toContain("ALARM");
    expect(html).toContain('data-testid="alarms-table"');
  });

  it("Coverage gaps and Sync runs are 'Coming soon'", async () => {
    for (const t of ["coverage-gaps", "sync-runs"] as const) expect(await render(t)).toContain("Coming soon");
  });

  it("Needs review lists only resources in NEEDS_REVIEW", async () => {
    const html = await render("needs-review");
    expect(html).toContain("checkout-alb");
    expect(html).not.toContain("payments-api-prod");
  });

  it("empty: no account yet → 'Connect an AWS account' with a link to onboarding", async () => {
    store.monitoring.resources = []; store.monitoring.alarms = [];
    const html = await render("resources");
    expect(html).toContain("Connect an AWS account");
    expect(html).toContain('href="/customers"');
  });

  it("empty: nothing to review", async () => {
    for (const r of store.monitoring.resources) if (r.monitoringState === "NEEDS_REVIEW") r.monitoringState = "MONITORED";
    expect(await render("needs-review")).toContain("Nothing to review");
  });

  it("a scope filter narrows the lists and the 'Outside this view' chip counts what is hidden", async () => {
    const html = await render("needs-review", { customer: "mirae" });
    expect(html).toContain("checkout-alb");
    expect(html).not.toContain("search-opensearch");
    expect(html).toContain("Outside this view: 2 need review");
    expect(html).toContain('href="/monitoring/needs-review"');
  });

  it("no filter, no chip", async () => {
    expect(await render("needs-review")).not.toContain("Outside this view");
  });

  it("an unknown customer is Not found, like one that is out of range", async () => {
    await expect(render("resources", { customer: "nobody" })).rejects.toThrow("notFound");
  });

  it("an API failure is an error card with Retry, not a blank page", async () => {
    store.monitoring = null as never;
    const html = await render("resources");
    expect(html).toContain("Could not load monitoring");
    expect(html).toContain("Retry");
  });

  it("a Viewer sees the list and a note, not working buttons", async () => {
    state.sub = "usr-sora";
    const html = await render("needs-review");
    expect(html).toContain("Operator role");
  });
});
