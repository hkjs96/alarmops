import { ApiError } from "./api/client";

/** What a server action hands back to the page. `details` is the contract's `error.details` (lib/errors.ts words it). */
export type ActionFailure = { ok: false; code: string; message: string; requestId: string; details?: Record<string, unknown> };
export type ActionResult<T = null> = { ok: true; data: T } | ActionFailure;

/** Only plain, known values cross to the browser: numbers, strings, booleans and one level of field lists. */
function safeDetails(d: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of ["field", "role", "perCycle", "perHour", "responders", "limit", "retryAfterSec", "currentVersion", "mutedUntil"]) {
    const v = d[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  if (Array.isArray(d.fields)) {
    out.fields = d.fields.slice(0, 20).map((f) => {
      const o = (f ?? {}) as Record<string, unknown>;
      return { field: typeof o.field === "string" ? o.field.slice(0, 80) : "", message: typeof o.message === "string" ? o.message.slice(0, 300) : "" };
    });
  }
  return Object.keys(out).length ? out : undefined;
}

export function fail(e: unknown): ActionFailure {
  if (e instanceof ApiError) {
    // "belongs to another customer" is answered like "does not exist" (security review 권고 3)
    if (e.code === "CROSS_CUSTOMER" && typeof e.details?.field !== "string") return { ok: false, code: "NOT_FOUND", message: "Not found.", requestId: e.requestId };
    const details = safeDetails(e.details ?? {});
    return { ok: false, code: e.code, message: e.code === "CROSS_CUSTOMER" ? "Not found." : e.message, requestId: e.requestId, ...(details ? { details } : {}) };
  }
  // the console's own refusals (UnauthorizedError, InvalidInputError, NotConfiguredError): their message is written for the user
  const code = e instanceof Error ? (e as Error & { code?: unknown }).code : undefined;
  if (e instanceof Error && (code === "UNAUTHORIZED" || code === "INVALID_INPUT" || code === "NOT_CONFIGURED")) return { ok: false, code, message: e.message, requestId: "" };
  return { ok: false, code: "UNKNOWN", message: "Something went wrong.", requestId: "" };
}
