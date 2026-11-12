// @vitest-environment node
/** /auth/dev-login: off → 404; on but the store refuses the user → /login?ended=1 (not a bare 404); on → a session. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
const authForSession = vi.fn();
vi.mock("@/lib/server/backend", () => ({ authForSession: (sub: string) => authForSession(sub) }));

import { SESSION_COOKIE } from "@/lib/auth/session";
import { GET } from "./route";

const SECRET = "x".repeat(40);
const req = (q = "") => new NextRequest(`http://localhost/auth/dev-login${q}`);

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("MOCK_API", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("NODE_ENV", "test");
  authForSession.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("GET /auth/dev-login (live)", () => {
  it("dev login disabled: 404, the store is not asked", async () => {
    vi.stubEnv("LIVE_DEV_LOGIN", "");
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(authForSession).not.toHaveBeenCalled();
  });
  it("dev login enabled, principal refused: /login?ended=1, no cookie", async () => {
    vi.stubEnv("LIVE_DEV_LOGIN", "1");
    authForSession.mockResolvedValue(null);
    const res = await GET(req("?as=viewer"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?ended=1");
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
  it("dev login enabled, principal accepted: a session cookie and the redirect", async () => {
    vi.stubEnv("LIVE_DEV_LOGIN", "1");
    authForSession.mockResolvedValue({ userId: "usr_a", kind: "INTERNAL", customerIds: "*", role: "ADMIN", name: "A" });
    const res = await GET(req());
    expect(res.status).toBe(307);
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBeTruthy();
  });
});
