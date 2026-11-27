import type {
  AckResult, BulkItem, BulkPreview, BulkResult, IncidentDetail, IncidentEvent, IncidentListQuery, IncidentListResponse, Me,
  NotificationLogEntry, Paginated, ResolveKind, ApiErrorBody, ScopeTreeResponse,
  AddResponderInput, CallOrderListQuery, CallOrderListResponse, CustomerPersonRole, PagingConfig, PagingConfigInput, PagingHealth, PagingPath, PagingPathQuery,
  RespondersResponse, RotationSummary, StaffSummary, ResponderWriteOptions, RespondersWriteResult, UndoResult,
  CustomerStatusChange, CustomerStatusInput, CustomerStatusResponse, Offboarding, OffboardStepKey,
  Digest, LegalHold, PurgeLog, RevealChannel, RevealResult, ContactRevealEntry, ContactRevealQuery,
  NewUserInput, UserItem, UserListQuery, UserPatchInput,
  CustomerRecord, ProjectRecord, ServiceRecord, AccountRecord, AccountStatus, NewAccountInput, AccountCapabilities, ContactRecord, NewContactInput,
  VerifyContactInput, VerifyContactResult, VerifyBulkResult, VerifyPeek, VerifyDone,
  ResponderTemplate, TemplateProposal, TemplatePreview, TemplateSaveResult, CustomerTemplatePreview, CustomerTemplateResult,
  ResourceListQuery, ResourceListResponse, ManagedAlarmListResponse, MonitoringAction, MonitoringCommandResult,
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

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 503 BUSY (API-CONTRACT §8.3 "잠금·재시도"): the system was busy with another change and wrote nothing, so the same request may be
 * sent again. It is sent once more after Retry-After (at most 5 s); a second BUSY is the caller's error to show.
 */
export async function withBusyRetry<T>(send: () => Promise<T>, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<T> {
  try {
    return await send();
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 503 || e.code !== "BUSY") throw e;
    const s = typeof e.details.retryAfterSec === "number" && Number.isFinite(e.details.retryAfterSec) ? e.details.retryAfterSec : 1;
    await sleep(Math.min(Math.max(s, 0), 5) * 1000);
    return send();
  }
}

/** Typed surface of API-CONTRACT §8 the console uses. */
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
  /** GET /scope-tree (API-CONTRACT §8.0) */
  scopeTree(): Promise<ScopeTreeResponse>;

  /* ---- Call order (API-CONTRACT §8.3) ---- */
  /** GET /oncall/now with the scope filter: one row per customer, per project/service with own steps, and for the asked node */
  callOrderList(q?: CallOrderListQuery): Promise<CallOrderListResponse>;
  /** GET /oncall/paging-path for a scope (scope slugs) */
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
  /** If-Match = the version of the Responders list the user saw (see RespondersResponse) */
  addResponder(customerId: string, input: AddResponderInput, opts: ResponderWriteOptions): Promise<RespondersWriteResult>;
  patchResponder(customerId: string, contactId: string, body: { role: CustomerPersonRole }, opts: ResponderWriteOptions): Promise<RespondersWriteResult>;
  removeResponder(customerId: string, contactId: string, opts: ResponderWriteOptions): Promise<RespondersWriteResult>;
  /** GET /rotations — read-only on this screen */
  listRotations(q?: { scope?: "MSP" | "CUSTOMER"; customerId?: string }): Promise<RotationSummary[]>;
  /** GET /staff?q= */
  listStaff(q?: string): Promise<StaffSummary[]>;

  /* ---- Responder templates (API-CONTRACT §8.3, D-64). Reads: MSP staff. Writes and previews: ADMIN with all customers. 503 BUSY is retried once. ---- */
  /** GET /responder-templates (by name; each item is also its detail) */
  listResponderTemplates(): Promise<ResponderTemplate[]>;
  /** POST /responder-templates → 201. 409 ALREADY_EXISTS (name), 400 VALIDATION_FAILED (members must be active MSP staff). */
  createResponderTemplate(body: { name: string; members: string[] }): Promise<ResponderTemplate>;
  /** POST /responder-templates/{id}/preview: nothing is written */
  previewResponderTemplate(id: string, proposal: TemplateProposal): Promise<TemplatePreview>;
  /** PATCH /responder-templates/{id}. If-Match = `version` of the template the user saw; `previewHash` of the preview of this very change. 409 VERSION_CONFLICT / PREVIEW_STALE / WOULD_BE_UNREACHABLE / ALREADY_EXISTS, 422 RESPONDER_LIMIT_EXCEEDED / SEND_CAP_EXCEEDED. */
  saveResponderTemplate(id: string, proposal: TemplateProposal, opts: { version: number; previewHash: string }): Promise<TemplateSaveResult>;
  /** POST /customers/{id}/responders/template/preview: `templateId: null` detaches */
  previewCustomerTemplate(customerId: string, templateId: string | null): Promise<CustomerTemplatePreview>;
  /** PUT /customers/{id}/responders/template. If-Match = the Responders `version` of the preview. 409 CUSTOMER_TERMINATED too. */
  putCustomerTemplate(customerId: string, templateId: string | null, opts: { version: number; previewHash: string }): Promise<CustomerTemplateResult>;

  /* ---- Customer status and offboarding (API-CONTRACT 8.4) ---- */
  /** GET /customers/{id}/status. ADMIN only (403 for other staff). */
  getCustomerStatus(customerId: string): Promise<CustomerStatusResponse>;
  /** PATCH /customers/{id}/status, If-Match = the version read. 409 VERSION_CONFLICT / CUSTOMER_TERMINATED, 503 COMMANDS_UNAVAILABLE (nothing changed) */
  patchCustomerStatus(customerId: string, body: CustomerStatusInput, version: number): Promise<CustomerStatusChange>;
  /** GET /customers/{id}/offboarding. 404 for a customer that was never terminated. */
  getOffboarding(customerId: string): Promise<Offboarding>;
  /** PATCH /customers/{id}/offboarding: a person marks a step DONE (no If-Match; ALARMS_DELETED needs `detail`, only when MANUAL) */
  markOffboardStep(customerId: string, body: { key: OffboardStepKey; state: "DONE"; detail?: string }): Promise<Offboarding>;

  /* ---- Retention (D-45) and the digest (D-46) ---- */
  /** PUT /customers/{id}/legal-hold { reason } (reason required). ADMIN. Same state as asked: 200, `changed:false`. */
  putLegalHold(customerId: string, reason: string): Promise<{ legalHold: LegalHold; changed: boolean }>;
  /** DELETE /customers/{id}/legal-hold { reason? } */
  deleteLegalHold(customerId: string, reason?: string): Promise<{ legalHold: LegalHold; changed: boolean }>;
  /** GET /customers/{id}/purge-log. ADMIN. */
  getPurgeLog(customerId: string): Promise<PurgeLog>;
  /**
   * GET /customers/{id}/export.csv. ADMIN. Resolves with the streaming Response (CSV); 409 CUSTOMER_NOT_TERMINATED,
   * 410 EXPORT_WINDOW_CLOSED, 413 EXPORT_TOO_LARGE throw an ApiError before any byte is sent.
   */
  exportCsv(customerId: string): Promise<Response>;
  /** POST /contacts/{id}/reveal (D-35). Mode is decided by the server. 422 EMERGENCY_REASON_REQUIRED, 403 NOT_A_RESPONDER, 404, 429. */
  revealContact(contactId: string, body: { channel: RevealChannel; reason?: string }): Promise<RevealResult>;
  /** GET /contact-reveals (D-35 review list), newest first */
  listContactReveals(q?: ContactRevealQuery): Promise<Paginated<ContactRevealEntry>>;
  /** GET /digests/latest (MSP staff; a portal user gets 404) */
  getLatestDigest(): Promise<Digest>;

  /* ---- Users (API-CONTRACT 8.4 #69): ADMIN with all customers only; a portal user gets 404 ---- */
  /** GET /users (filters kind, customerId, status, role, q). 403 for other staff and for an ADMIN with a narrower range. */
  listUsers(q?: UserListQuery): Promise<{ items: UserItem[] }>;
  /** POST /users → 201. 409 ALREADY_EXISTS (e-mail), 400 VALIDATION_FAILED. */
  createUser(body: NewUserInput): Promise<UserItem>;
  /** PATCH /users/{id}. 409 LAST_ADMIN / CONTACT_LINKED, 403 FORBIDDEN (yourself), 404. */
  patchUser(id: string, body: UserPatchInput): Promise<UserItem>;
  /* ---- Customer onboarding (API-CONTRACT 8.4, #62, #69) ---- */
  /** POST /customers (ADMIN). 409 ALREADY_EXISTS (`details.existingCustomerId` for a name), 422 VALIDATION_FAILED for a public mail login domain. */
  createCustomer(body: { name: string; loginDomains?: string[] }): Promise<CustomerRecord>;
  getCustomer(customerId: string): Promise<CustomerRecord>;
  listProjects(customerId: string): Promise<ProjectRecord[]>;
  createProject(customerId: string, body: { name: string }): Promise<ProjectRecord>;
  listServices(projectId: string): Promise<ServiceRecord[]>;
  createService(projectId: string, body: { name: string }): Promise<ServiceRecord>;
  /** GET /customers/{id}/accounts. The ExternalId is in it for an ADMIN. */
  listAccounts(customerId: string): Promise<AccountRecord[]>;
  createAccount(customerId: string, body: NewAccountInput): Promise<AccountRecord>;
  /** PATCH /accounts/{id}: capability toggles (the server adds or removes the role ARN) */
  patchAccount(accountId: string, body: Partial<AccountCapabilities>): Promise<AccountRecord>;
  /** POST /accounts/{id}/check -> 202 { commandId }. 429 RATE_LIMITED (`retryAfterSec`), 503 COMMANDS_UNAVAILABLE, 409 ACCOUNT_DISABLED. */
  checkAccount(accountId: string): Promise<{ commandId: string }>;
  getAccountStatus(accountId: string): Promise<AccountStatus>;
  /** GET /contacts?kind=CUSTOMER&customerId= */
  listContacts(q: { customerId: string; needsAction?: boolean }): Promise<{ items: ContactRecord[]; nextCursor: string | null }>;
  createContact(body: NewContactInput): Promise<ContactRecord>;
  /** POST /contacts/{id}/verify. link: 202 LINK_SENT, 503 VERIFICATION_UNAVAILABLE / NOT_CONFIGURED when nothing can send; manual: 200 (ADMIN). */
  verifyContact(contactId: string, body: VerifyContactInput): Promise<VerifyContactResult>;
  /** POST /contacts/verify-bulk with `{ contactIds }` */
  verifyBulk(contactIds: string[]): Promise<VerifyBulkResult>;
  /** Public, no session. GET /verify/{token}: no side effect. 404 = unknown, used, expired or malformed (all the same). */
  peekVerify(token: string): Promise<VerifyPeek>;
  /** Public. POST /verify/{token} consumes the token once. */
  confirmVerify(token: string): Promise<VerifyDone>;

  /* ---- Monitoring (API-CONTRACT 8.5) ---- */
  /** GET /resources with the scope filter. One call; `outside` is there when a filter is on. */
  listResources(q?: ResourceListQuery): Promise<ResourceListResponse>;
  /** GET /managed-alarms with the same scope filter */
  listManagedAlarms(q?: Pick<ResourceListQuery, "customer" | "project" | "service" | "mine" | "type" | "limit" | "cursor">): Promise<ManagedAlarmListResponse>;
  /** POST /resources/{id}/monitoring → 202. 409, 403 CAPABILITY_DISABLED, 503 COMMANDS_UNAVAILABLE. */
  setMonitoring(resourceId: string, action: MonitoringAction): Promise<MonitoringCommandResult>;
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

export function createHttpApi(opts: { baseUrl: string; fetch?: typeof fetch; headers?: () => Record<string, string>; sleep?: (ms: number) => Promise<void> }): ConsoleApi {
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
      const details: Record<string, unknown> = { ...(err.details ?? {}) };
      const header = res.headers?.get("retry-after") ?? null;
      if (details.retryAfterSec === undefined && header !== null && Number.isFinite(Number(header)) && Number(header) >= 0) details.retryAfterSec = Number(header);
      throw new ApiError(res.status, err.code, err.message, err.requestId, details);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  const enc = encodeURIComponent;
  async function raw(path: string): Promise<Response> {
    const res = await f(base + path, { method: "GET", headers: { ...(opts.headers?.() ?? {}) }, cache: "no-store" });
    if (res.ok) return res;
    let err: ApiErrorBody["error"] = { code: "UNKNOWN", message: res.statusText, requestId: "" };
    try { err = ((await res.json()) as ApiErrorBody).error ?? err; } catch { /* non-JSON error */ }
    throw new ApiError(res.status, err.code, err.message, err.requestId, err.details ?? {});
  }
  const busy = <T,>(send: () => Promise<T>) => withBusyRetry(send, opts.sleep);
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
    listResponderTemplates: () => call("GET", "/responder-templates"),
    createResponderTemplate: (body) => busy(() => call("POST", "/responder-templates", body)),
    previewResponderTemplate: (id, p) => busy(() => call("POST", `/responder-templates/${enc(id)}/preview`, p)),
    saveResponderTemplate: (id, p, o) => busy(() => call("PATCH", `/responder-templates/${enc(id)}`, { ...p, previewHash: o.previewHash }, { "If-Match": String(o.version) })),
    previewCustomerTemplate: (id, templateId) => busy(() => call("POST", `/customers/${enc(id)}/responders/template/preview`, { templateId })),
    putCustomerTemplate: (id, templateId, o) => busy(() => call("PUT", `/customers/${enc(id)}/responders/template`, { templateId, previewHash: o.previewHash }, { "If-Match": String(o.version) })),
    getCustomerStatus: (id) => call("GET", `/customers/${enc(id)}/status`),
    patchCustomerStatus: (id, body, version) => call("PATCH", `/customers/${enc(id)}/status`, body, { "If-Match": String(version) }),
    getOffboarding: (id) => call("GET", `/customers/${enc(id)}/offboarding`),
    markOffboardStep: (id, body) => call("PATCH", `/customers/${enc(id)}/offboarding`, body),
    putLegalHold: (id, reason) => call("PUT", `/customers/${enc(id)}/legal-hold`, { reason }),
    deleteLegalHold: (id, reason) => call("DELETE", `/customers/${enc(id)}/legal-hold`, reason ? { reason } : {}),
    getPurgeLog: (id) => call("GET", `/customers/${enc(id)}/purge-log`),
    exportCsv: (id) => raw(`/customers/${enc(id)}/export.csv`),
    revealContact: (id, body) => call("POST", `/contacts/${enc(id)}/reveal`, body),
    listContactReveals: (q = {}) => call("GET", "/contact-reveals" + toQuery({ ...q })),
    getLatestDigest: () => call("GET", "/digests/latest"),
    listUsers: (q = {}) => call("GET", "/users" + toQuery({ ...q })),
    createUser: (body) => call("POST", "/users", body),
    patchUser: (id, body) => call("PATCH", `/users/${enc(id)}`, body),
    createCustomer: (body) => call("POST", "/customers", body),
    getCustomer: (id) => call("GET", `/customers/${enc(id)}`),
    listProjects: async (id) => (await call<{ items: ProjectRecord[] }>("GET", `/customers/${enc(id)}/projects`)).items,
    createProject: (id, body) => call("POST", `/customers/${enc(id)}/projects`, body),
    listServices: async (id) => (await call<{ items: ServiceRecord[] }>("GET", `/projects/${enc(id)}/services`)).items,
    createService: (id, body) => call("POST", `/projects/${enc(id)}/services`, body),
    listAccounts: async (id) => (await call<{ items: AccountRecord[] }>("GET", `/customers/${enc(id)}/accounts`)).items,
    createAccount: (id, body) => call("POST", `/customers/${enc(id)}/accounts`, body),
    patchAccount: (id, body) => call("PATCH", `/accounts/${enc(id)}`, body),
    checkAccount: (id) => call("POST", `/accounts/${enc(id)}/check`, {}),
    getAccountStatus: (id) => call("GET", `/accounts/${enc(id)}/status`),
    listContacts: (q) => call("GET", "/contacts" + toQuery({ kind: "CUSTOMER", customerId: q.customerId, needsAction: q.needsAction ? true : undefined })),
    createContact: (body) => call("POST", "/contacts", { kind: "CUSTOMER", ...body }),
    verifyContact: (id, body) => call("POST", `/contacts/${enc(id)}/verify`, body),
    verifyBulk: (contactIds) => call("POST", "/contacts/verify-bulk", { contactIds }),
    peekVerify: (token) => call("GET", `/verify/${enc(token)}`),
    confirmVerify: (token) => call("POST", `/verify/${enc(token)}`, {}),
    listResources: (q = {}) => call("GET", "/resources" + toQuery({ ...q, mine: q.mine ? 1 : undefined })),
    listManagedAlarms: (q = {}) => call("GET", "/managed-alarms" + toQuery({ ...q, mine: q.mine ? 1 : undefined })),
    setMonitoring: (id, action) => call("POST", `/resources/${enc(id)}/monitoring`, { action }),
  };
}
