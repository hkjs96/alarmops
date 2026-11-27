import { describe, expect, it, vi } from "vitest";
import { ApiError, createHttpApi, withBusyRetry } from "./api/client";
import type { TemplatePreview } from "./api/types";
import { errorText } from "./errors";
import { blockedCustomers, draftKey, effectString, saveGate, saveLabel, templateErrorText, type PreviewState } from "./templates";

const saved = { name: "Infra core", members: ["a", "b"] };
const prev = (blocking: TemplatePreview["blocking"] = []): TemplatePreview => ({ templateId: "t", version: 1, customers: [], totals: { customers: 2, affected: 2, joins: 1, leaves: 0, warnings: 0 }, blocking, previewHash: "0".repeat(64) });
const ready = (d: typeof saved, blocking: TemplatePreview["blocking"] = []): PreviewState => ({ status: "ready", key: draftKey(d), preview: prev(blocking) });
const gate = (o: Partial<Parameters<typeof saveGate>[0]> & { draft: typeof saved }) => saveGate({ admin: true, roleWhy: "needs Admin", saved, preview: { status: "idle" }, busy: false, ...o });

describe("effect wording", () => {
  it("each effect has a mark and words", () => {
    expect(effectString({ kind: "JOINS", contactId: "c", name: "Dohyun Kang" })).toBe("+ Dohyun Kang joins Responders");
    expect(effectString({ kind: "LEAVES", contactId: "c", name: "Junho Park" })).toBe("− Junho Park leaves Responders");
    expect(effectString({ kind: "STAYS_DIRECT", contactId: "c", name: "Junho Park" })).toBe("= Junho Park stays (added directly)");
    expect(effectString({ kind: "ALREADY_DIRECT", contactId: "c", name: "Junho Park" })).toBe("= Junho Park is already in Responders (added directly) — no change");
    expect(effectString({ kind: "STEP_NAMES", contactId: "c", name: "Junho Park", stepIndex: 2 })).toBe("! step 2 still names Junho Park — fix in the customer");
  });
  it("labels", () => {
    expect(saveLabel(7)).toBe("Save template for 7 customers");
    expect(saveLabel(1)).toBe("Save template for 1 customer");
    expect(saveLabel(0)).toBe("Save template");
  });
});

describe("Save is on only for a changed, valid, previewed draft with nothing blocking", () => {
  const changed = { name: "Infra core", members: ["a", "b", "c"] };
  it("not admin: off, with the role reason", () => expect(gate({ admin: false, draft: changed })).toEqual({ enabled: false, reason: "needs Admin" }));
  it("nothing changed: off", () => expect(gate({ draft: saved }).enabled).toBe(false));
  it("invalid (no name, nobody): off with the problem", () => {
    expect(gate({ draft: { name: " ", members: ["a"] } }).reason).toBe("Enter a name.");
    expect(gate({ draft: { name: "X", members: [] } }).reason).toBe("Add at least one person.");
  });
  it("no preview yet, loading, or the preview of another draft: off", () => {
    expect(gate({ draft: changed }).enabled).toBe(false);
    expect(gate({ draft: changed, preview: { status: "loading", key: draftKey(changed) } }).enabled).toBe(false);
    expect(gate({ draft: changed, preview: ready({ name: "Infra core", members: ["a"] }) }).enabled).toBe(false);
  });
  it("blocking: off while it is not empty, on when it is", () => {
    const g = gate({ draft: changed, preview: ready(changed, [{ customerId: "c1", reason: "UNREACHABLE" }]) });
    expect(g.enabled).toBe(false);
    expect(g.reason).toContain("Blocked");
    expect(gate({ draft: changed, preview: ready(changed) })).toEqual({ enabled: true, reason: null });
  });
  it("busy: off", () => expect(gate({ draft: changed, preview: ready(changed), busy: true }).enabled).toBe(false));
  it("members in another order are the same draft", () => expect(draftKey({ name: "x", members: ["b", "a"] })).toBe(draftKey({ name: "x", members: ["a", "b"] })));
});

it("blocking is grouped by customer", () => {
  expect(blockedCustomers([{ customerId: "1", reason: "UNREACHABLE" }, { customerId: "1", reason: "SEND_CAP_EXCEEDED" }, { customerId: "2", reason: "UNREACHABLE" }], (i) => `C${i}`))
    .toEqual([{ customerId: "1", name: "C1", reasons: ["UNREACHABLE", "SEND_CAP_EXCEEDED"] }, { customerId: "2", name: "C2", reasons: ["UNREACHABLE"] }]);
});

describe("error copy says what was not done and what to do", () => {
  const f = (code: string, details?: Record<string, unknown>) => ({ code, message: "", details });
  it.each([
    ["WOULD_BE_UNREACHABLE", { customerIds: ["a", "b"] }, "Not saved. After this change nobody could be called for 2 customers. Nothing was changed."],
    ["RESPONDER_LIMIT_EXCEEDED", { customerIds: ["a"] }, "Not saved. After this change a step that calls everyone in Responders would reach more than 20 people for 1 customer. Nothing was changed."],
    ["SEND_CAP_EXCEEDED", { customerIds: ["a", "b", "c"] }, "for 3 customers. Nothing was changed."],
    ["PREVIEW_STALE", undefined, "Not saved. The template or its customers changed after the preview was made. Nothing was changed. Review the new preview, then save again."],
    ["BUSY", undefined, "The system was busy with another change, so this was not done. Nothing was changed. Try again in a moment."],
  ])("%s", (code, details, text) => expect(errorText(f(code, details))).toContain(text));
  it("template-only cases", () => {
    expect(templateErrorText(f("ALREADY_EXISTS"), { name: "Infra core" })).toBe("Not saved. A template named “Infra core” already exists. Nothing was changed. Choose a different name.");
    expect(templateErrorText(f("CUSTOMER_TERMINATED"), { where: "Iruda Studio" })).toContain("Iruda Studio is terminated");
    expect(templateErrorText(f("VERSION_CONFLICT"))).toContain("Reload");
  });
  it("one customer is named when the context has it", () => expect(errorText(f("WOULD_BE_UNREACHABLE", { customerIds: ["a"] }), { where: "Mirae Pay" })).toContain("for Mirae Pay."));
});

describe("503 BUSY is sent again once after Retry-After", () => {
  const busy = () => new ApiError(503, "BUSY", "busy", "r", { retryAfterSec: 2 });
  it("retries once, waiting Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    const send = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue("ok");
    expect(await withBusyRetry(send, sleep)).toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });
  it("a second BUSY is thrown; other errors are not retried", async () => {
    const send = vi.fn().mockRejectedValue(busy());
    await expect(withBusyRetry(send, async () => {})).rejects.toMatchObject({ code: "BUSY" });
    expect(send).toHaveBeenCalledTimes(2);
    const other = vi.fn().mockRejectedValue(new ApiError(409, "PREVIEW_STALE", "x", "r"));
    await expect(withBusyRetry(other, async () => {})).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(other).toHaveBeenCalledTimes(1);
  });
  it("the HTTP client reads the Retry-After header and retries the template write", async () => {
    const body = (s: number, o: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status: s, headers: h });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(body(503, { error: { code: "BUSY", message: "b", requestId: "r", details: {} } }, { "retry-after": "1" }))
      .mockResolvedValueOnce(body(200, { templateId: "t", version: 1, customers: [], totals: {}, blocking: [], previewHash: "h" }));
    const sleep = vi.fn(async () => {});
    const api = createHttpApi({ baseUrl: "http://x", fetch: fetchMock as unknown as typeof fetch, sleep });
    await api.previewResponderTemplate("t", { name: "n" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});
