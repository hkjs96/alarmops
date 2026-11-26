/**
 * Pure helpers of the Monitoring screens (no server-only import: pages, client tables and unit tests share them).
 * Words follow docs/ui/screens/monitoring.md; error sentences are written like lib/onboarding.ts: what was not done,
 * and what to do next.
 */
import type { ManagedAlarmItem, MonitoringAction, ResourceItem } from "./api/types";
import { errorLine, type Failure } from "./errors";

export const MONITORING_TABS = [
  { key: "alarms", label: "Alarms", href: "/monitoring/alarms" },
  { key: "resources", label: "Resources", href: "/monitoring/resources" },
  { key: "needs-review", label: "Needs review", href: "/monitoring/needs-review" },
  { key: "coverage-gaps", label: "Coverage gaps", href: "/monitoring/coverage-gaps" },
  { key: "sync-runs", label: "Sync runs", href: "/monitoring/sync-runs" },
] as const;
export type MonitoringTab = (typeof MONITORING_TABS)[number]["key"];

/** The list is one page of at most this many rows; a bigger fleet shows "n+" instead of a wrong exact number. */
export const LIST_LIMIT = 200;

/**
 * One definition per number, used by every tab (the tiles, the tab counts, the chip):
 *   Monitored        = resources in state MONITORED
 *   Needs review     = resources in state NEEDS_REVIEW (D-16)
 *   Alarms in ALARM  = managed alarms whose state is ALARM
 */
export function monitoringStats(resources: readonly ResourceItem[], alarms: readonly ManagedAlarmItem[]) {
  return {
    monitored: resources.filter((r) => r.monitoringState === "MONITORED").length,
    needsReview: resources.filter((r) => r.monitoringState === "NEEDS_REVIEW").length,
    inAlarm: alarms.filter((a) => a.state === "ALARM").length,
  };
}

/** "Outside this view: 2 need review · 3 in alarm" (D-33) */
export function outsideText(o: { needsReview: number; inAlarm: number }): string {
  return `Outside this view: ${o.needsReview} need review · ${o.inAlarm} in alarm`;
}

const REASON: Record<string, string> = {
  tag_removed: "Monitoring tag was removed",
  tag_unreadable: "Tags could not be read",
};
export const reasonText = (r: string | null): string => (r ? (REASON[r] ?? r.replace(/_/g, " ")) : "—");

/** Re-tag writes the Monitoring tag, which needs the account's TagWriter role (D-07, D-16). Missing information = off. */
export const canRetag = (r: Pick<ResourceItem, "account">): boolean => r.account?.tagWriterEnabled === true;

/** Stop deletes the resource's alarms, which needs the account's AlarmWriter role. Missing information = off. */
export const canStop = (r: Pick<ResourceItem, "account">): boolean => r.account?.alarmWriterEnabled === true;

export const stopPrompt = (r: Pick<ResourceItem, "name" | "alarmCount">): string => `Delete ${r.alarmCount} alarm${r.alarmCount === 1 ? "" : "s"} for ${r.name}? This cannot be undone.`;

const DONE: Record<MonitoringAction, string> = { stop: "Stop queued", keep: "Kept", tag_on: "Re-tag queued" };
export const doneText = (a: MonitoringAction): string => DONE[a];

/** The line shown when a monitoring command was refused. 403, 409 and 503 get a sentence a person can act on. */
export function monitoringError(f: Failure, action: MonitoringAction, name: string): string {
  const what = action === "stop" ? `Monitoring of ${name} was not stopped` : action === "keep" ? `${name} was not kept` : `${name} was not re-tagged`;
  switch (f.code) {
    case "CAPABILITY_DISABLED": {
      const role = f.details?.role === "alarmWriter" ? "AlarmWriter" : f.details?.role === "tagWriter" ? "TagWriter" : action === "tag_on" ? "TagWriter" : action === "stop" ? "AlarmWriter" : "required";
      return `${what}. The ${role} role is not enabled for this AWS account. Enable it under Customers › Onboarding, then try again.`;
    }
    case "ACCOUNT_DISABLED":
      return `${what}. This customer or AWS account is no longer active, so nothing can be changed for it. Check the customer’s status under Customers.`;
    case "NOT_SUPPORTED": return `${what}. Keeping a resource under review is not available yet.`;
    case "ROLE_REQUIRED": case "FORBIDDEN": case "READ_ONLY":
      return `${what}. Changing monitoring needs the Operator role.`;
    case "COMMANDS_UNAVAILABLE": return `${what}. The command queue is not available yet, so nothing was changed. Ask whoever manages the console’s deployment.`;
    case "COMMAND_PUBLISH_FAILED": return `${what}. The request could not be queued. Try again in a moment.`;
    case "INVALID_TRANSITION": case "VERSION_CONFLICT": case "CONFLICT":
      return `${what}. Someone already handled ${name}, or it no longer needs review. Reload the list to see how it is now.`;
    case "SESSION_ENDED": case "UNAUTHENTICATED": case "UNAUTHORIZED": case "NO_ANSWER": return errorLine(f);
    case "NOT_FOUND": return `${what}. It may have been removed, or you may not have access to it.`;
  }
  return `${what}. ${errorLine(f)}`;
}
