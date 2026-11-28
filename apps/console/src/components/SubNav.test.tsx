/**
 * The Call order tabs by who is looking: staff get Call order, Rotations and Templates; a portal user gets no Rotations and no
 * Templates tab (those addresses are "Not found" for them), and with one tab left there is no tab line at all.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ShellApi } from "./ShellContext";

const path = vi.hoisted(() => ({ value: "/call-order" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.value }));

import { ShellContext } from "./ShellContext";
import { SubNav } from "./SubNav";

const mount = (pathname: string, user: { role: "ADMIN" | "VIEWER"; kind?: "INTERNAL" | "CUSTOMER" }) => {
  path.value = pathname;
  return render(
    <ShellContext.Provider value={{ user: { id: "u", name: "U", ...user } } as unknown as ShellApi}>
      <SubNav />
    </ShellContext.Provider>,
  );
};

describe("SubNav, Call order", () => {
  it.each(["ADMIN", "VIEWER"] as const)("a staff %s sees the three tabs", (role) => {
    mount("/call-order", { role, kind: "INTERNAL" });
    const nav = screen.getByRole("navigation", { name: "Call order sections" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Call order", "Rotations", "Templates"]);
  });

  it("a portal user: no Rotations, no Templates", () => {
    mount("/c/mirae/call-order", { role: "VIEWER", kind: "CUSTOMER" });
    expect(screen.queryByRole("link", { name: "Rotations" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Templates" })).toBeNull();
  });

  it("a portal user has a single tab, so the tab line is not drawn", () => {
    const { container } = mount("/c/mirae/call-order", { role: "VIEWER", kind: "CUSTOMER" });
    expect(container.querySelector("nav")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
