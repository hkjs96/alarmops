import { fireEvent, render, screen } from "@testing-library/react";
import {
  ScopeLine, ScopeSearch, ScopeSheet, ScopeTree, buildTree, searchScopes, treeKey, type ScopeCustomerNode, type ScopeSel,
} from "../index";

const svc = (name: string, open = 0, own = false) => ({ id: `s_${name}`, slug: name.toLowerCase().replace(/\s+/g, "-"), name, openIncidents: open, ownSteps: own });
const prj = (name: string, services: ReturnType<typeof svc>[], own = false) => ({ ...svc(name, services.reduce((n, s) => n + s.openIncidents, 0), own), services });
const cus = (slug: string, name: string, mine: boolean, projects: ReturnType<typeof prj>[]): ScopeCustomerNode =>
  ({ id: `c_${slug}`, slug, name, mine, callHealth: "OK", projects, openIncidents: projects.reduce((n, p) => n + p.openIncidents, 0) });

/** The server's order is not alphabetical; Checkout exists under two customers, one of them mine. */
const CUSTOMERS: ScopeCustomerNode[] = [
  cus("mirae", "Mirae Pay", true, [prj("Core", [svc("Payments API", 1), svc("Checkout")]), prj("Data platform", [svc("Ledger")], true)]),
  cus("zio", "Zio Fashion", false, [prj("Main", [svc("Web")])]),
  cus("nuri", "Nuri Soft", false, [prj("Main", [svc("Web")])]),
  cus("daon", "Daon Retail", false, [prj("Commerce", [svc("Checkout"), svc("Search")])]),
  cus("bora", "Bora Foods", true, [prj("Main", [svc("Web"), svc("Orders")])]),
  cus("maru", "Maru Homes", false, [prj("Main", [svc("Web")])]),
];

