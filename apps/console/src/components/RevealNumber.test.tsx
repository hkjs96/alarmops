/**
 * D-35 in the console, component level: the button exists only where the API says canReveal; an ADMIN who is not a
 * responder must type a reason first; the value is shown for REVEAL_SHOW_MS and is masked again on Hide, on the timer,
 * when the tab hides and on unmount; the value is never put in storage, the address or the console log; refusals say so.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import type { RevealResult } from "@/lib/api/types";

const reveal = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/app/reveal/actions", () => ({ revealContact: (...a: unknown[]) => reveal.fn(...a) }));

import { REVEAL_SHOW_MS, RevealNumber } from "./RevealNumber";

const VALUE = "010-8028-3028";
const ok = (mode: "NORMAL" | "EMERGENCY"): ActionResult<RevealResult> => ({ ok: true, data: { channel: "PHONE", value: VALUE, mode, revealedAt: "2026-11-27T00:00:00Z", auditId: "crl_1" } });
const refuse = (code: string, details?: Record<string, unknown>): ActionResult<RevealResult> => ({ ok: false, code, message: code, requestId: "r1", ...(details ? { details } : {}) } as ActionResult<RevealResult>);

function mount(p: Partial<React.ComponentProps<typeof RevealNumber>> = {}) {
  return render(<RevealNumber contactId="ct_hyunwoo" name="Hyunwoo Ahn" customerName="Hanbit" channel="PHONE" canReveal requiresReason={false} {...p} />);
}
const press = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); };

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); reveal.fn.mockReset(); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("RevealNumber: who sees the button", () => {
  it("canReveal=false (Viewer, non-responder Operator, staff of another customer): no button at all", () => {
    mount({ canReveal: false });
    expect(screen.queryByTestId("reveal-show")).toBeNull();
    expect(reveal.fn).not.toHaveBeenCalled();
  });
  it("a responder gets Show number; the normal path sends no reason", async () => {
    reveal.fn.mockResolvedValue(ok("NORMAL"));
    mount();
    await press(screen.getByTestId("reveal-show"));
    expect(reveal.fn).toHaveBeenCalledWith("ct_hyunwoo", "PHONE", undefined);
    expect(screen.getByTestId("reveal-value")).toHaveTextContent(VALUE);
    expect(screen.getByTestId("reveal-note")).toHaveTextContent("Shown to you · logged");
  });
});

describe("RevealNumber: emergency reveal (ADMIN who is not a responder)", () => {
  it("asks for a typed reason first, never calls the API without it, then shows the emergency line", async () => {
    reveal.fn.mockResolvedValue(ok("EMERGENCY"));
    mount({ requiresReason: true });
    const btn = screen.getByTestId("reveal-show");
    expect(btn).toHaveTextContent("Show number (emergency)…");
    await press(btn);
    expect(reveal.fn).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: /Show number and log/ });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId("reveal-reason"), { target: { value: "   " } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId("reveal-reason"), { target: { value: "  SEV-1, nobody answers  " } });
    await press(confirm);
    expect(reveal.fn).toHaveBeenCalledWith("ct_hyunwoo", "PHONE", "SEV-1, nobody answers");
    expect(screen.getByTestId("reveal-value")).toHaveTextContent(VALUE);
    // D-35 / #39: delivery is not implemented, so the copy says "recorded", never "notified".
    expect(screen.getByTestId("reveal-note")).toHaveTextContent("Emergency reveal · logged for review · no alert is sent");
    expect(screen.getByTestId("reveal-note")).not.toHaveTextContent(/notified/i);
  });
  it("uses the same recorded-only copy when the customer has no primary responder", async () => {
    reveal.fn.mockResolvedValue(ok("EMERGENCY"));
    mount({ requiresReason: true, hasPrimary: false });
    await press(screen.getByTestId("reveal-show"));
    expect(document.body).toHaveTextContent("No alert is sent. The reveal is recorded in the audit log with your name and this reason, under Emergency reveals.");
    expect(document.body).not.toHaveTextContent(/will be notified/i);
    fireEvent.change(screen.getByTestId("reveal-reason"), { target: { value: "why" } });
    await press(screen.getByRole("button", { name: /Show number and log/ }));
    expect(screen.getByTestId("reveal-note")).toHaveTextContent("Emergency reveal · logged for review · no alert is sent");
  });
});

describe("RevealNumber: re-mask", () => {
  async function shown() {
    reveal.fn.mockResolvedValue(ok("NORMAL"));
    const view = mount();
    await press(screen.getByTestId("reveal-show"));
    expect(screen.getByTestId("reveal")).toHaveAttribute("data-revealed", "1");
    return view;
  }
  it("Hide puts the button back and the value is gone from the page", async () => {
    await shown();
    await press(screen.getByTestId("reveal-hide"));
    expect(screen.getByTestId("reveal")).toHaveAttribute("data-revealed", "0");
    expect(document.body.textContent).not.toContain(VALUE);
    expect(screen.getByTestId("reveal-live")).toHaveTextContent("Value hidden again.");
  });
  it("hides by itself after REVEAL_SHOW_MS (30 s)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    reveal.fn.mockResolvedValue(ok("NORMAL"));
    mount();
    await press(screen.getByTestId("reveal-show"));
    expect(REVEAL_SHOW_MS).toBe(30_000);
    await act(async () => { vi.advanceTimersByTime(REVEAL_SHOW_MS - 1_000); });
    expect(screen.getByTestId("reveal-value")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1_500); });
    expect(screen.queryByTestId("reveal-value")).toBeNull();
    expect(document.body.textContent).not.toContain(VALUE);
  });
  it("hides when the tab is hidden, and on pagehide", async () => {
    await shown();
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.queryByTestId("reveal-value")).toBeNull();
    vis.mockRestore();
    await press(screen.getByTestId("reveal-show"));
    expect(screen.getByTestId("reveal-value")).toBeInTheDocument();
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(screen.queryByTestId("reveal-value")).toBeNull();
  });
  it("leaving the screen (unmount) drops the value; a new mount starts masked and does not call the API", async () => {
    const view = await shown();
    view.unmount();
    expect(document.body.textContent).not.toContain(VALUE);
    reveal.fn.mockClear();
    mount();
    expect(screen.getByTestId("reveal")).toHaveAttribute("data-revealed", "0");
    expect(reveal.fn).not.toHaveBeenCalled();
  });
});

describe("RevealNumber: the value is kept nowhere but the component state", () => {
  it("not in localStorage, sessionStorage, the address, a data attribute or the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    reveal.fn.mockResolvedValue(ok("NORMAL"));
    const view = mount();
    await press(screen.getByTestId("reveal-show"));
    expect(screen.getByTestId("reveal-value")).toHaveTextContent(VALUE);
    expect(JSON.stringify({ ...localStorage })).not.toContain(VALUE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(VALUE);
    expect(location.href).not.toContain(VALUE);
    expect(view.container.innerHTML.replace(`>${VALUE}<`, "")).not.toContain(VALUE);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(VALUE);
    expect(screen.getByTestId("reveal-live").textContent).not.toContain(VALUE);
  });
});

describe("RevealNumber: refusals", () => {
  it.each([
    ["NOT_A_RESPONDER", undefined, /only for this customer.s responders \(Hanbit\)\. Nothing was shown/],
    ["ROLE_REQUIRED", { role: "OPERATOR" }, /needs the Operator role/],
    ["NOT_FOUND", undefined, /Not found/],
    ["RATE_LIMITED", { retryAfterSec: 12 }, /Try again in 12 s/],
  ])("%s: a plain line, no value, the button stays", async (code, details, text) => {
    reveal.fn.mockResolvedValue(refuse(code, details));
    mount();
    await press(screen.getByTestId("reveal-show"));
    expect(screen.getByTestId("reveal-err")).toHaveTextContent(text);
    expect(screen.queryByTestId("reveal-value")).toBeNull();
    expect(screen.getByTestId("reveal-show")).toBeEnabled();
  });
  it("a 429 on the emergency path closes the dialog, says when to retry next to the button and shows no value", async () => {
    reveal.fn.mockResolvedValue(refuse("RATE_LIMITED", { retryAfterSec: 90 }));
    mount({ requiresReason: true });
    await press(screen.getByTestId("reveal-show"));
    fireEvent.change(screen.getByTestId("reveal-reason"), { target: { value: "why" } });
    await press(screen.getByRole("button", { name: /Show number and log/ }));
    expect(screen.getByTestId("reveal-err")).toHaveTextContent(/Try again in 90 s/);
    expect(screen.queryByTestId("reveal-value")).toBeNull();
    expect(screen.queryByTestId("reveal-reason")).toBeNull();
  });
  it("EMERGENCY_REASON_REQUIRED from the server keeps the dialog open with the line, no value", async () => {
    reveal.fn.mockResolvedValue(refuse("EMERGENCY_REASON_REQUIRED"));
    mount({ requiresReason: true });
    await press(screen.getByTestId("reveal-show"));
    fireEvent.change(screen.getByTestId("reveal-reason"), { target: { value: "why" } });
    await press(screen.getByRole("button", { name: /Show number and log/ }));
    expect(screen.getByTestId("reveal-dialog-err")).toHaveTextContent(/Type why you need this contact/);
    expect(screen.queryByTestId("reveal-value")).toBeNull();
  });
});
