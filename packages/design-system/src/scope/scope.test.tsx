import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import {
  DirtyGuard, OutsideLine, Panel, ScopeLine, ScopeSheet, ScopeTree,
  buildTree, clampTreeWidth, highlightParts, matchesNode, normalizeSel, resolveSel, selKey, selLabel, treeKey,
  MY_KEY, OTHER_KEY, ROOT_KEY, type ScopeCustomerNode, type ScopeSel, type TreeRow,
} from "../index";

const svc = (name: string, open = 0, own = false) => ({ id: `s_${name}`, slug: name.toLowerCase().replace(/\s+/g, "-"), name, openIncidents: open, ownSteps: own });
const prj = (name: string, services: ReturnType<typeof svc>[], own = false) => ({ ...svc(name, services.reduce((n, s) => n + s.openIncidents, 0), own), services });
const cus = (slug: string, name: string, mine: boolean, projects: ReturnType<typeof prj>[], callHealth: ScopeCustomerNode["callHealth"] = "OK"): ScopeCustomerNode =>
  ({ id: `c_${slug}`, slug, name, mine, callHealth, projects, openIncidents: projects.reduce((n, p) => n + p.openIncidents, 0) });

/** Shape of the mockup data: Checkout exists under two customers. */
const CUSTOMERS: ScopeCustomerNode[] = [
  cus("mirae", "Mirae Pay", true, [prj("Core", [svc("Payments API", 1), svc("Settlement"), svc("Checkout")]), prj("Merchant", [svc("Merchant portal")]), prj("Data platform", [svc("Ledger")], true)]),
  cus("daon", "Daon Retail", false, [prj("Commerce", [svc("Checkout"), svc("Search")]), prj("Platform", [svc("EKS prod", 1)])]),
  cus("hanbit", "Hanbit Logistics", false, [prj("Tracking", [svc("Public API", 1)]), prj("Fulfilment", [svc("Orders API", 0, true)])]),
  cus("ara", "Ara Games", true, [prj("Live ops", [svc("Game API")])]),
  cus("kumho", "Kumho Clinic", false, [prj("Main", [svc("EMR")])], "UNREACHABLE"),
  cus("lumen", "Lumen Bank", false, [prj("Main", [svc("Core banking")])], "AT_RISK"),
];
const keys = (rows: TreeRow[]) => rows.map((r) => r.key);

describe("scope selection", () => {
  it("normalizes", () => {
    expect(normalizeSel({ project: "core" })).toEqual({});
    expect(normalizeSel({ customer: "a", service: "x" })).toEqual({ customer: "a" });
    expect(normalizeSel({ customer: "a", mine: true })).toEqual({ customer: "a" });
    expect(selKey({})).toBe(ROOT_KEY);
    expect(selKey({ mine: true })).toBe(MY_KEY);
    expect(selKey({ customer: "a", project: "b", service: "c" })).toBe("a/b/c");
  });
  it("resolves, and tells unknown from none", () => {
    expect(resolveSel(CUSTOMERS, {})).toBeNull();
    expect(resolveSel(CUSTOMERS, { customer: "nope" })).toBeUndefined();
    expect(resolveSel(CUSTOMERS, { customer: "mirae", project: "commerce" })).toBeUndefined();
    expect(selLabel(CUSTOMERS, { customer: "mirae", project: "core", service: "checkout" })).toBe("Mirae Pay › Core › Checkout");
    expect(selLabel(CUSTOMERS, { mine: true })).toBe("My customers");
    expect(selLabel(CUSTOMERS, {})).toBe("All customers");
  });
  it("clamps the width to 200–360", () => {
    expect([clampTreeWidth(10), clampTreeWidth(272.4), clampTreeWidth(999)]).toEqual([200, 272, 360]);
  });
});

