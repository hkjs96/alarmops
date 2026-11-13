/**
 * API-CONTRACT §8.4 (D-42, D-43): customer status and offboarding.
 *   GET   /customers/{id}/status        -> { status, statusChangedAt, version }  (ETag = version)
 *   PATCH /customers/{id}/status        -> ADMIN, If-Match, reason; TERMINATED also needs confirmName
 *   GET   /customers/{id}/offboarding   -> checklist + residual events
 *   PATCH /customers/{id}/offboarding   -> a person marks a MANUAL/PENDING step DONE
 * MSP staff only: for portal users the routes do not exist (the one 404, before any parameter is looked at).
 * The status is changed ONLY here; PATCH /customers/{id} (profile) never touches it.
 */
import { requireAuth, requireRole, type AuthContext } from './auth.js';
import { ApiError, ifMatch, invalid, isRecord, notFound, ok, versionConflict, type ApiRequest, type ApiResponse } from './http.js';
import { visibleCustomer } from './pagingApi.js';
import { OFFBOARD_STEP_KEYS, type ApiRepository, type CustomerStatusValue, type OffboardStepKey, type OffboardingState } from './repo.js';

/** The alarm-commands message of API-CONTRACT §6 (SQS `alarm-commands`). */
export interface AlarmCommand {
  schemaVersion: 1;
  commandId: string;
  type: 'OFFBOARD_ACCOUNT';
  customerId: string;
  cloudAccountId: string;
  requestedBy: { type: 'USER'; id: string };
  requestedAt: string;
  payload: { offboardingId: string };
}

/**
 * Port to the `alarm-commands` queue. Production adapter = SQS SendMessage (infra wires it; this package has no AWS
 * client). Publishing happens AFTER the database commit and may fail: see `PATCH /customers/{id}/status`.
 */
export interface CommandPublisher { publish(cmd: AlarmCommand): Promise<void> }

/** Test/local publisher: records every command; `failFor` makes publishing to those cloud accounts throw. */
export class InMemoryCommandPublisher implements CommandPublisher {
  sent: AlarmCommand[] = [];
  failFor = new Set<string>();
  async publish(cmd: AlarmCommand): Promise<void> {
    if (this.failFor.has(cmd.cloudAccountId)) throw new Error('simulated publish failure');
    this.sent.push(structuredClone(cmd));
  }
}

interface Deps { repo: ApiRepository; now: () => Date; commands?: CommandPublisher; log?: (level: 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void }

const STATUSES: readonly CustomerStatusValue[] = ['ACTIVE', 'SUSPENDED', 'TERMINATED'];
const REASON_MAX = 500;
const DETAIL_MAX = 500;
const internalOnly = (auth: AuthContext): void => { if (auth.kind !== 'INTERNAL') throw notFound(); };
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Customer visible to this staff member, whole-customer only (a narrowed staff scope does not exist today; same rule as Responders). */
async function adminCustomer(req: ApiRequest, deps: Deps, customerId: string, admin: boolean) {
  const auth = requireAuth(req);
  internalOnly(auth);
  const { customer } = await visibleCustomer(deps, auth, customerId, 'CUSTOMER');
  if (admin) requireRole(auth, 'ADMIN'); // after the 404 checks: an unknown id never reveals a role rule
  return { auth, customer };
}

// ───────────────────────────── status ─────────────────────────────

export async function getCustomerStatus(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { customer } = await adminCustomer(req, deps, customerId, true);
  const st = await deps.repo.customerStatusState(customer.id);
  if (!st) throw notFound();
  return ok({ status: st.status, statusChangedAt: iso(st.statusChangedAt), version: st.version }, { etag: `"${st.version}"` });
}

export async function patchCustomerStatus(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { auth, customer } = await adminCustomer(req, deps, customerId, true);
  const expected = ifMatch(req);
  const b = req.body;
  if (!isRecord(b)) throw invalid('body', 'Body must be a JSON object.');
  if (typeof b.status !== 'string' || !(STATUSES as readonly string[]).includes(b.status)) throw invalid('status', 'status must be ACTIVE, SUSPENDED or TERMINATED.');
  const to = b.status as CustomerStatusValue;
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) throw invalid('reason', 'reason is required.');
  if (reason.length > REASON_MAX) throw invalid('reason', `reason is at most ${REASON_MAX} characters.`);
  if (to === 'TERMINATED' && (typeof b.confirmName !== 'string' || b.confirmName.trim() !== customer.name)) throw invalid('confirmName', 'confirmName must be the exact customer name to terminate.');

  const st = await deps.repo.customerStatusState(customer.id);
  if (!st) throw notFound();
  if (st.version !== expected) throw versionConflict('The customer status', st.version);
  if (st.status === 'TERMINATED' && to !== 'TERMINATED') throw new ApiError(409, 'CUSTOMER_TERMINATED', 'A terminated customer cannot change status. Connect it again as a new customer.');
  if (st.status === to) {
    // No-op: nothing written, no audit row, the version does not move.
    const off = to === 'TERMINATED' ? await deps.repo.offboardingState(customer.id) : null;
    return ok({ status: st.status, statusChangedAt: iso(st.statusChangedAt), version: st.version, ...(off ? { offboardingId: off.id } : {}) }, { etag: `"${st.version}"` });
  }
  // Fail closed BEFORE any write: a termination whose alarm-deletion commands cannot be sent would strand the checklist.
  if (to === 'TERMINATED' && !deps.commands) throw new ApiError(503, 'COMMANDS_UNAVAILABLE', 'The command queue is not configured; the customer was not terminated.');

