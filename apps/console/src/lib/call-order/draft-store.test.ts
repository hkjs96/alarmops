import { beforeEach, describe, expect, it } from "vitest";
import type { PagingConfigInput } from "../api/types";
import { DRAFT_PREFIX, clearDraft, listDrafts, loadDraft, parseDraft, saveDraft } from "./draft-store";
import { OWNER_KEY, claimStorageFor, clearUserStorage } from "../user-storage";
import { setBackGuard, setEditIntent, setFocusRow, takeBackGuard, takeEditIntent, takeFocusRow } from "./flags";

const value: PagingConfigInput = { style: "CUSTOM", plan: "STANDARD", repeatCount: 1, steps: [{ atMin: 0, targetType: "ROTATION", targetId: "rot_night", channels: ["SLACK_DM", "VOICE"] }, { atMin: 13, targetType: "PERSON", targetId: "ct_yuna", channels: ["VOICE"] }] };
const U = "usr_haeun";
const K = DRAFT_PREFIX + U + "/";
const draft = (scope: string, label: string, user = U) => ({ user, scope, label, baseVersion: 3, creating: false, value });

describe("call-order draft store (per user and scope, sessionStorage)", () => {
  beforeEach(() => sessionStorage.clear());

  it("keeps a draft under its own scope and gives it back unchanged", () => {
    expect(saveDraft(draft("mirae", "Mirae Pay"), 1000)).toBe(true);
    expect(sessionStorage.getItem(K + "mirae")).not.toBeNull();
    expect(loadDraft(U, "mirae")).toEqual({ v: 2, at: 1000, ...draft("mirae", "Mirae Pay") });
  });
  it("a draft is never applied to another scope — not a wider one, not a narrower one, not another customer", () => {
    saveDraft(draft("mirae/core/checkout", "Mirae Pay › Core › Checkout"), 1);
    expect(loadDraft(U, "mirae")).toBeNull();
    expect(loadDraft(U, "mirae/core")).toBeNull();
    expect(loadDraft(U, "daon")).toBeNull();
    // even if storage is tampered with so the key and the content disagree
    sessionStorage.setItem(K + "daon", sessionStorage.getItem(K + "mirae/core/checkout")!);
    expect(loadDraft(U, "daon")).toBeNull();
    expect(listDrafts(U).map((d) => d.scope)).toEqual(["mirae/core/checkout"]);
  });
  it("several drafts live side by side, newest first; clearing one leaves the others", () => {
    saveDraft(draft("mirae", "Mirae Pay"), 10);
    saveDraft({ ...draft("hanbit/fulfilment/orders-api", "Hanbit Logistics › Fulfilment › Orders API"), creating: true, baseVersion: null, widenedFrom: "hanbit/fulfilment/orders-api" }, 30);
    saveDraft(draft("daon", "Daon Retail"), 20);
    expect(listDrafts(U).map((d) => d.scope)).toEqual(["hanbit/fulfilment/orders-api", "daon", "mirae"]);
    clearDraft(U, "daon");
    expect(listDrafts(U).map((d) => d.scope)).toEqual(["hanbit/fulfilment/orders-api", "mirae"]);
    expect(loadDraft(U, "hanbit/fulfilment/orders-api")).toMatchObject({ creating: true, baseVersion: null });
  });
  it("saving again replaces the draft of that scope", () => {
    saveDraft(draft("mirae", "Mirae Pay"), 1);
    saveDraft({ ...draft("mirae", "Mirae Pay"), value: { ...value, repeatCount: 0 } }, 2);
    expect(loadDraft(U, "mirae")?.value.repeatCount).toBe(0);
    expect(listDrafts(U)).toHaveLength(1);
  });
  it("keeps the version the edit started from, and half-typed values", () => {
    saveDraft({ ...draft("mirae", "Mirae Pay"), baseVersion: 7, value: { ...value, steps: [value.steps[0]!, { ...value.steps[1]!, atMin: -1 }] } }, 1);
    const d = loadDraft(U, "mirae")!;
    expect(d.baseVersion).toBe(7);
    expect(d.value.steps[1]!.atMin).toBe(-1);
  });
  it("anything that is not exactly a draft is no draft", () => {
    expect(parseDraft(null, U)).toBeNull();
    expect(parseDraft("not json", U)).toBeNull();
    expect(parseDraft("{}", U)).toBeNull();
    const ok = JSON.stringify({ v: 2, at: 1, ...draft("mirae", "Mirae Pay") });
    expect(parseDraft(ok, U)).not.toBeNull();
    expect(parseDraft(ok.replace('"v":2', '"v":1'), U)).toBeNull();
    expect(parseDraft(ok.replace('"scope":"mirae"', '"scope":"../x"'), U)).toBeNull();
    expect(parseDraft(ok.replace('"VOICE"', '"FAX"'), U)).toBeNull();
    expect(parseDraft(ok.replace('"CUSTOM"', '"WHATEVER"'), U)).toBeNull();
    expect(parseDraft(ok.replace('"atMin":13', '"atMin":"13"'), U)).toBeNull();
    sessionStorage.setItem(K + "mirae", "{broken");
    expect(loadDraft(U, "mirae")).toBeNull();
    expect(listDrafts(U)).toEqual([]);
  });
  it("holds no contact values: ids, minutes and channel kinds only", () => {
    saveDraft(draft("mirae", "Mirae Pay"), 1);
    const raw = sessionStorage.getItem(K + "mirae")!;
    expect(raw).not.toMatch(/@|010-|\+82/);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["at", "baseVersion", "creating", "label", "scope", "user", "v", "value"]);
  });
  it("storage that refuses (private mode, full) does not throw: the draft just is not kept", () => {
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("denied"); }, key: () => null, length: 0 };
    expect(saveDraft(draft("mirae", "Mirae Pay"), 1, refusing)).toBe(false);
    expect(loadDraft(U, "mirae", refusing)).toBeNull();
    expect(() => clearDraft(U, "mirae", refusing)).not.toThrow();
    expect(saveDraft(draft("mirae", "Mirae Pay"), 1, null)).toBe(false);
  });
});

