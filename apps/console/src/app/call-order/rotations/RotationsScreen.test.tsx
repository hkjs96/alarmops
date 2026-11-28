/**
 * Component level, Call order › Rotations (docs/ui/screens/oncall-rotations.md): read-only for non-admins with the reason on screen,
 * the version sent on save is the one the page was given, a preview of another version blocks the save, a re-rendered page with a newer
 * version saves with that one, the tree's customer narrows Customer rotations and marks "Used by", and Cover or swap is off with a reason.
 *
 * Assumed props (like TemplatesScreen): `rotations` (MSP and customer ones, RotationSummary), `staff`, and for the selected rotation
 * `usage` (GET usage) and `shifts` (GET shifts). Assumed actions module `./actions`: previewRotation(id, change),
 * saveRotation(id, change, version, previewHash), createRotation(input), deleteRotation(id, version).
 * Assumed controls: buttons named "New shared rotation", "Edit members & order", "Delete", "Move <name> up|down"; test ids rot-save,
 * rot-save-why, rot-error, rot-why (the role reason), rot-cust-row (a Customer rotations row), rot-used-row (a Used by row, with
 * data-selected="true" when it is the tree's customer).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, RotationSummary, StaffSummary } from "@/lib/api/types";

const act_ = vi.hoisted(() => ({ preview: vi.fn(), save: vi.fn(), create: vi.fn(), del: vi.fn() }));
vi.mock("./actions", () => ({
  previewRotation: (...a: unknown[]) => act_.preview(...a), saveRotation: (...a: unknown[]) => act_.save(...a),
  createRotation: (...a: unknown[]) => act_.create(...a), deleteRotation: (...a: unknown[]) => act_.del(...a),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/call-order/rotations", useSearchParams: () => new URLSearchParams() }));

import { ShellContext, type ShellApi } from "@/components/ShellContext";
import { RotationsScreen } from "./RotationsScreen";

const member = (contactId: string, name: string, extra: Record<string, unknown> = {}) => ({ contactId, name, ...extra });
const NIGHT = {
  id: "rot_night", scope: "MSP", name: "MSP night desk", cadence: "DAILY", handover: { minute: 540 }, version: 4,
  members: [member("ct_haeun", "Haeun Kim"), member("ct_junho", "Junho Park"), member("ct_jiwoo", "Jiwoo Han")],
  onShift: { contactId: "ct_haeun", name: "Haeun Kim", until: "2026-11-09T00:00:00Z" }, next: "Junho Park",
} as unknown as RotationSummary;
const HANBIT = {
  id: "rot_hanbit", scope: "CUSTOMER", customerId: "cus_hanbit", name: "Hanbit on-call", cadence: "DAILY", handover: { minute: 600 }, version: 1,
  members: [member("ct_junho", "Junho Park"), member("ct_hyunwoo", "Hyunwoo Ahn", { kind: "CUSTOMER", role: "NOTIFY_ONLY" })],
  onShift: { contactId: "ct_junho", name: "Junho Park", until: "2026-11-09T01:00:00Z" }, next: "Hyunwoo Ahn",
} as unknown as RotationSummary;
const LUMEN = {
  id: "rot_lumen", scope: "CUSTOMER", customerId: "cus_lumen", name: "Lumen on-call", cadence: "DAILY", handover: { minute: 600 }, version: 1,
  members: [member("ct_kyungmin", "Kyungmin Oh", { kind: "CUSTOMER", role: "PAGEABLE" }), member("ct_jiwoo", "Jiwoo Han")],
  onShift: { contactId: "ct_kyungmin", name: "Kyungmin Oh", until: "2026-11-09T01:00:00Z" }, next: "Jiwoo Han",
} as unknown as RotationSummary;
const STAFF: StaffSummary[] = [{ contactId: "ct_haeun", name: "Haeun Kim" }, { contactId: "ct_junho", name: "Junho Park" }, { contactId: "ct_jiwoo", name: "Jiwoo Han" }, { contactId: "ct_taemin", name: "Taemin Jung" }];
const USAGE = {
  rotationId: "rot_night",
  customers: [
    { id: "cus_hanbit", name: "Hanbit Logistics", slug: "hanbit", status: "ACTIVE", steps: [{ pagingConfigId: "pc_cus_hanbit", level: "CUSTOMER", scopeId: "cus_hanbit", stepIndex: 1, shared: true }] },
    { id: "cus_mirae", name: "Mirae Pay", slug: "mirae", status: "ACTIVE", steps: [{ pagingConfigId: "pc_cus_mirae", level: "CUSTOMER", scopeId: "cus_mirae", stepIndex: 1, shared: true }] },
  ],
};
const SHIFTS = {
  rotationId: "rot_night", version: 4, cadence: "DAILY", handover: { minute: 540 }, from: "2026-11-08T00:00:00Z", to: "2026-11-16T00:00:00Z",
  rows: [
    { start: "2026-11-08T00:00:00Z", end: "2026-11-09T00:00:00Z", contactId: "ct_haeun", name: "Haeun Kim", scheduled: null, pinned: false, overrides: [] },
    { start: "2026-11-09T00:00:00Z", end: "2026-11-10T00:00:00Z", contactId: "ct_junho", name: "Junho Park", scheduled: null, pinned: false, overrides: [] },
  ],
};
const preview = (version = 4, hash = "a".repeat(64)) => ({
  rotationId: "rot_night", version, handover: { minute: 540 }, anchorAt: "2026-11-08T00:00:00Z", previewHash: hash, pins: [],
  rows: [{ start: "2026-11-08T00:00:00Z", end: "2026-11-09T00:00:00Z", before: "Haeun Kim", after: "Haeun Kim", kept: true, changed: false }],
  nextShift: { before: "Junho Park", after: "Jiwoo Han" },
  customers: [{ id: "cus_hanbit", name: "Hanbit Logistics" }, { id: "cus_mirae", name: "Mirae Pay" }],
  totals: { customers: 2, changedRows: 6, pins: 0 },
});

const mount = (role: Role = "ADMIN", over: { rotations?: RotationSummary[]; sel?: Record<string, unknown>; kind?: "INTERNAL" | "CUSTOMER" } = {}) => {
  const node = (rotations: RotationSummary[]) => (
    <ShellContext.Provider value={{ user: { id: "u", name: "U", role, kind: over.kind }, sel: over.sel ?? {}, toast: vi.fn(), clearToast: vi.fn(), setLeaveGuard: vi.fn(), requestLeave: (p: () => void) => p() } as unknown as ShellApi}>
      <RotationsScreen rotations={rotations} staff={STAFF} usage={USAGE} shifts={SHIFTS} />
    </ShellContext.Provider>
  );
  const r = render(node(over.rotations ?? [NIGHT, HANBIT, LUMEN]));
  return { ...r, rerenderWith: (rotations: RotationSummary[]) => r.rerender(node(rotations)) };
};
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 320)); }); };
const confirm = async () => { await act(async () => { fireEvent.click(screen.getByTestId("confirm-dialog").querySelector('button[data-role="confirm"]')!); }); };
async function editAndSwap() {
  fireEvent.click(screen.getByRole("button", { name: "Edit members & order" }));
  fireEvent.click(screen.getByRole("button", { name: "Move Junho Park down" }));
  await flush();
}

beforeEach(() => { for (const m of Object.values(act_)) m.mockReset(); Element.prototype.scrollIntoView = vi.fn(); });

describe("roles", () => {
  it.each(["VIEWER", "OPERATOR"] as const)("%s: no write buttons, the reason is on screen, the read areas are there", (role) => {
    mount(role);
    for (const name of ["New shared rotation", "Edit members & order", "Delete"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByTestId("rot-why")).toHaveTextContent(new RegExp(`^Changing a rotation needs the Admin role\\. You are signed in as ${role === "VIEWER" ? "Viewer" : "Operator"}\\.`));
    for (const area of ["Order", "Next shifts", "Used by", "Customer rotations"]) expect(screen.getByRole("heading", { name: area })).toBeInTheDocument();
  });
  it("ADMIN has the three buttons and no reason", () => {
    mount("ADMIN");
    for (const name of ["New shared rotation", "Edit members & order", "Delete"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByTestId("rot-why")).toBeNull();
  });
});

describe("editing", () => {
  it("nothing changed: Save is off and says why", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit members & order" }));
    expect(screen.getByTestId("rot-save")).toBeDisabled();
    expect(screen.getByTestId("rot-save-why")).toHaveTextContent("Nothing has changed yet.");
    expect(act_.preview).not.toHaveBeenCalled();
  });

  it("the version sent on save is the RotationSummary.version the page was given", async () => {
    act_.preview.mockResolvedValue({ ok: true, data: preview(4) });
    act_.save.mockResolvedValue({ ok: true, data: { ...NIGHT, version: 5, affected: 2 } });
    mount();
    await editAndSwap();
    expect(act_.preview).toHaveBeenCalledWith("rot_night", { members: ["ct_haeun", "ct_jiwoo", "ct_junho"] });
    expect(screen.getByTestId("rot-save")).toHaveTextContent("Save rotation for 2 customers");
    fireEvent.click(screen.getByTestId("rot-save"));
    expect(act_.save).not.toHaveBeenCalled();
    await confirm();
    expect(act_.save).toHaveBeenCalledTimes(1);
    expect(act_.save).toHaveBeenCalledWith("rot_night", { members: ["ct_haeun", "ct_jiwoo", "ct_junho"] }, 4, "a".repeat(64));
    expect(Object.keys(act_.save.mock.calls[0]![1] as object)).not.toContain("cadence");
  });

  it("a preview of another version: Save is off, the VERSION_CONFLICT words are shown, nothing is saved", async () => {
    act_.preview.mockResolvedValue({ ok: true, data: preview(5) });
    mount();
    await editAndSwap();
    expect(screen.getByTestId("rot-save")).toBeDisabled();
    expect(screen.getByTestId("rot-error")).toHaveTextContent(/Someone else changed this in the meantime/);
    expect(screen.getByTestId("rot-error")).toHaveTextContent(/Reload/);
    fireEvent.click(screen.getByTestId("rot-save"));
    expect(act_.save).not.toHaveBeenCalled();
  });

  it("after a save, the page comes again with version v+1: the next edit saves with v+1 and shows no conflict", async () => {
    act_.preview.mockResolvedValueOnce({ ok: true, data: preview(4, "a".repeat(64)) });
    act_.save.mockResolvedValueOnce({ ok: true, data: { ...NIGHT, version: 5, affected: 2 } });
    const m = mount();
    await editAndSwap();
    fireEvent.click(screen.getByTestId("rot-save"));
    await confirm();
    expect(act_.save).toHaveBeenLastCalledWith("rot_night", expect.anything(), 4, "a".repeat(64));

    // the server refreshed the page: same rotation, new order, version 5
    const after = { ...NIGHT, version: 5, members: [NIGHT.members[0]!, NIGHT.members[2]!, NIGHT.members[1]!], next: "Jiwoo Han" } as RotationSummary;
    m.rerenderWith([after, HANBIT, LUMEN]);
    act_.preview.mockResolvedValueOnce({ ok: true, data: preview(5, "b".repeat(64)) });
    act_.save.mockResolvedValueOnce({ ok: true, data: { ...after, version: 6, affected: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "Edit members & order" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Jiwoo Han down" }));
    await flush();
    expect(screen.queryByTestId("rot-error")).toBeNull();
    expect(screen.queryByText(/Someone else changed this/)).toBeNull();
    expect(screen.getByTestId("rot-save")).toBeEnabled();
    fireEvent.click(screen.getByTestId("rot-save"));
    await confirm();
    expect(act_.save).toHaveBeenLastCalledWith("rot_night", { members: ["ct_haeun", "ct_junho", "ct_jiwoo"] }, 5, "b".repeat(64));
  });
});

describe("the tree's customer", () => {
  it("hanbit selected: Customer rotations keeps Hanbit on-call only, and Hanbit is marked in Used by", () => {
    mount("ADMIN", { sel: { customer: "hanbit" } });
    const rows = screen.getAllByTestId("rot-cust-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Hanbit on-call");
    expect(screen.queryByText("Lumen on-call")).toBeNull();
    const used = screen.getAllByTestId("rot-used-row");
    expect(used.find((r) => r.textContent!.includes("Hanbit Logistics"))).toHaveAttribute("data-selected", "true");
    expect(used.find((r) => r.textContent!.includes("Mirae Pay"))).not.toHaveAttribute("data-selected", "true");
  });
  it("nothing selected: both rows, nothing marked; the table has name, customer, members (with badges) and who is on now", () => {
    mount();
    const rows = screen.getAllByTestId("rot-cust-row");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Hanbit on-call"), expect.stringContaining("Lumen on-call")]);
    expect(screen.getAllByTestId("rot-used-row").some((r) => r.getAttribute("data-selected") === "true")).toBe(false);
    const table = screen.getByRole("table", { name: /Customer rotations/i });
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent!.trim());
    expect(heads).toEqual([expect.stringMatching(/^Name$/i), expect.stringMatching(/^Customer$/i), expect.stringMatching(/^Members$/i), expect.stringMatching(/now|on shift/i)]);
    // a customer's person and a notify-only person are badges, in words
    expect(rows[0]).toHaveTextContent("Hyunwoo Ahn");
    expect(within(rows[0]!).getByText("Customer")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Notify only")).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("Junho Park");
  });
});

describe("Cover or swap", () => {
  it("Cover or swap and Swap with me are off, with the reason linked by aria-describedby; pressing sends nothing", () => {
    mount();
    const buttons = [...screen.getAllByRole("button", { name: /^(Cover or swap|Swap with me)$/ })];
    expect(buttons.length).toBeGreaterThan(0);
    expect(new Set(buttons.map((b) => b.textContent)).size).toBe(2);
    for (const b of buttons) {
      expect(b).toBeDisabled();
      const id = b.getAttribute("aria-describedby");
      expect(id, b.textContent!).toBeTruthy();
      expect(document.getElementById(id!)!.textContent!.trim().length).toBeGreaterThan(10);
      fireEvent.click(b);
    }
    for (const m of Object.values(act_)) expect(m).not.toHaveBeenCalled();
  });
});
