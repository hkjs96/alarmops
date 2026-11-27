/**
 * Route table of the console REST API parts built so far (API-CONTRACT §8.0, §8.1, scope parts of §8.3).
 * `createApi(deps).handle(request)` is all an adapter needs.
 */
import { createHash } from 'node:crypto';
import { IDEMPOTENCY_MAX_PER_USER, errorTag, type RetentionConfig } from '@alarmops/core';
import { strictApiConfig, type ApiConfig } from './audience.js';
import { requireAuth, scopeKey } from './auth.js';
import { ApiError, assertCleanInput, errorResponse, header, isRecord, notFound, type ApiRequest, type ApiResponse } from './http.js';
import { actOnIncident, bulkIncidents, getIncident, getNotifications, getTimeline, listIncidents, undoIncidents } from './incidents.js';
import { deleteLegalHold, exportCsv, getLatestDigest, getPurgeLog, putLegalHold } from './retentionApi.js';
import { getCustomerStatus, getOffboarding, patchCustomerStatus, patchOffboarding, type CommandPublisher } from './customerApi.js';
import { deletePagingOverride, getCustomerPaging, getPagingPath, putCustomerPaging, putPagingOverride } from './pagingApi.js';
import type { ApiRepository } from './repo.js';
import { getScopeTree } from './scope.js';
import { listContactReveals, revealContact } from './revealApi.js';
import { createCustomer, listAccounts, createAccount, patchAccount, deleteAccount, checkAccount, getAccountStatus } from './onboardingApi.js';
import { listContacts, createContact, patchContact, deleteContact, verifyContact, verifyBulk, useVerifyLink, peekVerifyLink, type VerificationSender } from './contactsApi.js';
import { createProject, createService, getCustomer, listCustomers, listProjects, listServices, patchCustomer, patchProject, patchService } from './orgApi.js';
import { getResource, listManagedAlarms, listResources, postMonitoring } from './monitoringApi.js';
import { createUser, getUser, listUsers, patchUser } from './usersApi.js';
import { createTemplate, listTemplates, patchTemplate, previewTemplate } from './templatesApi.js';
import { deleteResponder, getMe, getOncallNow, getPagingHealth, getResponders, listRotations, listStaff, patchResponder, postResponder } from './peopleApi.js';

