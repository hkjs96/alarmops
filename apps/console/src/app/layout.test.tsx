// @vitest-environment node
/** The root layout: GET /me → 401 (a signed cookie the API no longer accepts) is "not signed in", not an error page. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

vi.mock("@alarmops/design-system/styles.css", () => ({}));
vi.mock("./globals.css", () => ({}));
vi.mock("./fonts", () => ({ fontVariables: "" }));
vi.mock("@/components/ScopeShell", () => ({ ScopeShell: () => null }));
vi.mock("@/lib/shell-prefs", () => ({ shellInitScript: "" }));
vi.mock("@/components/ThemeToggle", () => ({ themeInitScript: "" }));
vi.mock("@/lib/auth", () => ({ getSession: async () => ({ sub: "usr_a", email: "", name: "", exp: 0, token: "t" }) }));
const me = vi.fn();
vi.mock("@/lib/api", () => ({ getApi: async () => ({ me, listIncidents: async () => ({ counts: { open: 0 } }), scopeTree: async () => ({ customers: [] }) }) }));
const redirect = vi.fn((to: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { to }); });
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));

import RootLayout from "./layout";

describe("RootLayout", () => {
  beforeEach(() => { me.mockReset(); redirect.mockClear(); });
  it("401 from me() → /auth/ended (cookie removed there, then /login)", async () => {
    me.mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.", "", {}));
    await expect(RootLayout({ children: null })).rejects.toMatchObject({ to: "/auth/ended" });
    expect(redirect).toHaveBeenCalledWith("/auth/ended");
  });
  it("any other failure is still an error", async () => {
    me.mockRejectedValue(new ApiError(500, "INTERNAL", "x", "", {}));
    await expect(RootLayout({ children: null })).rejects.toMatchObject({ status: 500 });
    expect(redirect).not.toHaveBeenCalled();
  });
  it("signed in: the shell is rendered", async () => {
    me.mockResolvedValue({ id: "usr_a", name: "A", role: "ADMIN" });
    await expect(RootLayout({ children: null })).resolves.toBeTruthy();
  });
});
