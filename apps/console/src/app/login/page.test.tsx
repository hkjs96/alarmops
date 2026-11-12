// @vitest-environment node
/** /login?ended=1: one calm line, nothing about why (no customer status); only the fixed flag shows it. */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/api", () => ({ isMock: () => true }));
vi.mock("@/lib/auth", () => ({ getSession: async () => null }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import LoginPage from "./page";

const NOTICE = "You were signed out. If you can&#x27;t sign back in, contact your administrator.";
const render = async (sp: Record<string, string>) => renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(sp) }));

describe("LoginPage notice", () => {
  it("?ended=1 shows the one-line notice as a status, without customer status words", async () => {
    const html = await render({ ended: "1" });
    expect(html).toContain(NOTICE);
    expect(html).toContain('role="status"');
    const notice = /<p[^>]*data-testid="login-ended"[^>]*>(.*?)<\/p>/.exec(html)?.[1] ?? "";
    expect(notice).toBe(NOTICE);
    expect(html).not.toMatch(/suspend|customer/i);
  });
  it("no flag, or any other value: no notice", async () => {
    for (const sp of [{} as Record<string, string>, { ended: "0" }, { ended: "yes" }, { ended: "https://evil.example" }]) {
      expect(await render(sp)).not.toContain("You were signed out");
    }
  });
});
