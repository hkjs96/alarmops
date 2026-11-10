import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShellContext, type ShellApi } from "@/components/ShellContext";
import { openIncidents } from "@/lib/api/mock/fixtures";
import { sortIncidents } from "@/lib/incidents";
import { DOUBLE_MS, HOLD_MS, heldOrder, IncidentsTable, type IncidentRow } from "./IncidentsTable";

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

/** The shell's part: remembers undo tokens. `server` plays the list after router.refresh(). */
function Harness({ initial, listKey }: { initial: IncidentRow[]; listKey?: string }) {
  const [acks, setAcks] = useState<Record<string, string>>({});
  const api: ShellApi = {
    sel: {}, label: "All customers", filtered: false, totalCustomers: 14, toast, clearToast: () => undefined, setOutside: () => undefined, acks,
    setAck: (id, t) => setAcks((a) => { const n = { ...a }; if (t) n[id] = t; else delete n[id]; return n; }),
  };
  return <ShellContext.Provider value={api}><IncidentsTable items={initial} nowMs={Date.parse("2026-11-08T18:16:16Z")} emptyKind="active incidents" listKey={listKey} /></ShellContext.Provider>;
}
const titles = () => screen.getAllByTestId("incident-row").map((r) => within(r).getByRole("link").textContent);
const ackButton = (title: RegExp) => screen.getByRole("button", { name: title });
const press = (el: HTMLElement, x = 300, y = 200) => fireEvent.click(el, { detail: 1, clientX: x, clientY: y });
/** jsdom's pointer events carry no pointerType; React reads it from the native event */
const leave = (el: HTMLElement, pointerType: string) => act(() => {
  const ev = new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body });
  Object.defineProperty(ev, "pointerType", { value: pointerType });
  el.dispatchEvent(ev);
});
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  ackIncident.mockResolvedValue({ ok: true, data: { undoToken: "undo_1" } });
  undoBulk.mockResolvedValue({ ok: true, data: null });
});

describe("heldOrder", () => {
  it("keeps the frozen order; rows that arrive meanwhile go last; no hold = the server's order", () => {
    const items = [{ id: "b" }, { id: "c" }, { id: "new" }, { id: "a" }];
    expect(heldOrder(items, ["a", "b", "c"]).map((i) => i.id)).toEqual(["a", "b", "c", "new"]);
    expect(heldOrder(items, null)).toBe(items);
  });
});

