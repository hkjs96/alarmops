import type { IncidentListQuery, Severity, AlertSource } from "./api/types";
import { SEVERITIES } from "@alarmops/design-system";
import { parseScopeParams } from "./scope";

export type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export function parseQuery(sp: SP): IncidentListQuery {
  const status = one(sp.status);
  const { sel } = parseScopeParams(sp);
  return {
    customer: sel.customer,
    project: sel.project,
    service: sel.service,
    mine: sel.mine || undefined,
    status: status === "ACKNOWLEDGED" || status === "RESOLVED" ? status : "active",
    severity: SEVERITIES.includes(one(sp.severity) as Severity) ? (one(sp.severity) as Severity) : undefined,
    source: (["CLOUDWATCH", "PROMETHEUS", "GRAFANA"] as const).find((x) => x === one(sp.source)) as AlertSource | undefined,
    assignee: one(sp.assignee) === "me" ? "me" : undefined,
    customerId: one(sp.customerId),
    q: one(sp.q),
  };
}