describe("Other customers are listed by name (QA P2-6)", () => {
  it("tree: My customers keep the server's order, Other customers are alphabetical", () => {
    const rows = buildTree(CUSTOMERS, { sel: {}, expanded: { "~ot": true } }).rows.filter((r) => r.kind === "customer").map((r) => r.label);
    expect(rows).toEqual(["Mirae Pay", "Bora Foods", "Daon Retail", "Maru Homes", "Nuri Soft", "Zio Fashion"]);
  });
  it("sheet: the same order", () => {
    render(<ScopeSheet open customers={CUSTOMERS} value={{}} onApply={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByTestId("sheet-customer").map((r) => r.querySelector("b")!.textContent))
      .toEqual(["Mirae Pay", "Bora Foods", "Daon Retail", "Maru Homes", "Nuri Soft", "Zio Fashion"]);
  });
});

describe("legend (QA P2-1, P2-7)", () => {
  const tree = () => render(<ScopeTree customers={CUSTOMERS} value={{}} onChange={vi.fn()} rail={false} onRailChange={vi.fn()} width={272} onWidthChange={vi.fn()} storageKey="t-legend" />);
  beforeEach(() => sessionStorage.clear());

  it("tree: one collapsed link, the last control of the tree; opening it explains the tags in plain words", () => {
    const { container } = tree();
    const link = screen.getByRole("button", { name: /^What do these mean\?/ });
    expect(link).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/has its own call order instead of the customer's/)).toBeNull();
    const focusable = Array.from(container.querySelectorAll<HTMLElement>("input, button:not([tabindex='-1']), [tabindex='0']"));
    expect(focusable[focusable.length - 1]).toBe(link);
    fireEvent.click(link);
    expect(link).toHaveAttribute("aria-expanded", "true");
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "2Open incidents here: triggered or escalated, and nobody has acknowledged them yet.",
      "UnreachableIf something breaks now, nobody for this customer can be called or texted.",
      "At riskThe person who is called first has no verified phone number.",
      "Own stepsThis project or service has its own call order instead of the customer's.",
      "Something inside has its own call order. Expand to see which.",
    ]);
  });
  it("tree: stays open for the session once opened, collapsed again in a new one", () => {
    const a = tree();
    fireEvent.click(screen.getByRole("button", { name: /^What do these mean\?/ }));
    a.unmount();
    tree();
    expect(screen.getByRole("button", { name: /^What do these mean\?/ })).toHaveAttribute("aria-expanded", "true");
  });
  it("sheet: a collapsed link under the rows, collapsed again every time the sheet opens", () => {
    const view = render(<ScopeSheet open customers={CUSTOMERS} value={{}} onApply={vi.fn()} onClose={vi.fn()} />);
    const link = () => screen.getByRole("button", { name: /^What do these mean\?/ });
    expect(link()).toHaveAttribute("aria-expanded", "false");
    expect(link().closest(".ssheet-body")).not.toBeNull(); // in the scrolling body, never over the header or the button below
    fireEvent.click(link());
    expect(screen.getByText(/has its own call order instead of the customer's/)).toBeInTheDocument();
    view.rerender(<ScopeSheet open={false} customers={CUSTOMERS} value={{}} onApply={vi.fn()} onClose={vi.fn()} />);
    view.rerender(<ScopeSheet open customers={CUSTOMERS} value={{}} onApply={vi.fn()} onClose={vi.fn()} />);
    expect(link()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("tree keyboard: Space chooses like Enter (QA P3-2)", () => {
  it("model and component", () => {
    const rows = buildTree(CUSTOMERS, { sel: {} }).rows;
    expect(treeKey(rows, "mirae", " ")).toEqual({ handled: true, pick: "mirae" });
    const onChange = vi.fn();
    render(<ScopeTree customers={CUSTOMERS} value={{}} onChange={onChange} rail={false} onRailChange={vi.fn()} width={272} onWidthChange={vi.fn()} storageKey="t-space" />);
    const t = screen.getByRole("tree");
    fireEvent.keyDown(t, { key: "ArrowDown" });
    fireEvent.keyDown(t, { key: "ArrowDown" });
    fireEvent.keyDown(t, { key: " " });
    expect(onChange).toHaveBeenCalledWith({ customer: "mirae" });
  });
});

describe("searchScopes — Filter to… (E14)", () => {
  const paths = (q: string) => searchScopes(CUSTOMERS, q).flat.map((h) => h.path.join(" › "));
  it("no text: All customers, My customers, then my customers, then the others by name; nothing preselected", () => {
    const v = searchScopes(CUSTOMERS, "");
    expect(v.flat.map((h) => h.path[0])).toEqual(["All customers", "My customers", "Mirae Pay", "Bora Foods", "Daon Retail", "Maru Homes", "Nuri Soft", "Zio Fashion"]);
    expect(v.groups.map((g) => g.label)).toEqual(["", "My customers · 2", "Other customers · 4"]);
    expect(v.flat[0]!.sel).toEqual({});
    expect(v.flat[1]!.sel).toEqual({ mine: true });
    expect(v.preselect).toBe(-1);
  });
  it("matches word starts over the whole path; my customers first", () => {
    expect(paths("mar")).toEqual(["Maru Homes", "Maru Homes › Main", "Maru Homes › Main › Web"]);
    const v = searchScopes(CUSTOMERS, "m");
    expect(v.groups.map((g) => g.label)).toEqual(["My customers", "Other customers"]);
    expect(v.flat.slice(0, 2).map((h) => h.path.join(" › "))).toEqual(["Mirae Pay", "Bora Foods › Main"]);
    expect(v.flat.findIndex((h) => !h.mine)).toBe(v.groups[0]!.hits.length); // every one of mine comes before any other
    expect(v.preselect).toBe(0);
    expect(paths("xyz")).toEqual([]);
    expect(paths("pay")).toEqual(["Mirae Pay", "Mirae Pay › Core › Payments API", "Mirae Pay › Core", "Mirae Pay › Data platform", "Mirae Pay › Core › Checkout", "Mirae Pay › Data platform › Ledger"]);
  });
  it("the same name under several customers: nothing preselected, tree order, the customers are named", () => {
    const v = searchScopes(CUSTOMERS, "check");
    expect(v.preselect).toBe(-1);
    expect(v.ambiguous).toEqual(["Mirae Pay", "Daon Retail"]);
    expect(v.flat.map((h) => h.path.join(" › "))).toEqual(["Mirae Pay › Core › Checkout", "Daon Retail › Commerce › Checkout"]);
    const web = searchScopes(CUSTOMERS, "web");
    expect(web.preselect).toBe(-1);
    expect(web.ambiguous).toEqual(["Bora Foods", "Maru Homes", "Nuri Soft", "Zio Fashion"]);
  });
  it("adding the customer's name narrows it to one, which is preselected", () => {
    const v = searchScopes(CUSTOMERS, "daon check");
    expect(v.flat.map((h) => h.key)).toEqual(["daon/commerce/checkout"]);
    expect(v.preselect).toBe(0);
    expect(v.ambiguous).toEqual([]);
    expect(v.flat[0]!.sel).toEqual({ customer: "daon", project: "commerce", service: "checkout" });
  });
});

describe("<ScopeSearch>", () => {
  const setup = () => {
    const onPick = vi.fn<(s: ScopeSel) => void>();
    const onClose = vi.fn();
    render(<ScopeSearch open customers={CUSTOMERS} screen="Incidents" onPick={onPick} onClose={onClose} />);
    return { onPick, onClose, input: screen.getByRole("combobox") };
  };
  const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

  it("is a dialog with the search focused; every row starts with the customer in bold", () => {
    const { input } = setup();
    expect(screen.getByRole("dialog", { name: "Filter to a customer, project or service" })).toBeInTheDocument();
    expect(input).toHaveFocus();
    type(input, "led");
    const opt = screen.getByRole("option");
    expect(opt).toHaveTextContent("Mirae Pay›Data platform›Ledger");
    expect(opt.querySelector("b")).toHaveTextContent("Mirae Pay");
    expect(opt).toHaveAttribute("aria-selected", "true");
  });
  it("Enter takes the preselected single match", () => {
    const { onPick, input } = setup();
    type(input, "daon check");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({ customer: "daon", project: "commerce", service: "checkout" });
  });
  it("duplicate names: nothing is selected and Enter does nothing until one is chosen", () => {
    const { onPick, input } = setup();
    type(input, "check");
    expect(screen.getByRole("alert")).toHaveTextContent("2 customers have a match for “check”: Mirae Pay, Daon Retail. Nothing is selected — choose one, or type the customer name too.");
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "false"]);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({ customer: "daon", project: "commerce", service: "checkout" });
  });
  it("without text Enter does nothing; All customers and My customers can be chosen", () => {
    const { onPick, input } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: /My customers/ }));
    expect(onPick).toHaveBeenLastCalledWith({ mine: true });
    fireEvent.click(screen.getByRole("option", { name: /All customers/ }));
    expect(onPick).toHaveBeenLastCalledWith({});
  });
  it("Escape and Close close without choosing; no match says so", () => {
    const { onPick, onClose, input } = setup();
    type(input, "xyz");
    expect(screen.getByText("No customer, project or service starts with “xyz”")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onPick).not.toHaveBeenCalled();
  });
  it("renders nothing when closed", () => {
    render(<ScopeSearch open={false} customers={CUSTOMERS} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("<ScopeLine> phone search entry", () => {
  it("a search button beside the line opens Filter to…", () => {
    const onOpenSearch = vi.fn();
    render(<ScopeLine totalCustomers={6} mineCustomers={2} onClear={vi.fn()} onOpenPicker={vi.fn()} onOpenSearch={onOpenSearch} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter to a customer, project or service by name" }));
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });
});
