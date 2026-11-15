/**
 * Mock of the retention part of API-CONTRACT 8.4 (D-45) and of GET /digests/latest (D-46). packages/api/src/retentionApi.ts
 * is the reference for every rule here (ADMIN only, 404 for a portal user, 409 / 410 / 413 on the export, no-op = changed:false).
 *
 * Fixed data (the e2e specs rely on it):
 *   iruda  TERMINATED 2026-11-06, no hold; purge log has the CONNECTIONS stage; export window closes 30 days after
 *   others no purge rows, hold off, export answers 409 CUSTOMER_NOT_TERMINATED
 *   digest eden suspended (1 not-paged incident), iruda still sending events
 */
import { ApiError, type ConsoleApi } from "../client";
import type { Digest, LegalHold, PurgeLogEntry, PurgeLog, Role } from "../types";
import type { FxCustomer } from "./scope-fixtures";
import type { StatusStore } from "./status-mock";

export interface RetentionStore { holds: Record<string, LegalHold>; purge: Record<string, PurgeLogEntry[]>; seq: number }
export const MOCK_RETURN_DAYS = 30;
export const MOCK_AUDIT_DAYS = 730;
export const MOCK_SLA_DAYS = 1826;
const DAY = 86_400_000;
/** a terminated customer whose history is too large to export (413) */
export const TOO_LARGE_TO_EXPORT = new Set<string>();

export function createRetentionStore(): RetentionStore {
  return {
    holds: {},
    purge: {
      cus_iruda: [{ id: "pl_iruda_1", at: "2026-11-06T04:00:00Z", stage: "CONNECTIONS", counts: { cloudAccounts: 2, webhookTokens: 1, resources: 37, managedAlarms: 112 }, actor: "system" }],
    },
    seq: 1,
  };
}

interface Ctx {
  store: RetentionStore;
  status: StatusStore;
  customers: FxCustomer[];
  me: { id: string; role: Role };
  portal?: boolean;
  now: () => string;
  need: (role: Role) => void;
  err: (status: number, code: string, message: string, details?: Record<string, unknown>) => ApiError;
}

type RetentionApi = Pick<ConsoleApi, "putLegalHold" | "deleteLegalHold" | "getPurgeLog" | "exportCsv" | "getLatestDigest">;

