/**
 * API-CONTRACT §8.4 (D-45, D-46):
 *   PUT    /customers/{id}/legal-hold   ADMIN  { reason }   -> stop automatic purging of this customer
 *   DELETE /customers/{id}/legal-hold   ADMIN  { reason? }  -> resume
 *   GET    /customers/{id}/purge-log    ADMIN  -> certificate data (what was deleted when, by whom) + schedule + hold
 *   GET    /customers/{id}/export.csv   ADMIN  -> incident history as CSV, only while TERMINATED and inside the return period
 *   GET    /digests/latest              MSP staff -> the business-hours digest (D-46)
 * MSP staff only: for portal users the routes do not exist (404 before anything else).
 */
import { DEFAULT_RETENTION, buildDigest, latestDigestWindow, retentionSchedule, type RetentionConfig } from '@alarmops/core';
import { requireAuth, scopeOf } from './auth.js';
import { adminCustomer } from './customerApi.js';
import { ApiError, invalid, isRecord, notFound, ok, type ApiRequest, type ApiResponse } from './http.js';
import type { ApiRepository, ExportIncidentRow, LegalHoldState } from './repo.js';

interface Deps { repo: ApiRepository; now: () => Date; retention?: RetentionConfig; log?: (level: 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void }

const REASON_MAX = 500;
/**
 * Size cap of the CSV export. The response is streamed in pages of EXPORT_PAGE rows (flat memory), but a customer whose
 * history is larger than this gets 413 EXPORT_TOO_LARGE before anything is sent (an export that silently stops in the
 * middle would hand the customer an incomplete history). At roughly 300 bytes a row the cap is about 15 MB.
 */
export const MAX_EXPORT_ROWS = 50_000;
const EXPORT_PAGE = 500;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const holdView = (h: LegalHoldState) => ({ active: h.active, ...(h.active ? { at: iso(h.at), byUserId: h.byUserId, reason: h.reason } : {}) });

async function holdRequest(req: ApiRequest, deps: Deps, customerId: string, set: boolean): Promise<ApiResponse> {
  const { auth, customer } = await adminCustomer(req, deps, customerId, true);
  const b = req.body;
  if (b !== undefined && !isRecord(b)) throw invalid('body', 'Body must be a JSON object.');
  const reason = typeof b?.reason === 'string' ? b.reason.trim() : '';
  if (set && !reason) throw invalid('reason', 'reason is required.');
  if (b?.reason !== undefined && typeof b.reason !== 'string') throw invalid('reason', 'reason must be text.');
  if (reason.length > REASON_MAX) throw invalid('reason', `reason is at most ${REASON_MAX} characters.`);
  const cur = await deps.repo.retentionView(customer.id);
  if (!cur) throw notFound();
  const now = deps.now();
  const audit = {
    at: now, customerId: customer.id, actorType: 'USER' as const, actorId: auth.userId, action: set ? 'customer.legal_hold.set' : 'customer.legal_hold.release', targetType: 'CustomerLegalHold', targetId: customer.id,
    before: { legalHold: cur.legalHold.active, ...(cur.legalHold.active ? { reason: cur.legalHold.reason } : {}) }, after: { legalHold: set, ...(reason ? { reason } : {}) }, requestId: req.requestId,
  };
  const r = await deps.repo.setLegalHold(customer.id, set ? { byUserId: auth.userId, reason, at: now } : null, audit);
  if (r === 'NOT_FOUND') throw notFound();
  const after = await deps.repo.retentionView(customer.id);
  if (!after) throw notFound();
  // Same state as asked: 200 and nothing written (idempotent; no audit row, no purge-log row).
  return ok({ legalHold: holdView(after.legalHold), changed: r === 'OK' });
}
export const putLegalHold = (req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> => holdRequest(req, deps, customerId, true);
export const deleteLegalHold = (req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> => holdRequest(req, deps, customerId, false);

export async function getPurgeLog(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { customer } = await adminCustomer(req, deps, customerId, true);
  const [view, entries] = await Promise.all([deps.repo.retentionView(customer.id), deps.repo.purgeLog(customer.id)]);
  if (!view) throw notFound();
  const cfg = deps.retention ?? DEFAULT_RETENTION;
  const sched = view.status === 'TERMINATED' && view.statusChangedAt ? retentionSchedule(view.statusChangedAt, cfg) : null;
  return ok({
    customer: { id: customer.id, name: view.name, status: view.status, statusChangedAt: iso(view.statusChangedAt) },
    legalHold: holdView(view.legalHold),
    // Counts only, never content. `actor` is 'system' (the daily job) or the ADMIN's user id (legal-hold changes).
    entries: entries.map((e) => ({ id: e.id, at: e.at.toISOString(), stage: e.stage, counts: e.counts, actor: e.actor })),
    schedule: sched ? { returnPeriodEndsAt: sched.returnPeriodEndsAt.toISOString(), auditExpiresAt: sched.auditExpiresAt.toISOString(), slaExpiresAt: sched.slaExpiresAt.toISOString(), returnDays: cfg.returnDays, auditDays: cfg.auditDays, slaDays: cfg.slaDays } : null,
  });
}

// ───────────────────────────── export.csv ─────────────────────────────

/** Cells that a spreadsheet would run as a formula get a leading apostrophe (CSV injection). */
function cell(v: string | number | null): string {
  if (v === null) return '';
  let t = String(v);
  if (/^[=+\-@\t\r]/.test(t) && typeof v === 'string') t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
export const EXPORT_HEADER = ['number', 'id', 'title', 'severity', 'status', 'triggeredAt', 'acknowledgedAt', 'resolvedAt', 'mttaSec', 'mttrSec', 'memberCount', 'eventCount', 'accountIds', 'resourceTypes', 'pagingSuppressed'];
const line = (r: ExportIncidentRow): string => [
  r.number, r.id, r.title, r.severity, r.status, r.triggeredAt.toISOString(), iso(r.acknowledgedAt), iso(r.resolvedAt), r.mttaSec, r.mttrSec, r.memberCount, r.eventCount,
  r.accountIds.join(' '), r.resourceTypes.join(' '), r.pagingSuppressed,
].map((v) => cell(v as string | number | null)).join(',') + '\r\n';

export async function exportCsv(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { auth, customer } = await adminCustomer(req, deps, customerId, true);
  const st = await deps.repo.customerStatusState(customer.id);
  if (!st) throw notFound();
  // The export exists to hand the history back to a customer that left: only TERMINATED, only during the return period.
  if (st.status !== 'TERMINATED' || !st.statusChangedAt) throw new ApiError(409, 'CUSTOMER_NOT_TERMINATED', 'The incident history can be exported only for a terminated customer.');
  const cfg = deps.retention ?? DEFAULT_RETENTION;
  const closesAt = retentionSchedule(st.statusChangedAt, cfg).returnPeriodEndsAt;
  const now = deps.now();
  if (now.getTime() >= closesAt.getTime()) throw new ApiError(410, 'EXPORT_WINDOW_CLOSED', 'The return period is over; the incident history is no longer available for export.', { closedAt: closesAt.toISOString() });
  const total = await deps.repo.countExportIncidents(customer.id);
  if (total > MAX_EXPORT_ROWS) throw new ApiError(413, 'EXPORT_TOO_LARGE', `The history has more than ${MAX_EXPORT_ROWS} incidents; ask the platform team for a manual export.`, { rows: total, max: MAX_EXPORT_ROWS });
  await deps.repo.recordAudit({
    at: now, customerId: customer.id, actorType: 'USER', actorId: auth.userId, action: 'customer.export', targetType: 'CustomerExport', targetId: customer.id,
    before: null, after: { format: 'csv', incidents: total }, requestId: req.requestId,
  });
  const repo = deps.repo;
  async function* rows(): AsyncGenerator<string> {
    yield '﻿' + EXPORT_HEADER.join(',') + '\r\n'; // BOM: Excel reads Korean text as UTF-8
    let after = 0;
    let sent = 0;
    for (;;) {
      const page = await repo.exportIncidents(customer.id, after, EXPORT_PAGE);
      if (!page.length) return;
      let chunk = '';
      for (const r of page) { chunk += line(r); after = r.number; }
      sent += page.length;
      yield chunk;
      if (page.length < EXPORT_PAGE || sent >= MAX_EXPORT_ROWS + EXPORT_PAGE) return;
    }
  }
  const safe = customer.id.replace(/[^A-Za-z0-9_-]/g, '_');
  return {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="incidents-${safe}-${now.toISOString().slice(0, 10)}.csv"`, 'x-export-closes-at': closesAt.toISOString(),
    },
    stream: rows(),
  };
}

// ───────────────────────────── digest ─────────────────────────────

export async function getLatestDigest(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  if (auth.kind !== 'INTERNAL') throw notFound();
  const w = latestDigestWindow(deps.now());
  const data = await deps.repo.digestData(scopeOf(auth), w.from, w.to);
  return ok(buildDigest(w, data));
}
