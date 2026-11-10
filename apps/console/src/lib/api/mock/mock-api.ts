import { ApiError, type ConsoleApi } from "../client";
import type { AckResult, BulkItem, BulkResult, IncidentDetail, IncidentEvent, IncidentListItem, IncidentListQuery, IncidentStatus, ScopeTreeResponse } from "../types";
import { computeCounts, isOpen, matchesBaseFilters, matchesStatus, outsideCounts, sortIncidents } from "../../incidents";
import { isSlug } from "../../validate";
import * as fx from "./fixtures";
import { customers14, customers34, type FxCustomer } from "./scope-fixtures";

interface Store {
  customers: FxCustomer[];
  incidents: IncidentListItem[];
  timelines: Record<string, IncidentEvent[]>;
  undo: Map<string, { snapshot: IncidentListItem[]; exp: number }>;
}

const ME = { id: "usr_haeun", contactId: "ct_haeun", name: "Haeun Kim", email: "haeun@msp.example", role: "OPERATOR" as const };

/** `customers: 34` adds the 20 extra customers of the mockup's "34 customers" toggle. */
export function createStore(opts: { customers?: 14 | 34 } = {}): Store {
  return {
    customers: opts.customers === 34 ? customers34 : customers14,
    incidents: structuredClone([...fx.openIncidents, ...fx.resolvedIncidents]),
    timelines: structuredClone(fx.timelines),
    undo: new Map(),
  };
}

let reqSeq = 0;
const notFound = () => new ApiError(404, "NOT_FOUND", "Not found.", `req_mock_${++reqSeq}`);

/**
 * In-memory implementation of ConsoleApi with contract semantics:
 * counts on the same filter basis, If-Match version checks (409 VERSION_CONFLICT),
 * bulk preview → execute → undoToken (5 min).
 */
