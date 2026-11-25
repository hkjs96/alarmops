/**
 * Mock of API-CONTRACT 8.5 for the Monitoring screens (#139): GET /resources, GET /managed-alarms and
 * POST /resources/{id}/monitoring, with the scope filter (`customer` · `project` · `service` · `mine`) and `outside`.
 *
 * Deterministic switches (the real API has none of these):
 *   a resource whose id ends in `_503`  → POST answers 503 COMMANDS_UNAVAILABLE
 *   `tag_on` on an account without TagWriter → 403 CAPABILITY_DISABLED
 *   `keep` → 409 NOT_SUPPORTED; `stop` outside NEEDS_REVIEW, `tag_on` outside NEEDS_REVIEW / NOT_MONITORED → 409 INVALID_TRANSITION
 *   `stop` on an account without AlarmWriter → 403 CAPABILITY_DISABLED (details.role alarmWriter)
 *   `stop` is queued; the "engine" deletes the alarms ENGINE_DELAY_MS later (the next list shows NOT_MONITORED)
 */
import { ApiError, type ConsoleApi } from "../client";
import type { AlarmState, ManagedAlarmItem, MonitoringState, OrgChain, ResourceItem, Role, Severity } from "../types";
import type { FxCustomer } from "./scope-fixtures";
import { isSlug } from "../../validate";
import { MOCK_NOW } from "./fixtures";

export const STOP_DELAY_MS = 20_000;
type MonitoringApi = Pick<ConsoleApi, "listResources" | "listManagedAlarms" | "setMonitoring">;

interface FxResource extends ResourceItem { stopAt?: number }
export interface MonitoringStore { resources: FxResource[]; alarms: ManagedAlarmItem[]; seq: number }

const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000", "");

/** [id, name, type, region, customer/project/service slugs, state, reason, hours since review, alarms, tagWriter] */
type Def = [string, string, string, string, [string, string, string], MonitoringState, string | null, number, number, boolean];
const DEFS: Def[] = [
  ["res_pay_api", "payments-api-prod", "EC2", "ap-northeast-2", ["mirae", "core", "payments-api"], "MONITORED", null, 0, 4, true],
  ["res_pay_db", "payments-db-prod", "RDS", "ap-northeast-2", ["mirae", "core", "payments-api"], "MONITORED", null, 0, 5, true],
  ["res_settle_q", "settlement-queue", "SQS", "ap-northeast-2", ["mirae", "core", "settlement"], "MONITORED", null, 0, 2, true],
  ["res_checkout_alb", "checkout-alb", "ALB", "ap-northeast-2", ["mirae", "core", "checkout"], "NEEDS_REVIEW", "tag_removed", 6, 3, true],
  ["res_ledger_db", "ledger-db", "RDS", "ap-northeast-2", ["mirae", "data-platform", "ledger"], "NEEDS_REVIEW", "tag_removed", 52, 5, false],
  ["res_merchant_web", "merchant-portal-web", "EC2", "ap-northeast-2", ["mirae", "merchant", "merchant-portal"], "MONITORED", null, 0, 3, true],
  ["res_daon_search", "search-opensearch", "OpenSearch", "ap-northeast-2", ["daon", "commerce", "search"], "NEEDS_REVIEW", "tag_unreadable", 3, 2, true],
  ["res_daon_eks", "eks-prod-nodes", "EKS", "ap-northeast-2", ["daon", "platform", "eks-prod"], "MONITORED", null, 0, 6, true],
  ["res_hanbit_api", "tracking-public-api", "Lambda", "ap-northeast-2", ["hanbit", "tracking", "public-api"], "MONITORED", null, 0, 2, true],
  ["res_hanbit_batch", "batch-worker", "EC2", "ap-northeast-1", ["hanbit", "ops", "batch"], "NOT_MONITORED", null, 0, 0, true],
  ["res_ara_game", "game-api-fleet", "EC2", "ap-northeast-2", ["ara", "live-ops", "game-api"], "MONITORED", null, 0, 4, true],
  ["res_ara_cache", "matchmaking-cache", "ElastiCache", "ap-northeast-2", ["ara", "live-ops", "matchmaking"], "NEEDS_REVIEW", "tag_removed", 30, 2, true],
];
const METRICS: Record<string, [string, number, string][]> = {
  EC2: [["CPUUtilization", 80, "%"], ["StatusCheckFailed", 1, ""], ["mem_used_percent", 85, "%"], ["disk_used_percent", 90, "%"]],
  RDS: [["CPUUtilization", 80, "%"], ["FreeStorageSpace", 10, "GB"], ["DatabaseConnections", 400, ""], ["FreeableMemory", 512, "MB"], ["ReplicaLag", 30, "s"]],
  SQS: [["ApproximateAgeOfOldestMessage", 600, "s"], ["ApproximateNumberOfMessagesVisible", 1000, ""]],
  ALB: [["HTTPCode_ELB_5XX_Count", 20, ""], ["TargetResponseTime", 2, "s"], ["UnHealthyHostCount", 1, ""]],
  OpenSearch: [["ClusterStatus.red", 1, ""], ["FreeStorageSpace", 20, "GB"]],
  EKS: [["node_cpu_utilization", 80, "%"], ["node_memory_utilization", 85, "%"], ["pod_restarts", 5, ""], ["node_not_ready", 1, ""], ["disk_utilization", 90, "%"], ["network_errors", 10, ""]],
  Lambda: [["Errors", 5, ""], ["Throttles", 1, ""]],
  ElastiCache: [["CPUUtilization", 75, "%"], ["Evictions", 100, ""]],
};
const SEVS: Severity[] = ["SEV_2", "SEV_3", "SEV_3", "SEV_4", "SEV_2", "SEV_1"];
const SOURCES = ["CODE", "MSP", "CUSTOMER", "CONSOLE", "TAG"] as const;
/** which alarms are in ALARM at the start: a few, spread over the customers */
const IN_ALARM = new Set(["res_pay_db:0", "res_checkout_alb:0", "res_ledger_db:2", "res_daon_eks:1", "res_ara_game:0"]);