describe("tree rows", () => {
  it("default: All customers, My customers open, Other customers collapsed with totals", () => {
    const v = buildTree(CUSTOMERS, { sel: {} });
    expect(keys(v.rows)).toEqual([ROOT_KEY, MY_KEY, "mirae", "ara", OTHER_KEY]);
    expect(v.rows[0]).toMatchObject({ selected: true, count: 6 });
    const other = v.rows.at(-1)!;
    expect(other).toMatchObject({ expanded: false, count: 4, openIncidents: 2, health: "UNREACHABLE", sel: null });
  });
  it("the chosen branch is open and marked; its group opens too", () => {
    const v = buildTree(CUSTOMERS, { sel: { customer: "daon", project: "commerce", service: "checkout" } });
    expect(keys(v.rows)).toEqual([ROOT_KEY, MY_KEY, "mirae", "ara", OTHER_KEY, "daon", "daon/commerce", "daon/commerce/checkout", "daon/commerce/search", "daon/platform", "hanbit", "kumho", "lumen"]);
    expect(v.rows.filter((r) => r.selected).map((r) => r.key)).toEqual(["daon/commerce/checkout"]);
    expect(v.rows.find((r) => r.key === "daon/commerce/checkout")).toMatchObject({ level: 4, depth: 2, hasKids: false });
  });
  it("a collapsed row that holds the filter says so", () => {
    const sel = { customer: "mirae", project: "core", service: "checkout" };
    const v = buildTree(CUSTOMERS, { sel, expanded: { mirae: false } });
    expect(v.rows.find((r) => r.key === "mirae")).toMatchObject({ expanded: false, filterInside: true, selected: false });
    const g = buildTree(CUSTOMERS, { sel: { customer: "daon" }, expanded: { [OTHER_KEY]: false } });
    expect(g.rows.find((r) => r.key === OTHER_KEY)).toMatchObject({ filterInside: true });
  });
  it("My customers is a filter row; customers never carry Own steps, projects and services do", () => {
    const v = buildTree(CUSTOMERS, { sel: { mine: true }, expanded: { mirae: true, hanbit: true, "hanbit/fulfilment": true, [OTHER_KEY]: true } });
    expect(v.rows.find((r) => r.key === MY_KEY)).toMatchObject({ selected: true, sel: { mine: true } });
    expect(v.rows.find((r) => r.key === ROOT_KEY)!.selected).toBe(false);
    expect(v.rows.find((r) => r.key === "mirae")).toMatchObject({ ownSteps: false, ownInside: 1 });
    expect(v.rows.find((r) => r.key === "mirae/data-platform")!.ownSteps).toBe(true);
    expect(v.rows.find((r) => r.key === "hanbit/fulfilment/orders-api")!.ownSteps).toBe(true);
    expect(v.rows.find((r) => r.key === "kumho")!.health).toBe("UNREACHABLE");
    expect(v.rows.find((r) => r.key === "lumen")!.health).toBe("AT_RISK");
    expect(v.rows.find((r) => r.key === "ara")!.health).toBeNull();
  });
  it("without any customer of mine there is one group called Customers", () => {
    const v = buildTree(CUSTOMERS.map((c) => ({ ...c, mine: false })), { sel: {} });
    expect(v.rows[1]).toMatchObject({ key: OTHER_KEY, label: "Customers", expanded: true });
  });
});

describe("Only with problems", () => {
  it("keeps customers with an open incident or a call-health problem and opens Other customers", () => {
    const v = buildTree(CUSTOMERS, { sel: {}, problemsOnly: true });
    expect(v.problemCount).toBe(5);
    expect(keys(v.rows)).toEqual([ROOT_KEY, MY_KEY, "mirae", OTHER_KEY, "daon", "hanbit", "kumho", "lumen"]);
    expect(v.rows.find((r) => r.key === MY_KEY)).toMatchObject({ shown: 1, count: 2 });
  });
  it("below a customer only levels with a problem stay, plus the chosen one", () => {
    const v = buildTree(CUSTOMERS, { sel: { customer: "mirae", project: "merchant" }, problemsOnly: true, expanded: { "mirae/core": true } });
    expect(keys(v.rows).filter((k) => k.startsWith("mirae"))).toEqual(["mirae", "mirae/core", "mirae/core/payments-api", "mirae/merchant"]);
  });
  it("keeps the chosen customer even when it has no problem", () => {
    const v = buildTree(CUSTOMERS, { sel: { customer: "ara" }, problemsOnly: true });
    expect(keys(v.rows)).toContain("ara");
  });
  it("is ignored while text is typed", () => {
    const v = buildTree(CUSTOMERS, { sel: {}, problemsOnly: true, query: "ara" });
    expect(keys(v.rows)).toContain("ara");
  });
});

