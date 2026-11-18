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

describe("LoginPage notices (QA #64)", () => {
  it("refused names whom to contact, without the reason", async () => {
    const html = await render({ sso: "refused" });
    expect(html).toContain("contact the person who gave you access.");
    const n = /<p[^>]*data-testid="login-sso-notice"[^>]*>(.*?)<\/p>/.exec(html)?.[1] ?? "";
    expect(n).not.toMatch(/administrator|domain|registered|inactive/i);
  });
  it("the notice sits after 'Use your Google account.' and before the button, as an alert with the error tone", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "id"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "s"); vi.stubEnv("SSO_ALLOWED_DOMAINS", "mz.co.kr");
    const html = await render({ sso: "failed" });
    const iUse = html.indexOf("Use your Google account."), iNote = html.indexOf("login-sso-notice"), iBtn = html.indexOf("sign-in-google");
    expect(iUse).toBeGreaterThan(-1);
    expect(iUse).toBeLessThan(iNote);
    expect(iNote).toBeLessThan(iBtn);
    expect(html).toMatch(/<p[^>]*class="banner red"[^>]*role="alert"|<p[^>]*role="alert"[^>]*class="banner red"/);
    vi.unstubAllEnvs();
  });
  it("not configured + ?sso=unavailable: one message, not two", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    const html = await render({ sso: "unavailable" });
    expect(html).toContain("Google sign-in is unavailable right now");
    expect(html).not.toContain("not set up in this environment");
    expect(html).not.toContain("Sign-in is unavailable until");
    vi.unstubAllEnvs();
  });
  it("dev links (mock): one per line, 44px tap height", async () => {
    const html = await render({});
    expect(html.match(/min-height:44px[^>]*>Sign in as [^<]*\(dev\)/g)?.length).toBe(3);
  });
});
