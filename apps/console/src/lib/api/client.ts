import type {
  AckResult, BulkItem, BulkPreview, BulkResult, IncidentDetail, IncidentEvent, IncidentListQuery, IncidentListResponse, Me,
  NotificationLogEntry, OncallNowEntry, Paginated, ResolveKind, ApiErrorBody, ScopeTreeResponse,
} from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Read paths: a 403 is treated exactly like a 404 (security R-5). The contract says reads never answer 403, but if a
 * backend slips, "you may not see this" must not look different from "this does not exist".
 */
export const isHidden = (e: unknown): boolean => e instanceof ApiError && (e.status === 404 || e.status === 403);

/** Typed surface of API-CONTRACT §8.1 the console uses (plus /me and /oncall/now for the list side panel). */
export interface ConsoleApi {
  me(): Promise<Me>;
  listIncidents(q?: IncidentListQuery): Promise<IncidentListResponse>;
  getIncident(id: string): Promise<IncidentDetail>;
  getTimeline(id: string, cursor?: string): Promise<Paginated<IncidentEvent>>;
  getNotifications(id: string, cursor?: string): Promise<Paginated<NotificationLogEntry>>;
  ack(id: string, version: number): Promise<AckResult>;
  resolve(id: string, version: number, body: { kind?: ResolveKind; note?: string }): Promise<IncidentDetail>;
  /** If-Match like ack and resolve (security S-4): "Escalate now" pressed on a stale panel must not page the next step of an incident that changed */
  escalate(id: string, version: number): Promise<IncidentDetail>;
  bulkPreview(action: "ack" | "resolve", items: BulkItem[]): Promise<BulkPreview>;
  bulkExecute(action: "ack" | "resolve", items: BulkItem[]): Promise<BulkResult>;
  bulkUndo(undoToken: string): Promise<{ restored: string[] }>;
  oncallNow(customerId?: string): Promise<OncallNowEntry[]>;
  /** GET /scope-tree (API-CONTRACT §8.0) */
  scopeTree(): Promise<ScopeTreeResponse>;
}

/** Empty params are dropped (known-bugs 9-6). */
export function toQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function createHttpApi(opts: { baseUrl: string; fetch?: typeof fetch; headers?: () => Record<string, string> }): ConsoleApi {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "") + "/api/v1";

  async function call<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
    const res = await f(base + path, {
      method,
      headers: { "content-type": "application/json", ...(opts.headers?.() ?? {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      let err: ApiErrorBody["error"] = { code: "UNKNOWN", message: res.statusText, requestId: "" };
      try {
        err = ((await res.json()) as ApiErrorBody).error ?? err;
      } catch {
        /* non-JSON error */
      }
      throw new ApiError(res.status, err.code, err.message, err.requestId);
    }
    return (await res.json()) as T;
  }
  const enc = encodeURIComponent;

  return {
    me: () => call("GET", "/me"),
    listIncidents: (q = {}) => call("GET", "/incidents" + toQuery({ ...q })),
    getIncident: (id) => call("GET", `/incidents/${enc(id)}`),
    getTimeline: (id, cursor) => call("GET", `/incidents/${enc(id)}/timeline` + toQuery({ cursor })),
    getNotifications: (id, cursor) => call("GET", `/incidents/${enc(id)}/notifications` + toQuery({ cursor })),
    ack: (id, version) => call("POST", `/incidents/${enc(id)}/ack`, {}, { "If-Match": String(version) }),
    resolve: (id, version, body) => call("POST", `/incidents/${enc(id)}/resolve`, body, { "If-Match": String(version) }),
    escalate: (id, version) => call("POST", `/incidents/${enc(id)}/escalate`, {}, { "If-Match": String(version) }),
    bulkPreview: (action, items) => call("POST", "/incidents/bulk", { action, items, preview: true }),
    bulkExecute: (action, items) => call("POST", "/incidents/bulk", { action, items, preview: false }),
    bulkUndo: (undoToken) => call("POST", "/incidents/bulk/undo", { undoToken }),
    oncallNow: (customerId) => call("GET", "/oncall/now" + toQuery({ customerId })),
    scopeTree: () => call("GET", "/scope-tree"),
  };
}
