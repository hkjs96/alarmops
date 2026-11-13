import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog, CustomerStatusBadge, buildTree, type ScopeCustomerNode } from "./index";

describe("CustomerStatusBadge", () => {
  it("each status has its own word AND its own shape, never colour alone", () => {
    const shapes = new Set<string>();
    for (const [status, word] of [["ACTIVE", "Active"], ["SUSPENDED", "Suspended"], ["TERMINATED", "Terminated"]] as const) {
      const { container, unmount } = render(<CustomerStatusBadge status={status} />);
      expect(screen.getByText(word)).toBeInTheDocument();
      shapes.add(container.querySelector(".mk")!.className);
      unmount();
    }
    expect(shapes.size).toBe(3);
  });
});

describe("tree rows carry the customer status", () => {
  const c = (slug: string, status?: ScopeCustomerNode["status"]): ScopeCustomerNode => ({ id: `cus_${slug}`, slug, name: slug, mine: false, openIncidents: 0, callHealth: "OK", status, projects: [] });
  it("SUSPENDED and TERMINATED are set on the row, ACTIVE and missing are not", () => {
    const { rows } = buildTree([c("a", "SUSPENDED"), c("b", "TERMINATED"), c("c", "ACTIVE"), c("d")], { sel: {}, expanded: { "~ot": true } });
    const st = Object.fromEntries(rows.filter((r) => r.kind === "customer").map((r) => [r.key, r.status ?? null]));
    expect(st).toEqual({ a: "SUSPENDED", b: "TERMINATED", c: null, d: null });
  });
});

describe("ConfirmDialog with a form", () => {
  it("confirmDisabled keeps the confirm button off; the cancel button works; the field takes the focus", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="T" confirmLabel="Go" defaultFocus="field" confirmDisabled onConfirm={onConfirm} onCancel={onCancel}><input aria-label="reason" /></ConfirmDialog>);
    expect(screen.getByLabelText("reason")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Go" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
