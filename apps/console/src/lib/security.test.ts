import { apiBaseUrl, mockMode, NotConfiguredError } from "./mode";
import { safeExternalUrl } from "./safe-url";
import { assertIds, assertVersion, assertId, assertBulkAction, MAX_BULK_IDS } from "./validate";
import { signSession, verifySession, sessionSecret, DEV_USER } from "./auth/session";
import { createHttpApi } from "./api/client";

describe("C-1 mock mode", () => {
  it("is allowed in development", () => {
    expect(mockMode({ MOCK_API: "1", NODE_ENV: "development" })).toBe(true);
    expect(mockMode({ NODE_ENV: "production" })).toBe(false);
  });
  it("throws in production", () => {
    expect(() => mockMode({ MOCK_API: "1", NODE_ENV: "production" })).toThrow(/forbidden/);
    expect(() => mockMode({ MOCK_API: "1", NODE_ENV: "development", VERCEL_ENV: "production" })).toThrow(/forbidden/);
    expect(() => mockMode({ MOCK_API: "1", NODE_ENV: "production", VERCEL_ENV: "production", E2E_ALLOW_MOCK: "1" })).toThrow();
    expect(() => mockMode({ MOCK_API: "1", NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "preview", E2E_ALLOW_MOCK: "1" })).toThrow();
  });
  it("allows a local production build only with the e2e flag", () => {
    expect(mockMode({ MOCK_API: "1", NODE_ENV: "production", E2E_ALLOW_MOCK: "1" })).toBe(true);
  });
});

describe("C-2 session + token forwarding", () => {
  const secret = "x".repeat(32);
  it("signs and verifies; rejects tampered, expired, wrong secret", async () => {
    const t = await signSession({ ...DEV_USER, exp: 2e9 }, secret);
    expect((await verifySession(t, secret, 1e9))?.sub).toBe(DEV_USER.sub);
    expect(await verifySession(t, "y".repeat(32), 1e9)).toBeNull();
    expect(await verifySession(t, secret, 3e9)).toBeNull();
    const [b, s] = t.split(".");
    expect(await verifySession(`${b}x.${s}`, secret, 1e9)).toBeNull();
    expect(await verifySession(undefined, secret)).toBeNull();
    expect(await verifySession(t, null, 1e9)).toBeNull();
  });
  it("has no secret outside mock mode unless SESSION_SECRET is set", () => {
    expect(sessionSecret({}, false)).toBeNull();
    expect(sessionSecret({ SESSION_SECRET: "short" }, false)).toBeNull();
    expect(sessionSecret({ SESSION_SECRET: secret }, false)).toBe(secret);
    expect(sessionSecret({}, true)).toBeTruthy();
  });
  it("http client forwards Authorization", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "u" }), { status: 200 }));
    await createHttpApi({ baseUrl: "https://api.test", fetch: f as unknown as typeof fetch, headers: () => ({ authorization: "Bearer tok" }) }).me();
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });
});

describe("C-3 API_BASE_URL", () => {
  it("fails closed when missing", () => {
    expect(() => apiBaseUrl({})).toThrow(NotConfiguredError);
    expect(() => apiBaseUrl({ API_BASE_URL: " " })).toThrow(NotConfiguredError);
    expect(apiBaseUrl({ API_BASE_URL: "https://api.x" })).toBe("https://api.x");
  });
});

describe("C-4 safeExternalUrl", () => {
  it("allows https only", () => {
    expect(safeExternalUrl("https://wiki.example.com/rb")).toBe("https://wiki.example.com/rb");
    for (const bad of ["http://x.com", "javascript:alert(1)", "data:text/html,hi", "//x.com", "nope", "https://u:p@x.com", 5, null]) {
      expect(safeExternalUrl(bad)).toBeNull();
    }
  });
  it("Slack links must be *.slack.com", () => {
    expect(safeExternalUrl("https://acme.slack.com/archives/C1/p1", { slack: true })).toBeTruthy();
    expect(safeExternalUrl("https://slack.com/x", { slack: true })).toBeTruthy();
    expect(safeExternalUrl("https://evilslack.com/x", { slack: true })).toBeNull();
    expect(safeExternalUrl("https://acme.slack.com.evil.io/x", { slack: true })).toBeNull();
  });
});

describe("C-5 input validation", () => {
  it("ids list 1..200", () => {
    expect(assertIds(["a", "b"])).toEqual(["a", "b"]);
    expect(() => assertIds([])).toThrow();
    expect(() => assertIds(Array.from({ length: MAX_BULK_IDS + 1 }, (_, i) => `i${i}`))).toThrow();
    expect(assertIds(Array.from({ length: MAX_BULK_IDS }, (_, i) => `i${i}`))).toHaveLength(200);
    expect(() => assertIds("a")).toThrow();
    expect(() => assertIds([1])).toThrow();
  });
  it("version integer, id shape, action enum", () => {
    expect(assertVersion(3)).toBe(3);
    for (const v of [1.5, "3", -1, NaN, null]) expect(() => assertVersion(v)).toThrow();
    expect(() => assertId("../x")).toThrow();
    expect(() => assertBulkAction("delete")).toThrow();
  });
});
