/**
 * Mock of API-CONTRACT 8.4 (D-42, D-43, D-45): customer status and the offboarding checklist, with the contract's
 * errors. packages/api/src/customerApi.ts is the reference for every rule here.
 *
 * Fixed customers of the mock (the e2e specs rely on them):
 *   eden   SUSPENDED          (has a not-paged incident)
 *   iruda  TERMINATED         (checklist half done, events still arriving)
 *   dasol  terminating it answers 503 COMMANDS_UNAVAILABLE (the command queue is not configured), status unchanged
 *   all others ACTIVE.
 */
import { ApiError, type ConsoleApi } from "../client";
import type {
  CustomerStatusValue, IncidentListItem, Offboarding, OffboardStep, OffboardStepKey, Role,
} from "../types";
import type { FxCustomer } from "./scope-fixtures";

export interface StatusRow { status: CustomerStatusValue; changedAt: string | null; version: number }
export interface StatusStore { status: Record<string, StatusRow>; offboarding: Record<string, Offboarding> }

export const NO_COMMAND_QUEUE = new Set(["cus_dasol"]);
const STEP_KEYS: OffboardStepKey[] = ["PAGING_STOPPED", "ALARMS_DELETED", "CUSTOMER_STACK_REMOVED", "ACCOUNTS_DISABLED", "BUS_ALLOWLIST_REMOVED"];

export function createStatusStore(): StatusStore {
  return {
    status: {
      cus_eden: { status: "SUSPENDED", changedAt: "2026-11-05T01:00:00Z", version: 1 },
      cus_iruda: { status: "TERMINATED", changedAt: "2026-11-06T02:30:00Z", version: 1 },
    },
    offboarding: {
      cus_iruda: {
        id: "off_iruda", startedAt: "2026-11-06T02:30:00Z", completedAt: null, reason: "Contract ended on Nov 5.",
        steps: [
          { key: "PAGING_STOPPED", state: "DONE", at: "2026-11-06T02:30:00Z" },
          { key: "ALARMS_DELETED", state: "MANUAL", detail: "CAPABILITY_DISABLED: 481220935017 (the account has no AlarmWriter role, so its alarms were not deleted)" },
          { key: "CUSTOMER_STACK_REMOVED", state: "MANUAL" },
          { key: "ACCOUNTS_DISABLED", state: "DONE", at: "2026-11-06T02:31:00Z" },
          { key: "BUS_ALLOWLIST_REMOVED", state: "MANUAL" },
        ],
        residual: { count: 4, lastEventAt: "2026-11-08T17:40:00Z" },
      },
    },
  };
}

interface Ctx {
  store: StatusStore;
  customers: FxCustomer[];
  incidents: () => IncidentListItem[];
  me: { id: string; role: Role };
  /** a portal user: these routes do not exist for them (404) */
  portal?: boolean;
  now: () => string;
  need: (role: Role) => void;
  err: (status: number, code: string, message: string, details?: Record<string, unknown>) => ApiError;
}

type StatusApi = Pick<ConsoleApi, "getCustomerStatus" | "patchCustomerStatus" | "getOffboarding" | "markOffboardStep">;