describe("filter as you type", () => {
  it("matches word starts of the path, and at least one word of the node's own name", () => {
    expect(matchesNode(["mirae", "check"], "Checkout", "Mirae Pay Core Checkout")).toBe(true);
    expect(matchesNode(["mirae", "check"], "Core", "Mirae Pay Core")).toBe(false);
    expect(matchesNode(["ay"], "Mirae Pay", "Mirae Pay")).toBe(false); // not inside a word
    expect(matchesNode(["pay"], "Mirae Pay", "Mirae Pay")).toBe(true);
    expect(matchesNode([], "x", "x")).toBe(false);
  });
  it("shows the ancestors of a match and nothing else", () => {
    const v = buildTree(CUSTOMERS, { sel: {}, query: "settle" });
    expect(keys(v.rows)).toEqual([ROOT_KEY, MY_KEY, "mirae", "mirae/core", "mirae/core/settlement"]);
    expect(v.rows.filter((r) => r.hit).map((r) => r.key)).toEqual(["mirae/core/settlement"]);
    expect(v).toMatchObject({ hits: 1, hitCustomers: 1, onlyHit: "mirae/core/settlement" });
  });
  it("duplicate names: both shown under their own customer, none is the single hit", () => {
    const v = buildTree(CUSTOMERS, { sel: {}, query: "checkout" });
    expect(v.rows.filter((r) => r.hit).map((r) => r.key)).toEqual(["mirae/core/checkout", "daon/commerce/checkout"]);
    expect(v).toMatchObject({ hits: 2, hitCustomers: 2, onlyHit: null });
    expect(keys(v.rows)).toEqual([ROOT_KEY, MY_KEY, "mirae", "mirae/core", "mirae/core/checkout", OTHER_KEY, "daon", "daon/commerce", "daon/commerce/checkout"]);
    expect(v.rows.filter((r) => r.selected).map((r) => r.key)).toEqual([ROOT_KEY]); // typing never selects
  });
  it("more words narrow a duplicate to one", () => {
    expect(buildTree(CUSTOMERS, { sel: {}, query: "mirae check" })).toMatchObject({ hits: 1, onlyHit: "mirae/core/checkout" });
    expect(buildTree(CUSTOMERS, { sel: {}, query: "daon  CHECK " })).toMatchObject({ hits: 1, onlyHit: "daon/commerce/checkout" });
  });
  it("a customer match stays collapsed; groups show n of m", () => {
    const v = buildTree(CUSTOMERS, { sel: {}, query: "lum" });
    expect(keys(v.rows)).toEqual([ROOT_KEY, OTHER_KEY, "lumen"]);
    expect(v.rows[1]).toMatchObject({ shown: 1, count: 4 });
  });
  it("no match leaves only All customers", () => {
    const v = buildTree(CUSTOMERS, { sel: {}, query: "zzz" });
    expect(keys(v.rows)).toEqual([ROOT_KEY]);
    expect(v.hits).toBe(0);
  });
  it("marks the typed start of each word", () => {
    expect(highlightParts("Payments API", ["pay", "a"])).toEqual([{ text: "Pay", mark: true }, { text: "ments", mark: false }, { text: " ", mark: false }, { text: "A", mark: true }, { text: "PI", mark: false }]);
    expect(highlightParts("Core", [])).toEqual([{ text: "Core", mark: false }]);
  });
});

