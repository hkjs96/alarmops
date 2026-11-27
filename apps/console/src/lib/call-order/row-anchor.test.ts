// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { correction, holdRow, pickAnchor, restoreRow, takeHeldRow } from "./row-anchor";

const box = (key: string, top: number, h = 50) => ({ key, top, bottom: top + h });

describe("pickAnchor: the row that was being looked at", () => {
  it("is the edited row while any part of it is on screen", () => {
    expect(pickAnchor([box("a", 10), box("b", 400), box("c", 850)], 900, "c")).toEqual({ key: "c", top: 850 });
    expect(pickAnchor([box("a", -30), box("b", 20)], 900, "a")).toEqual({ key: "a", top: -30 });
  });
  it("is the topmost visible row when the edited row is off screen", () => {
    expect(pickAnchor([box("a", -80), box("b", 20), box("c", 100), box("z", 2000)], 900, "z")).toEqual({ key: "b", top: 20 });
    expect(pickAnchor([box("c", 100), box("b", 20)], 900, undefined)).toEqual({ key: "b", top: 20 });
  });
  it("is null when nothing is on screen", () => {
    expect(pickAnchor([box("a", -200), box("b", 1000)], 900, "a")).toBeNull();
    expect(pickAnchor([], 900, "a")).toBeNull();
  });
});

describe("correction", () => {
  it("is how far the row moved, and nothing inside the half pixel", () => {
    expect(correction({ key: "a", top: 820 }, 984.5)).toBe(164.5);
    expect(correction({ key: "a", top: 100 }, 60)).toBe(-40);
    expect(correction({ key: "a", top: 100 }, 100.3)).toBe(0);
  });
});

describe("holdRow / restoreRow on a page", () => {
  const scrolledTo = (y: number) => Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); takeHeldRow(); scrolledTo(0); });
  const page = (tops: Record<string, number>) => {
    document.body.innerHTML = Object.keys(tops).map((k) => `<table><tbody><tr data-row-key="${k}"></tr></tbody></table>`).join("");
    for (const tr of document.querySelectorAll<HTMLElement>("tr")) {
      vi.spyOn(tr, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
      vi.spyOn(tr, "getBoundingClientRect").mockImplementation(() => ({ top: tops[tr.dataset.rowKey!]!, bottom: tops[tr.dataset.rowKey!]! + 50 } as DOMRect));
    }
  };

  it("scrolls the window by the distance the row moved", () => {
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    const by = vi.fn();
    window.scrollBy = by as unknown as typeof window.scrollBy;
    const tops = { a: 100, b: 820 };
    page(tops);
    scrolledTo(300);
    holdRow("b");
    const a = takeHeldRow()!;
    expect(a).toEqual({ key: "b", top: 820 });
    tops.b = 984.5; // the list widened and re-laid out: the row slid down
    expect(restoreRow(a)).toBe(true);
    expect(by).toHaveBeenCalledWith({ top: 164.5, behavior: "instant" });
  });

  it("does nothing when the row is already in place, and says so when the row is gone", () => {
    const by = vi.fn();
    window.scrollBy = by as unknown as typeof window.scrollBy;
    page({ a: 100 });
    expect(restoreRow({ key: "a", top: 100 })).toBe(true);
    expect(by).not.toHaveBeenCalled();
    expect(restoreRow({ key: "nope", top: 100 })).toBe(false);
  });

  it("takes the note once", () => {
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    page({ a: 100 });
    scrolledTo(300);
    holdRow("a");
    expect(takeHeldRow()).not.toBeNull();
    expect(takeHeldRow()).toBeNull();
  });

  it("holds nothing while the view is at the top: the list goes back to where it starts", () => {
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    page({ a: 100, b: 820 });
    scrolledTo(0);
    holdRow("b");
    expect(takeHeldRow()).toBeNull();
  });
});
