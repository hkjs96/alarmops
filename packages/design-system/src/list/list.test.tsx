import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../scope/ConfirmDialog";
import { BOTTOM_BAND_PX, PRESS_FOLLOW_MS, SAME_SPOT_MS, SAME_SPOT_PX, clearSpot, followsPressAttr, installSameSpotGuard, isSameSpot, lastActionPress, markSpot, placeClearOfPress } from "./same-spot";
import { Tombstone } from "./Tombstone";
import { useStableRows } from "./useStableRows";

const at = (x: number, y: number, detail = 1) => ({ detail, clientX: x, clientY: y });
let now: ReturnType<typeof vi.spyOn>;
beforeEach(() => { now = vi.spyOn(performance, "now").mockReturnValue(10_000); clearSpot(); });
afterEach(() => now.mockRestore());

describe("same-spot guard: one rule for every list", () => {
  it("a second pointer press at the same spot within 600 ms is not a decision; later, elsewhere or by keyboard it is", () => {
    markSpot(at(300, 200));
    expect(isSameSpot(at(310, 190))).toBe(true);
    expect(isSameSpot(at(300, 240))).toBe(false); // another spot
    expect(isSameSpot(at(300, 200, 0))).toBe(false); // Enter / Space
    now.mockReturnValue(10_000 + SAME_SPOT_MS - 1);
    expect(isSameSpot(at(300, 200))).toBe(true);
    now.mockReturnValue(10_000 + SAME_SPOT_MS);
    expect(isSameSpot(at(300, 200))).toBe(false);
    markSpot(at(0, 0, 0)); // a keyboard action has no spot
    expect(isSameSpot(at(0, 0))).toBe(false);
  });
  it("installed on the document, the second press reaches nothing — whatever is under the pointer by then", () => {
    const off = installSameSpotGuard();
    const first = vi.fn((e: React.MouseEvent) => markSpot(e));
    const next = vi.fn();
    const { rerender } = render(<button onClick={first}>Remove Junho</button>);
    fireEvent.click(screen.getByRole("button"), at(300, 200));
    // the row is gone and the next row's button is where the pointer is
    rerender(<button onClick={next}>Remove Minjae</button>);
    fireEvent.click(screen.getByRole("button"), at(300, 200));
    expect([first.mock.calls.length, next.mock.calls.length]).toEqual([1, 0]);
    fireEvent.click(screen.getByRole("button"), at(300, 200, 0)); // keyboard: goes through
    now.mockReturnValue(10_000 + SAME_SPOT_MS + 1);
    fireEvent.click(screen.getByRole("button"), at(300, 200));
    expect(next).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("same-spot guard: what a press raises keeps clear of where it was pressed (QA P2-N)", () => {
  const box = (el: Element, left: number, top: number, width: number, height: number) => {
    el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
  };
  it("the guard remembers every pressed [data-list-action] with its box; a keyboard activation forgets it; it ages out", () => {
    const off = installSameSpotGuard();
    render(<><button data-list-action="incident.ack">Acknowledge</button><button>Plain</button><button data-list-action="x" disabled>Off</button></>);
    const ack = screen.getByRole("button", { name: "Acknowledge" });
    box(ack, 220, 620, 126, 44);
    expect(lastActionPress()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plain" }), at(10, 10));
    expect(lastActionPress()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Off" }), at(10, 10));
    expect(lastActionPress()).toBeNull();
    fireEvent.click(ack, at(274, 641));
    expect(lastActionPress()).toMatchObject({ x: 274, y: 641, box: { left: 220, top: 620, right: 346, bottom: 664 } });
    expect(isSameSpot(at(274, 641))).toBe(false); // remembering is not marking: the handler decides that
    now.mockReturnValue(10_000 + PRESS_FOLLOW_MS - 1);
    expect(lastActionPress()).not.toBeNull();
    now.mockReturnValue(10_000 + PRESS_FOLLOW_MS);
    expect(lastActionPress()).toBeNull();
    now.mockReturnValue(10_000);
    fireEvent.click(ack, at(274, 641, 0)); // Enter
    expect(lastActionPress()).toBeNull();
    off();
  });
  it("markSpot remembers the control it was given; without one, the point", () => {
    render(<button>Remove</button>);
    const b = screen.getByRole("button");
    box(b, 100, 300, 80, 28);
    markSpot({ ...at(120, 310), currentTarget: b });
    expect(lastActionPress()!.box).toEqual({ left: 100, top: 300, right: 180, bottom: 328 });
    markSpot(at(50, 60));
    expect(lastActionPress()!.box).toEqual({ left: 50, top: 60, right: 50, bottom: 60 });
    markSpot(at(50, 60, 0));
    expect(lastActionPress()).toBeNull();
  });
  it("placement: bottom unless the pressed control, slop included, reaches into the bottom band; then top", () => {
    expect(placeClearOfPress(740, null)).toBe("bottom");
    const press = (bottom: number) => ({ t: 0, x: 0, y: bottom - 22, box: { left: 200, top: bottom - 44, right: 340, bottom } });
    const edge = 740 - BOTTOM_BAND_PX - SAME_SPOT_PX;
    expect(placeClearOfPress(740, press(edge))).toBe("bottom");
    expect(placeClearOfPress(740, press(edge + 1))).toBe("top");
    expect(placeClearOfPress(740, press(664))).toBe("top"); // the panel's Acknowledge on a 360×740 phone
    expect(placeClearOfPress(915, press(664))).toBe("bottom");
  });
  it("an element that follows a press takes no pointer press inside the pressed control's box, for as long as it is there", () => {
    const off = installSameSpotGuard();
    const undo = vi.fn();
    render(<button data-list-action="incident.ack">Acknowledge</button>);
    const ack = screen.getByRole("button", { name: "Acknowledge" });
    box(ack, 220, 620, 126, 44);
    fireEvent.click(ack, at(274, 641));
    const follows = followsPressAttr();
    expect(follows).toBe("196,596,370,688");
    render(<div data-follows-press={follows}><button onClick={undo}>Undo</button></div>);
    const b = screen.getByRole("button", { name: "Undo" });
    for (const ms of [150, 400, 1000, 2000, 3000, 8000]) {
      now.mockReturnValue(10_000 + ms);
      fireEvent.click(b, at(274, 641));
      fireEvent.click(b, at(300, 660));
    }
    expect(undo).not.toHaveBeenCalled();
    fireEvent.click(b, at(274, 641, 0)); // keyboard
    fireEvent.click(b, at(274, 560)); // outside the box
    expect(undo).toHaveBeenCalledTimes(2);
    expect(followsPressAttr(null)).toBeUndefined();
    off();
  });
});

describe("ConfirmDialog", () => {
  const dlg = (p: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) => (
    <ConfirmDialog open title="Remove Junho Park from Responders of Daon Retail?" confirmLabel="Remove Junho Park from Daon Retail" cancelLabel="Keep Junho Park" onConfirm={() => undefined} onCancel={() => undefined} {...p}>body</ConfirmDialog>
  );
  it("the safe choice has the focus unless the caller says otherwise", () => {
    const { unmount } = render(dlg());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep Junho Park" }));
    unmount();
    render(dlg({ defaultFocus: "confirm" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Junho Park from Daon Retail" }));
  });
  it("a warning is shown first, as an alert", () => {
    render(dlg({ warning: "After this, nobody for Daon Retail is reached." }));
    const w = screen.getByTestId("confirm-warning");
    expect(w).toHaveAttribute("role", "alert");
    expect(w.parentElement!.firstElementChild).toBe(w);
  });
  it("a double click that opened the dialog does not also confirm it; the press that confirms marks the spot for what lies behind", () => {
    const onConfirm = vi.fn();
    markSpot(at(500, 400)); // the Remove… button was pressed here, and the dialog's button came up under it
    render(dlg({ onConfirm }));
    const ok = screen.getByRole("button", { name: /^Remove/ });
    fireEvent.click(ok, at(500, 400));
    expect(onConfirm).not.toHaveBeenCalled();
    now.mockReturnValue(10_000 + SAME_SPOT_MS + 1);
    fireEvent.click(ok, at(500, 400));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(isSameSpot(at(500, 400))).toBe(true);
  });
});

describe("Tombstone and useStableRows", () => {
  it("Removed · Undo: Undo names who comes back, is absent when nothing can be undone, and is guarded like every row action", () => {
    const onUndo = vi.fn();
    const { rerender } = render(<Tombstone label="Junho Park · Removed" name="Junho Park" onUndo={onUndo} action="responder.undo-remove" />);
    expect(screen.getByTestId("tombstone")).toHaveTextContent("Junho Park · Removed");
    const b = screen.getByRole("button", { name: "Undo: put Junho Park back" });
    expect(b).toHaveAttribute("data-list-action", "responder.undo-remove");
    markSpot(at(40, 40));
    fireEvent.click(b, at(40, 40));
    expect(onUndo).not.toHaveBeenCalled();
    fireEvent.click(b, at(40, 140));
    expect(onUndo).toHaveBeenCalledTimes(1);
    rerender(<Tombstone label="Junho Park · No longer in Responders" name="Junho Park" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("rows keep their place; a removed row stays as gone until resort; in append mode a new row goes last", () => {
    const a = [{ id: "junho" }, { id: "minjae" }, { id: "soyeon" }];
    const { result, rerender } = renderHook(({ items }) => useStableRows(items, "daon", { fresh: "append" }), { initialProps: { items: a } });
    rerender({ items: [{ id: "minjae" }, { id: "soyeon" }, { id: "jiwoo" }] });
    expect(result.current.rows.map((r) => [r.item.id, r.gone])).toEqual([["junho", true], ["minjae", false], ["soyeon", false], ["jiwoo", false]]);
    rerender({ items: [{ id: "soyeon" }, { id: "jiwoo" }] });
    expect(result.current.rows.map((r) => [r.item.id, r.gone])).toEqual([["junho", true], ["minjae", true], ["soyeon", false], ["jiwoo", false]]);
    rerender({ items: [{ id: "junho" }, { id: "soyeon" }, { id: "jiwoo" }] }); // Undo of the first removal: back in its place
    expect(result.current.rows.map((r) => [r.item.id, r.gone])).toEqual([["junho", false], ["minjae", true], ["soyeon", false], ["jiwoo", false]]);
    act(() => result.current.resort());
    expect(result.current.rows.map((r) => r.item.id)).toEqual(["junho", "soyeon", "jiwoo"]);
  });
  it("wait mode (a feed): new rows are counted, not inserted; another list key starts over; the view survives a remount through `keep`", () => {
    const keep = { current: null as unknown };
    const { result, rerender, unmount } = renderHook(({ items }) => useStableRows(items, "all", { keep }), { initialProps: { items: [{ id: "a" }, { id: "b" }] } });
    rerender({ items: [{ id: "n" }, { id: "a" }] });
    expect(result.current.rows.map((r) => [r.item.id, r.gone])).toEqual([["a", false], ["b", true]]);
    expect(result.current.pending).toEqual({ text: "1 no longer in this list · 1 new", button: "Show and re-sort" });
    unmount();
    const again = renderHook(() => useStableRows([{ id: "n" }, { id: "a" }], "all", { keep }));
    expect(again.result.current.rows.map((r) => r.item.id)).toEqual(["a", "b"]);
    const other = renderHook(() => useStableRows([{ id: "n" }, { id: "a" }], "mine", { keep }));
    expect(other.result.current.rows.map((r) => r.item.id)).toEqual(["n", "a"]);
  });
});
