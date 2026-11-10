/** Server action input checks (security review C-5). Server actions accept arbitrary client input. */
export const MAX_BULK_IDS = 200;
/**
 * The one id pattern (security R-6). Dot-only values ("." "..") are refused: encodeURIComponent leaves them as they
 * are, and a path segment of dots would be folded away by fetch (/incidents/../ack → /ack).
 */
export const ID_RE = /^(?!\.+$)[A-Za-z0-9._:-]{1,128}$/;
/** The one slug pattern (API-CONTRACT §2): customer, project and service slugs in addresses and queries. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
export const isSlug = (v: unknown): v is string => typeof v === "string" && SLUG_RE.test(v);

export class InvalidInputError extends Error {
  readonly code = "INVALID_INPUT";
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

export function assertId(v: unknown, name = "id"): string {
  if (!isId(v)) throw new InvalidInputError(`Invalid ${name}.`);
  return v;
}
export function assertVersion(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new InvalidInputError("Invalid version.");
  return v;
}
/** Bulk targets: every item carries the version the user saw (API-CONTRACT §8.1, security R-3). */
export function assertBulkItems(v: unknown): { id: string; version: number }[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BULK_IDS) {
    throw new InvalidInputError(`items must be a list of 1-${MAX_BULK_IDS} items.`);
  }
  return v.map((x) => {
    const o = (x ?? {}) as { id?: unknown; version?: unknown };
    return { id: assertId(o.id), version: assertVersion(o.version) };
  });
}
export function assertBulkAction(v: unknown): "ack" | "resolve" {
  if (v !== "ack" && v !== "resolve") throw new InvalidInputError("Invalid action.");
  return v;
}
export function assertToken(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 512) throw new InvalidInputError("Invalid token.");
  return v;
}