export function createMockApi(store: Store = createStore(), clock: () => number = () => Date.parse(fx.MOCK_NOW)): ConsoleApi {
  const find = (id: string) => store.incidents.find((i) => i.id === id);
  const nowIso = () => new Date(clock()).toISOString().replace(".000", "");

  /**
   * Scope filter → predicate. Unknown slugs are 404 with the same body as an unknown incident, so a link to a
   * customer the user may not see is indistinguishable from a link to nothing.
   */
  function scopeOf(q: IncidentListQuery): { active: boolean; inView: (i: IncidentListItem) => boolean; customerIds: Set<string> | null } {
    if (q.customer === undefined) {
      if (q.project !== undefined || q.service !== undefined) throw notFound();
      if (!q.mine) return { active: false, inView: () => true, customerIds: null };
      const ids = new Set(store.customers.filter((c) => c.mine).map((c) => c.id));
      // unmapped accounts belong to nobody, so they stay visible in "My customers"
      return { active: true, inView: (i) => i.unmapped || (i.org.customer !== null && ids.has(i.org.customer.id)), customerIds: ids };
    }
    if (![q.customer, q.project, q.service].every((v) => v === undefined || isSlug(v))) throw notFound();
    const c = store.customers.find((x) => x.slug === q.customer);
    const p = q.project === undefined ? undefined : c?.projects.find((x) => x.slug === q.project);
    const s = q.service === undefined ? undefined : p?.services.find((x) => x.slug === q.service);
    if (!c || (q.project !== undefined && !p) || (q.service !== undefined && !s)) throw notFound();
    return {
      active: true, customerIds: new Set([c.id]),
      inView: (i) => i.org.customer?.id === c.id && (!p || i.org.project?.id === p.id) && (!s || i.org.service?.id === s.id),
    };
  }

  function detail(i: IncidentListItem): IncidentDetail {
    const extra: Omit<IncidentDetail, keyof IncidentListItem> =
      i.id === fx.openIncidents[0]!.id
        ? fx.paymentsDetailExtra
        : {
            alerts: [], assignmentSnapshot: null, why: null, suppression: [], remediation: null,
            rcaPlaceholder: { availableAfterPoc: true },
            details: { source: i.source === "CLOUDWATCH" ? "CloudWatch" : i.source === "PROMETHEUS" ? "Prometheus" : "Grafana", resource: i.title.split(" ")[0]!, alarm: i.title },
            paged: [], notificationCount: (fx.notifications[i.id] ?? []).length,
          };
    return structuredClone({ ...i, ...extra });
  }

  function transition(i: IncidentListItem, to: IncidentStatus) {
    if (to === "ACKNOWLEDGED" && i.status !== "TRIGGERED") throw new ApiError(409, "INVALID_TRANSITION", "Incident is not triggered.", `req_mock_${++reqSeq}`);
    if (to === "RESOLVED" && i.status === "RESOLVED") throw new ApiError(409, "INVALID_TRANSITION", "Incident is already resolved.", `req_mock_${++reqSeq}`);
    const at = nowIso();
    i.status = to;
    i.escalated = false;
    i.version += 1;
    if (to === "ACKNOWLEDGED") {
      i.acknowledgedAt = at;
      i.acknowledgedBy = { contactId: ME.contactId, name: ME.name };
      i.assigneeNote = `ack'd ${new Date(clock() + 9 * 3600_000).toISOString().slice(11, 16)}`;
      if (i.escalation) i.escalation = { ...i.escalation, nextAt: null, doneAt: at, summary: "stopped" };
    } else {
      i.resolvedAt = at;
      i.resolvedVia = "MANUAL";
      i.escalation = null;
    }
    (store.timelines[i.id] ??= []).unshift({
      id: `ev_${i.version}_${to}`, at, kind: to === "ACKNOWLEDGED" ? "ACKED" : "RESOLVED", actorType: "USER", actorId: ME.id,
      message: `${to === "ACKNOWLEDGED" ? "Acknowledged" : "Resolved"} by ${ME.name}`,
    });
  }

  /** undo token for a single ack or a bulk run: 5 minutes */
  function remember(snapshot: IncidentListItem[]): string {
    const undoToken = `undo_${++reqSeq}`;
    store.undo.set(undoToken, { snapshot, exp: clock() + 5 * 60_000 });
    return undoToken;
  }

  function checkVersion(i: IncidentListItem, version: number) {
    if (i.version !== version) throw new ApiError(409, "VERSION_CONFLICT", "Incident was updated by someone else.", `req_mock_${++reqSeq}`);
  }

  return {
    async me() { return { id: ME.id, name: ME.name, email: ME.email, role: ME.role }; },
    async listIncidents(q = {}) {
      const scope = scopeOf(q);
      const base = store.incidents.filter((i) => scope.inView(i) && matchesBaseFilters(i, q, ME.contactId));
      const muted = fx.mutedAlerts.filter((m) => (!q.customerId || m.customerId === q.customerId) && (!scope.customerIds || scope.customerIds.has(m.customerId))
        && (!q.project && !q.service) && (!q.severity || m.severity === q.severity));
      const counts = computeCounts(base, clock(), q.unmapped || q.assignee || q.source || q.q ? 0 : muted.length, new Set(muted.map((m) => m.windowId)).size);
      const items = sortIncidents(base.filter((i) => matchesStatus(i, q.status)));
      const limit = Math.min(q.limit ?? 50, 200);
      const start = q.cursor ? Number(q.cursor) : 0;
      const page = items.slice(start, start + limit);
      const unmapped = q.customerId || q.customer ? [] : fx.unmappedAccounts;
      const outside = scope.active ? outsideCounts(store.incidents, scope.inView) : null;
      return { items: structuredClone(page), nextCursor: start + limit < items.length ? String(start + limit) : null, counts, unmapped, outside };
    },
    async getIncident(id) {
      const i = find(id);
      if (!i) throw notFound();
      return detail(i);
    },
    async getTimeline(id) {
      if (!find(id)) throw notFound();
      return { items: structuredClone(store.timelines[id] ?? []), nextCursor: null };
    },
    async getNotifications(id) {
      if (!find(id)) throw notFound();
      return { items: structuredClone(fx.notifications[id] ?? []), nextCursor: null };
    },
    async ack(id, version): Promise<AckResult> {
      const i = find(id);
      if (!i) throw notFound();
      checkVersion(i, version);
      const snapshot = [structuredClone(i)];
      transition(i, "ACKNOWLEDGED");
      return { incident: detail(i), undoToken: remember(snapshot) };
    },
    async resolve(id, version) {
      const i = find(id);
      if (!i) throw notFound();
      checkVersion(i, version);
      transition(i, "RESOLVED");
      return detail(i);
    },
    async escalate(id, version) {
      const i = find(id);
      if (!i) throw notFound();
      checkVersion(i, version);
      if (i.status !== "TRIGGERED" || !i.escalation) throw new ApiError(409, "INVALID_TRANSITION", "Nothing to escalate.", `req_mock_${++reqSeq}`);
      i.escalated = true;
      i.version += 1;
      i.escalation = { ...i.escalation, step: Math.min(i.escalation.step + 1, i.escalation.totalSteps - 1) };
      return detail(i);
    },
    async bulkPreview(action, items: BulkItem[]) {
      const targets = [];
      const skipped = [];
      for (const { id, version } of items) {
        const i = find(id);
        if (!i) { skipped.push({ id, reason: "Not found" }); continue; }
        if (i.version !== version) { skipped.push({ id, reason: "Changed since you loaded the list" }); continue; }
        const ok = action === "ack" ? i.status === "TRIGGERED" : i.status !== "RESOLVED";
        if (ok) targets.push({ id: i.id, key: i.key, title: i.title, status: i.status });
        else skipped.push({ id, reason: action === "ack" ? "Already acknowledged" : "Already resolved" });
      }
      return { action, targets, skipped };
    },
    async bulkExecute(action, items: BulkItem[]): Promise<BulkResult> {
      // a version that moved on is skipped and reported; the rest runs (API-CONTRACT §8.1)
      const done: IncidentListItem[] = [];
      const conflicts: BulkResult["conflicts"] = [];
      for (const { id, version } of items) {
        const i = find(id);
        if (!i) conflicts.push({ id, code: "NOT_FOUND" });
        else if (i.version !== version) conflicts.push({ id, code: "VERSION_CONFLICT" });
        else if (action === "ack" ? i.status !== "TRIGGERED" : i.status === "RESOLVED") conflicts.push({ id, code: "INVALID_TRANSITION" });
        else done.push(i);
      }
      const snapshot = structuredClone(done);
      for (const i of done) transition(i, action === "ack" ? "ACKNOWLEDGED" : "RESOLVED");
      return { done: done.map((i) => i.id), conflicts, undoToken: remember(snapshot) };
    },
    async bulkUndo(undoToken) {
      const u = store.undo.get(undoToken);
      if (!u || u.exp < clock()) throw new ApiError(409, "INVALID_TRANSITION", "Undo window has expired.", `req_mock_${++reqSeq}`);
      store.undo.delete(undoToken);
      for (const snap of u.snapshot) {
        const idx = store.incidents.findIndex((i) => i.id === snap.id);
        if (idx >= 0) store.incidents[idx] = { ...snap, version: store.incidents[idx]!.version + 1 };
        const tl = store.timelines[snap.id];
        if (tl?.[0] && (tl[0].kind === "ACKED" || tl[0].kind === "RESOLVED") && tl[0].actorId === ME.id) tl.shift();
      }
      return { restored: u.snapshot.map((s) => s.id) };
    },
    async oncallNow() { return structuredClone(fx.oncallNow); },
    async scopeTree(): Promise<ScopeTreeResponse> {
      const open = store.incidents.filter(isOpen);
      const n = (f: (i: IncidentListItem) => boolean) => open.filter(f).length;
      return {
        customers: store.customers.map((c) => ({
          id: c.id, slug: c.slug, name: c.name, mine: c.mine, callHealth: c.callHealth,
          openIncidents: n((i) => i.org.customer?.id === c.id),
          projects: c.projects.map((p) => ({
            id: p.id, slug: p.slug, name: p.name, ownSteps: p.ownSteps,
            openIncidents: n((i) => i.org.project?.id === p.id),
            services: p.services.map((v) => ({ id: v.id, slug: v.slug, name: v.name, ownSteps: v.ownSteps, openIncidents: n((i) => i.org.service?.id === v.id) })),
          })),
        })),
      };
    },
  };
}