describe("Acknowledge on a row (QA P1-1, security R-3)", () => {
  it("sends the row's version", async () => {
    const list = rows();
    render(<Harness initial={list} />);
    press(ackButton(/^Acknowledge payments-db-1/));
    await flush();
    expect(ackIncident).toHaveBeenCalledWith(list[0]!.id, list[0]!.version);
  });

  it("the acknowledged row stays in place for 5 s with Acknowledged · Undo, then the list sorts again", async () => {
    const list = rows();
    const before = list.map((i) => i.title);
    const view = render(<Harness initial={list} />);
    press(ackButton(/^Acknowledge payments-db-1/));
    await flush();
    // the server list now sorts the acknowledged incident below the open ones
    const after = sortIncidents(list.map((i) => (i.id === list[0]!.id ? { ...i, status: "ACKNOWLEDGED" as const, version: i.version + 1 } : i)));
    expect(after[0]!.title).toMatch(/^api-alb/);
    view.rerender(<Harness initial={after} />);
    expect(titles()).toEqual(before); // nothing moved under the pointer
    const row = screen.getAllByTestId("incident-row")[0]!;
    expect(row).toHaveAttribute("data-held", "1");
    expect(within(row).getByText(/^Acknowledged/)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /^Undo acknowledge of payments-db-1/ })).toHaveTextContent("Undo");
    expect(toast).toHaveBeenCalledWith("Acknowledged in Mirae Pay › Core › Payments API · payments-db-1 FreeStorageSpace below 10 GB", expect.objectContaining({ label: "Undo" }));
    act(() => { vi.advanceTimersByTime(HOLD_MS - 1); });
    expect(titles()).toEqual(before);
    act(() => { vi.advanceTimersByTime(2); });
    expect(titles()).toEqual(after.map((i) => i.title));
    // Undo stays on the row after it moved
    expect(screen.getByRole("button", { name: /^Undo acknowledge of payments-db-1/ })).toBeInTheDocument();
  });

  it("the mouse leaving the row, or the list changing, lets it go at once", async () => {
    const list = rows();
    const after = sortIncidents(list.map((i) => (i.id === list[0]!.id ? { ...i, status: "ACKNOWLEDGED" as const } : i)));
    const view = render(<Harness initial={list} listKey="a" />);
    press(ackButton(/^Acknowledge payments-db-1/));
    await flush();
    view.rerender(<Harness initial={after} listKey="a" />);
    expect(titles()[0]).toMatch(/^payments-db-1/);
    leave(screen.getAllByTestId("incident-row")[0]!, "touch"); // a finger lifting is not "leaving"
    expect(titles()[0]).toMatch(/^payments-db-1/);
    leave(screen.getAllByTestId("incident-row")[0]!, "mouse");
    expect(titles()[0]).toMatch(/^api-alb/);

    press(ackButton(/^Acknowledge api-alb/), 10, 10);
    await flush();
    expect(screen.getAllByTestId("incident-row")[0]).toHaveAttribute("data-held", "1");
    view.rerender(<Harness initial={after} listKey="b" />);
    expect(screen.getAllByTestId("incident-row")[0]).not.toHaveAttribute("data-held");
  });

  it("a second press at the same spot within 600 ms is ignored, on another row and on Undo; a later one or one elsewhere counts", async () => {
    const t0 = 1_000_000;
    const now = vi.spyOn(performance, "now").mockReturnValue(t0);
    render(<Harness initial={rows()} />);
    press(ackButton(/^Acknowledge payments-db-1/), 300, 200);
    await flush();
    expect(ackIncident).toHaveBeenCalledTimes(1);
    // the row did not move, but even if another row's button were under the same finger: ignored
    now.mockReturnValue(t0 + DOUBLE_MS - 1);
    press(ackButton(/^Acknowledge api-alb/), 302, 205);
    await flush();
    expect(ackIncident).toHaveBeenCalledTimes(1);
    // somewhere else on the screen is a different decision
    press(ackButton(/^Acknowledge api-alb/), 300, 320);
    await flush();
    expect(ackIncident).toHaveBeenCalledTimes(2);
    // and after 600 ms the same spot works again
    now.mockReturnValue(t0 + 5 * DOUBLE_MS);
    press(ackButton(/^Acknowledge node-exporter/), 300, 320);
    await flush();
    expect(ackIncident).toHaveBeenCalledTimes(3);
    // keyboard activation (no pointer position) is never swallowed
    fireEvent.click(ackButton(/^Acknowledge payments-db-1/), { detail: 0 });
    await flush();
    expect(ackIncident).toHaveBeenCalledTimes(4);
    now.mockRestore();
  });

  it("a double tap does not undo what the first tap acknowledged", async () => {
    const t0 = 2_000_000;
    const now = vi.spyOn(performance, "now").mockReturnValue(t0);
    const list = rows();
    const view = render(<Harness initial={list} />);
    press(ackButton(/^Acknowledge payments-db-1/), 300, 200);
    await flush();
    view.rerender(<Harness initial={list.map((i) => (i.id === list[0]!.id ? { ...i, status: "ACKNOWLEDGED" as const } : i))} />);
    now.mockReturnValue(t0 + 200);
    press(screen.getByRole("button", { name: /^Undo acknowledge of payments-db-1/ }), 300, 200);
    await flush();
    expect(undoBulk).not.toHaveBeenCalled();
    now.mockReturnValue(t0 + 2000);
    press(screen.getByRole("button", { name: /^Undo acknowledge of payments-db-1/ }), 300, 200);
    await flush();
    expect(undoBulk).toHaveBeenCalledWith("undo_1");
    expect(toast).toHaveBeenLastCalledWith("Acknowledge undone in Mirae Pay › Core › Payments API · paging continues");
    now.mockRestore();
  });

  it("409: the row says it changed and offers Reload; nothing is acknowledged, no toast, no Undo", async () => {
    ackIncident.mockResolvedValue({ ok: false, code: "VERSION_CONFLICT", message: "Incident was updated by someone else.", requestId: "r1" });
    const list = rows();
    const view = render(<Harness initial={list} />);
    press(ackButton(/^Acknowledge payments-db-1/));
    await flush();
    const row = screen.getAllByTestId("incident-row")[0]!;
    expect(within(row).getByRole("status")).toHaveTextContent("Changed since you loaded this list · not acknowledged");
    expect(within(row).queryByRole("button", { name: /^Acknowledge/ })).toBeNull();
    expect(row).not.toHaveAttribute("data-held");
    expect(toast).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled(); // the stale row stays so the message has something to point at
    fireEvent.click(within(row).getByRole("button", { name: /^Reload the list, payments-db-1/ }));
    expect(refresh).toHaveBeenCalledTimes(1);
    // the reloaded row (new version) can be acknowledged again
    view.rerender(<Harness initial={list.map((i) => (i.id === list[0]!.id ? { ...i, version: i.version + 1, escalated: true } : i))} />);
    expect(ackButton(/^Acknowledge payments-db-1/)).toBeInTheDocument();
  });

  it("an unmapped-account row has no Acknowledge", () => {
    render(<Harness initial={rows()} />);
    expect(screen.queryByRole("button", { name: /^Acknowledge 3 alarms from unmapped account/ })).toBeNull();
  });
});
