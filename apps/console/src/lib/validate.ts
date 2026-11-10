/** Server action input checks (security review C-5). Server actions accept arbitrary client input. */
export const MAX_BULK_IDS = 200;
export const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export class InvalidInputError extends Error {
  readonly code = "INVALID_INPUT";
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

export function assertId(v: unknown, name = "id"): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new InvalidInputError(`Invalid ${name}.`);
  return v;
}
export function assertVersion(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new InvalidInputError("Invalid version.");
  return v;
}
export function assertIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BULK_IDS) {
    throw new InvalidInputError(`ids must be a list of 1-${MAX_BULK_IDS} items.`);
  }
  return v.map((x) => assertId(x));
}
export function assertBulkAction(v: unknown): "ack" | "resolve" {
  if (v !== "ack" && v !== "resolve") throw new InvalidInputError("Invalid action.");
  return v;
}
export function assertToken(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 512) throw new InvalidInputError("Invalid token.");
  return v;
}