export function createStatusApi(x: Ctx): StatusApi {
  const customer = (id: string) => {
    if (x.portal) throw x.err(404, "NOT_FOUND", "Not found.");
    const c = x.customers.find((k) => k.id === id);
    if (!c) throw x.err(404, "NOT_FOUND", "Not found.");
    return c;
  };
  const row = (id: string): StatusRow => (x.store.status[id] ??= { status: "ACTIVE", changedAt: null, version: 0 });
  const invalid = (field: string, message: string) => x.err(400, "VALIDATION_FAILED", message, { fields: [{ field, message }] });
  const view = (r: StatusRow) => ({ status: r.status, statusChangedAt: r.changedAt, version: r.version });
  const offView = (o: Offboarding): Offboarding => structuredClone(o);

  return {
    async getCustomerStatus(id) {
      customer(id);
      x.need("ADMIN");
      return view(row(id));
    },
    async patchCustomerStatus(id, b, version) {
      const c = customer(id);
      x.need("ADMIN");
      const reason = (b.reason ?? "").trim();
      if (!reason) throw invalid("reason", "reason is required.");
      if (reason.length > 500) throw invalid("reason", "reason is at most 500 characters.");
      if (b.status === "TERMINATED" && (b.confirmName ?? "").trim() !== c.name) throw invalid("confirmName", "confirmName must be the exact customer name to terminate.");
      const cur = row(id);
      if (cur.version !== version) throw x.err(409, "VERSION_CONFLICT", "The customer status was changed by someone else.", { currentVersion: cur.version });
      if (cur.status === "TERMINATED" && b.status !== "TERMINATED") throw x.err(409, "CUSTOMER_TERMINATED", "A terminated customer cannot change status. Connect it again as a new customer.");
      if (cur.status === b.status) return { ...view(cur), ...(x.store.offboarding[id] ? { offboardingId: x.store.offboarding[id]!.id } : {}) };
      if (b.status === "TERMINATED" && NO_COMMAND_QUEUE.has(id)) throw x.err(503, "COMMANDS_UNAVAILABLE", "The command queue is not configured; the customer was not terminated.");
      const at = x.now();
      cur.status = b.status; cur.changedAt = at; cur.version += 1;
      if (b.status !== "ACTIVE") {
        // the tick marks the open incidents of a customer that is not ACTIVE; they stay marked after it returns (D-43)
        for (const i of x.incidents()) {
          if (i.org.customer?.id === id && i.status !== "RESOLVED" && !i.pagingSuppressed) i.pagingSuppressed = b.status === "SUSPENDED" ? "CUSTOMER_SUSPENDED" : "CUSTOMER_TERMINATED";
        }
      }
      if (b.status === "TERMINATED") {
        const steps: OffboardStep[] = STEP_KEYS.map((key) => (key === "PAGING_STOPPED" ? { key, state: "DONE" as const, at } : { key, state: key === "ALARMS_DELETED" ? "PENDING" as const : "MANUAL" as const }));
        x.store.offboarding[id] = { id: `off_${c.slug}`, startedAt: at, completedAt: null, reason, steps, residual: { count: 0 } };
        return { ...view(cur), offboardingId: `off_${c.slug}`, commandsSent: 1 };
      }
      return view(cur);
    },
    async getOffboarding(id) {
      customer(id);
      x.need("ADMIN");
      const o = x.store.offboarding[id];
      if (!o) throw x.err(404, "NOT_FOUND", "Not found.");
      return offView(o);
    },
    async markOffboardStep(id, b) {
      customer(id);
      x.need("ADMIN");
      const o = x.store.offboarding[id];
      if (!o) throw x.err(404, "NOT_FOUND", "Not found.");
      if (!STEP_KEYS.includes(b.key)) throw invalid("key", `key must be one of ${STEP_KEYS.join(", ")}.`);
      if (b.state !== "DONE") throw invalid("state", "state must be DONE.");
      if (b.detail !== undefined && b.detail.length > 500) throw invalid("detail", "detail must be text of at most 500 characters.");
      const step = o.steps.find((s) => s.key === b.key)!;
      const human = b.detail?.trim() || "";
      if (b.key === "ALARMS_DELETED" && step.state === "PENDING") throw x.err(409, "STEP_NOT_MANUAL", "ALARMS_DELETED is set by the alarm engine; it can be marked only when it needs a person (MANUAL).");
      if (b.key === "ALARMS_DELETED" && step.state === "MANUAL" && !human) throw invalid("detail", "Say what you checked: detail is required to close a failed ALARMS_DELETED step.");
      if (step.state !== "DONE") {
        step.state = "DONE"; step.at = x.now(); step.byUserId = x.me.id;
        if (human) step.detail = human;
        if (o.steps.every((s) => s.state === "DONE")) o.completedAt = x.now();
      }
      return offView(o);
    },
  };
}
