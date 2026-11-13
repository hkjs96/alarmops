// @vitest-environment node
/** Production hardening (issue #11): CONSOLE_ORIGIN required, /auth/session rate limit, CSP nonce in middleware. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/backend", () => ({ authForSession: vi.fn() }));

import { consoleOrigin, sameOriginPost } from "./auth/origin";
import { clientIp, hit, resetRateLimits } from "./server/rate-limit";
import { middleware } from "../middleware";
import { GET as sessionGET } from "../app/auth/session/route";

afterEach(() => { vi.unstubAllEnvs(); resetRateLimits(); });

describe("CONSOLE_ORIGIN is required in production (2a)", () => {
  const post = { origin: "https://console.example.com", host: "console.example.com", forwardedHost: null, secFetchSite: "same-origin", proto: "https" };
  it("production without it (or with junk) fails closed — no fallback to the Host header", () => {
    expect(() => consoleOrigin({ NODE_ENV: "production" })).toThrow(/CONSOLE_ORIGIN is not configured/);
    expect(() => consoleOrigin({ NODE_ENV: "production", CONSOLE_ORIGIN: "not a url" })).toThrow();
    expect(() => consoleOrigin({ NODE_ENV: "production", CONSOLE_ORIGIN: "ftp://x.example" })).toThrow();
    expect(sameOriginPost(post, { NODE_ENV: "production" })).toBe(false);
  });
  it("production with it: that origin, and only that", () => {
    const env = { NODE_ENV: "production", CONSOLE_ORIGIN: "https://console.example.com/" };
    expect(consoleOrigin(env)).toBe("https://console.example.com");
    expect(sameOriginPost(post, env)).toBe(true);
    expect(sameOriginPost({ ...post, origin: "https://evil.example" }, env)).toBe(false);
  });
  it("dev and test keep working without it; the mock e2e run (next start) too", () => {
    expect(consoleOrigin({ NODE_ENV: "development" })).toBeNull();
    expect(consoleOrigin({ NODE_ENV: "test" })).toBeNull();
    expect(consoleOrigin({ NODE_ENV: "production", MOCK_API: "1", E2E_ALLOW_MOCK: "1" })).toBeNull();
    expect(() => consoleOrigin({ NODE_ENV: "production", MOCK_API: "1" })).toThrow();
  });
  it("the mock exemption is mockMode()'s: never on Vercel production, never with a CONSOLE_ORIGIN that is invalid", () => {
    const e = { NODE_ENV: "production", MOCK_API: "1", E2E_ALLOW_MOCK: "1" };
    expect(() => consoleOrigin({ ...e, VERCEL_ENV: "production" })).toThrow();
    expect(() => consoleOrigin({ ...e, VERCEL: "1" })).toThrow();
    expect(() => consoleOrigin({ ...e, CONSOLE_ORIGIN: "junk" })).toThrow();
    expect(consoleOrigin({ ...e, CONSOLE_ORIGIN: "https://c.example" })).toBe("https://c.example");
  });
  it("middleware answers 503 for every request in a misconfigured production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONSOLE_ORIGIN", "");
    vi.stubEnv("MOCK_API", "");
    const res = await middleware(new NextRequest("http://localhost:3107/login"));
    expect(res.status).toBe(503);
  });
});

describe("rate limit (2b)", () => {
  it("fixed window: the limit-th request passes, the next is refused with a Retry-After, the window then reopens", () => {
    expect(hit("k", 2, 1000, 0).ok).toBe(true);
    expect(hit("k", 2, 1000, 10).ok).toBe(true);
    const r = hit("k", 2, 1000, 400);
    expect(r).toEqual({ ok: false, retryAfterSec: 1 });
    expect(hit("other", 2, 1000, 400).ok).toBe(true);
    expect(hit("k", 2, 1000, 1000).ok).toBe(true);
  });
  it("a full table evicts the oldest keys, not everybody: a flood of new keys does not wipe a counted address", () => {
    hit("victim", 1, 60_000, 0);
    expect(hit("victim", 1, 60_000, 1).ok).toBe(false);
    for (let i = 0; i < 10_050; i++) hit(`flood-${i}`, 1, 60_000, 2 + i);
    expect(hit("flood-10049", 1, 60_000, 20_000).ok).toBe(false); // the newest are still counted
  });
  it("/auth/session: random cookies do not get a bucket of their own (only the address counts)", async () => {
    vi.stubEnv("SESSION_SECRET", "x".repeat(40));
    vi.stubEnv("MOCK_API", "");
    for (let i = 0; i < 121; i++) {
      const r = new NextRequest("http://localhost/auth/session");
      r.cookies.set("ao_session", `forged-${i}`);
      const res = await sessionGET(r);
      if (i < 120) expect(res.status).not.toBe(429); else expect(res.status).toBe(429); // the address bucket, whatever the cookie
    }
  });
  it("X-Forwarded-For counts only behind a trusted proxy", () => {
    const h = new Headers({ "x-forwarded-for": "6.6.6.6, 10.0.0.1" });
    expect(clientIp(h, {})).toBe("direct");
    expect(clientIp(h, { TRUSTED_PROXY: "1" })).toBe("10.0.0.1");
  });
  it("GET /auth/session answers 429 in the contract's error format with Retry-After", async () => {
    vi.stubEnv("SESSION_SECRET", "x".repeat(40));
    vi.stubEnv("MOCK_API", "");
    let last = 0;
    let res!: Response;
    for (let i = 0; i < 121; i++) { res = await sessionGET(new NextRequest("http://localhost/auth/session")); last = res.status; }
    expect(last).toBe(429);
    const ra = Number(res.headers.get("retry-after"));
    expect(ra).toBeGreaterThanOrEqual(1);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: "RATE_LIMITED", message: expect.any(String), details: { retryAfterSec: ra } });
    expect(body.error.requestId).toMatch(/^req_/);
  });
});

describe("CSP nonce (2c)", () => {
  beforeEach(() => { vi.stubEnv("MOCK_API", "1"); });
  it("each response has its own nonce; production scripts have no 'unsafe-inline'", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONSOLE_ORIGIN", "https://console.example.com");
    vi.stubEnv("E2E_ALLOW_MOCK", "1");
    const a = (await middleware(new NextRequest("http://localhost:3107/login"))).headers.get("content-security-policy")!;
    const b = (await middleware(new NextRequest("http://localhost:3107/login"))).headers.get("content-security-policy")!;
    const script = (c: string) => c.split("; ").find((d) => d.startsWith("script-src "))!;
    expect(script(a)).toMatch(/^script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}' 'strict-dynamic'$/);
    expect(script(a)).not.toBe(script(b));
    expect(a).not.toMatch(/unsafe-eval/);
  });
  it("the redirect to /login carries it too", async () => {
    const res = await middleware(new NextRequest("http://localhost:3107/incidents"));
    expect(res.status).toBe(307);
    expect(res.headers.get("content-security-policy")).toContain("'nonce-");
  });
});
