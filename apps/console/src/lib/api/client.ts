import type {
  AckResult, BulkItem, BulkPreview, BulkResult, IncidentDetail, IncidentEvent, IncidentListQuery, IncidentListResponse, Me,
  NotificationLogEntry, OncallNowEntry, Paginated, ResolveKind, ApiErrorBody, ScopeTreeResponse,
  AddResponderInput, CallOrderListQuery, CallOrderListResponse, CustomerPersonRole, PagingConfig, PagingConfigInput, PagingHealth, PagingPath, PagingPathQuery,
  RespondersResponse, RotationSummary, StaffSummary, ResponderWriteOptions, RespondersWriteResult, UndoResult,
} from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string,
    /** `error.details` of the contract: fields[] of VALIDATION_FAILED, the numbers of SEND_CAP_EXCEEDED, retryAfterSec … */
    public readonly details: Record<string, unknown> = {},
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
/**
 * "This belongs to another customer" is told to the user exactly like "this does not exist" (security review 권고 3):
 * the console never confirms that an id of another tenant is real.
 */
export const isNotFoundLike = (e: unknown): boolean => e instanceof ApiError && (e.status === 404 || e.code === "CROSS_CUSTOMER");

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
  /** POST /incidents/bulk/undo. An unknown, used, expired or foreign token is the one 404. */
  bulkUndo(undoToken: string): Promise<UndoResult>;
  oncallNow(customerId?: string): Promise<OncallNowEntry[]>;
  /** GET /scope-tree (API-CONTRACT §8.0) */
  scopeTree(): Promise<ScopeTreeResponse>;

  /* ---- Call order (API-CONTRACT §8.3) ---- */
  /** GET /oncall/now with the scope filter: one row per customer, per project/service with own steps, and for the asked node */
  callOrderList(q?: CallOrderListQuery): Promise<CallOrderListResponse>;
  /** GET /oncall/paging-path for a scope (PROPOSED slug query) */
  pagingPath(q: PagingPathQuery): Promise<PagingPath>;
  getPaging(customerId: string): Promise<PagingConfig>;
  /** PUT /customers/{id}/paging, If-Match */
  putPaging(customerId: string, body: PagingConfigInput, version: number): Promise<PagingConfig>;
  /**
   * PUT /customers/{id}/paging-overrides/{scopeType}/{scopeId}. `version` is If-Match; 0 creates own steps (201) — a
   * level that got steps meanwhile is at a higher version, so it is not overwritten (409 VERSION_CONFLICT).
   */
  putPagingOverride(customerId: string, scopeType: "PROJECT" | "SERVICE", scopeId: string, body: PagingConfigInput, version: number): Promise<PagingConfig>;
  deletePagingOverride(customerId: string, scopeType: "PROJECT" | "SERVICE", scopeId: string, version: number): Promise<void>;
  pagingHealth(customerId: string): Promise<PagingHealth>;
  getResponders(customerId: string): Promise<RespondersResponse>;
  /** If-Match = the version of the Responders list the user saw (PROPOSED, see RespondersResponse) */
  addResponder(customerId: string, input: AddResponderInput, opts: ResponderWriteOptions): Promise<RespondersWriteResult>;
  patchResponder(customerId: string, contactId: string, body: { role: CustomerPersonRole }, opts: ResponderWriteOptions): Promise<RespondersWriteResult>;
  removeResponder(customerId: string, contactId: string, opts: ResponderWriteOptions): Promise<RespondersWriteResult>;
  /** GET /rotations — read-only on this screen */
  listRotations(q?: { scope?: "MSP" | "CUSTOMER"; customerId?: string }): Promise<RotationSummary[]>;
  /** GET /staff?q= */
  listStaff(q?: string): Promise<StaffSummary[]>;
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
      throw new ApiError(res.status, err.code, err.message, err.requestId, err.details ?? {});
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  const enc = encodeURIComponent;
  const unreachable = (o: ResponderWriteOptions) => toQuery({ confirmUnreachable: o.confirmUnreachable ? true : undefined });

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
    callOrderList: (q = {}) => call("GET", "/oncall/now" + toQuery({ customer: q.customer, project: q.project, service: q.service, mine: q.mine ? 1 : undefined, onlyProblems: q.onlyProblems ? true : undefined })),
    pagingPath: (q) => call("GET", "/oncall/paging-path" + toQuery({ ...q })),
    getPaging: (id) => call("GET", `/customers/${enc(id)}/paging`),
    putPaging: (id, body, version) => call("PUT", `/customers/${enc(id)}/paging`, body, { "If-Match": String(version) }),
    putPagingOverride: (id, scopeType, scopeId, body, version) =>
      call("PUT", `/customers/${enc(id)}/paging-overrides/${scopeType}/${enc(scopeId)}`, body, { "If-Match": String(version) }),
    deletePagingOverride: (id, scopeType, scopeId, version) => call("DELETE", `/customers/${enc(id)}/paging-overrides/${scopeType}/${enc(scopeId)}`, undefined, { "If-Match": String(version) }),
    pagingHealth: (id) => call("GET", `/customers/${enc(id)}/paging-health`),
    getResponders: (id) => call("GET", `/customers/${enc(id)}/responders`),
    addResponder: (id, input, o) => call("POST", `/customers/${enc(id)}/responders`, input, { "If-Match": String(o.version) }),
    patchResponder: (id, contactId, body, o) => call("PATCH", `/customers/${enc(id)}/responders/${enc(contactId)}` + unreachable(o), body, { "If-Match": String(o.version) }),
    removeResponder: (id, contactId, o) => call("DELETE", `/customers/${enc(id)}/responders/${enc(contactId)}` + unreachable(o), undefined, { "If-Match": String(o.version) }),
    listRotations: (q = {}) => call("GET", "/rotations" + toQuery({ ...q })),
    listStaff: (q) => call("GET", "/staff" + toQuery({ q })),
  };
}
