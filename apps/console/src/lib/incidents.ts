import type { DisplayStatus } from "@alarmops/design-system";
import { SEVERITIES } from "@alarmops/design-system";
import type { IncidentCounts, IncidentListItem, IncidentListQuery } from "./api/types";

/** One definition used on every screen: Escalated = TRIGGERED with an unacked escalation step. */
export function displayStatus(i: Pick<IncidentListItem, "status" | "escalated">): DisplayStatus {
  if (i.status === "TRIGGERED" && i.escalated) return "ESCALATED";
  return i.status;
}

/** "Open" = not resolved (TRIGGERED + ACKNOWLEDGED). Nav badge = open and not acknowledged. */
export const isOpen = (i: Pick<IncidentListItem, "status">) => i.status !== "RESOLVED";
export const needsAck = (i: Pick<IncidentListItem, "status">) => i.status === "TRIGGERED";

/** Default sort (incidents-list.md 미결 제안): unacked first, then severity, then oldest first. */
export function sortIncidents<T extends Pick<IncidentListItem, "status" | "severity" | "triggeredAt">>(items: T[]): T[] {
  const rank = (s: IncidentListItem["status"]) => (s === "TRIGGERED" ? 0 : s === "ACKNOWLEDGED" ? 1 : 2);
  return [...items].sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      a.triggeredAt.localeCompare(b.triggeredAt),
  );
}

/** Applies every filter except `status` (counts are computed on this set, then status narrows the list). */
export function matchesBaseFilters(i: IncidentListItem, q: IncidentListQuery, meContactId?: string): boolean {
  if (q.severity && i.severity !== q.severity) return false;
  if (q.customerId && i.org.customer?.id !== q.customerId) return false;
  if (q.source && i.source !== q.source) return false;
  if (q.unmapped && !i.unmapped) return false;
  if (q.assignee === "me" && i.assignee?.contactId !== meContactId) return false;
  if (q.q) {
    const needle = q.q.toLowerCase();
    const hay = [i.title, i.key, ...i.awsAccountIds, i.org.customer?.name, i.org.project?.name, i.org.service?.name]
      .filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function matchesStatus(i: IncidentListItem, status: IncidentListQuery["status"]): boolean {
  if (!status || status === "open") return isOpen(i);
  return i.status === status;
}

export function computeCounts(base: IncidentListItem[], nowMs: number, muted: number, maintenanceWindows: number): IncidentCounts {
  const trig = base.filter((i) => displayStatus(i) === "TRIGGERED");
  const esc = base.filter((i) => displayStatus(i) === "ESCALATED");
  const ack = base.filter((i) => i.status === "ACKNOWLEDGED");
  const res = base.filter((i) => i.status === "RESOLVED" && i.resolvedAt && nowMs - Date.parse(i.resolvedAt) <= 86_400_000);
  const ackSecs = ack
    .map((i) => (Date.parse(i.acknowledgedAt!) - Date.parse(i.triggeredAt)) / 1000)
    .sort((a, b) => a - b);
  const oldest = trig.map((i) => i.triggeredAt).sort()[0] ?? null;
  const nextEsc = esc.map((i) => i.escalation?.nextAt).filter(Boolean).sort()[0] ?? null;
  return {
    triggered: trig.length,
    escalated: esc.length,
    acknowledged: ack.length,
    resolved24h: res.length,
    muted,
    open: base.filter(isOpen).length,
    meta: {
      triggeredSev1: trig.filter((i) => i.severity === "SEV_1").length,
      oldestTriggeredAt: oldest,
      medianAckSec: ackSecs.length ? ackSecs[Math.floor((ackSecs.length - 1) / 2)]! : null,
      resolvedAuto: res.filter((i) => i.resolvedVia === "AUTO").length,
      resolvedManual: res.filter((i) => i.resolvedVia !== "AUTO").length,
      maintenanceWindows,
      escalatedNext: nextEsc,
    },
  };
}

export function orgChainParts(i: Pick<IncidentListItem, "org">): string[] {
  return [i.org.customer?.name, i.org.project?.name, i.org.service?.name].filter((x): x is string => Boolean(x));
}
