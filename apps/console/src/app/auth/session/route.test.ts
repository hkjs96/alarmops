// @vitest-environment node
/** /auth/session and /auth/ended check the principal, not only the cookie (suspended portal user = not signed in). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
const authForSession = vi.fn();
vi.mock("@/lib/server/backend", () => ({ authForSession: (sub: string) => authForSession(sub) }));

import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { GET as sessionGET } from "./route";
import { GET as endedGET } from "../ended/route";

const SECRET = "x".repeat(40);
const req = async (path: string, sub: string | null) => {
  const r = new NextRequest(`http://localhost${path}`);
  if (sub) r.cookies.set(SESSION_COOKIE, await signSession({ sub, email: "e@example.test", name: "N", exp: Date.now() / 1000 + 3600 }, SECRET));
  return r;
};

beforeEach(() => { vi.stubEnv("SESSION_SECRET", SECRET); vi.stubEnv("MOCK_API", ""); authForSession.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("GET /auth/session", () => {
  it("204 only when the user still resolves to a principal", async () => {
    authForSession.mockResolvedValue({ userId: "usr_a", kind: "INTERNAL", customerIds: "*", role: "ADMIN" });
    expect((await sessionGET(await req("/auth/session", "usr_a"))).status).toBe(204);
    expect(authForSession).toHaveBeenCalledWith("usr_a");
  });
  it("401 for a valid cookie whose user has no principal (suspended customer, disabled user)", async () => {
    authForSession.mockResolvedValue(null);
    expect((await sessionGET(await req("/auth/session", "usr_suspended"))).status).toBe(401);
  });
  it("401 without a cookie, without asking the store", async () => {
    expect((await sessionGET(await req("/auth/session", null))).status).toBe(401);
    expect(authForSession).not.toHaveBeenCalled();
  });
  it("503 (cannot say) when the store does not answer — never 401", async () => {
    authForSession.mockRejectedValue(new Error("db down"));
    expect((await sessionGET(await req("/auth/session", "usr_a"))).status).toBe(503);
  });
});

describe("GET /auth/ended", () => {
  it("dead session: the cookie is removed and the browser goes to /login", async () => {
    authForSession.mockResolvedValue(null);
    const res = await endedGET(await req("/auth/ended", "usr_suspended"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?ended=1");
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBe("");
  });
  it("a principal the API would refuse (normalizeAuth fails) is signed out, not bounced back to /incidents", async () => {
    authForSession.mockResolvedValue({ userId: "usr_a", kind: "ROBOT", customerIds: "*", role: "ADMIN" });
    const res = await endedGET(await req("/auth/ended?from=layout", "usr_a"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?ended=1");
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBe("");
    expect((await sessionGET(await req("/auth/session", "usr_a"))).status).toBe(401);
  });
  it("live session sent by the layout's 401 (?from=layout): a plain 200 page, no redirect, cookie kept", async () => {
    authForSession.mockResolvedValue({ userId: "usr_a", kind: "INTERNAL", customerIds: "*", role: "ADMIN" });
    const res = await endedGET(await req("/auth/ended?from=layout", "usr_a"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    const html = await res.text();
    expect(html).toContain("Something went wrong — try again");
    expect(html).toContain('href="/incidents"');
    expect(html).toMatch(/<form method="post" action="\/auth\/sign-out"><button type="submit">Sign out<\/button><\/form>/);
    expect(html).toContain("min-height:44px");
  });
  it("only the fixed flag value counts: any other ?from= is a normal redirect to /incidents", async () => {
    authForSession.mockResolvedValue({ userId: "usr_a", kind: "INTERNAL", customerIds: "*", role: "ADMIN" });
    for (const v of ["https://evil.example", "/x", "Layout", ""]) {
      const res = await endedGET(await req(`/auth/ended?from=${encodeURIComponent(v)}`, "usr_a"));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/incidents");
    }
  });
  it("live session (a link from elsewhere): nothing is removed", async () => {
    authForSession.mockResolvedValue({ userId: "usr_a", kind: "INTERNAL", customerIds: "*", role: "ADMIN" });
    const res = await endedGET(await req("/auth/ended", "usr_a"));
    expect(res.headers.get("location")).toBe("/incidents");
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
  it("store down: 503, cookie kept", async () => {
    authForSession.mockRejectedValue(new Error("db down"));
    const res = await endedGET(await req("/auth/ended", "usr_a"));
    expect(res.status).toBe(503);
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
});
