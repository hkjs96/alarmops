import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShellContext, type LocalMark, type ShellApi } from "@/components/ShellContext";
import { openIncidents } from "@/lib/api/mock/fixtures";
import { sortIncidents } from "@/lib/incidents";
import { clearSpot } from "@alarmops/design-system";
import { DOUBLE_MS, IncidentsTable, type IncidentRow } from "./IncidentsTable";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));
const ackIncident = vi.fn();
const undoBulk = vi.fn();
vi.mock("./actions", () => ({
  ackIncident: (...a: unknown[]) => ackIncident(...a),
  undoBulk: (...a: unknown[]) => undoBulk(...a),
}));

const rows = (): IncidentRow[] => sortIncidents(structuredClone(openIncidents)).map((i) => ({ ...i, href: `/c/x/incident/${i.id}` }));
const toast = vi.fn();
let marksNow: Record<string, LocalMark> = {};

/** The shell's part: remembers undo tokens and marks. Re-rendering with other `initial` plays the list after router.refresh(). */
function Harness({ initial, listKey }: { initial: IncidentRow[]; listKey?: string }) {
  const [acks, setAcks] = useState<Record<string, string>>({});
  const [marks, setMarks] = useState<Record<string, LocalMark>>(marksNow);
  const listView = useRef<unknown>(null);
  const api: ShellApi = {
    user: { id: "usr_haeun", name: "Haeun Kim", role: "ADMIN" }, sel: {}, label: "All customers", filtered: false, totalCustomers: 14, toast, clearToast: () => undefined, setOutside: () => undefined, acks,
    setAck: (id, t) => setAcks((a) => { const n = { ...a }; if (t) n[id] = t; else delete n[id]; return n; }),
    marks, mark: (id, m) => setMarks((a) => { const n = { ...a }; if (m) n[id] = m; else delete n[id]; return n; }), listView,
    customers: [], problemsOnly: false, callOrderView: { current: null }, requestLeave: (go) => go(), setLeaveGuard: () => undefined,
  };
  return <ShellContext.Provider value={api}><IncidentsTable items={initial} nowMs={Date.parse("2026-11-08T18:16:16Z")} emptyKind="active incidents" listKey={listKey} /></ShellContext.Provider>;
}
const titles = () => screen.getAllByTestId("incident-row").map((r) => within(r).getByRole("link").textContent);
const ackButton = (title: RegExp) => screen.getByRole("button", { name: title });
const press = (el: HTMLElement, x = 300, y = 200) => fireEvent.click(el, { detail: 1, clientX: x, clientY: y });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const ackedList = (list: IncidentRow[], ...ids: string[]) => sortIncidents(list.map((i) => (ids.includes(i.id) ? { ...i, status: "ACKNOWLEDGED" as const, acknowledgedAt: "2026-11-08T18:16:20Z", version: i.version + 1 } : i)));
const bar = () => screen.queryByTestId("list-pending")?.textContent ?? null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  marksNow = {};
  ackIncident.mockResolvedValue({ ok: true, data: { undoToken: "undo_1" } });
  undoBulk.mockImplementation(async () => ({ ok: true, data: { restored: openIncidents.map((i) => i.id), skipped: [] } }));
  clearSpot();
});