export interface ApiDeps {
  repo: ApiRepository;
  now?: () => Date;
  /** `alarm-commands` queue (D-43 OFFBOARD_ACCOUNT). Without it a TERMINATED change is refused (503) before any write. */
  commands?: CommandPublisher;
  /** D-45 retention periods (default DEFAULT_RETENTION; build with `retentionConfigFromEnv(process.env)`). Decides the CSV export window and the schedule shown with the purge log. */
  retention?: RetentionConfig;
  /**
   * Policy switches with safe defaults (see audience.ts). Build it with `loadApiConfig(process.env)`; a value that
   * is not the boolean `true` is treated as off (R-15).
   */
  config?: Partial<ApiConfig>;
  /** Delivers contact verification links (e-mail / SMS adapters, hkjs96/alarmops#39, #10). Without it a link request is 503 VERIFICATION_UNAVAILABLE. */
  verification?: VerificationSender;
  /** Server secret (>= 32 chars) that keys the per-destination send cap (HMAC-SHA-256). Required when `verification` is set; otherwise link requests are 503 NOT_CONFIGURED. The console passes e.g. an env secret `VERIFY_HASH_SECRET`. */
  verificationSecret?: string;
  log?: (level: 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

type Handler = (req: ApiRequest, deps: { repo: ApiRepository; now: () => Date; config: ApiConfig; commands?: CommandPublisher; retention?: RetentionConfig; verification?: VerificationSender; verificationSecret?: string; log?: ApiDeps['log'] }, p: string[]) => Promise<ApiResponse>;
interface Route {
  method: ApiRequest['method']; pattern: string[]; run: Handler;
  /** true → no session is required (the credential is in the path: GET /verify/{token}). Everything else answers 401 without one. */
  public?: boolean;
  /**
   * false → the response is never stored for Idempotency-Key replay.
   * - read-only requests (N-19: a bulk preview);
   * - CONVENTION (security review SQL, R-7): ANY route whose response carries contact details — a phone number, an
   *   e-mail address, a Slack id (the contact reveal of D-35, contact lists and exports) — MUST be registered with
   *   `() => false`. `IdempotencyKey.response` is a plain copy of the body kept for 24 h; contact details live in
   *   `Contact` only. A second call of such a route runs again (and is audited again) instead of being replayed.
   */
  replayable?: (req: ApiRequest) => boolean;
}

const route = (method: ApiRequest['method'], path: string, run: Handler, replayable?: Route['replayable'], isPublic = false): Route => ({ method, pattern: path.split('/').filter(Boolean), run, replayable, ...(isPublic ? { public: true } : {}) });

/** Order matters only where a literal and a parameter compete (`/incidents/bulk` before `/incidents/:id`). */
export const ROUTES: Route[] = [
  route('GET', '/scope-tree', (r, d) => getScopeTree(r, d)),
  route('GET', '/incidents', (r, d) => listIncidents(r, d)),
  // A preview changes nothing: running it again IS the replay, so its (large) body is not kept (N-19).
  route('POST', '/incidents/bulk', (r, d) => bulkIncidents(r, d), (r) => !(isRecord(r.body) && r.body.preview === true)),
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
  route('GET', '/me', (r, d) => getMe(r, d)),
  route('GET', '/oncall/now', (r, d) => getOncallNow(r, d)),
  route('GET', '/customers/:id/paging-health', (r, d, p) => getPagingHealth(r, d, p[0]!)),
  route('GET', '/customers/:id/responders', (r, d, p) => getResponders(r, d, p[0]!)),
  route('POST', '/customers/:id/responders', (r, d, p) => postResponder(r, d, p[0]!)),
  route('PATCH', '/customers/:id/responders/:contactId', (r, d, p) => patchResponder(r, d, p[0]!, p[1]!)),
  route('DELETE', '/customers/:id/responders/:contactId', (r, d, p) => deleteResponder(r, d, p[0]!, p[1]!)),
  route('GET', '/customers/:id/status', (r, d, p) => getCustomerStatus(r, d, p[0]!)),
  route('PATCH', '/customers/:id/status', (r, d, p) => patchCustomerStatus(r, d, p[0]!)),
  route('GET', '/customers/:id/offboarding', (r, d, p) => getOffboarding(r, d, p[0]!)),
  route('PATCH', '/customers/:id/offboarding', (r, d, p) => patchOffboarding(r, d, p[0]!)),
  route('PUT', '/customers/:id/legal-hold', (r, d, p) => putLegalHold(r, d, p[0]!)),
  route('DELETE', '/customers/:id/legal-hold', (r, d, p) => deleteLegalHold(r, d, p[0]!)),
  route('GET', '/customers/:id/purge-log', (r, d, p) => getPurgeLog(r, d, p[0]!)),
  route('GET', '/customers/:id/export.csv', (r, d, p) => exportCsv(r, d, p[0]!)),
  route('GET', '/digests/latest', (r, d) => getLatestDigest(r, d)),
  route('GET', '/responder-templates', (r, d) => listTemplates(r, d)),
  route('POST', '/responder-templates', (r, d) => createTemplate(r, d)),
  route('PATCH', '/responder-templates/:id', (r, d, p) => patchTemplate(r, d, p[0]!)),
  // A preview changes nothing: running it again IS the replay, so its body is not kept.
  route('POST', '/responder-templates/:id/preview', (r, d, p) => previewTemplate(r, d, p[0]!), () => false),
  route('GET', '/rotations', (r, d) => listRotations(r, d)),
  route('GET', '/staff', (r, d) => listStaff(r, d)),
  // D-35. The reveal response carries a contact value: never stored for replay (security review SQL R-7), a second call runs and is logged again.
  route('POST', '/contacts/:id/reveal', (r, d, p) => revealContact(r, d, p[0]!), () => false),
  route('GET', '/contact-reveals', (r, d) => listContactReveals(r, d)),
  // ── onboarding (#62): customer, AWS accounts, contacts, verification ──
  route('POST', '/customers', (r, d) => createCustomer(r, d)),
  // wizard (#69): customer profile, projects, services — MSP staff only
  route('GET', '/customers', (r, d) => listCustomers(r, d)),
  route('GET', '/customers/:id', (r, d, p) => getCustomer(r, d, p[0]!)),
  route('PATCH', '/customers/:id', (r, d, p) => patchCustomer(r, d, p[0]!)),
  route('GET', '/customers/:id/projects', (r, d, p) => listProjects(r, d, p[0]!)),
  route('POST', '/customers/:id/projects', (r, d, p) => createProject(r, d, p[0]!)),
  route('PATCH', '/projects/:id', (r, d, p) => patchProject(r, d, p[0]!)),
  route('GET', '/projects/:id/services', (r, d, p) => listServices(r, d, p[0]!)),
  route('POST', '/projects/:id/services', (r, d, p) => createService(r, d, p[0]!)),
  route('PATCH', '/services/:id', (r, d, p) => patchService(r, d, p[0]!)),
  // An account response carries the ExternalId: never kept for replay (a second call with the same Idempotency-Key runs again).
  route('GET', '/customers/:id/accounts', (r, d, p) => listAccounts(r, d, p[0]!)),
  route('POST', '/customers/:id/accounts', (r, d, p) => createAccount(r, d, p[0]!), () => false),
  route('PATCH', '/accounts/:id', (r, d, p) => patchAccount(r, d, p[0]!), () => false),
  route('DELETE', '/accounts/:id', (r, d, p) => deleteAccount(r, d, p[0]!)),
  route('POST', '/accounts/:id/check', (r, d, p) => checkAccount(r, d, p[0]!)),
  route('GET', '/accounts/:id/status', (r, d, p) => getAccountStatus(r, d, p[0]!)),
  // Contact responses are masked, but a list of people is still personal data: never replayed from the idempotency store.
  route('GET', '/contacts', (r, d) => listContacts(r, d)),
  route('POST', '/contacts', (r, d) => createContact(r, d), () => false),
  route('POST', '/contacts/verify-bulk', (r, d) => verifyBulk(r, d)),
  route('PATCH', '/contacts/:id', (r, d, p) => patchContact(r, d, p[0]!), () => false),
  route('DELETE', '/contacts/:id', (r, d, p) => deleteContact(r, d, p[0]!)),
  route('POST', '/contacts/:id/verify', (r, d, p) => verifyContact(r, d, p[0]!)),
  // ── monitoring (D-16): resources, managed alarms ──
  route('GET', '/resources', (r, d) => listResources(r, d)),
  route('GET', '/resources/:id', (r, d, p) => getResource(r, d, p[0]!)),
  route('POST', '/resources/:id/monitoring', (r, d, p) => postMonitoring(r, d, p[0]!)),
  route('GET', '/managed-alarms', (r, d) => listManagedAlarms(r, d)),
  // ── users (#69, D-55): responses carry a masked e-mail only, so replay is fine ──
  route('GET', '/users', (r, d) => listUsers(r, d)),
  route('POST', '/users', (r, d) => createUser(r, d)),
  route('GET', '/users/:id', (r, d, p) => getUser(r, d, p[0]!)),
  route('PATCH', '/users/:id', (r, d, p) => patchUser(r, d, p[0]!)),
  route('GET', '/verify/:token', (r, d, p) => peekVerifyLink(r, d, p[0]!), undefined, true),
  route('POST', '/verify/:token', (r, d, p) => useVerifyLink(r, d, p[0]!), () => false, true),
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
/**
 * Body fields that are never written to the idempotency store (R-7). `undoToken` is a bearer secret for 5 minutes
 * and `UndoRecord` keeps only its SHA-256; a plain copy in `IdempotencyKey.response` for 24 h would undo that.
 * A REPLAYED response therefore has no `undoToken`: the client keeps the token of the first answer; a client that
 * lost it cannot undo through a replay (it can still act on the incident with the version it sees).
 */
export const NEVER_STORED_FIELDS: readonly string[] = ['undoToken'];
const storable = (body: unknown): unknown =>
  isRecord(body) && NEVER_STORED_FIELDS.some((f) => f in body) ? Object.fromEntries(Object.entries(body).filter(([k]) => !NEVER_STORED_FIELDS.includes(k))) : body;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** Stable JSON (sorted keys) so the same body hashes the same whatever the key order. */
const stable = (v: unknown): string =>
  v === undefined ? 'null' : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : v !== null && typeof v === 'object' ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v) ?? 'null';

/** `/verify/<token>` carries a credential in the path: it must never reach a log line. */
export const loggablePath = (path: string): string => path.replace(/(\/verify\/)[^/?#]*/g, '$1[token]');

export function createApi(deps: ApiDeps) {
  const inner = { repo: deps.repo, now: deps.now ?? (() => new Date()), config: strictApiConfig(deps.config), commands: deps.commands, retention: deps.retention, verification: deps.verification, verificationSecret: deps.verificationSecret, log: deps.log };
  async function handle(req: ApiRequest): Promise<ApiResponse> {
    try {
      const m = match(req.method, req.path);
      // Every console route needs a session (401 before anything else) — except a route marked `public`, whose credential is its path.
      const auth = m?.route.public ? null : requireAuth(req);
      assertCleanInput(req); // R-5: NUL bytes and malformed path ids are a 400 here, never an error from the database
      if (!m) throw notFound();
      // Idempotency-Key (§2): the same key from the same user for the same request replays the first response for 24h.
      // R-5: - the key is looked up together with the caller's CURRENT range and role (scopeKey): after a change of
      //        customers, sub-scopes, kind or role nothing is replayed — the request runs again and is authorised now;
      //      - it is bound to method + canonical path + If-Match + body hash: the same key with another request is 422;
      //      - only successful responses are stored, so failing requests cannot fill the store.
      // N-19: - read-only requests (bulk preview) are not stored at all;
      //       - a user holds at most IDEMPOTENCY_MAX_PER_USER live entries (the store drops the oldest).
      const replayable = m.route.replayable ? m.route.replayable(req) : true;
      const idem = req.method === 'GET' || !replayable ? undefined : header(req, 'idempotency-key');
      const idemKey = idem && auth ? sha([auth.userId, sha(scopeKey(auth)), sha(idem)].join('|')) : undefined;
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
        await inner.repo.putIdempotent(idemKey, { fingerprint, res: { status: res.status, headers: res.headers, body: storable(res.body) } }, new Date(inner.now().getTime() + IDEMPOTENCY_TTL_MS), { owner: auth!.userId, maxPerOwner: IDEMPOTENCY_MAX_PER_USER });
      }
      return res;
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err, req.requestId);
      deps.log?.('error', 'unhandled', { requestId: req.requestId, path: loggablePath(req.path), error: errorTag(err) });
      return errorResponse(new ApiError(500, 'INTERNAL', 'Something went wrong.'), req.requestId);
    }
  }
  return { handle };
}
