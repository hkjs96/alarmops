import { apiBaseUrl, mockMode, NotConfiguredError } from "./mode";
import { safeExternalUrl } from "./safe-url";
import { assertBulkItems, assertVersion, assertId, assertBulkAction, isId, isSlug, MAX_BULK_IDS } from "./validate";
import { parsePanelRoute, parseScopeParams } from "./scope";
import { ApiError, isHidden } from "./api/client";
import { securityHeaders } from "../../next.config";
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
  it("bulk items 1..200, each with an id and the version the user saw", () => {
    const it = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, version: i }));
    expect(assertBulkItems([{ id: "a", version: 1, extra: "dropped" }])).toEqual([{ id: "a", version: 1 }]);
    expect(() => assertBulkItems([])).toThrow();
    expect(() => assertBulkItems(it(MAX_BULK_IDS + 1))).toThrow();
    expect(assertBulkItems(it(MAX_BULK_IDS))).toHaveLength(200);
    for (const bad of ["a", ["a"], [1], [{ id: "a" }], [{ id: "a", version: "1" }], [{ id: "..", version: 1 }], [null]]) expect(() => assertBulkItems(bad)).toThrow();
  });
  it("version integer, id shape, action enum", () => {
    expect(assertVersion(3)).toBe(3);
    for (const v of [1.5, "3", -1, NaN, null]) expect(() => assertVersion(v)).toThrow();
    expect(() => assertId("../x")).toThrow();
    expect(() => assertBulkAction("delete")).toThrow();
  });
});

describe("R-6 one id / slug validator", () => {
  it("refuses dot-only ids everywhere an id is accepted", () => {
    for (const bad of [".", "..", "...", "", "a/b", "a b", "../x", "a".repeat(129), 5, null, undefined]) {
      expect(isId(bad), String(bad)).toBe(false);
      expect(() => assertId(bad)).toThrow();
    }
    for (const ok of ["inc-7f3a0c91b2d4-20261108181204", "a.b", ".a", "a..b", "x:y_z", "A1"]) expect(isId(ok), ok).toBe(true);
    // the panel address and server-action input use the same check
    expect(parsePanelRoute("mirae", ["incident", ".."])).toBeNull();
    expect(parsePanelRoute("mirae", ["incident", "."])).toBeNull();
    expect(parsePanelRoute("-", ["incident", "..."])).toBeNull();
    expect(parsePanelRoute("mirae", ["incident", "a.b"])).not.toBeNull();
    expect(() => assertBulkItems([{ id: "..", version: 1 }])).toThrow();
  });
  it("slugs: lower-case letters, digits and dashes; never dots", () => {
    for (const bad of [".", "..", "-", "-a", "A", "a.b", "a/b", "", "a".repeat(65), 1, null]) expect(isSlug(bad), String(bad)).toBe(false);
    for (const ok of ["mirae", "payments-api", "0a", "a".repeat(64)]) expect(isSlug(ok)).toBe(true);
    expect(parseScopeParams({ customer: ".." }).malformed).toBe(true);
    expect(parseScopeParams({ customer: "mirae", project: "." }).malformed).toBe(true);
    expect(parsePanelRoute("..", ["incident", "x"])).toBeNull();
    expect(parsePanelRoute("mirae", ["..", "incident", "x"])).toBeNull();
  });
});

describe("R-5 a 403 on a read is the same as a 404", () => {
  it("isHidden", () => {
    expect(isHidden(new ApiError(404, "NOT_FOUND", "Not found.", "r"))).toBe(true);
    expect(isHidden(new ApiError(403, "FORBIDDEN", "No.", "r"))).toBe(true);
    for (const s of [400, 401, 409, 500, 503]) expect(isHidden(new ApiError(s, "X", "x", "r"))).toBe(false);
    expect(isHidden(new Error("x"))).toBe(false);
  });
});

describe("R-4 security response headers", () => {
  const h = (prod: boolean) => Object.fromEntries(securityHeaders(prod).map((x) => [x.key, x.value]));
  it("no framing, no sniffing, short referrer", () => {
    const p = h(true);
    expect(p["X-Frame-Options"]).toBe("DENY");
    expect(p["X-Content-Type-Options"]).toBe("nosniff");
    expect(p["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(p["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });
  it("CSP: own origin plus Google Fonts only; no eval and no remote scripts in production", () => {
    const d = Object.fromEntries(h(true)["Content-Security-Policy"]!.split("; ").map((x) => [x.split(" ")[0]!, x.split(" ").slice(1)]));
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d["style-src"]).toEqual(["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]);
    expect(d["font-src"]).toEqual(["'self'", "https://fonts.gstatic.com"]);
    expect(d["connect-src"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(h(true)["Content-Security-Policy"]).not.toMatch(/unsafe-eval|\*|http:/);
    expect(h(false)["Content-Security-Policy"]).toContain("'unsafe-eval'"); // next dev only
  });
});
