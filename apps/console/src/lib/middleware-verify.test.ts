// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.stubEnv("MOCK_API", "1");
vi.stubEnv("NODE_ENV", "test");

import { middleware } from "../middleware";

const call = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => middleware(new NextRequest(`http://localhost${path}`, init));

describe("middleware: the public verification link", () => {
  for (const [name, init] of [["GET", {}], ["POST (the Confirm server action)", { method: "POST", headers: { "next-action": "abc" } }]] as const) {
    it(`${name} on /verify/<token> needs no session and carries the three headers`, async () => {
      const res = await call("/verify/vf_abc-123", init);
      expect(res.status).toBe(200);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toContain("nonce-");
    });
  }
  it("is an exact pattern: a longer path or a look-alike is not public", async () => {
    for (const p of ["/verify/x/y", "/verifyX", "/verify", "/verify/", "/verify/a.b", `/verify/${"x".repeat(201)}`]) {
      const res = await call(p);
      expect(res.status, p).toBe(307);
      expect(res.headers.get("location"), p).toContain("/login");
      expect(res.headers.get("referrer-policy"), p).toBeNull();
    }
  });
  it("other pages keep their session gate and do not get the verify headers", async () => {
    const res = await call("/customers/new");
    expect(res.status).toBe(307);
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });
});