  const now = deps.now();
  const audit = {
    at: now, customerId: customer.id, actorType: 'USER' as const, actorId: auth.userId, action: `customer.status.${to.toLowerCase()}`, targetType: 'CustomerStatus', targetId: customer.id,
    before: { status: st.status, version: st.version }, after: { status: to, version: st.version + 1, reason }, requestId: req.requestId,
  };
  const r = await deps.repo.changeCustomerStatus(customer.id, expected, to, to === 'TERMINATED' ? { startedByUserId: auth.userId, reason } : null, audit);
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'CONFLICT') throw versionConflict('The customer status', (await deps.repo.customerStatusState(customer.id))?.version);
  if (r === 'CUSTOMER_TERMINATED') throw new ApiError(409, 'CUSTOMER_TERMINATED', 'A terminated customer cannot change status. Connect it again as a new customer.');

  // After the commit (no outbox table yet: see API-CONTRACT §8.4). A failed publish is recorded on the checklist and
  // reported in the response; the status change itself stands (paging is already stopped).
  const failed: string[] = [];
  if (r.offboardingId && deps.commands) {
    for (const cloudAccountId of r.cloudAccountIds) {
      try {
        await deps.commands.publish({
          schemaVersion: 1, commandId: `offboard-${r.offboardingId}-${cloudAccountId}`, type: 'OFFBOARD_ACCOUNT', customerId: customer.id, cloudAccountId,
          requestedBy: { type: 'USER', id: auth.userId }, requestedAt: now.toISOString(), payload: { offboardingId: r.offboardingId },
        });
      } catch {
        failed.push(cloudAccountId); // no error text: it may carry queue URLs
      }
    }
    if (failed.length) {
      deps.log?.('error', 'offboard_publish_failed', { customerId: customer.id, offboardingId: r.offboardingId, accounts: failed });
      await deps.repo.recordOffboardPublishFailure(customer.id, failed, now).catch(() => undefined);
    }
  }
  return ok({ status: r.status, statusChangedAt: r.statusChangedAt.toISOString(), version: r.version, ...(r.offboardingId ? { offboardingId: r.offboardingId, commandsSent: r.cloudAccountIds.length - failed.length, ...(failed.length ? { commandsFailed: failed } : {}) } : {}) }, { etag: `"${r.version}"` });
}

// ───────────────────────────── offboarding ─────────────────────────────

function offboardingView(o: OffboardingState) {
  return {
    id: o.id, startedAt: o.startedAt.toISOString(), completedAt: iso(o.completedAt), reason: o.reason,
    steps: OFFBOARD_STEP_KEYS.map((key) => {
      const s = o.steps[key];
      return { key, state: s.state, ...(s.at ? { at: s.at } : {}), ...(s.byUserId ? { byUserId: s.byUserId } : {}), ...(s.detail ? { detail: s.detail } : {}) };
    }),
    residual: { ...(o.residual.lastEventAt ? { lastEventAt: o.residual.lastEventAt.toISOString() } : {}), count: o.residual.count },
  };
}

export async function getOffboarding(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { customer } = await adminCustomer(req, deps, customerId, true);
  const o = await deps.repo.offboardingState(customer.id);
  if (!o) throw notFound(); // a customer that was never terminated has no checklist
  return ok(offboardingView(o));
}

/**
 * PATCH `{ key, state: "DONE", detail? }`. No If-Match: the mark is idempotent, DONE is never overwritten (a second
 * mark answers 200 unchanged) and the engine's own result writes take the same row lock.
 * `ALARMS_DELETED` belongs to the engine: a person may mark it only when it is MANUAL (409 STEP_NOT_MANUAL otherwise).
 */
export async function patchOffboarding(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { auth, customer } = await adminCustomer(req, deps, customerId, true);
  const b = req.body;
  if (!isRecord(b)) throw invalid('body', 'Body must be a JSON object.');
  if (typeof b.key !== 'string' || !(OFFBOARD_STEP_KEYS as readonly string[]).includes(b.key)) throw invalid('key', `key must be one of ${OFFBOARD_STEP_KEYS.join(', ')}.`);
  if (b.state !== 'DONE') throw invalid('state', 'state must be DONE.');
  if (b.detail !== undefined && (typeof b.detail !== 'string' || b.detail.length > DETAIL_MAX)) throw invalid('detail', `detail must be text of at most ${DETAIL_MAX} characters.`);
  const key = b.key as OffboardStepKey;
  const now = deps.now();
  const audit = {
    at: now, customerId: customer.id, actorType: 'USER' as const, actorId: auth.userId, action: 'customer.offboarding.step_done', targetType: 'CustomerOffboarding', targetId: key,
    before: { key }, after: { key, state: 'DONE' }, requestId: req.requestId,
  };
  const r = await deps.repo.markOffboardStepDone(customer.id, key, auth.userId, typeof b.detail === 'string' && b.detail.trim() ? b.detail.trim() : null, now, audit);
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'NOT_ALLOWED') throw new ApiError(409, 'STEP_NOT_MANUAL', 'ALARMS_DELETED is set by the alarm engine; it can be marked only when it needs a person (MANUAL).');
  const o = await deps.repo.offboardingState(customer.id);
  if (!o) throw notFound();
  return ok(offboardingView(o));
}
