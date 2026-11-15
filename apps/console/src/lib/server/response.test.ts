// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createApi, MemoryApiStore, commandPublisherFromEnv, type ApiResponse, type AuthContext } from "@alarmops/api";
import { DEFAULT_RETENTION } from "@alarmops/core";
import { toResponse } from "./response";
import { commands, retention } from "./wiring";
import { sqsClientFromEnv } from "./sqs-client";

const ADMIN: AuthContext = { userId: "usr_a", name: "A", kind: "INTERNAL", customerIds: "*", role: "ADMIN" };
const NOW = new Date("2026-11-10T00:00:00Z");

describe("toResponse: streaming", () => {
  it("writes the chunks as the body, with the headers of the ApiResponse", async () => {
    async function* g() { yield "a,b\r\n"; yield "1,2\r\n"; }
    const r = toResponse({ status: 200, headers: { "content-type": "text/csv; charset=utf-8" }, stream: g() });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await r.text()).toBe("a,b\r\n1,2\r\n");
  });

  it("aborts the stream when the generator fails midway: no JSON is appended, headers were already out", async () => {
    async function* g() { yield "a,b\r\n"; throw new Error("db down: secret detail"); }
    const log = vi.fn();
    const r = toResponse({ status: 200, headers: { "content-type": "text/csv" }, stream: g() }, log);
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("a,b\r\n");
    let msg = ""; try { await reader.read(); } catch (e) { msg = (e as Error).message; }
    expect(msg).toBe("stream aborted");
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]![0])).not.toContain("secret");
  });

  it("stops the generator when the client goes away", async () => {
    let finished = false;
    async function* g() { try { yield "x"; yield "y"; } finally { finished = true; } }
    const r = toResponse({ status: 200, headers: {}, stream: g() });
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(finished).toBe(true);
  });

  it("keeps JSON and empty bodies as they were", async () => {
    const j: ApiResponse = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
    expect(await toResponse(j).json()).toEqual({ ok: true });
    expect(toResponse({ status: 204, headers: {} }).body).toBeNull();
  });

  it("GET /customers/{id}/export.csv through createApi returns the CSV body (was empty)", async () => {
    const store = new MemoryApiStore();
    store.customers.set("cus_x", { id: "cus_x", name: "Iruda", slug: "iruda", status: "TERMINATED", statusChangedAt: new Date("2026-11-06T00:00:00Z") } as never);
    store.incidents.set("inc1", { id: "inc1", number: 7, customerId: "cus_x", title: "disk full", severity: "SEV_2", status: "RESOLVED", triggeredAt: new Date("2026-11-01T00:00:00Z"), acknowledgedAt: null, resolvedAt: null, mttaSec: null, mttrSec: null, memberCount: 1, eventCount: 2, accountIds: ["111111111111"], resourceTypes: ["ec2"], pagingSuppressed: null } as never);
    const api = createApi({ repo: store, now: () => NOW });
    const res = await api.handle({ method: "GET", path: "/api/v1/customers/cus_x/export.csv", auth: ADMIN, requestId: "r1" });
    expect(res.status).toBe(200);
    const r = toResponse(res);
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toContain("incidents-cus_x-2026-11-10.csv");
    const bytes = Buffer.from(await r.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM kept on the wire
    const text = bytes.toString("utf8");
    expect(text.startsWith("﻿number,id,title")).toBe(true);
    expect(text).toContain("7,inc1,disk full,SEV_2,RESOLVED,2026-11-01T00:00:00.000Z");
  });
});

describe("wiring", () => {
  it("one retention instance is shared (API and tick)", () => {
    const a = retention({ RETENTION_RETURN_DAYS: "14" });
    expect(retention({})).toBe(a);
    expect(a.returnDays === 14 || a.returnDays === DEFAULT_RETENTION.returnDays).toBe(true);
  });

  it("no queue url: no publisher; url without a role: still none (503 stays)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(commands({})).toBeUndefined();
    expect(commands({ ALARM_COMMANDS_QUEUE_URL: "https://sqs.ap-northeast-2.amazonaws.com/123456789012/alarm-commands", ALARM_COMMANDS_EXPECTED_ACCOUNT: "123456789012" })).toBeUndefined();
    warn.mockRestore();
  });

  it("with queue, account and role a publisher exists; the AWS SDK is not loaded until a send", () => {
    const env = { ALARM_COMMANDS_QUEUE_URL: "https://sqs.ap-northeast-2.amazonaws.com/123456789012/alarm-commands", ALARM_COMMANDS_EXPECTED_ACCOUNT: "123456789012", AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/console" };
    expect(sqsClientFromEnv({})).toBeUndefined();
    expect(sqsClientFromEnv(env)).toBeDefined();
    expect(commands(env)).toBeDefined();
    expect(() => commandPublisherFromEnv({ ...env, ALARM_COMMANDS_EXPECTED_ACCOUNT: "999999999999" }, { client: sqsClientFromEnv(env)! })).toThrow();
  });
});