describe("rows never move under the pointer (QA P1-1, P1-A)", () => {
  it("sends the row's version", async () => {
    const list = rows();
    render(<Harness initial={list} />);
    press(ackButton(/^Acknowledge payments-db-1/));
    await flush();
    expect(ackIncident).toHaveBeenCalledWith(list[0]!.id, list[0]!.version);
  });

  it("an acknowledged row stays exactly where it is — for as long as the list is on screen — and only Re-sort moves it", async () => {
    const list = rows();
    const before = list.map((i) => i.title);
    const view = render(<Harness initial={list} listKey="a" />);
    expect(bar()).toBeNull();
    press(ackButton(/^Acknowledge payments-db-1/));
    await flush();
    // before the list has refreshed the row already says so, and nothing is offered in the button's place
    let row = screen.getAllByTestId("incident-row")[0]!;
    expect(within(row).getByTestId("ack-label")).toHaveTextContent("Acknowledged ✓");
    expect(within(row).queryByRole("button", { name: /^(Acknowledge|Undo)/ })).toBeNull();
    // the server list now sorts the acknowledged incident below the open ones
    const after = ackedList(list, list[0]!.id);
    expect(after[0]!.title).toMatch(/^api-alb/);
    view.rerender(<Harness initial={after} listKey="a" />);
    expect(titles()).toEqual(before);
    row = screen.getAllByTestId("incident-row")[0]!;
    expect(row).toHaveAttribute("data-inplace", "1");
    expect(row).toHaveClass("dim");
    expect(within(row).getByTestId("ack-label")).toHaveTextContent("Acknowledged ✓ 03:16");
    expect(toast).toHaveBeenCalledWith("Acknowledged in Mirae Pay › Core › Payments API · payments-db-1 FreeStorageSpace below 10 GB", expect.objectContaining({ label: "Undo" }));
    expect(bar()).toBe("1 acknowledged in place");
    // no timer and no pointer movement lets it go
    act(() => { vi.advanceTimersByTime(120_000); });
    fireEvent.pointerOut(row); fireEvent.mouseLeave(row);
    expect(titles()).toEqual(before);
    // a second one
    press(ackButton(/^Acknowledge api-alb/), 300, 400);
    await flush();
    view.rerender(<Harness initial={ackedList(list, list[0]!.id, list[1]!.id)} listKey="a" />);
    expect(titles()).toEqual(before);
    expect(bar()).toBe("2 acknowledged in place");
    // the user asks
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 5000);
    press(screen.getByRole("button", { name: "Re-sort" }), 10, 10);
    expect(titles()).toEqual(ackedList(list, list[0]!.id, list[1]!.id).map((i) => i.title));
    expect(bar()).toBeNull();
    vi.restoreAllMocks();
  });

  it("a tab, filter or search change sorts the list; the Re-sort button ignores a press in the first 600 ms", async () => {
    const list = rows();
    const after = ackedList(list, list[0]!.id);
    const view = render(<Harness initial={list} listKey="a" />);
    const t0 = 5_000_000;
    const now = vi.spyOn(performance, "now").mockReturnValue(t0);
    press(ackButton(/^Acknowledge payments-db-1/));
    await flush();
    view.rerender(<Harness initial={after} listKey="a" />);
    press(screen.getByRole("button", { name: "Re-sort" }), 300, 200); // it came up a moment ago, maybe under a second tap
    expect(titles()[0]).toMatch(/^payments-db-1/);
    view.rerender(<Harness initial={after} listKey="b" />);
    expect(titles()).toEqual(after.map((i) => i.title));
    expect(bar()).toBeNull();
    now.mockRestore();
  });

  it("a refresh never inserts, removes or reorders rows: new ones are announced, ones that left stay and say so", () => {
    const list = rows();
    const before = list.map((i) => i.title);
    const view = render(<Harness initial={list} listKey="a" />);
    const fresh: IncidentRow = { ...list[0]!, id: "inc-new-1", key: "INC-NEW", title: "brand new SEV-1", href: "/c/x/incident/inc-new-1" };
    // server: a new incident on top, the second row resolved by someone else (gone from Active), the rest re-ordered
    const server = [fresh, ...list.filter((_, n) => n !== 1).reverse()];
    view.rerender(<Harness initial={server} listKey="a" />);
    expect(titles()).toEqual(before);
    expect(bar()).toBe("1 no longer in this list · 1 new");
    const left = screen.getAllByTestId("incident-row")[1]!;
    expect(left).toHaveAttribute("data-gone", "1");
    expect(within(left).getByRole("status")).toHaveTextContent("Left this list");
    expect(within(left).queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show and re-sort" }), { detail: 0 });
    expect(titles()).toEqual(server.map((i) => i.title));
  });

  it("a row the user resolved or reopened says which", () => {
    const list = rows();
    marksNow = { [list[0]!.id]: "RESOLVED", [list[1]!.id]: "REOPENED" };
    const view = render(<Harness initial={list} listKey="a" />);
    view.rerender(<Harness initial={list.slice(2)} listKey="a" />);
    const [a, b] = screen.getAllByTestId("incident-row");
    expect(within(a!).getByRole("status")).toHaveTextContent("Resolved ✓");
    expect(within(b!).getByRole("status")).toHaveTextContent("Reopened · paging");
    expect(titles()).toEqual(list.map((i) => i.title));
  });

  it("one row waiting for the server does not lock the others", async () => {
    let release: (v: unknown) => void = () => undefined;
    ackIncident.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const list = rows();
    render(<Harness initial={list} />);
    press(ackButton(/^Acknowledge payments-db-1/), 300, 200);
    await flush();
    expect(within(screen.getAllByTestId("incident-row")[0]!).getByTestId("ack-label")).toHaveTextContent("Acknowledging…");
    expect(ackButton(/^Acknowledge api-alb/)).toBeEnabled();
    press(ackButton(/^Acknowledge api-alb/), 300, 260);
    await flush();
    expect(ackIncident).toHaveBeenCalledTimes(2);
    expect(ackIncident).toHaveBeenLastCalledWith(list[1]!.id, list[1]!.version);
    release({ ok: true, data: { undoToken: "undo_0" } });
    await flush();
  });

  it("a second press at the same spot within 600 ms is ignored; a later one or one elsewhere counts", async () => {
    const t0 = 1_000_000;
    const now = vi.spyOn(performance, "now").mockReturnValue(t0);
    render(<Harness initial={rows()} />);
    press(ackButton(/^Acknowledge payments-db-1/), 300, 200);
    await flush();
    expect(ackIncident).toHaveBeenCalledTimes(1);
    now.mockReturnValue(t0 + DOUBLE_MS - 1);
    press(ackButton(/^Acknowledge api-alb/), 302, 205);
    await flush();
    expect(ackIncident).toHaveBeenCalledTimes(1);
    press(ackButton(/^Acknowledge api-alb/), 300, 320);
    await flush();
    expect(ackIncident).toHaveBeenCalledTimes(2);
    now.mockReturnValue(t0 + 5 * DOUBLE_MS);
    press(ackButton(/^Acknowledge node-exporter/), 300, 320);
    await flush();
    expect(ackIncident).toHaveBeenCalledTimes(3);
    now.mockRestore();
  });
});

