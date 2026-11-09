import { age, countdown, duration, groupDigits, kstHeading, kstTime } from "./format";
import { computeCounts, displayStatus, sortIncidents } from "./incidents";
import { toQuery, createHttpApi, ApiError } from "./api/client";
import { createMockApi, createStore } from "./api/mock/mock-api";
import { MOCK_NOW, openIncidents } from "./api/mock/fixtures";
import { parseQuery } from "./query";

const NOW = Date.parse(MOCK_NOW);

describe("format", () => {
  it("formats KST", () => {
    expect(kstTime("2026-11-08T18:12:04Z", true)).toBe("03:12:04");
    expect(kstHeading(MOCK_NOW)).toBe("Monday, Nov 9 · 03:16 KST");
  });
  it("age / duration / countdown", () => {
    expect(age("2026-11-08T18:12:04Z", NOW)).toBe("4m");
    expect(duration("2026-11-08T18:12:04Z", NOW)).toBe("4m 12s");
    expect(countdown("2026-11-08T18:22:04Z", NOW)).toBe("5:48");
    expect(countdown("2026-11-08T18:00:00Z", NOW)).toBe("now");
  });
  it("groups digits", () => {
    expect(groupDigits("481220935017")).toBe("481 220 935 017");
    expect(groupDigits("827311046650", 4)).toBe("8273 1104 6650");
  });
});

describe("incidents logic", () => {
  it("escalated is a display state of TRIGGERED", () => {
    expect(displayStatus({ status: "TRIGGERED", escalated: true })).toBe("ESCALATED");
    expect(displayStatus({ status: "ACKNOWLEDGED", escalated: true })).toBe("ACKNOWLEDGED");
  });
  it("sorts triggered first, then severity, then oldest", () => {
    const s = sortIncidents(openIncidents).map((i) => i.title.split(" ")[0]);
    expect(s[0]).toBe("payments-db-1");
    expect(s.at(-1)).toBe("grafana:");
  });
  it("counts match mockup tiles", () => {
    const c = computeCounts(openIncidents, NOW, 5, 2);
    expect([c.triggered, c.escalated, c.acknowledged, c.open]).toEqual([3, 1, 2, 6]);
  });
  it("parses query and drops unknown values", () => {
    expect(parseQuery({ status: "RESOLVED", severity: "SEV_9", assignee: "me" })).toMatchObject({ status: "RESOLVED", severity: undefined, assignee: "me" });
  });
});

describe("api client", () => {
  it("drops empty query params", () => {
    expect(toQuery({ a: "", b: undefined, c: 1, d: "x" })).toBe("?c=1&d=x");
  });
  it("sends If-Match and maps errors", async () => {
    const calls: [string, RequestInit][] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "x", requestId: "req_1" } }), { status: 409 });
    }) as unknown as typeof fetch;
    const api = createHttpApi({ baseUrl: "http://h/", fetch: fake });
    await expect(api.ack("inc 1", 3)).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT", requestId: "req_1" });
    expect(calls[0]![0]).toBe("http://h/api/v1/incidents/inc%201/ack");
    expect((calls[0]![1].headers as Record<string, string>)["If-Match"]).toBe("3");
  });
});

describe("mock api", () => {
  it("lists open with counts on the same filter basis", async () => {
    const api = createMockApi(createStore(), () => NOW);
    const r = await api.listIncidents({ status: "open" });
    expect(r.items).toHaveLength(6);
    expect(r.counts).toMatchObject({ triggered: 3, escalated: 1, acknowledged: 2, resolved24h: 17, muted: 5 });
    const f = await api.listIncidents({ status: "open", customerId: "cus_daon" });
    expect(f.items).toHaveLength(f.counts.open);
  });
  it("acks with version check", async () => {
    const api = createMockApi(createStore(), () => NOW);
    const id = openIncidents[0]!.id;
    await expect(api.ack(id, 1)).rejects.toBeInstanceOf(ApiError);
    const d = await api.ack(id, openIncidents[0]!.version);
    expect(d.status).toBe("ACKNOWLEDGED");
    const tl = await api.getTimeline(id);
    expect(tl.items[0]!.kind).toBe("ACKED");
  });
  it("bulk preview → execute → undo", async () => {
    const api = createMockApi(createStore(), () => NOW);
    const ids = openIncidents.map((i) => i.id);
    const p = await api.bulkPreview("ack", ids);
    expect(p.targets).toHaveLength(4);
    expect(p.skipped).toHaveLength(2);
    const r = await api.bulkExecute("ack", ids);
    expect((await api.listIncidents({ status: "open" })).counts.triggered).toBe(0);
    await api.bulkUndo(r.undoToken);
    expect((await api.listIncidents({ status: "open" })).counts.triggered).toBe(3);
  });
  it("404 for unknown", async () => {
    await expect(createMockApi().getIncident("nope")).rejects.toMatchObject({ status: 404 });
  });
});
