import type {
  BulkPreview, BulkResult, IncidentDetail, IncidentEvent, IncidentListQuery, IncidentListResponse, Me,
  NotificationLogEntry, OncallNowEntry, Paginated, ResolveKind, ApiErrorBody,
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

/** Typed surface of API-CONTRACT §8.1 the console uses (plus /me and /oncall/now for the list side panel). */
export interface ConsoleApi {
  me(): Promise<Me>;
  listIncidents(q?: IncidentListQuery): Promise<IncidentListResponse>;
  getIncident(id: string): Promise<IncidentDetail>;
  getTimeline(id: string, cursor?: string): Promise<Paginated<IncidentEvent>>;
  getNotifications(id: string, cursor?: string): Promise<Paginated<NotificationLogEntry>>;
  ack(id: string, version: number): Promise<IncidentDetail>;
  resolve(id: string, version: number, body: { kind?: ResolveKind; note?: string }): Promise<IncidentDetail>;
  escalate(id: string): Promise<IncidentDetail>;
  bulkPreview(action: "ack" | "resolve", ids: string[]): Promise<BulkPreview>;
  bulkExecute(action: "ack" | "resolve", ids: string[]): Promise<BulkResult>;
  bulkUndo(undoToken: string): Promise<{ restored: string[] }>;
  oncallNow(customerId?: string): Promise<OncallNowEntry[]>;
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
    escalate: (id) => call("POST", `/incidents/${enc(id)}/escalate`, {}),
    bulkPreview: (action, ids) => call("POST", "/incidents/bulk", { action, ids, preview: true }),
    bulkExecute: (action, ids) => call("POST", "/incidents/bulk", { action, ids, preview: false }),
    bulkUndo: (undoToken) => call("POST", "/incidents/bulk/undo", { undoToken }),
    oncallNow: (customerId) => call("GET", "/oncall/now" + toQuery({ customerId })),
  };
}