describe("Undo is not where Acknowledge was (QA P2-A)", () => {
  it("the row has a label in the button's place; Undo is behind … and in the toast, and the row does not move on Undo", async () => {
    const list = rows();
    const before = list.map((i) => i.title);
    const view = render(<Harness initial={list} listKey="a" />);
    press(ackButton(/^Acknowledge payments-db-1/), 300, 200);
    await flush();
    const after = ackedList(list, list[0]!.id);
    view.rerender(<Harness initial={after} listKey="a" />);
    const row = screen.getAllByTestId("incident-row")[0]!;
    expect(within(row).queryByRole("button", { name: /Undo/ })).toBeNull();
    const more = within(row).getByRole("button", { name: /^More for payments-db-1/ });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(more, { detail: 0 });
    const item = screen.getByRole("menuitem", { name: "Undo acknowledge" });
    expect(item).toHaveFocus();
    fireEvent.click(item);
    await flush();
    expect(undoBulk).toHaveBeenCalledWith("undo_1");
    expect(toast).toHaveBeenLastCalledWith("Acknowledge undone in Mirae Pay › Core › Payments API · paging continues");
    view.rerender(<Harness initial={list.map((i) => (i.id === list[0]!.id ? { ...i, version: i.version + 2 } : i))} listKey="a" />);
    expect(titles()).toEqual(before);
    expect(ackButton(/^Acknowledge payments-db-1/)).toBeInTheDocument();
    expect(bar()).toBeNull();
  });

  it("Esc closes the menu and returns to …", async () => {
    const list = rows();
    render(<Harness initial={list} />);
    press(ackButton(/^Acknowledge payments-db-1/));
    await flush();
    const more = screen.getByRole("button", { name: /^More for payments-db-1/ });
    fireEvent.click(more, { detail: 0 });
    fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more).toHaveFocus();
    expect(undoBulk).not.toHaveBeenCalled();
  });
});

describe("keyboard (QA P3-A)", () => {
  it("Enter on Acknowledge: the focus moves to the row's status label, not to the top of the page", async () => {
    const list = rows();
    render(<Harness initial={list} />);
    const b = ackButton(/^Acknowledge payments-db-1/);
    b.focus();
    fireEvent.click(b, { detail: 0 });
    await flush();
    const label = within(screen.getAllByTestId("incident-row")[0]!).getByTestId("ack-label");
    expect(label).toHaveFocus();
    expect(label).toHaveTextContent("Acknowledged ✓");
  });
});

describe("409 (security R-3)", () => {
  it("the row says it was not acknowledged and offers Reload away from the button's place; no toast, no Undo, same rows", async () => {
    ackIncident.mockResolvedValue({ ok: false, code: "VERSION_CONFLICT", message: "Incident was updated by someone else.", requestId: "r1" });
    const list = rows();
    const view = render(<Harness initial={list} />);
    press(ackButton(/^Acknowledge payments-db-1/));
    await flush();
    const row = screen.getAllByTestId("incident-row")[0]!;
    expect(within(row).getByRole("status")).toHaveTextContent("Not acknowledged");
    expect(within(row).getByText("Changed since loaded")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /^Acknowledge/ })).toBeNull();
    expect(toast).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 5000);
    press(within(row).getByRole("button", { name: /^Reload the list, payments-db-1/ }));
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender(<Harness initial={list.map((i) => (i.id === list[0]!.id ? { ...i, version: i.version + 1, escalated: true } : i))} />);
    expect(ackButton(/^Acknowledge payments-db-1/)).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("an unmapped-account row has no Acknowledge", () => {
    render(<Harness initial={rows()} />);
    expect(screen.queryByRole("button", { name: /^Acknowledge 3 alarms from unmapped account/ })).toBeNull();
  });
});
