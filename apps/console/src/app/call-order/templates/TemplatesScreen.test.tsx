/** Component level: preview follows the draft, Save is off while blocking is not empty, the confirmation lists the customers, errors say what to do, others read only. */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResponderTemplate, StaffSummary, TemplatePreview } from "@/lib/api/types";
import type { Role } from "@/lib/api/types";

const act_ = vi.hoisted(() => ({ preview: vi.fn(), save: vi.fn(), create: vi.fn() }));
vi.mock("./actions", () => ({ previewTemplate: (...a: unknown[]) => act_.preview(...a), saveTemplate: (...a: unknown[]) => act_.save(...a), createTemplate: (...a: unknown[]) => act_.create(...a) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { ShellContext, type ShellApi } from "@/components/ShellContext";
import { TemplatesScreen } from "./TemplatesScreen";

const T: ResponderTemplate = { id: "t1", name: "Infra core", version: 1, updatedAt: "2026-11-04T05:00:00Z", members: [{ contactId: "a", name: "Haeun Kim" }, { contactId: "b", name: "Junho Park" }], customers: [{ id: "c1", name: "Mirae Pay" }, { id: "c2", name: "Ara Games" }] };
const STAFF: StaffSummary[] = [{ contactId: "a", name: "Haeun Kim" }, { contactId: "b", name: "Junho Park" }, { contactId: "d", name: "Dohyun Kang" }];
const preview = (blocking: TemplatePreview["blocking"] = []): TemplatePreview => ({
  templateId: "t1", version: 1, previewHash: "a".repeat(64), blocking,
  totals: { customers: 2, affected: 2, joins: 2, leaves: 0, warnings: 0 },
  customers: [
    { id: "c1", name: "Mirae Pay", effects: [{ kind: "JOINS", contactId: "d", name: "Dohyun Kang" }] },
    { id: "c2", name: "Ara Games", effects: [{ kind: "JOINS", contactId: "d", name: "Dohyun Kang" }] },
  ],
});
const mount = (role: Role = "ADMIN") => render(
  <ShellContext.Provider value={{ user: { id: "u", name: "U", role }, toast: vi.fn(), clearToast: vi.fn() } as unknown as ShellApi}>
    <TemplatesScreen templates={[T]} staff={STAFF} />
  </ShellContext.Provider>,
);
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 320)); }); };
async function edit() {
  fireEvent.click(screen.getByTestId("tpl-open"));
  fireEvent.click(screen.getByTestId("tpl-edit"));
  fireEvent.change(screen.getByTestId("tpl-add-select"), { target: { value: "d" } });
  fireEvent.click(screen.getByTestId("tpl-add"));
  await flush();
}

beforeEach(() => { act_.preview.mockReset(); act_.save.mockReset(); Element.prototype.scrollIntoView = vi.fn(); });

describe("Templates screen", () => {
  it("lists the template with its customers count", () => {
    mount();
    expect(screen.getByTestId("tpl-count")).toHaveTextContent("2");
  });

  it("a change shows the effects per customer and Save names the number of customers", async () => {
    act_.preview.mockResolvedValue({ ok: true, data: preview() });
    mount();
    await edit();
    expect(act_.preview).toHaveBeenCalledWith("t1", { members: ["a", "b", "d"] });
    expect(screen.getByTestId("tpl-affects")).toHaveTextContent("This change affects 2 customers");
    expect(screen.getAllByText("Dohyun Kang joins Responders")).toHaveLength(2);
    expect(screen.getByTestId("tpl-save")).toHaveTextContent("Save template for 2 customers");
    expect(screen.getByTestId("tpl-save")).toBeEnabled();
  });

  it("blocking: Save stays off, the customer and the reason are shown", async () => {
    act_.preview.mockResolvedValue({ ok: true, data: preview([{ customerId: "c1", reason: "UNREACHABLE" }]) });
    mount();
    await edit();
    expect(screen.getByTestId("tpl-save")).toBeDisabled();
    expect(screen.getByTestId("tpl-blocked")).toHaveTextContent("Can’t save: this would break 1 customer");
    expect(screen.getByTestId("tpl-blocked")).toHaveTextContent("Mirae Pay: nobody could be called after this change.");
    expect(screen.getByTestId("tpl-save-why")).toHaveTextContent("Blocked");
  });

  it("Save asks first with the customers listed; confirming sends the version and the preview hash", async () => {
    act_.preview.mockResolvedValue({ ok: true, data: preview() });
    act_.save.mockResolvedValue({ ok: true, data: { ...T, version: 2, affected: 2 } });
    mount();
    await edit();
    fireEvent.click(screen.getByTestId("tpl-save"));
    expect(screen.getByTestId("tpl-dialog")).toHaveTextContent("Mirae Pay");
    expect(act_.save).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId("confirm-dialog").querySelector('button[data-role="confirm"]')!); });
    expect(act_.save).toHaveBeenCalledWith("t1", { members: ["a", "b", "d"] }, 1, "a".repeat(64));
    expect(screen.getByTestId("tpl-result")).toHaveTextContent("Saved “Infra core” for 2 customers");
    expect(screen.getByTestId("tpl-undo")).toBeInTheDocument();
  });

  it("a save refused as stale says what to do and offers a new preview", async () => {
    act_.preview.mockResolvedValue({ ok: true, data: preview() });
    act_.save.mockResolvedValue({ ok: false, code: "PREVIEW_STALE", message: "", requestId: "r" });
    mount();
    await edit();
    fireEvent.click(screen.getByTestId("tpl-save"));
    await act(async () => { fireEvent.click(screen.getByTestId("confirm-dialog").querySelector('button[data-role="confirm"]')!); });
    expect(screen.getByTestId("tpl-error")).toHaveTextContent("Nothing was changed. Review the new preview, then save again.");
  });

  it("an operator reads: no New template, no Edit, with the reason", () => {
    mount("OPERATOR");
    fireEvent.click(screen.getByTestId("tpl-open"));
    expect(screen.queryByTestId("tpl-new")).toBeNull();
    expect(screen.queryByTestId("tpl-edit")).toBeNull();
    expect(screen.getByTestId("tpl-why")).toHaveTextContent("Changing a template needs the Admin role. You are signed in as Operator.");
    expect(screen.getByTestId("tpl-customers")).toHaveTextContent("Mirae Pay");
  });
});
