import "server-only";
import { randomUUID } from "node:crypto";
import { authFromPrincipal, createApi, normalizeAuth, loadApiConfig, type ApiRequest, type ApiResponse, type AuthContext } from "@alarmops/api";
import { SqlApiStore, pgClient } from "@alarmops/store-sql";
import { NotConfiguredError } from "../mode";
import { databaseConfig } from "./db-config";
import { commands, resolvePartition, retention, verificationSecret } from "./wiring";
import { toResponse } from "./response";

export { toResponse };

/**
 * The backend inside the console app (D-09: one Vercel deployment + Postgres). packages/api answers every
 * `/api/v1/*` request, on the SQL store (packages/store-sql, node-postgres) — nothing goes over the network to
 * another service. One pool per server process (a serverless instance), created on first use.
 *
 * DATABASE_URL is required (fail closed: 503 NOT_CONFIGURED, no localhost fallback). DATABASE_POOLER=transaction
 * for a transaction-mode pooler (Supabase/Supavisor port 6543, what a serverless runtime should use — db/README.md
 * "Connecting"); anything else is a direct / session-mode connection.
 */
/**
 * SqlApiStore plus the one lookup the sign-in needs and the API does not have: user id by e-mail (User.email is citext, so
 * the match is case-insensitive). It only finds the id of an ACTIVE user; everything else (customer status, contact link,
 * role, scope) is decided by `sessionPrincipal` afterwards, the same path every request takes.
 */
class ConsoleStore extends SqlApiStore {
  async activeUserIdByEmail(email: string): Promise<string | null> {
    const [r] = await this.sql.query(`SELECT "id" FROM "User" WHERE "email" = $1 AND "status" = 'ACTIVE'`, [email]);
    return (r?.id as string | undefined) ?? null;
  }
}

interface Backend { repo: ConsoleStore; api: ReturnType<typeof createApi>; close(): Promise<void> }
const g = globalThis as unknown as { __aoBackend?: Backend };

export function backend(env: Record<string, string | undefined> = process.env): Backend {
  if (g.__aoBackend) return g.__aoBackend;
  const cfg = databaseConfig(env);
  if (!cfg) throw new NotConfiguredError("DATABASE_URL");
  // Everything that can throw on configuration runs BEFORE the pool exists: a bad value must not leak a pool per request.
  const { config, warnings } = loadApiConfig(env);
  for (const w of warnings) console.warn(`[api config] ${w}`);
  const partition = resolvePartition(env); // throws when AWS_PARTITION and the queue URL disagree
  const client = pgClient({ connectionString: cfg.url, pooler: cfg.pooler, max: cfg.max });
  const repo = new ConsoleStore(client);
  const api = createApi({
    repo, config, partition, retention: retention(env), commands: commands(env), verificationSecret: verificationSecret(env),
    log: (level, msg, data) => console[level === "error" ? "error" : "warn"](`[api] ${msg}`, data ?? {}),
  });
  g.__aoBackend = { repo, api, close: () => client.close?.() ?? Promise.resolve() };
  return g.__aoBackend;
}

/**
 * The AuthContext of a console session, built on the SERVER from the session's user id (never from anything the
 * client sends): the user must exist and be ACTIVE in the database; role, kind and customers come from there.
 * Unknown or disabled user → null (the API answers 401).
 */
export async function authForSession(sub: string | null | undefined): Promise<AuthContext | null> {
  if (!sub) return null;
  const p = await backend().repo.sessionPrincipal(sub);
  return p ? authFromPrincipal(p) : null;
}

/**
 * Google sign-in: the id of the pre-registered, active user with this verified e-mail whose principal the API would also
 * accept (ACTIVE customer for a portal user, consistent contact link), else null. Throws when the store does not answer.
 */
export async function signInUserByEmail(email: string): Promise<{ id: string; name: string; kind: "INTERNAL" | "CUSTOMER" } | null> {
  const id = await backend().repo.activeUserIdByEmail(email);
  if (!id) return null;
  const auth = await authForSession(id);
  return auth && normalizeAuth(auth) ? { id, name: auth.name ?? id, kind: auth.kind } : null;
}

export type SignInUserRow = { id: string; name: string; kind: "INTERNAL" | "CUSTOMER" };

/**
 * Login-domain enrolment (D-55 b). Asked by the callback only when no user row exists and the address is outside the
 * staff fence. `enrolPortalUserByDomain` creates or returns the VIEWER portal user of the ONE active customer that
 * registered the domain; the result then goes through the same `sessionPrincipal` check as every sign-in (ACTIVE,
 * customer not suspended). `refused` carries the store's reason code (never an address).
 */
export async function enrolByLoginDomain(email: string): Promise<{ user: SignInUserRow } | { refused: string }> {
  const out = await backend().repo.enrolPortalUserByDomain(email, new Date());
  if ("refused" in out) return { refused: out.refused };
  if (out.user.kind !== "CUSTOMER" || out.user.status !== "ACTIVE") return { refused: "NOT_ACTIVE_PORTAL_USER" };
  const auth = await authForSession(out.user.id);
  if (!auth || !normalizeAuth(auth) || auth.kind !== "CUSTOMER") return { refused: "PRINCIPAL_REFUSED" };
  return { user: { id: out.user.id, name: auth.name ?? out.user.id, kind: "CUSTOMER" } };
}

/** Binds the verified Google `sub` to the user (first sign-in) or compares it (later ones). */
export const bindGoogleAccount = (userId: string, sub: string) => backend().repo.bindGoogleSub(userId, sub, new Date());
/** Stamps `User.lastLoginAt` (no audit row). */
export const touchLastLogin = (userId: string) => backend().repo.touchLastLogin(userId, new Date());

/** Hand one request to packages/api. `auth` is the server-side AuthContext (or null = not signed in). */
export async function handleApi(req: Omit<ApiRequest, "requestId" | "auth">, auth: AuthContext | null): Promise<ApiResponse> {
  return backend().api.handle({ ...req, auth, requestId: `req_${randomUUID().replace(/-/g, "").slice(0, 20)}` });
}

/** Single-valued query parameters, the way packages/api reads them. */
export function queryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export const apiMethod = (m: string): ApiRequest["method"] | null => (METHODS.has(m) ? (m as ApiRequest["method"]) : null);

/**
 * A `fetch` that never leaves the process: what the console's typed HTTP client (lib/api/client.ts) uses on the
 * server in live mode. Same request and response shapes as `/api/v1/*` over the wire, same handler — only the
 * session is not read from a cookie but given (it was verified by the caller), and nothing is sent anywhere.
 */
export function inProcessFetch(auth: () => Promise<AuthContext | null>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = apiMethod((init?.method ?? "GET").toUpperCase());
    if (!method) return new Response(null, { status: 405 });
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length) {
      try { body = JSON.parse(init.body); } catch { return Response.json({ error: { code: "VALIDATION_FAILED", message: "Body must be JSON.", details: {}, requestId: "" } }, { status: 400 }); }
    }
    const res = await handleApi({ method, path: url.pathname, query: queryOf(url), headers, body }, await auth());
    return toResponse(res);
  }) as typeof fetch;
}
