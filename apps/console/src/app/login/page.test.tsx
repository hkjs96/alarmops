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

describe("LoginPage Google sign-in", () => {
  it("not configured: the button is disabled, with a calm note", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    const html = await render({});
    expect(html).not.toContain('data-testid="sign-in-google"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Sign in with Google/);
    vi.unstubAllEnvs();
  });
  it("configured: a plain link to the start route (no script), carrying a safe next only", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "id"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "s"); vi.stubEnv("SSO_ALLOWED_DOMAINS", "mz.co.kr");
    expect(await render({})).toContain('href="/auth/google/start"');
    expect(await render({ next: "/incidents" })).toContain('href="/auth/google/start?next=%2Fincidents"');
    expect(await render({ next: "//evil.example" })).not.toContain("evil");
    expect(await render({})).not.toContain("<script");
    vi.unstubAllEnvs();
  });
  it("?sso= shows one fixed calm line per key, nothing else", async () => {
    for (const k of ["refused", "failed", "unavailable"]) expect(await render({ sso: k })).toContain('data-testid="login-sso-notice"');
    for (const k of ["x", "<b>", "__proto__", "constructor"]) expect(await render({ sso: k })).not.toContain("login-sso-notice");
  });
});
