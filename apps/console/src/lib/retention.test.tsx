/**
 * D-45 / D-46 in the console: the mock answers like packages/api/src/retentionApi.ts, the legal-hold action is for admins
 * only, the export card offers the download only inside the return period, the digest badge shows one number.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ApiError, type ConsoleApi } from "./api/client";
import { MOCK_USERS, createMockApi, createStore } from "./api/mock/mock-api";
import { digestCount, type Digest } from "./api/types";

const state = vi.hoisted(() => ({ sub: "usr-haeun" as string | null, api: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/" }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => {
    if (!state.sub) throw Object.assign(new Error("Sign in required."), { code: "UNAUTHORIZED" });
    return { sub: state.sub, email: "", name: "", exp: 0, token: "t" };
  },
}));
vi.mock("@/lib/api", () => ({ getApi: async () => (state.api as (sub: string) => ConsoleApi)(state.sub!) }));
const shellUser = vi.hoisted(() => ({ role: "ADMIN" as "ADMIN" | "OPERATOR" }));
vi.mock("@/components/ShellContext", () => ({
  useShell: () => ({ user: { id: "u", name: "U", role: shellUser.role }, toast: vi.fn(), clearToast: vi.fn() }),
  hasRole: (u: { role: string }, min: string) => (min === "ADMIN" ? u.role === "ADMIN" : true),
  roleReason: (_u: unknown, _m: string, what: string) => `${what} needs the Admin role.`,
}));

import { setLegalHold } from "@/app/customers/actions";
import { ExportCard } from "@/app/customers/RetentionCards";
import { DigestBadge } from "@/components/DigestBadge";

let store: ReturnType<typeof createStore>;
let admin: ConsoleApi;
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? `${e.status} ${e.code}` : String(e); } };

beforeEach(() => {
  store = createStore();
  admin = createMockApi(store, undefined, MOCK_USERS["usr-haeun"]!);
  state.sub = "usr-haeun";
  state.api = (sub: string) => createMockApi(store, undefined, MOCK_USERS[sub]!);
  shellUser.role = "ADMIN";
});

describe("mock: legal hold", () => {
  it("place needs a reason; place and release are idempotent and write one purge-log row each", async () => {
    expect(await code(admin.putLegalHold("cus_iruda", "  "))).toBe("400 VALIDATION_FAILED");
    expect(await admin.putLegalHold("cus_iruda", "Dispute with the customer")).toMatchObject({ changed: true, legalHold: { active: true, reason: "Dispute with the customer", byUserId: "usr_haeun" } });
    expect(await admin.putLegalHold("cus_iruda", "again")).toMatchObject({ changed: false });
    expect(await admin.deleteLegalHold("cus_iruda")).toMatchObject({ changed: true, legalHold: { active: false } });
    expect(await admin.deleteLegalHold("cus_iruda")).toMatchObject({ changed: false });
    const log = await admin.getPurgeLog("cus_iruda");
    expect(log.entries.map((e) => e.stage)).toEqual(["CONNECTIONS", "LEGAL_HOLD_SET", "LEGAL_HOLD_RELEASED"]);
    expect(log.schedule).toMatchObject({ returnDays: 30 });
  });

  it("ADMIN only; a portal user gets 404", async () => {
    const op = createMockApi(store, undefined, MOCK_USERS["usr-minjae"]!);
    expect(await code(op.putLegalHold("cus_iruda", "x"))).toBe("403 ROLE_REQUIRED");
    expect(await code(op.getPurgeLog("cus_iruda"))).toBe("403 ROLE_REQUIRED");
    const portal = createMockApi(store, undefined, MOCK_USERS["usr-portal"]!);
    expect(await code(portal.getPurgeLog("cus_iruda"))).toBe("404 NOT_FOUND");
    expect(await code(portal.getLatestDigest())).toBe("404 NOT_FOUND");
  });

  it("the server action runs as admin only", async () => {
    expect(await setLegalHold("cus_iruda", true, "Dispute")).toMatchObject({ ok: true, data: { changed: true } });
    state.sub = "usr-minjae";
    expect(await setLegalHold("cus_iruda", false, "")).toMatchObject({ ok: false, code: "ROLE_REQUIRED" });
    expect((await admin.getPurgeLog("cus_iruda")).legalHold.active).toBe(true);
    state.sub = "usr-haeun";
    expect(await setLegalHold("../x", true, "r")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await setLegalHold("cus_iruda", true, "x".repeat(501))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});

describe("mock: export.csv", () => {
  it("a terminated customer inside the window gets the CSV body (BOM, header, rows)", async () => {
    const res = await admin.exportCsv("cus_iruda");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text.split("\r\n")[0]).toContain("number,id,title,severity");
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(3);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  });
  it("409 for an active customer; 410 after the window", async () => {
    expect(await code(admin.exportCsv("cus_mirae"))).toBe("409 CUSTOMER_NOT_TERMINATED");
    const later = createMockApi(store, () => Date.parse("2026-12-07T00:00:00Z"), MOCK_USERS["usr-haeun"]!);
    expect(await code(later.exportCsv("cus_iruda"))).toBe("410 EXPORT_WINDOW_CLOSED");
  });
});

describe("ExportCard", () => {
  const props = { customerSlug: "iruda", customerName: "Iruda Edu" };
  it("inside the window: enabled, with the deadline", () => {
    render(<ExportCard {...props} deadline="2026-12-06T02:30:00Z" nowMs={Date.parse("2026-11-08T00:00:00Z")} />);
    expect(screen.getByTestId("export-btn")).toBeEnabled();
    expect(screen.getByTestId("export-deadline").textContent).toBe("2026-12-06");
    expect(screen.queryByTestId("export-why")).toBeNull();
  });
  it("after the window: disabled, with the reason and the date", () => {
    render(<ExportCard {...props} deadline="2026-12-06T02:30:00Z" nowMs={Date.parse("2026-12-07T00:00:00Z")} />);
    expect(screen.getByTestId("export-btn")).toBeDisabled();
    expect(screen.getByTestId("export-why").textContent).toContain("return period ended on 2026-12-06");
  });
  it("a non-admin gets the role reason", () => {
    shellUser.role = "OPERATOR";
    render(<ExportCard {...props} deadline="2026-12-06T02:30:00Z" nowMs={Date.parse("2026-11-08T00:00:00Z")} />);
    expect(screen.getByTestId("export-btn")).toBeDisabled();
    expect(screen.getByTestId("export-why").textContent).toContain("needs the Admin role");
  });
  it("a redirect to the login page, or a body that is not a CSV, is never saved as a file", async () => {
    const create = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const html = new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
    vi.stubGlobal("fetch", vi.fn(async () => html));
    render(<ExportCard {...props} deadline="2026-12-06T02:30:00Z" nowMs={Date.parse("2026-11-08T00:00:00Z")} />);
    fireEvent.click(screen.getByTestId("export-btn"));
    expect((await screen.findByTestId("export-err")).textContent).toContain("Your session ended");
    expect(create).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("401 SESSION_ENDED from the route says the session ended", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "SESSION_ENDED", message: "Sign in again.", details: {}, requestId: "" } }, { status: 401 })));
    render(<ExportCard {...props} deadline="2026-12-06T02:30:00Z" nowMs={Date.parse("2026-11-08T00:00:00Z")} />);
    fireEvent.click(screen.getByTestId("export-btn"));
    expect((await screen.findByTestId("export-err")).textContent).toContain("Your session ended");
    vi.unstubAllGlobals();
  });
  it.each([[409, "CUSTOMER_NOT_TERMINATED", "only for a terminated customer"], [410, "EXPORT_WINDOW_CLOSED", "return period is over"], [413, "EXPORT_TOO_LARGE", "too large"]])("answers %s in words", async (status, errCode, text) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: errCode, message: "m", details: {}, requestId: "r1" } }, { status })));
    render(<ExportCard {...props} deadline="2026-12-06T02:30:00Z" nowMs={Date.parse("2026-11-08T00:00:00Z")} />);
    fireEvent.click(screen.getByTestId("export-btn"));
    expect((await screen.findByTestId("export-err")).textContent).toContain(text);
    vi.unstubAllGlobals();
  });
});

describe("digest", () => {
  it("the badge shows one number: incidents of suspended customers + terminated customers still sending", async () => {
    const d = await admin.getLatestDigest();
    expect(digestCount(d)).toBe(2);
    render(<DigestBadge digest={d} />);
    const b = screen.getByTestId("digest-badge");
    expect(b.getAttribute("aria-label")).toBe("Business-hours summary: 2");
    fireEvent.click(b);
    expect(screen.getByTestId("digest-suspended").textContent).toContain("Eden Mobility");
    expect(screen.getByTestId("digest-residuals").textContent).toContain("Iruda Edu");
  });
  it("says what N counts", async () => {
    render(<DigestBadge digest={await admin.getLatestDigest()} />);
    fireEvent.click(screen.getByTestId("digest-badge"));
    expect(screen.getByTestId("digest-meaning").textContent).toContain("2 customers need attention");
  });
  it("an empty digest says so", () => {
    const d: Digest = { businessDay: "2026-11-06", digestAt: "2026-11-06T01:00:00Z", from: "2026-11-05T01:00:00Z", to: "2026-11-06T01:00:00Z", suspended: [], terminatedResiduals: [], totals: { suspendedIncidents: 0, suspendedCustomers: 0, residualCustomers: 0 }, empty: true };
    render(<DigestBadge digest={d} />);
    fireEvent.click(screen.getByTestId("digest-badge"));
    expect(screen.getByTestId("digest-empty")).toBeTruthy();
  });
});
