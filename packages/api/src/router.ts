/**
 * Route table of the console REST API parts built so far (API-CONTRACT §8.0, §8.1, scope parts of §8.3).
 * `createApi(deps).handle(request)` is all an adapter needs.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_API_CONFIG, type ApiConfig } from './audience.js';
import { requireAuth, scopeKey } from './auth.js';
import { ApiError, errorResponse, header, notFound, type ApiRequest, type ApiResponse } from './http.js';
import { actOnIncident, bulkIncidents, getIncident, getNotifications, getTimeline, listIncidents, undoIncidents } from './incidents.js';
import { deletePagingOverride, getCustomerPaging, getPagingPath, putCustomerPaging, putPagingOverride } from './pagingApi.js';
import type { ApiRepository } from './repo.js';
import { getScopeTree } from './scope.js';

export interface ApiDeps {
  repo: ApiRepository;
  now?: () => Date;
  /** Policy switches with safe defaults (see audience.ts). */
  config?: Partial<ApiConfig>;
  log?: (level: 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

type Handler = (req: ApiRequest, deps: { repo: ApiRepository; now: () => Date; config: ApiConfig }, p: string[]) => Promise<ApiResponse>;
interface Route { method: ApiRequest['method']; pattern: string[]; run: Handler }

const route = (method: ApiRequest['method'], path: string, run: Handler): Route => ({ method, pattern: path.split('/').filter(Boolean), run });

/** Order matters only where a literal and a parameter compete (`/incidents/bulk` before `/incidents/:id`). */
export const ROUTES: Route[] = [
  route('GET', '/scope-tree', (r, d) => getScopeTree(r, d)),
  route('GET', '/incidents', (r, d) => listIncidents(r, d)),
  route('POST', '/incidents/bulk', (r, d) => bulkIncidents(r, d)),
  route('POST', '/incidents/bulk/undo', (r, d) => undoIncidents(r, d)),
  route('GET', '/incidents/:id', (r, d, p) => getIncident(r, d, p[0]!)),
  route('GET', '/incidents/:id/timeline', (r, d, p) => getTimeline(r, d, p[0]!)),
  route('GET', '/incidents/:id/notifications', (r, d, p) => getNotifications(r, d, p[0]!)),
  route('POST', '/incidents/:id/ack', (r, d, p) => actOnIncident(r, d, p[0]!, 'ack')),
  route('POST', '/incidents/:id/resolve', (r, d, p) => actOnIncident(r, d, p[0]!, 'resolve')),
  route('POST', '/incidents/:id/escalate', (r, d, p) => actOnIncident(r, d, p[0]!, 'escalate')),
  route('GET', '/customers/:id/paging', (r, d, p) => getCustomerPaging(r, d, p[0]!)),
  route('PUT', '/customers/:id/paging', (r, d, p) => putCustomerPaging(r, d, p[0]!)),
  route('PUT', '/customers/:id/paging-overrides/:scopeType/:scopeId', (r, d, p) => putPagingOverride(r, d, p[0]!, p[1]!, p[2]!)),
  route('DELETE', '/customers/:id/paging-overrides/:scopeType/:scopeId', (r, d, p) => deletePagingOverride(r, d, p[0]!, p[1]!, p[2]!)),
  route('GET', '/oncall/paging-path', (r, d) => getPagingPath(r, d)),
];

function match(method: string, path: string): { route: Route; params: string[]; canonical: string } | null {
  let segs: string[];
  try {
    segs = path.replace(/^\/api\/v1(?=\/|$)/, '').split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  for (const r of ROUTES) {
    if (r.method !== method || r.pattern.length !== segs.length) continue;
    const params: string[] = [];
    // `canonical`: the path as the route table sees it, so `/api/v1/x` and `/x` are one request for idempotency (R-5).
    if (r.pattern.every((p, i) => (p.startsWith(':') ? (params.push(segs[i]!), true) : p === segs[i]))) return { route: r, params, canonical: JSON.stringify(segs) };
  }
  return null;
}

const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** Stable JSON (sorted keys) so the same body hashes the same whatever the key order. */
const stable = (v: unknown): string =>
  v === undefined ? 'null' : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : v !== null && typeof v === 'object' ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v) ?? 'null';

export function createApi(deps: ApiDeps) {
  const inner = { repo: deps.repo, now: deps.now ?? (() => new Date()), config: { ...DEFAULT_API_CONFIG, ...deps.config } };
  async function handle(req: ApiRequest): Promise<ApiResponse> {
    try {
      const auth = requireAuth(req); // every console route needs a session (401 before anything else)
      const m = match(req.method, req.path);
      if (!m) throw notFound();
      // Idempotency-Key (§2): the same key from the same user for the same request replays the first response for 24h.
      // R-5: - the key is looked up together with the caller's CURRENT range and role (scopeKey): after a change of
      //        customers, sub-scopes, kind or role nothing is replayed — the request runs again and is authorised now;
      //      - it is bound to method + canonical path + If-Match + body hash: the same key with another request is 422;
      //      - only successful responses are stored, so failing requests cannot fill the store.
      const idem = req.method === 'GET' ? undefined : header(req, 'idempotency-key');
      const idemKey = idem ? sha([auth.userId, sha(scopeKey(auth)), sha(idem)].join('|')) : undefined;
      const fingerprint = idem ? sha([req.method, m.canonical, header(req, 'if-match') ?? '', stable(req.body)].join('\n')) : '';
      if (idemKey) {
        const replay = await inner.repo.getIdempotent(idemKey, inner.now());
        if (replay) {
          if (replay.fingerprint !== fingerprint) throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
          return replay.res;
        }
      }
      const res = await m.route.run(req, inner, m.params);
      if (idemKey && res.status >= 200 && res.status < 300) {
        await inner.repo.putIdempotent(idemKey, { fingerprint, res: { status: res.status, headers: res.headers, body: res.body } }, new Date(inner.now().getTime() + IDEMPOTENCY_TTL_MS));
      }
      return res;
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err, req.requestId);
      deps.log?.('error', 'unhandled', { requestId: req.requestId, path: req.path, error: err instanceof Error ? err.message : String(err) });
      return errorResponse(new ApiError(500, 'INTERNAL', 'Something went wrong.'), req.requestId);
    }
  }
  return { handle };
}