describe("drafts belong to one user (security review 권고 1)", () => {
  beforeEach(() => sessionStorage.clear());
  it("another user in the same tab neither sees nor loads a draft, even with the key copied under their id", () => {
    saveDraft(draft("mirae", "Mirae Pay"), 1);
    expect(listDrafts("usr_minjae")).toEqual([]);
    expect(loadDraft("usr_minjae", "mirae")).toBeNull();
    sessionStorage.setItem(DRAFT_PREFIX + "usr_minjae/mirae", sessionStorage.getItem(K + "mirae")!);
    expect(loadDraft("usr_minjae", "mirae")).toBeNull(); // the draft says whose it is
    expect(listDrafts("usr_minjae")).toEqual([]);
    expect(listDrafts(U)).toHaveLength(1);
    expect(listDrafts("")).toEqual([]);
  });
  it("sign-out removes every ao- key; a change of user removes what the other one left before anything reads it", () => {
    saveDraft(draft("mirae", "Mirae Pay"), 1);
    setEditIntent({ scope: "mirae" }); setFocusRow("mirae");
    sessionStorage.setItem("ao-scope-shell", "{}"); sessionStorage.setItem("other-app", "stays");
    expect(claimStorageFor(U)).toBe(true); // a tab without an owner on record: nothing is inherited
    expect(listDrafts(U)).toEqual([]);
    saveDraft(draft("mirae", "Mirae Pay"), 2);
    expect(claimStorageFor(U)).toBe(false); // the same user again (reload, session renewed): the draft stays
    expect(listDrafts(U)).toHaveLength(1);
    expect(claimStorageFor("usr_minjae")).toBe(true);
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith("ao-"))).toEqual([OWNER_KEY]);
    expect(sessionStorage.getItem(OWNER_KEY)).toBe("usr_minjae");
    saveDraft(draft("daon", "Daon Retail", "usr_minjae"), 3);
    expect(clearUserStorage()).toBe(2);
    expect(Object.keys(sessionStorage)).toEqual(["other-app"]);
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
