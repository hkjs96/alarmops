import { beforeEach, describe, expect, it } from "vitest";
import type { PagingConfigInput } from "../api/types";
import { DRAFT_PREFIX, clearDraft, listDrafts, loadDraft, parseDraft, saveDraft } from "./draft-store";
import { setBackGuard, setEditIntent, setFocusRow, takeBackGuard, takeEditIntent, takeFocusRow } from "./flags";

const value: PagingConfigInput = { style: "CUSTOM", plan: "STANDARD", repeatCount: 1, steps: [{ atMin: 0, targetType: "ROTATION", targetId: "rot_night", channels: ["SLACK_DM", "VOICE"] }, { atMin: 13, targetType: "PERSON", targetId: "ct_yuna", channels: ["VOICE"] }] };
const draft = (scope: string, label: string) => ({ scope, label, baseVersion: 3, creating: false, value });

describe("call-order draft store (per scope, sessionStorage)", () => {
  beforeEach(() => sessionStorage.clear());

  it("keeps a draft under its own scope and gives it back unchanged", () => {
    expect(saveDraft(draft("mirae", "Mirae Pay"), 1000)).toBe(true);
    expect(sessionStorage.getItem(DRAFT_PREFIX + "mirae")).not.toBeNull();
    expect(loadDraft("mirae")).toEqual({ v: 1, at: 1000, ...draft("mirae", "Mirae Pay") });
  });
  it("a draft is never applied to another scope — not a wider one, not a narrower one, not another customer", () => {
    saveDraft(draft("mirae/core/checkout", "Mirae Pay › Core › Checkout"), 1);
    expect(loadDraft("mirae")).toBeNull();
    expect(loadDraft("mirae/core")).toBeNull();
    expect(loadDraft("daon")).toBeNull();
    // even if storage is tampered with so the key and the content disagree
    sessionStorage.setItem(DRAFT_PREFIX + "daon", sessionStorage.getItem(DRAFT_PREFIX + "mirae/core/checkout")!);
    expect(loadDraft("daon")).toBeNull();
    expect(listDrafts().map((d) => d.scope)).toEqual(["mirae/core/checkout"]);
  });
  it("several drafts live side by side, newest first; clearing one leaves the others", () => {
    saveDraft(draft("mirae", "Mirae Pay"), 10);
    saveDraft({ ...draft("hanbit/fulfilment/orders-api", "Hanbit Logistics › Fulfilment › Orders API"), creating: true, baseVersion: null, widenedFrom: "hanbit/fulfilment/orders-api" }, 30);
    saveDraft(draft("daon", "Daon Retail"), 20);
    expect(listDrafts().map((d) => d.scope)).toEqual(["hanbit/fulfilment/orders-api", "daon", "mirae"]);
    clearDraft("daon");
    expect(listDrafts().map((d) => d.scope)).toEqual(["hanbit/fulfilment/orders-api", "mirae"]);
    expect(loadDraft("hanbit/fulfilment/orders-api")).toMatchObject({ creating: true, baseVersion: null });
  });
  it("saving again replaces the draft of that scope", () => {
    saveDraft(draft("mirae", "Mirae Pay"), 1);
    saveDraft({ ...draft("mirae", "Mirae Pay"), value: { ...value, repeatCount: 0 } }, 2);
    expect(loadDraft("mirae")?.value.repeatCount).toBe(0);
    expect(listDrafts()).toHaveLength(1);
  });
  it("keeps the version the edit started from, and half-typed values", () => {
    saveDraft({ ...draft("mirae", "Mirae Pay"), baseVersion: 7, value: { ...value, steps: [value.steps[0]!, { ...value.steps[1]!, atMin: -1 }] } }, 1);
    const d = loadDraft("mirae")!;
    expect(d.baseVersion).toBe(7);
    expect(d.value.steps[1]!.atMin).toBe(-1);
  });
  it("anything that is not exactly a draft is no draft", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("not json")).toBeNull();
    expect(parseDraft("{}")).toBeNull();
    const ok = JSON.stringify({ v: 1, at: 1, ...draft("mirae", "Mirae Pay") });
    expect(parseDraft(ok)).not.toBeNull();
    expect(parseDraft(ok.replace('"v":1', '"v":2'))).toBeNull();
    expect(parseDraft(ok.replace('"scope":"mirae"', '"scope":"../x"'))).toBeNull();
    expect(parseDraft(ok.replace('"VOICE"', '"FAX"'))).toBeNull();
    expect(parseDraft(ok.replace('"CUSTOM"', '"WHATEVER"'))).toBeNull();
    expect(parseDraft(ok.replace('"atMin":13', '"atMin":"13"'))).toBeNull();
    sessionStorage.setItem(DRAFT_PREFIX + "mirae", "{broken");
    expect(loadDraft("mirae")).toBeNull();
    expect(listDrafts()).toEqual([]);
  });
  it("holds no contact values: ids, minutes and channel kinds only", () => {
    saveDraft(draft("mirae", "Mirae Pay"), 1);
    const raw = sessionStorage.getItem(DRAFT_PREFIX + "mirae")!;
    expect(raw).not.toMatch(/@|010-|\+82/);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["at", "baseVersion", "creating", "label", "scope", "v", "value"]);
  });
  it("storage that refuses (private mode, full) does not throw: the draft just is not kept", () => {
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("denied"); }, key: () => null, length: 0 };
    expect(saveDraft(draft("mirae", "Mirae Pay"), 1, refusing)).toBe(false);
    expect(loadDraft("mirae", refusing)).toBeNull();
    expect(() => clearDraft("mirae", refusing)).not.toThrow();
    expect(saveDraft(draft("mirae", "Mirae Pay"), 1, null)).toBe(false);
  });
});

describe("one-shot notes between the list and the panel", () => {
  beforeEach(() => sessionStorage.clear());
  it("an edit intent is for one scope and is used once", () => {
    setEditIntent({ scope: "hanbit", widenedFrom: "hanbit/fulfilment/orders-api" });
    expect(takeEditIntent("mirae")).toBeNull(); // not for this panel — and forgotten, so it cannot fire later somewhere else
    expect(takeEditIntent("hanbit")).toBeNull();
    setEditIntent({ scope: "hanbit", widenedFrom: "hanbit/fulfilment/orders-api" });
    expect(takeEditIntent("hanbit")).toEqual({ scope: "hanbit", widenedFrom: "hanbit/fulfilment/orders-api" });
    expect(takeEditIntent("hanbit")).toBeNull();
  });
  it("the row to focus is read once", () => {
    setFocusRow("mirae/data-platform");
    expect(takeFocusRow()).toBe("mirae/data-platform");
    expect(takeFocusRow()).toBeNull();
  });
  it("the Back note is for one scope, once, and only for a moment", () => {
    setBackGuard("mirae", 1000);
    expect(takeBackGuard("daon", 1100)).toBe(false); // another panel passing by does not use it up
    expect(takeBackGuard("mirae", 1500)).toBe(true);
    expect(takeBackGuard("mirae", 1600)).toBe(false); // once
    setBackGuard("mirae", 1000);
    expect(takeBackGuard("mirae", 9000)).toBe(false); // stale: a later visit must not open the editor by itself
    expect(takeBackGuard("mirae", 1000)).toBe(false);
  });
});
