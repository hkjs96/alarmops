import { NextResponse, type NextRequest } from "next/server";
import { getApi } from "@/lib/api";
import { ApiError, isHidden } from "@/lib/api/client";
import { NotConfiguredError } from "@/lib/mode";
import { errorTag } from "@/lib/server/error-tag";
import { isId, isSlug } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fail = (status: number, code: string, message: string, details: Record<string, unknown> = {}, requestId = "") =>
  NextResponse.json({ error: { code, message, details, requestId } }, { status, headers: { "cache-control": "no-store" } });

/**
 * GET /customers/{slug-or-id}/export.csv: the incident history of a terminated customer (D-45, ADMIN, during the return
 * period). The console page fetches this same-origin and hands the file to the browser; the body is the API's stream,
 * passed through chunk by chunk. Errors are JSON before the first byte (409 / 410 / 413 / 403 / 404). Works in mock mode too
 * (/api/v1 does not exist there). Only GET, session cookie only.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!isSlug(id) && !isId(id)) return fail(404, "NOT_FOUND", "Not found.");
  try {
    const api = await getApi();
    const [tree, me] = await Promise.all([api.scopeTree(), api.me()]);
    const c = tree.customers.find((x) => x.slug === id || x.id === id);
    if (!c) return fail(404, "NOT_FOUND", "Not found.");
    if (me.role !== "ADMIN") return fail(403, "ROLE_REQUIRED", "Exporting the incident history needs the ADMIN role.", { role: "ADMIN" });
    const up = await api.exportCsv(c.id);
    const headers = new Headers({ "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    for (const h of ["content-disposition", "x-export-closes-at"]) { const v = up.headers.get(h); if (v) headers.set(h, v); }
    return new Response(up.body, { status: 200, headers });
  } catch (e) {
    if (e instanceof NotConfiguredError) return fail(503, "NOT_CONFIGURED", e.message);
    if (e instanceof ApiError) {
      if (e.code === "UNAUTHENTICATED") return fail(401, "SESSION_ENDED", "Sign in again.");
      if (isHidden(e) && e.status === 404) return fail(404, "NOT_FOUND", "Not found.", {}, e.requestId);
      const closedAt = typeof e.details.closedAt === "string" ? { closedAt: e.details.closedAt } : {};
      return fail(e.status, e.code, e.message, closedAt, e.requestId);
    }
    if (e instanceof Error && (e as Error & { code?: unknown }).code === "UNAUTHORIZED") return fail(401, "SESSION_ENDED", "Sign in again.");
    console.error("[export] failed", errorTag(e));
    return fail(500, "INTERNAL", "Something went wrong.");
  }
}
