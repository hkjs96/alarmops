import { mergeView, pendingOf, pendingText, startView } from "./stable-list";

const r = (id: string, status = "TRIGGERED") => ({ id, status });

describe("stable list", () => {
  it("keeps the on-screen order whatever the server sends; changed rows update in place", () => {
    const v = startView([r("a"), r("b"), r("c")], "k");
    const m = mergeView(v, [r("b"), r("c"), r("a", "ACKNOWLEDGED")]);
    expect(m.rows.map((x) => `${x.item.id}:${x.item.status}`)).toEqual(["a:ACKNOWLEDGED", "b:TRIGGERED", "c:TRIGGERED"]);
    expect(pendingText(pendingOf(m))).toEqual({ text: "1 acknowledged in place", button: "Re-sort" });
  });
  it("new rows wait outside, rows that left stay as gone", () => {
    const v = startView([r("a"), r("b")], "k");
    const m = mergeView(v, [r("n1"), r("n2"), r("n3"), r("a"), r("b")]);
    expect(m.rows.map((x) => x.item.id)).toEqual(["a", "b"]);
    expect(pendingText(pendingOf(m))).toEqual({ text: "3 new", button: "Show" });
    const g = mergeView(m, [r("b")]);
    expect(g.rows.map((x) => [x.item.id, x.gone])).toEqual([["a", true], ["b", false]]);
    expect(pendingText(pendingOf(g))).toEqual({ text: "1 no longer in this list", button: "Re-sort" });
    // it comes back (Undo of a Resolve): the same place, not gone
    expect(mergeView(g, [r("a"), r("b")]).rows.every((x) => !x.gone)).toBe(true);
  });
  it("nothing waiting when a status change does not change the order; undo clears it", () => {
    const v = startView([r("a"), r("b", "ACKNOWLEDGED")], "k");
    expect(pendingText(pendingOf(mergeView(v, [r("a"), r("b", "ACKNOWLEDGED")])))).toBeNull();
    const m = mergeView(v, [r("b", "TRIGGERED"), r("a")]);
    expect(pendingText(pendingOf(m))?.text).toBe("1 reopened in place");
    expect(pendingText(pendingOf(mergeView(m, [r("a"), r("b", "ACKNOWLEDGED")])))).toBeNull();
    expect(pendingText(pendingOf(mergeView(v, [r("b", "ACKNOWLEDGED"), r("a")])))?.text).toBe("Order changed");
  });
  it("append mode: a row the user added goes after the last row; a removed row stays as gone; nothing above moves", () => {
    const v = startView([{ id: "a" }, { id: "b" }], "k");
    const m = mergeView(v, [{ id: "n" }, { id: "b" }], "append");
    expect(m.rows.map((x) => [x.item.id, x.gone])).toEqual([["a", true], ["b", false], ["n", false]]);
    expect(pendingOf(m).fresh).toBe(0);
    // the removed row comes back (Undo): the same place
    expect(mergeView(m, [{ id: "a" }, { id: "n" }, { id: "b" }], "append").rows.map((x) => [x.item.id, x.gone])).toEqual([["a", false], ["b", false], ["n", false]]);
  });
  it("an empty list takes whatever arrives", () => {
    expect(mergeView(startView<{ id: string; status: string }>([], "k"), [r("a")]).rows).toHaveLength(1);
  });
});
