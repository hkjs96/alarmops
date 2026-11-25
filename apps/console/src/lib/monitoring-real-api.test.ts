// @vitest-environment node
/**
 * The console's typed client against the REAL API handler (packages/api on its in-memory store), not the mock: the
 * query names, the response shapes and the error codes of API-CONTRACT 8.5 are the ones the screens rely on.
 */
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@alarmops/api";
import { createHttpApi } from "./api/client";
import { monitoringError } from "./monitoring";

// The API's own test helpers, loaded by path at run time: they are another package's test code (typed against its own
// build of the stores), so the console's type check does not follow them.
/* eslint-disable @typescript-eslint/no-explicit-any */
const load = async (rel: string): Promise<any> => import(/* @vite-ignore */ new URL(rel, import.meta.url).href);
const helpers = await load("../../../../packages/api/test/helpers.ts");
const { cworld } = await load("../../../../packages/api/test/contract/apiContract.ts");
const { seedMonitoring } = await load("../../../../packages/api/test/contract/monitoringContract.ts");
const { memoryFixture } = await load("../../../../packages/core/test/contract/fixture.ts");
const USERS: Record<string, AuthContext> = helpers.USERS;

async function realApi(who: AuthContext) {
  const w = await cworld(async (seed: unknown) => memoryFixture(seed), seedMonitoring);
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const r = await w.call(who, (init?.method ?? "GET") as never, url.pathname.replace(/^\/api\/v1/, ""), { query, body });
    return new Response(r.status === 204 ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { api: createHttpApi({ baseUrl: "http://x.invalid", fetch: f }), w };
}

describe("console client against the real Monitoring API", () => {
  it("lists resources with account capabilities, and filters by scope slug with `outside`", async () => {
    const { api, w } = await realApi(USERS.haeun);
    const all = await api.listResources({});
    expect(all.outside).toBeNull();
    const a = all.items.find((r) => r.name === "api-1")!;
    expect(a.account).toMatchObject({ alarmWriterEnabled: true, tagWriterEnabled: false });
    const scoped = await api.listResources({ customer: "mirae", mine: false });
    expect(scoped.items.every((r) => r.org.customer?.slug === "mirae")).toBe(true);
    expect(scoped.outside).toEqual({ needsReview: 1, inAlarm: 1 });
    const alarms = await api.listManagedAlarms({ customer: "mirae" });
    expect(alarms.items.length).toBeGreaterThan(0);
    expect(alarms.outside).toEqual(scoped.outside);
    await w.fx.close();
  });

  it("stop is queued (202); keep is 409 NOT_SUPPORTED; tag_on without TagWriter is 403 with details.role, all worded", async () => {
    const { api, w } = await realApi(USERS.haeun);
    await expect(api.setMonitoring("res_a", "keep")).rejects.toMatchObject({ status: 409, code: "NOT_SUPPORTED" });
    const e = await api.setMonitoring("res_a", "tag_on").catch((x) => x);
    expect(e).toMatchObject({ status: 403, code: "CAPABILITY_DISABLED", details: { role: "tagWriter" } });
    expect(monitoringError(e, "tag_on", "api-1")).toContain("TagWriter role is not enabled");
    const ok = await api.setMonitoring("res_a", "stop");
    expect(ok).toMatchObject({ status: "queued" });
    expect(ok.commandId).toBeTruthy();
    await expect(api.setMonitoring("res_b", "stop")).rejects.toMatchObject({ status: 409, code: "INVALID_TRANSITION" });
    await w.fx.close();
  });

  it("a portal user gets awsAccountId null and the rows still carry what the screen needs", async () => {
    const { api, w } = await realApi(USERS.yuna);
    const r = await api.listResources({});
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((x) => x.account === null || x.account.awsAccountId === null)).toBe(true);
    await w.fx.close();
  });
});
