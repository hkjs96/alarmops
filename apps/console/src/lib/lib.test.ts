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
    expect([c.triggered, c.escalated, c.acknowledged, c.open]).toEqual([3, 1, 3, 4]);
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
    const r = await api.listIncidents({ status: "active" });
    expect(r.items).toHaveLength(7);
    expect(r.counts).toMatchObject({ triggered: 3, escalated: 1, acknowledged: 3, resolved24h: 17, muted: 5 });
    const f = await api.listIncidents({ status: "active", customerId: "cus_daon" });
    // one meaning of "open": triggered or escalated, nobody acknowledged. The active list is open + acknowledged.
    expect(r.counts.open).toBe(4);
    expect(f.items).toHaveLength(f.counts.open + f.counts.acknowledged);
  });
  it("acks with version check", async () => {
    const api = createMockApi(createStore(), () => NOW);
    const id = openIncidents[0]!.id;
    await expect(api.ack(id, 1)).rejects.toBeInstanceOf(ApiError);
    await expect(api.ack(id, 1)).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    const d = await api.ack(id, openIncidents[0]!.version);
    expect(d.incident.status).toBe("ACKNOWLEDGED");
    expect(d.incident.acknowledgedBy?.name).toBe("Haeun Kim");
    expect(d.incident.escalation?.nextAt).toBeNull();
    const tl = await api.getTimeline(id);
    expect(tl.items[0]!.kind).toBe("ACKED");
    // the single-ack token goes to /incidents/bulk/undo (API-CONTRACT §8.1)
    await api.bulkUndo(d.undoToken);
    const back = await api.getIncident(id);
    expect(back.status).toBe("TRIGGERED");
    expect(back.escalation?.nextAt).toBe(openIncidents[0]!.escalation!.nextAt);
    expect((await api.getTimeline(id)).items[0]!.kind).not.toBe("ACKED");
  });
  it("R-3: an Acknowledge from a stale list does not land on an incident that changed meanwhile", async () => {
    const api = createMockApi(createStore(), () => NOW);
    const seen = (await api.listIncidents()).items.find((i) => i.id === openIncidents[0]!.id)!;
    await api.escalate(seen.id); // it escalated after the list was loaded
    await expect(api.ack(seen.id, seen.version)).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect((await api.getIncident(seen.id)).status).toBe("TRIGGERED");
    // bulk: the stale item is skipped and reported, the others run
    const other = (await api.listIncidents()).items.find((i) => i.title.includes("KubeNodeNotReady"))!;
    const r = await api.bulkExecute("ack", [{ id: seen.id, version: seen.version }, { id: other.id, version: other.version }, { id: "nope", version: 1 }]);
    expect(r.done).toEqual([other.id]);
    expect(r.conflicts).toEqual([{ id: seen.id, code: "VERSION_CONFLICT" }, { id: "nope", code: "NOT_FOUND" }]);
  });
  it("R-3: the HTTP client sends items [{id, version}] for bulk and reads { incident, undoToken } from a single ack", async () => {
    const calls: [string, RequestInit][] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      const body = url.endsWith("/ack") ? { incident: { id: "i1" }, undoToken: "u1" } : { done: ["i1"], conflicts: [], undoToken: "u2" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createHttpApi({ baseUrl: "http://h", fetch: fake });
    expect((await api.ack("i1", 7)).undoToken).toBe("u1");
    expect((calls[0]![1].headers as Record<string, string>)["If-Match"]).toBe("7");
    await api.bulkExecute("ack", [{ id: "i1", version: 7 }]);
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ action: "ack", items: [{ id: "i1", version: 7 }], preview: false });
  });
  it("bulk preview → execute → undo", async () => {
    const api = createMockApi(createStore(), () => NOW);
    const ids = openIncidents.map((i) => ({ id: i.id, version: i.version }));
    const p = await api.bulkPreview("ack", ids);
    expect(p.targets).toHaveLength(4);
    expect(p.skipped).toHaveLength(3);
    const r = await api.bulkExecute("ack", ids);
    expect((await api.listIncidents({ status: "active" })).counts.triggered).toBe(0);
    await api.bulkUndo(r.undoToken);
    expect((await api.listIncidents({ status: "active" })).counts.triggered).toBe(3);
  });
  it("404 for unknown", async () => {
    await expect(createMockApi().getIncident("nope")).rejects.toMatchObject({ status: 404 });
  });
});
