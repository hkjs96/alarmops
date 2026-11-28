/**
 * The HTTP wrappers of the rotation writes (API-CONTRACT §8.3): what goes on the wire. The only test of these wrappers in client.ts.
 * Expected: PATCH /rotations/{id} with If-Match: <version> and a body that is exactly the change + previewHash (no cadence);
 * DELETE with If-Match; POST, PATCH and DELETE send again once after a 503 BUSY and throw the second one.
 *
 * Assumed signatures (like the template wrappers): createRotation(body), saveRotation(id, change, { version, previewHash }),
 * deleteRotation(id, { version }).
 */
import { describe, expect, it, vi } from "vitest";
import { buildChange } from "../rotations";
import { ApiError, createHttpApi } from "./client";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const BUSY = () => json(503, { error: { code: "BUSY", message: "busy", requestId: "r", details: {} } }, { "retry-after": "1" });
const OK = { id: "rot_night", version: 2 };
const api = (fetchMock: ReturnType<typeof vi.fn>) => createHttpApi({ baseUrl: "http://x", fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
const sent = (fetchMock: ReturnType<typeof vi.fn>, n = 0) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return { url, method: init.method, headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(init.body as string) };
};
const HASH = "c".repeat(64);
const saved = { name: "MSP night desk", members: ["ct_haeun", "ct_junho", "ct_jiwoo"], handover: { minute: 540 } };

describe("saveRotation", () => {
  it("PATCH /rotations/{id}, If-Match is the version, the body is the change plus previewHash and nothing else", async () => {
    const f = vi.fn().mockResolvedValue(json(200, OK));
    const change = buildChange(saved, { ...saved, members: ["ct_haeun", "ct_jiwoo", "ct_junho"] })!;
    await api(f).saveRotation("rot_night", change, { version: 7, previewHash: HASH });
    const r = sent(f);
    expect([r.method, r.url]).toEqual(["PATCH", "http://x/api/v1/rotations/rot_night"]);
    expect(r.headers["If-Match"]).toBe("7");
    expect(r.body).toEqual({ ...change, previewHash: HASH });
    expect(Object.keys(r.body).sort()).toEqual(["members", "previewHash"]);
    expect(r.body).not.toHaveProperty("cadence");
  });
  it("a rename alone sends {name, previewHash}", async () => {
    const f = vi.fn().mockResolvedValue(json(200, OK));
    await api(f).saveRotation("rot_night", buildChange(saved, { ...saved, name: "Night desk" })!, { version: 1, previewHash: HASH });
    expect(Object.keys(sent(f).body).sort()).toEqual(["name", "previewHash"]);
  });
  it("the id is encoded in the path", async () => {
    const f = vi.fn().mockResolvedValue(json(200, OK));
    await api(f).saveRotation("a/b", { name: "x" }, { version: 1, previewHash: HASH });
    expect(sent(f).url).toBe("http://x/api/v1/rotations/a%2Fb");
  });
});

describe("deleteRotation", () => {
  it("DELETE /rotations/{id} with If-Match, no body", async () => {
    const f = vi.fn().mockResolvedValue(json(200, { id: "rot_e2e_spare", deleted: true }));
    expect(await api(f).deleteRotation("rot_e2e_spare", { version: 3 })).toEqual({ id: "rot_e2e_spare", deleted: true });
    const r = sent(f);
    expect([r.method, r.url, r.headers["If-Match"], r.body]).toEqual(["DELETE", "http://x/api/v1/rotations/rot_e2e_spare", "3", undefined]);
  });
});

describe("503 BUSY on POST, PATCH and DELETE: sent again once; a second one is the caller's error", () => {
  const calls: [string, (a: ReturnType<typeof api>) => Promise<unknown>][] = [
    ["POST (create)", (a) => a.createRotation({ scope: "MSP", name: "N", cadence: "DAILY", handover: { minute: 540 }, members: ["ct_haeun"] })],
    ["PATCH (save)", (a) => a.saveRotation("rot_night", { name: "x" }, { version: 1, previewHash: HASH })],
    ["DELETE", (a) => a.deleteRotation("rot_night", { version: 1 })],
  ];
  it.each(calls)("%s: one BUSY then success", async (_n, run) => {
    const f = vi.fn().mockResolvedValueOnce(BUSY()).mockResolvedValueOnce(json(200, OK));
    await expect(run(api(f))).resolves.toEqual(OK);
    expect(f).toHaveBeenCalledTimes(2);
    // the same request again
    expect(sent(f, 1)).toEqual(sent(f, 0));
  });
  it.each(calls)("%s: two BUSY throws BUSY (503), after exactly two sends", async (_n, run) => {
    const f = vi.fn().mockImplementation(async () => BUSY());
    const e = await run(api(f)).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.code]).toEqual([503, "BUSY"]);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("another refusal is not sent again", async () => {
    const f = vi.fn().mockResolvedValue(json(409, { error: { code: "VERSION_CONFLICT", message: "m", requestId: "r", details: { currentVersion: 4 } } }));
    const e = await api(f).saveRotation("rot_night", { name: "x" }, { version: 1, previewHash: HASH }).catch((x) => x);
    expect([e.status, e.code, e.details.currentVersion]).toEqual([409, "VERSION_CONFLICT", 4]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
