import { NextResponse, type NextRequest } from "next/server";
import { mockMode } from "@/lib/mode";
import { sameOriginPost } from "@/lib/auth/origin";
import { SESSION_COOKIE, sessionSecret, verifySession } from "@/lib/auth/session";
import { apiMethod, authForSession, handleApi, queryOf, toResponse } from "@/lib/server/backend";
import { NotConfiguredError } from "@/lib/mode";
import { errorTag } from "@/lib/server/error-tag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message, details: {}, requestId: "" } }, { status, headers: { "cache-control": "no-store" } });

/**
 * `/api/v1/*` — packages/api mounted in the console (D-09). Same origin as the pages; the session cookie is the only
 * credential and the AuthContext is built on the server from it. Writes must come from the console's own origin
 * (the cookie is SameSite=Lax; this is the second check). Mock mode has no HTTP API (the pages use the in-memory store).
 */
async function serve(req: NextRequest): Promise<Response> {
  let mock = false;
  try { mock = mockMode(); } catch { return json(503, "NOT_CONFIGURED", "Misconfigured."); }
  if (mock) return json(404, "NOT_FOUND", "Not found.");
  const method = apiMethod(req.method);
  if (!method) return json(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
  if (method !== "GET" && !sameOriginPost({ origin: req.headers.get("origin"), host: req.headers.get("host"), forwardedHost: req.headers.get("x-forwarded-host"), secFetchSite: req.headers.get("sec-fetch-site"), proto: req.nextUrl.protocol })) {
    return json(403, "FORBIDDEN", "Cross-site request refused.");
  }
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, sessionSecret(process.env, false));
  let body: unknown;
  if (method !== "GET") {
    const text = await req.text();
    if (text.length > 256 * 1024) return json(413, "PAYLOAD_TOO_LARGE", "Request body too large.");
    if (text) { try { body = JSON.parse(text); } catch { return json(400, "VALIDATION_FAILED", "Body must be JSON."); } }
  }
  const headers: Record<string, string> = {};
  // only what the API reads; never the cookie
  for (const h of ["if-match", "if-none-match", "idempotency-key"]) { const v = req.headers.get(h); if (v !== null) headers[h] = v; }
  try {
    const auth = session ? await authForSession(session.sub) : null;
    return toResponse(await handleApi({ method, path: req.nextUrl.pathname, query: queryOf(req.nextUrl), headers, body }, auth));
  } catch (e) {
    if (e instanceof NotConfiguredError) return json(503, "NOT_CONFIGURED", e.message);
    console.error("[api] adapter error", errorTag(e));
    return json(500, "INTERNAL", "Something went wrong.");
  }
}

export { serve as GET, serve as POST, serve as PUT, serve as PATCH, serve as DELETE };