describe("keyboard", () => {
  const open = buildTree(CUSTOMERS, { sel: { customer: "mirae", project: "core" } }).rows;
  it("↑ ↓ Home End", () => {
    expect(treeKey(open, "mirae", "ArrowDown").cur).toBe("mirae/core");
    expect(treeKey(open, "mirae", "ArrowUp").cur).toBe(MY_KEY);
    expect(treeKey(open, ROOT_KEY, "ArrowUp").cur).toBe(ROOT_KEY);
    expect(treeKey(open, "mirae", "Home").cur).toBe(ROOT_KEY);
    expect(treeKey(open, "mirae", "End").cur).toBe(OTHER_KEY);
    expect(treeKey(open, OTHER_KEY, "ArrowDown").cur).toBe(OTHER_KEY);
  });
  it("→ expands, then goes to the first child; on a leaf it stays", () => {
    expect(treeKey(open, "mirae/merchant", "ArrowRight")).toMatchObject({ toggle: "mirae/merchant" });
    expect(treeKey(open, "mirae/core", "ArrowRight").cur).toBe("mirae/core/payments-api");
    expect(treeKey(open, MY_KEY, "ArrowRight").cur).toBe("mirae");
    expect(treeKey(open, "mirae/core/checkout", "ArrowRight").cur).toBe("mirae/core/checkout");
    expect(treeKey(open, OTHER_KEY, "ArrowRight")).toMatchObject({ toggle: OTHER_KEY });
  });
  it("← collapses, then goes to the parent", () => {
    expect(treeKey(open, "mirae/core", "ArrowLeft")).toMatchObject({ toggle: "mirae/core" });
    expect(treeKey(open, "mirae/core/checkout", "ArrowLeft").cur).toBe("mirae/core");
    expect(treeKey(open, "mirae/merchant", "ArrowLeft").cur).toBe("mirae");
    expect(treeKey(open, "ara", "ArrowLeft").cur).toBe(MY_KEY);
  });
  it("Enter chooses; on Other customers it only expands", () => {
    expect(treeKey(open, "mirae/core/checkout", "Enter")).toMatchObject({ pick: "mirae/core/checkout" });
    expect(treeKey(open, MY_KEY, " ")).toMatchObject({ pick: MY_KEY });
    expect(treeKey(open, OTHER_KEY, "Enter")).toMatchObject({ toggle: OTHER_KEY });
    expect(treeKey(open, "mirae", "Enter").toggle).toBeUndefined();
  });
  it("type-ahead moves to the next row starting with the letters", () => {
    expect(treeKey(open, ROOT_KEY, "s")).toMatchObject({ cur: "mirae/core/settlement", typeahead: "s" });
    expect(treeKey(open, "mirae/core/settlement", "e", { typeahead: "s" })).toMatchObject({ cur: "mirae/core/settlement", typeahead: "se" });
    expect(treeKey(open, "mirae", "m")).toMatchObject({ cur: "mirae/merchant" }); // next one, not itself
    expect(treeKey(open, "mirae/merchant", "m").cur).toBe("mirae");
  });
  it("type-ahead opens a collapsed group to reach a customer", () => {
    expect(treeKey(open, ROOT_KEY, "h", { customers: CUSTOMERS })).toMatchObject({ cur: "hanbit", openGroup: OTHER_KEY });
    expect(treeKey(open, ROOT_KEY, "z", { customers: CUSTOMERS })).toMatchObject({ handled: true, cur: ROOT_KEY });
  });
  it("while searching ↑ ↓ step between matches only", () => {
    const rows = buildTree(CUSTOMERS, { sel: {}, query: "checkout" }).rows;
    expect(treeKey(rows, "mirae/core/checkout", "ArrowDown", { searching: true }).cur).toBe("daon/commerce/checkout");
    expect(treeKey(rows, "daon/commerce/checkout", "ArrowUp", { searching: true }).cur).toBe("mirae/core/checkout");
    expect(treeKey(rows, "daon/commerce/checkout", "ArrowDown", { searching: true }).cur).toBe("daon/commerce/checkout");
  });
  it("Enter with several matches and no choice selects nothing, however often", () => {
    const rows = buildTree(CUSTOMERS, { sel: {}, query: "checkout" }).rows;
    for (let n = 0; n < 3; n++) {
      const r = treeKey(rows, "mirae/core/checkout", "Enter", { searching: true, ambiguous: true });
      expect(r).toMatchObject({ handled: true, refuse: true });
      expect(r.pick).toBeUndefined();
    }
    // the first arrow confirms the highlighted match instead of skipping it; then Enter chooses
    expect(treeKey(rows, "mirae/core/checkout", "ArrowDown", { searching: true, ambiguous: true }).cur).toBe("mirae/core/checkout");
    expect(treeKey(rows, "mirae/core/checkout", "Enter", { searching: true }).pick).toBe("mirae/core/checkout");
  });
  it("leaves other keys alone", () => {
    expect(treeKey(open, "mirae", "Escape").handled).toBe(false);
    expect(treeKey(open, "mirae", "F5").handled).toBe(false);
  });
});

