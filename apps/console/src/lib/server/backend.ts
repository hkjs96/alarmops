import "server-only";
import { randomUUID } from "node:crypto";
import { authFromPrincipal, createApi, loadApiConfig, type ApiRequest, type ApiResponse, type AuthContext } from "@alarmops/api";
import { SqlApiStore, pgClient } from "@alarmops/store-sql";
import { NotConfiguredError } from "../mode";
import { databaseConfig } from "./db-config";

/**
 * The backend inside the console app (D-09: one Vercel deployment + Postgres). packages/api answers every
 * `/api/v1/*` request, on the SQL store (packages/store-sql, node-postgres) — nothing goes over the network to
 * another service. One pool per server process (a serverless instance), created on first use.
 *
 * DATABASE_URL is required (fail closed: 503 NOT_CONFIGURED, no localhost fallback). DATABASE_POOLER=transaction
 * for a transaction-mode pooler (Supabase/Supavisor port 6543, what a serverless runtime should use — db/README.md
 * "Connecting"); anything else is a direct / session-mode connection.
 */
interface Backend { repo: SqlApiStore; api: ReturnType<typeof createApi>; close(): Promise<void> }
const g = globalThis as unknown as { __aoBackend?: Backend };

export function backend(env: Record<string, string | undefined> = process.env): Backend {
  if (g.__aoBackend) return g.__aoBackend;
  const cfg = databaseConfig(env);
  if (!cfg) throw new NotConfiguredError("DATABASE_URL");
  const client = pgClient({ connectionString: cfg.url, pooler: cfg.pooler, max: cfg.max });
  const repo = new SqlApiStore(client);
  const { config, warnings } = loadApiConfig(env);
  for (const w of warnings) console.warn(`[api config] ${w}`);
  const api = createApi({
    repo, config,
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

export function toResponse(res: ApiResponse): Response {
  const noBody = res.status === 204 || res.status === 304 || res.body === undefined;
  return new Response(noBody ? null : JSON.stringify(res.body), { status: res.status, headers: res.headers });
}