export function createMonitoringStore(customers: FxCustomer[]): MonitoringStore {
  const now = Date.parse(MOCK_NOW);
  const chain = (path: [string, string, string]): OrgChain => {
    const c = customers.find((k) => k.slug === path[0]);
    const p = c?.projects.find((k) => k.slug === path[1]);
    const s = p?.services.find((k) => k.slug === path[2]);
    return {
      customer: c ? { id: c.id, name: c.name, slug: c.slug } : null, project: p ? { id: p.id, name: p.name, slug: p.slug } : null, service: s ? { id: s.id, name: s.name, slug: s.slug } : null,
    };
  };
  const resources: FxResource[] = DEFS.map(([id, name, type, region, path, state, reason, hours, alarms, tw], n) => ({
    id, name, resourceKey: `arn:aws:${type.toLowerCase()}:${region}:${100000000000 + n * 7}:${name}`, resourceType: type, region,
    account: { id: `acc_${path[0]}`, awsAccountId: String(100000000000 + n * 7).padStart(12, "0"), alias: `${path[0]}-prd`, alarmWriterEnabled: n !== 6, tagWriterEnabled: tw },
    org: chain(path), monitoringState: state, needsReviewSince: state === "NEEDS_REVIEW" ? iso(now - hours * HOUR) : null, needsReviewReason: reason,
    alarmCount: alarms, lastSeenAt: iso(now - (n + 1) * 6 * 60_000),
  }));
  const alarms: ManagedAlarmItem[] = resources.flatMap((r) =>
    (METRICS[r.resourceType] ?? []).slice(0, r.alarmCount).map((m, i): ManagedAlarmItem => ({
      id: `al_${r.id}_${i}`, resourceId: r.id, resourceName: r.name, resourceType: r.resourceType, metricKey: m[0], threshold: m[1], 
      thresholdSource: SOURCES[(i + r.name.length) % SOURCES.length]!, severity: SEVS[(i + r.name.length) % SEVS.length]!,
      state: (IN_ALARM.has(`${r.id}:${i}`) ? "ALARM" : i === 3 && r.monitoringState === "MONITORED" ? "INSUFFICIENT_DATA" : "OK") as AlarmState, org: r.org,
    })),
  );
  return { resources, alarms, seq: 0 };
}

interface Ctx { store: MonitoringStore; customers: FxCustomer[]; me: { role: Role; kind?: "INTERNAL" | "CUSTOMER" }; mineIds: () => Set<string>; need: (r: Role) => void; err: (status: number, code: string, message: string, details?: Record<string, unknown>) => ApiError }