export function createRetentionApi(x: Ctx): RetentionApi {
  const customer = (id: string) => {
    if (x.portal) throw x.err(404, "NOT_FOUND", "Not found.");
    const c = x.customers.find((k) => k.id === id);
    if (!c) throw x.err(404, "NOT_FOUND", "Not found.");
    return c;
  };
  const hold = (id: string): LegalHold => x.store.holds[id] ?? { active: false };
  const holdView = (h: LegalHold): LegalHold => (h.active ? { active: true, at: h.at, byUserId: h.byUserId, reason: h.reason } : { active: false });
  const log = (id: string, stage: PurgeLogEntry["stage"], at: string) => {
    (x.store.purge[id] ??= []).push({ id: `pl_${id}_${++x.store.seq}`, at, stage, counts: {}, actor: x.me.id });
  };
  const invalid = (field: string, message: string) => x.err(400, "VALIDATION_FAILED", message, { fields: [{ field, message }] });

  function setHold(id: string, on: boolean, rawReason: string | undefined) {
    customer(id);
    x.need("ADMIN");
    const reason = (rawReason ?? "").trim();
    if (on && !reason) throw invalid("reason", "reason is required.");
    if (reason.length > 500) throw invalid("reason", "reason is at most 500 characters.");
    const cur = hold(id);
    if (cur.active === on) return { legalHold: holdView(cur), changed: false };
    const at = x.now();
    x.store.holds[id] = on ? { active: true, at, byUserId: x.me.id, reason } : { active: false };
    log(id, on ? "LEGAL_HOLD_SET" : "LEGAL_HOLD_RELEASED", at);
    return { legalHold: holdView(hold(id)), changed: true };
  }

  return {
    async putLegalHold(id, reason) { return setHold(id, true, reason); },
    async deleteLegalHold(id, reason) { return setHold(id, false, reason); },
    async getPurgeLog(id): Promise<PurgeLog> {
      const c = customer(id);
      x.need("ADMIN");
      const st = x.status.status[id];
      const status = st?.status ?? "ACTIVE";
      const at = st?.changedAt ?? null;
      const t = at ? Date.parse(at) : null;
      const iso = (days: number) => new Date((t as number) + days * DAY).toISOString().replace(".000", "");
      return {
        customer: { id, name: c.name, status, statusChangedAt: at },
        legalHold: holdView(hold(id)),
        entries: structuredClone(x.store.purge[id] ?? []),
        schedule: status === "TERMINATED" && t !== null
          ? { returnPeriodEndsAt: iso(MOCK_RETURN_DAYS), auditExpiresAt: iso(MOCK_AUDIT_DAYS), slaExpiresAt: iso(MOCK_SLA_DAYS), returnDays: MOCK_RETURN_DAYS, auditDays: MOCK_AUDIT_DAYS, slaDays: MOCK_SLA_DAYS }
          : null,
      };
    },
    async exportCsv(id) {
      customer(id);
      x.need("ADMIN");
      const st = x.status.status[id];
      if (st?.status !== "TERMINATED" || !st.changedAt) throw x.err(409, "CUSTOMER_NOT_TERMINATED", "The incident history can be exported only for a terminated customer.");
      const closes = new Date(Date.parse(st.changedAt) + MOCK_RETURN_DAYS * DAY);
      if (Date.parse(x.now()) >= closes.getTime()) throw x.err(410, "EXPORT_WINDOW_CLOSED", "The return period is over; the incident history is no longer available for export.", { closedAt: closes.toISOString() });
      if (TOO_LARGE_TO_EXPORT.has(id)) throw x.err(413, "EXPORT_TOO_LARGE", "The history has more than 50000 incidents; ask the platform team for a manual export.", { rows: 50_001, max: 50_000 });
      const head = "number,id,title,severity,status,triggeredAt,acknowledgedAt,resolvedAt,mttaSec,mttrSec,memberCount,eventCount,accountIds,resourceTypes,pagingSuppressed\r\n";
      const rows = [
        "5301,inc-iruda-5301,lms-web-1 CPUUtilization above 90%,SEV_3,RESOLVED,2026-10-30T02:10:00.000Z,2026-10-30T02:14:00.000Z,2026-10-30T02:40:00.000Z,240,1800,1,3,481220935017,EC2,\r\n",
        "5309,inc-iruda-5309,\"lms-db-1 FreeStorageSpace, below 10 GB\",SEV_2,RESOLVED,2026-11-02T13:00:00.000Z,,2026-11-02T13:35:00.000Z,,2100,2,6,481220935017,RDS,\r\n",
      ];
      const body = new ReadableStream<Uint8Array>({
        start(c) { const e = new TextEncoder(); c.enqueue(e.encode("﻿" + head)); for (const r of rows) c.enqueue(e.encode(r)); c.close(); },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="incidents-${id}-${x.now().slice(0, 10)}.csv"`, "x-export-closes-at": closes.toISOString() },
      });
    },
    async getLatestDigest(): Promise<Digest> {
      if (x.portal) throw x.err(404, "NOT_FOUND", "Not found.");
      const suspended = [{ customerId: "cus_eden", customerName: "Eden Mobility", incidents: 1, firstAt: "2026-11-05T09:00:00Z", lastAt: "2026-11-05T09:00:00Z" }];
      const terminatedResiduals = [{ customerId: "cus_iruda", customerName: "Iruda Edu", sources: 1, lastEventAt: "2026-11-08T01:10:00Z", totalEvents: 4 }];
      return {
        businessDay: "2026-11-06", digestAt: "2026-11-06T01:00:00Z", from: "2026-11-05T01:00:00Z", to: "2026-11-06T01:00:00Z",
        suspended, terminatedResiduals,
        totals: { suspendedIncidents: 1, suspendedCustomers: 1, residualCustomers: 1 }, empty: false,
      };
    },
  };
}
