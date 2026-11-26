import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceItem } from "@/lib/api/types";
import { NeedsReviewTable } from "./NeedsReviewTable";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));
const setMonitoring = vi.fn();
vi.mock("./actions", () => ({ setMonitoring: (...a: unknown[]) => setMonitoring(...a) }));

const NOW = Date.parse("2026-11-08T18:16:16Z");
const row = (over: Partial<ResourceItem> = {}): ResourceItem => ({
  id: "res_checkout_alb", name: "checkout-alb", resourceKey: "arn:aws:alb:ap-northeast-2:1:checkout-alb", resourceType: "ALB", region: "ap-northeast-2",
  account: { awsAccountId: "123456789012", alias: "mirae-prd", alarmWriterEnabled: true, tagWriterEnabled: true },
  org: { customer: { id: "c1", name: "Mirae Pay", slug: "mirae" }, project: { id: "p1", name: "Core", slug: "core" }, service: { id: "s1", name: "Checkout", slug: "checkout" } },
  monitoringState: "NEEDS_REVIEW", needsReviewSince: "2026-11-08T12:00:00Z", needsReviewReason: "tag_removed", alarmCount: 3, lastSeenAt: "2026-11-08T18:00:00Z", ...over,
});
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const ui = (items: ResourceItem[], canWrite = true) => <NeedsReviewTable items={items} now={NOW} canWrite={canWrite} readOnlyReason="Changing monitoring needs the Operator role." />;

beforeEach(() => { setMonitoring.mockReset(); refresh.mockReset(); });
afterEach(cleanup);

describe("Needs review table", () => {
  it("shows resource, since, reason and alarms kept, with the three actions", () => {
    render(ui([row()]));
    const r = screen.getByTestId("needs-review-row");
    expect(within(r).getByText("checkout-alb")).toBeInTheDocument();
    expect(within(r).getByText("Monitoring tag was removed")).toBeInTheDocument();
    expect(within(r).getByText("6h ago")).toBeInTheDocument();
    for (const n of ["Re-tag", "Stop monitoring"]) expect(within(r).getByRole("button", { name: n })).toBeEnabled();
    expect(within(r).queryByRole("button", { name: /keep/i })).toBeNull();
  });

  it("Stop monitoring asks first, naming the alarm count and the resource, and sends nothing until confirmed", async () => {
    setMonitoring.mockResolvedValue({ ok: true, data: { commandId: "cmd_1", status: "queued" } });
    render(ui([row()]));
    fireEvent.click(screen.getByRole("button", { name: "Stop monitoring" }));
    expect(screen.getByTestId("stop-prompt")).toHaveTextContent("Delete 3 alarms for checkout-alb? This cannot be undone.");
    expect(setMonitoring).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByTestId("confirm-dialog")).getByRole("button", { name: "Stop monitoring" }));
    await flush();
    expect(setMonitoring).toHaveBeenCalledWith("res_checkout_alb", "stop");
    expect(screen.getByTestId("row-done")).toHaveTextContent("Stop queued");
    expect(refresh).toHaveBeenCalled();
  });

  it("Cancel in the confirmation sends nothing", async () => {
    render(ui([row()]));
    fireEvent.click(screen.getByRole("button", { name: "Stop monitoring" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(setMonitoring).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });

  it("Stop is off, with 'Enable AlarmWriter role', when the account has no AlarmWriter", () => {
    render(ui([row({ account: { awsAccountId: null, alarmWriterEnabled: false, tagWriterEnabled: true } })]));
    expect(screen.getByRole("button", { name: "Stop monitoring" })).toBeDisabled();
    expect(screen.getByTestId("stop-hint")).toHaveTextContent("Enable AlarmWriter role");
    fireEvent.click(screen.getByRole("button", { name: "Stop monitoring" }));
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });

  it("a portal user's row (no AWS account id) renders", () => {
    render(ui([row({ account: { awsAccountId: null, alarmWriterEnabled: true, tagWriterEnabled: true } })]));
    expect(screen.getByText("checkout-alb")).toBeInTheDocument();
  });

  it("Re-tag is off, with 'Enable TagWriter role', when the account has no TagWriter", () => {
    render(ui([row({ account: { awsAccountId: "123456789012", tagWriterEnabled: false } })]));
    expect(screen.getByRole("button", { name: "Re-tag" })).toBeDisabled();
    expect(screen.getByTestId("retag-hint")).toHaveTextContent("Enable TagWriter role");
    fireEvent.click(screen.getByRole("button", { name: "Re-tag" }));
    expect(setMonitoring).not.toHaveBeenCalled();
  });

  it("a Viewer sees every action off and why", () => {
    render(ui([row()], false));
    for (const n of ["Re-tag", "Stop monitoring"]) expect(screen.getByRole("button", { name: n })).toBeDisabled();
    expect(screen.getByTestId("readonly-note")).toHaveTextContent("Operator role");
  });

  it.each([
    ["CAPABILITY_DISABLED", 403, "TagWriter role is not enabled"],
    ["COMMAND_PUBLISH_FAILED", 502, "could not be queued"],
    ["COMMANDS_UNAVAILABLE", 503, "nothing was changed"],
    ["INVALID_TRANSITION", 409, "no longer needs review"],
  ])("a %s answer is said in a sentence, the row stays actionable", async (code, _status, text) => {
    setMonitoring.mockResolvedValue({ ok: false, code, message: "raw server text", requestId: "req_1" });
    render(ui([row()]));
    fireEvent.click(screen.getByRole("button", { name: "Re-tag" }));
    await flush();
    const err = screen.getByTestId("row-error");
    expect(err).toHaveTextContent(text);
    expect(err.textContent).not.toContain("raw server text");
    expect(screen.queryByTestId("row-done")).toBeNull();
    expect(screen.getByRole("button", { name: "Re-tag" })).toBeEnabled();
  });
});