export function createMonitoringApi(x: Ctx): MonitoringApi {
  const s = x.store;
  const notFound = () => x.err(404, "NOT_FOUND", "Not found.");
  /** the engine deletes the alarms of a stopped resource a little later: settle what is due, whenever a list is read */
  const settle = () => {
    for (const r of s.resources) {
      if (r.stopAt !== undefined && r.stopAt <= Date.now()) {
        r.monitoringState = "NOT_MONITORED"; r.needsReviewSince = null; r.needsReviewReason = null; r.alarmCount = 0; delete r.stopAt;
        s.alarms = s.alarms.filter((a) => a.resourceId !== r.id);
      }
    }
  };
  type Scope = { customer?: string; project?: string; service?: string; mine?: boolean };
  /** unknown slug → 404, same as a slug out of range (API-CONTRACT 8.0) */
  function scoped(q: Scope): (org: OrgChain) => boolean {
    for (const [k, v] of Object.entries({ customer: q.customer, project: q.project, service: q.service })) if (v !== undefined && !isSlug(v)) throw x.err(400, "VALIDATION_FAILED", `${k} is not a slug.`, { fields: [{ field: k, message: "not a slug" }] });
    if ((q.project && !q.customer) || (q.service && !q.project)) throw x.err(400, "VALIDATION_FAILED", "project needs customer, service needs project.");
    if (q.customer) {
      const c = x.customers.find((k) => k.slug === q.customer);
      const p = q.project ? c?.projects.find((k) => k.slug === q.project) : undefined;
      const v = q.service ? p?.services.find((k) => k.slug === q.service) : undefined;
      if (!c || (q.project && !p) || (q.service && !v)) throw notFound();
      return (o) => o.customer?.slug === q.customer && (!q.project || o.project?.slug === q.project) && (!q.service || o.service?.slug === q.service);
    }
    if (q.mine) { const ids = x.mineIds(); return (o) => o.customer !== null && ids.has(o.customer.id); }
    return () => true;
  }
  const filtered = (q: Scope) => Boolean(q.customer || q.mine);
  const outsideOf = (q: Scope, inView: (o: OrgChain) => boolean) =>
    filtered(q)
      ? {
          needsReview: s.resources.filter((r) => r.monitoringState === "NEEDS_REVIEW" && !inView(r.org)).length,
          inAlarm: s.alarms.filter((a) => a.state === "ALARM" && !inView(a.org)).length,
        }
      : null;
  const page = <T,>(rows: T[], limit = 200) => ({ items: structuredClone(rows.slice(0, limit)), nextCursor: rows.length > limit ? "next" : null });
  const strip = (r: FxResource): ResourceItem => { const { stopAt: _s, ...rest } = r; void _s; return rest; };

  return {
    async listResources(q = {}) {
      settle();
      const inView = scoped(q);
      const rows = s.resources.filter((r) => inView(r.org) && (!q.type || r.resourceType === q.type) && (!q.monitoringState || r.monitoringState === q.monitoringState)).map(strip);
      return { ...page(rows, q.limit), outside: outsideOf(q, inView) };
    },
    async listManagedAlarms(q = {}) {
      settle();
      const inView = scoped(q);
      return { ...page(s.alarms.filter((a) => inView(a.org) && (!q.type || a.resourceType === q.type)), q.limit), outside: outsideOf(q, inView) };
    },
    async setMonitoring(id, action) {
      x.need("OPERATOR");
      if (x.me.kind === "CUSTOMER") throw notFound();
      settle();
      const r = s.resources.find((k) => k.id === id);
      if (!r) throw notFound();
      if (action === "keep") throw x.err(409, "NOT_SUPPORTED", "keep has no command in the engine.");
      const okState = action === "stop" ? r.monitoringState === "NEEDS_REVIEW" : r.monitoringState === "NEEDS_REVIEW" || r.monitoringState === "NOT_MONITORED";
      if (!okState || r.stopAt !== undefined) throw x.err(409, "INVALID_TRANSITION", "This resource is not in a state that allows this.");
      if (action === "tag_on" && !r.account?.tagWriterEnabled) throw x.err(403, "CAPABILITY_DISABLED", "TagWriter is not enabled for this account.", { role: "tagWriter" });
      if (action === "stop" && !r.account?.alarmWriterEnabled) throw x.err(403, "CAPABILITY_DISABLED", "AlarmWriter is not enabled for this account.", { role: "alarmWriter" });
      if (id.endsWith("_503")) throw x.err(503, "COMMANDS_UNAVAILABLE", "The command queue is not configured.");
      if (action === "stop") r.stopAt = Date.now() + STOP_DELAY_MS;
      else { r.monitoringState = "MONITORED"; r.needsReviewSince = null; r.needsReviewReason = null; }
      return { commandId: `cmd_${++s.seq}`, status: "queued" as const };
    },
  };
}