function Harness({ initial = {}, rail = false, onPick }: { initial?: ScopeSel; rail?: boolean; onPick?: (s: ScopeSel) => void }) {
  const [sel, setSel] = useState<ScopeSel>(initial);
  const [r, setR] = useState(rail);
  const [w, setW] = useState(272);
  return <ScopeTree customers={CUSTOMERS} value={sel} onChange={(s) => { setSel(s); onPick?.(s); }} rail={r} onRailChange={setR} width={w} onWidthChange={setW} me="Haeun" />;
}
const item = (name: RegExp | string) => screen.getByRole("treeitem", { name });

describe("<ScopeTree>", () => {
  beforeEach(() => sessionStorage.clear());

  it("has tree semantics: levels, selection, expansion, active descendant", () => {
    render(<Harness initial={{ customer: "mirae", project: "core" }} />);
    const tree = screen.getByRole("tree", { name: "Customers, projects and services" });
    expect(item(/^All customers/)).toHaveAttribute("aria-level", "1");
    expect(item(/Mirae Pay/)).toHaveAttribute("aria-level", "2");
    expect(item(/Mirae Pay/)).toHaveAttribute("aria-expanded", "true");
    expect(item(/^Core/)).toHaveAttribute("aria-selected", "true");
    expect(item(/Settlement/)).toHaveAttribute("aria-level", "4");
    expect(item(/Settlement/)).not.toHaveAttribute("aria-expanded");
    expect(tree.getAttribute("aria-activedescendant")).toBe(item(/^Core/).id);
  });
  it("shows the tags: open count, one call-health tag, Own steps", () => {
    render(<Harness initial={{ customer: "kumho" }} />);
    expect(within(item(/Kumho Clinic/)).getByText("Unreachable")).toBeInTheDocument();
    expect(within(item(/Lumen Bank/)).getByText("At risk")).toBeInTheDocument();
    expect(within(item(/Mirae Pay/)).getByText("1")).toBeInTheDocument();
    expect(within(item(/Mirae Pay/)).getByRole("img", { name: "Contains own steps" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand Mirae Pay" }));
    expect(within(item(/Data platform/)).getByText("Own steps")).toBeInTheDocument();
    expect(within(item(/Mirae Pay/)).queryByText("Own steps")).toBeNull();
  });
  it("the name chooses; the arrow only expands", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Mirae Pay" }));
    expect(onPick).not.toHaveBeenCalled();
    expect(item(/^Core/)).toBeInTheDocument();
    fireEvent.click(item(/^Core/));
    expect(onPick).toHaveBeenLastCalledWith({ customer: "mirae", project: "core" });
    fireEvent.click(item(/My customers/));
    expect(onPick).toHaveBeenLastCalledWith({ mine: true });
    fireEvent.click(item(/Other customers/));
    expect(onPick).toHaveBeenCalledTimes(2); // Other customers is not a filter
    expect(item(/Daon Retail/)).toBeInTheDocument();
  });
  it("keyboard: ↓ → Enter reaches a service without the mouse", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const tree = screen.getByRole("tree");
    tree.focus();
    for (const k of ["ArrowDown", "ArrowDown", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowDown", "ArrowDown", "Enter"]) fireEvent.keyDown(tree, { key: k });
    expect(onPick).toHaveBeenCalledWith({ customer: "mirae", project: "core", service: "checkout" });
    fireEvent.keyDown(tree, { key: "Home" });
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onPick).toHaveBeenLastCalledWith({});
  });
  it("type-ahead opens Other customers for a customer inside it", () => {
    render(<Harness />);
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "k" });
    expect(tree.getAttribute("aria-activedescendant")).toBe(item(/Kumho Clinic/).id);
  });
  it("typing filters, shows ancestors, and one match is chosen with Enter; the search then clears", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const box = screen.getByRole("textbox", { name: /Filter the tree/ });
    fireEvent.change(box, { target: { value: "settle" } });
    expect(screen.getByRole("status")).toHaveTextContent("1 match · Enter selects it");
    expect(screen.queryByRole("treeitem", { name: /Ara Games/ })).toBeNull();
    expect(item(/Mirae Pay/)).toBeInTheDocument();
    expect(item(/Settlement/).querySelector("mark")).toHaveTextContent("Settle");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({ customer: "mirae", project: "core", service: "settlement" });
    expect(box).toHaveValue("");
    expect(item(/Ara Games/)).toBeInTheDocument();
  });
  it("duplicate names: Enter never auto-selects, the hint says so, ↓ then Enter chooses", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const box = screen.getByRole("textbox", { name: /Filter the tree/ });
    const tree = screen.getByRole("tree");
    fireEvent.change(box, { target: { value: "checkout" } });
    expect(screen.getByRole("status")).toHaveTextContent("2 matches in 2 customers · nothing is selected until you choose one");
    expect(screen.getAllByRole("treeitem", { name: /Checkout/ })).toHaveLength(2);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(document.activeElement).toBe(tree);
    fireEvent.keyDown(tree, { key: "Enter" });
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("2 matches · nothing selected. Use ↑↓ to choose one, then Enter.");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith({ customer: "daon", project: "commerce", service: "checkout" });
  });
  it("Escape clears the search; no match says so", () => {
    render(<Harness />);
    const box = screen.getByRole("textbox", { name: /Filter the tree/ });
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText(/No customer, project or service starts with “zzz”/)).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveValue("");
    expect(item(/Mirae Pay/)).toBeInTheDocument();
  });
  it("Only with problems is a switch with the count, and is remembered for the session", () => {
    const { unmount } = render(<Harness />);
    const sw = screen.getByRole("switch", { name: /Only with problems/ });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveTextContent("5");
    // the number is explained to a screen reader and on hover (QA P3-B)
    expect(sw).toHaveAccessibleName("Only with problems, 5 customers with problems");
    expect(screen.getByTestId("problem-count")).toHaveAttribute("title", "5 customers with problems");
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("treeitem", { name: /Ara Games/ })).toBeNull();
    expect(item(/Kumho Clinic/)).toBeInTheDocument();
    unmount();
    render(<Harness />);
    expect(screen.getByRole("switch", { name: /Only with problems/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("treeitem", { name: /Ara Games/ })).toBeNull();
  });
  it("remembers what was expanded by hand", () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Ara Games" }));
    expect(item(/Live ops/)).toBeInTheDocument();
    unmount();
    render(<Harness />);
    expect(item(/Live ops/)).toBeInTheDocument();
  });
  it("collapses to a rail that states the filter, and opens again", () => {
    render(<Harness initial={{ customer: "mirae", project: "core" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse the tree to a narrow rail" }));
    expect(screen.queryByRole("tree")).toBeNull();
    const railBtn = screen.getByRole("button", { name: "Open the customer tree beside the list. Showing: Mirae Pay › Core" });
    expect(railBtn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(railBtn);
    expect(screen.getByRole("tree")).toBeInTheDocument();
  });
  it("resizes with the keyboard within 200–360", () => {
    render(<Harness />);
    const sep = screen.getByRole("separator");
    expect(sep).toHaveAttribute("aria-valuenow", "272");
    for (let n = 0; n < 10; n++) fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(sep).toHaveAttribute("aria-valuenow", "360");
    expect(screen.getByRole("complementary", { name: "Customer tree" })).toHaveStyle({ width: "360px" });
    for (let n = 0; n < 20; n++) fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(sep).toHaveAttribute("aria-valuenow", "200");
  });
});

describe("<ScopeLine> / <OutsideLine>", () => {
  const base = { totalCustomers: 14, mineCustomers: 7 };
  it("states the filter as text, with × per level", () => {
    const onClear = vi.fn();
    const { container } = render(<ScopeLine {...base} customer="Mirae Pay" project="Core" onClear={onClear} />);
    expect(container.querySelector(".sline-desk")).toHaveTextContent("Mirae Pay×›Core×›All services");
    fireEvent.click(screen.getByRole("button", { name: "Clear Core · show all of Mirae Pay" }));
    expect(onClear).toHaveBeenLastCalledWith("project");
    fireEvent.click(screen.getByRole("button", { name: "Clear Mirae Pay · show all customers" }));
    expect(onClear).toHaveBeenLastCalledWith("customer");
    expect(screen.queryByRole("button", { name: /Clear .* show all of Core/ })).toBeNull();
  });
  it("All customers has nothing to clear; My customers has", () => {
    const { container, rerender } = render(<ScopeLine {...base} onClear={() => undefined} />);
    expect(container.querySelector(".sline-desk")).toHaveTextContent("All customers · 14");
    expect(container.querySelector(".sline-desk button")).toBeNull();
    rerender(<ScopeLine {...base} mine onClear={() => undefined} />);
    expect(container.querySelector(".sline-desk")).toHaveTextContent("My customers · 7");
    expect(screen.getByRole("button", { name: "Show all customers" })).toBeInTheDocument();
  });
  it("the phone line is one button that opens the picker", () => {
    const open = vi.fn();
    render(<ScopeLine {...base} customer="Daon Retail" project="Commerce" service="Checkout" onClear={() => undefined} onOpenPicker={open} />);
    const b = screen.getByRole("button", { name: /Showing\s*Daon Retail\s*Commerce\s*Checkout/ });
    expect(b).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(b);
    expect(open).toHaveBeenCalled();
  });
  it("outside line: open includes unmapped; zero unmapped is not mentioned; nothing outside is one calm line", () => {
    const p = { href: "/incidents", filterLabel: "Mirae Pay", totalCustomers: 14 };
    const { rerender } = render(<OutsideLine {...p} open={3} unmapped={1} acknowledged={3} />);
    expect(screen.getByRole("link")).toHaveTextContent("Outside this view: 3 open (1 from an unmapped account) · 3 acknowledged");
    expect(screen.getByRole("link")).toHaveAttribute("href", "/incidents");
    rerender(<OutsideLine {...p} open={2} unmapped={0} acknowledged={2} />);
    expect(screen.getByRole("link")).toHaveTextContent("Outside this view: 2 open · 2 acknowledged");
    rerender(<OutsideLine {...p} open={0} unmapped={0} acknowledged={0} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Outside this view: no incidents")).toBeInTheDocument();
  });
  it("explains the numbers on request", () => {
    render(<OutsideLine href="/incidents" filterLabel="Mirae Pay" totalCustomers={14} open={3} unmapped={1} acknowledged={3} />);
    fireEvent.click(screen.getByRole("button", { name: "What do these numbers mean?" }));
    expect(screen.getByRole("note")).toHaveTextContent("your filter (Mirae Pay) hides");
  });
});

describe("<ScopeSheet>", () => {
  const setup = (value: ScopeSel = {}) => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<ScopeSheet open customers={CUSTOMERS} value={value} onApply={onApply} onClose={onClose} />);
    return { onApply, onClose };
  };
  it("steps Customer → Project → Service without typing", () => {
    const { onApply } = setup();
    expect(screen.getByRole("dialog", { name: "Choose a customer" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Daon Retail/ }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Choose a project of Daon Retail" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Commerce/ }));
    expect(screen.getByRole("dialog", { name: "Choose a service of Commerce" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Checkout/ }));
    expect(onApply).toHaveBeenCalledWith({ customer: "daon", project: "commerce", service: "checkout" });
  });
  it("opens on the step that holds the current choice and marks it", () => {
    setup({ customer: "mirae", project: "core", service: "checkout" });
    expect(screen.getByRole("dialog", { name: "Choose a service of Core" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Checkout/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "3 · Service" })).toHaveAttribute("aria-current", "step");
  });
  it("“Use X only” applies exactly the scope it names", () => {
    const { onApply } = setup({ customer: "mirae", project: "core", service: "checkout" });
    fireEvent.click(screen.getByRole("button", { name: "Use Mirae Pay › Core only" }));
    expect(onApply).toHaveBeenLastCalledWith({ customer: "mirae", project: "core" });
    fireEvent.click(screen.getByRole("button", { name: "1 · Customer" }));
    fireEvent.click(screen.getByRole("button", { name: /Hanbit Logistics/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use Hanbit Logistics only" }));
    expect(onApply).toHaveBeenLastCalledWith({ customer: "hanbit" });
  });
  it("Back goes one step; Close and Escape change nothing", () => {
    const { onApply, onClose } = setup({ customer: "mirae", project: "core" });
    expect(screen.getByRole("dialog", { name: "Choose a project of Mirae Pay" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(screen.getByRole("dialog", { name: "Choose a customer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "← Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onApply).not.toHaveBeenCalled();
  });
  it("step 1 lists All / My customers, my customers first, and filters by name", () => {
    const { onApply } = setup();
    const rows = screen.getAllByTestId("sheet-customer").map((r) => r.textContent);
    expect(rows.slice(0, 2).join()).toMatch(/Mirae Pay.*Ara Games/);
    fireEvent.change(screen.getByRole("textbox", { name: "Find a customer by name" }), { target: { value: "lu" } });
    expect(screen.getAllByTestId("sheet-customer")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /My customers · 2/ }));
    expect(onApply).toHaveBeenLastCalledWith({ mine: true });
    fireEvent.click(screen.getByRole("button", { name: /All customers · 6/ }));
    expect(onApply).toHaveBeenLastCalledWith({});
  });
  it("renders nothing when closed", () => {
    const { container } = render(<ScopeSheet open={false} customers={CUSTOMERS} value={{}} onApply={() => undefined} onClose={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("<Panel>", () => {
  it("header band: initials + full path, customer in bold; focus goes to the heading", () => {
    render(<Panel kind="Incident" path={["Mirae Pay", "Core", "Payments API"]} onClose={() => undefined}>body</Panel>);
    // each › belongs to the name before it: a wrapped line never starts with a separator (QA P3-B)
    expect(Array.from(screen.getByTestId("panel-path").children).map((c) => c.textContent)).toEqual(["Mirae Pay›", "Core›", "Payments API"]);
    const h = screen.getByRole("heading", { level: 2 });
    expect(h).toHaveTextContent("Mirae Pay›Core›Payments API");
    expect(h.querySelector("b")).toHaveTextContent("Mirae Pay");
    expect(document.activeElement).toBe(h);
    expect(screen.getByRole("complementary", { name: "Detail panel" }).querySelector(".panel-id")).toHaveTextContent("MP");
  });
  it("close, Back to the list and Escape all close", () => {
    const onClose = vi.fn();
    render(<Panel kind="Incident" path={null} pathLabel="Unmapped account" onClose={onClose}>body</Panel>);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Unmapped account");
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.click(screen.getByRole("button", { name: "← Back to the list" }));
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
  it("Copy link confirms", async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    render(<Panel kind="Incident" path={["Daon Retail"]} onClose={() => undefined} onCopyLink={onCopy}>body</Panel>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy link" })); });
    expect(onCopy).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Link copied");
  });
});

describe("<DirtyGuard>", () => {
  it("offers Save / Keep draft / Discard / Cancel with the full path, and traps focus", () => {
    const fn = { onSave: vi.fn(), onKeepDraft: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() };
    render(<DirtyGuard open scopeLabel="Mirae Pay › Core" leavingTo="change the filter" {...fn} />);
    const dlg = screen.getByRole("alertdialog", { name: "Unsaved changes for Mirae Pay › Core" });
    const names = within(dlg).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Save for Mirae Pay › Core", "Keep draft and change the filter", "Discard changes", "Cancel"]);
    expect(document.activeElement).toHaveTextContent("Save for Mirae Pay › Core");
    fireEvent.keyDown(dlg, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toHaveTextContent("Cancel");
    fireEvent.keyDown(dlg, { key: "Tab" });
    expect(document.activeElement).toHaveTextContent("Save for");
    for (const n of names) fireEvent.click(within(dlg).getByRole("button", { name: n! }));
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect([fn.onSave, fn.onKeepDraft, fn.onDiscard].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(fn.onCancel).toHaveBeenCalledTimes(2);
  });
  it("is absent when closed", () => {
    render(<DirtyGuard open={false} scopeLabel="x" onSave={() => undefined} onKeepDraft={() => undefined} onDiscard={() => undefined} onCancel={() => undefined} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
