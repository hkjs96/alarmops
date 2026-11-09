/** Runtime-mode guards (security review C-1, C-3). Pure: takes env so it can be unit tested. */
type Env = Record<string, string | undefined>;

export class NotConfiguredError extends Error {
  readonly code = "NOT_CONFIGURED";
  readonly status = 503;
  constructor(what: string) {
    super(`${what} is not configured.`);
    this.name = "NotConfiguredError";
  }
}

/**
 * Mock mode is allowed only outside production. NODE_ENV=production (next start) is allowed only with the
 * explicit e2e flag E2E_ALLOW_MOCK=1, and never on Vercel production.
 */
export function mockMode(env: Env = process.env): boolean {
  if (env.MOCK_API !== "1") return false;
  if (env.VERCEL_ENV === "production") throw new Error("MOCK_API=1 is forbidden in production (VERCEL_ENV=production).");
  if (env.NODE_ENV === "production" && (env.E2E_ALLOW_MOCK !== "1" || env.VERCEL)) {
    throw new Error("MOCK_API=1 is forbidden in production (NODE_ENV=production).");
  }
  return true;
}

/** API base URL; missing → fail closed (no localhost fallback). */
export function apiBaseUrl(env: Env = process.env): string {
  const v = env.API_BASE_URL?.trim();
  if (!v) throw new NotConfiguredError("API_BASE_URL");
  return v;
}
