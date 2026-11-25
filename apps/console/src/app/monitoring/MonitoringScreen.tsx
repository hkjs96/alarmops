import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, EmptyState, Mark, cx } from "@alarmops/design-system";
import { getApi, nowMs } from "@/lib/api";
import { ApiError, isHidden } from "@/lib/api/client";
import type { ManagedAlarmItem, MonitoringOutside, ResourceItem } from "@/lib/api/types";
import { errorLine } from "@/lib/errors";
import { LIST_LIMIT, MONITORING_TABS, monitoringStats, outsideText, type MonitoringTab } from "@/lib/monitoring";
import { roleAtLeast } from "@/lib/roles";
import { parseScopeParams, scopeQuery } from "@/lib/scope";
import type { SP } from "@/lib/query";
import { AlarmsTable, ResourcesTable } from "./MonitoringTables";
import { NeedsReviewTable } from "./NeedsReviewTable";
import { ScopeEcho } from "@/components/ShellContext";

const plus = (n: number, more: boolean) => (more ? `${n}+` : String(n));

/**
 * Monitoring (docs/ui/screens/monitoring.md). The two lists are read in parallel, once per page view, never per row:
 * the tiles, the tab counts and every tab come from the same two answers, so a number means the same on every tab.
 */
export async function MonitoringScreen({ tab, sp }: { tab: MonitoringTab; sp: SP }) {
  const scope = parseScopeParams(sp);
  if (scope.malformed) notFound();
  const api = await getApi();
  const q = { customer: scope.sel.customer, project: scope.sel.project, service: scope.sel.service, mine: scope.sel.mine, limit: LIST_LIMIT };
  const now = nowMs();

  let resources: ResourceItem[] = [];
  let alarms: ManagedAlarmItem[] = [];
  let outside: MonitoringOutside | null = null;
  let more = false;
  let role: "VIEWER" | "OPERATOR" | "ADMIN" = "VIEWER";
  let portal = false;
  let error: ApiError | null = null;
  try {
    const [r, a, me] = await Promise.all([api.listResources(q), api.listManagedAlarms(q), api.me()]);
    resources = r.items; alarms = a.items; outside = r.outside ?? a.outside; more = Boolean(r.nextCursor || a.nextCursor);
    role = me.role; portal = me.kind === "CUSTOMER";
  } catch (e) {
    if (isHidden(e)) notFound();
    error = e instanceof ApiError ? e : new ApiError(500, "UNKNOWN", "Could not load monitoring.", "");
  }

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) { const one = Array.isArray(v) ? v[0] : v; if (one) params.set(k, one); }
  const keep = scopeQuery(scope.sel, params);
  const filtered = Boolean(scope.sel.customer || scope.sel.mine);
  const stats = monitoringStats(resources, alarms);
  const review = resources.filter((r) => r.monitoringState === "NEEDS_REVIEW");
  const canWrite = !portal && roleAtLeast(role, "OPERATOR");
  const counts: Partial<Record<MonitoringTab, string>> = { alarms: plus(alarms.length, more), resources: plus(resources.length, more), "needs-review": String(stats.needsReview) };
  const tabHref = (key: MonitoringTab) => `/monitoring/${key}${keep}`;
  const outsideHref = `/monitoring/needs-review${scopeQuery({}, params)}`;

  return (
    <div className="page">
      <div className="ph">
        <div><h1 tabIndex={-1}>Monitoring</h1><p className="sm mut">Showing <ScopeEcho />.</p></div>
      </div>

      <nav className="tabs subnav" aria-label="Monitoring sections">
        {MONITORING_TABS.map((t) => (
          <Link key={t.key} href={tabHref(t.key)} aria-selected={t.key === tab} aria-current={t.key === tab ? "page" : undefined}>
            {t.label}{counts[t.key] !== undefined && !error ? <span className="n mon-n">{counts[t.key]}</span> : null}
          </Link>
        ))}
      </nav>

      {error ? (
        <Card accent="red" title="Could not load monitoring">
          <p className="sm" style={{ marginTop: 0 }}>{errorLine(error)}</p>
          <div className="row"><Link className="btn" href={tabHref(tab)}>Retry</Link></div>
        </Card>
      ) : (
        <>
          <div className="tiles mon-tiles" role="group" aria-label="Monitoring counts for the current filter" data-testid="mon-tiles">
            <div className="tile" data-testid="tile-monitored">
              <div className="row"><span className="st res"><Mark shape="chk" /></span><span className="ov">Monitored</span></div>
              <div className="v">{plus(stats.monitored, more)}</div>
              <div className="d">resources with alarms managed here</div>
            </div>
            <div className={cx("tile", stats.needsReview > 0 && "on")} data-testid="tile-needs-review">
              <div className="row"><span className="st warn"><Mark shape="tri" /></span><span className="ov">Needs review</span></div>
              <div className="v">{plus(stats.needsReview, more)}</div>
              <div className="d">tag removed outside AlarmOps, alarms kept</div>
            </div>
            <div className="tile" data-testid="tile-in-alarm">
              <div className="row"><span className="st trig"><Mark shape="dot" /></span><span className="ov">Alarms in ALARM</span></div>
              <div className={cx("v", stats.inAlarm > 0 && "red")}>{plus(stats.inAlarm, more)}</div>
              <div className="d">managed alarms in state ALARM</div>
            </div>
          </div>

          {filtered && outside ? (
            <div className="row mon-outside">
              <Link className={cx("chip", "mon-chip")} href={outsideHref} data-testid="outside-chip" title="Resources and alarms hidden by the filter. Opens Needs review for all customers.">
                {outsideText(outside)}
              </Link>
            </div>
          ) : null}

          <Body tab={tab} resources={resources} alarms={alarms} review={review} now={now} filtered={filtered} canWrite={canWrite} portal={portal} role={role} allHref={`/monitoring/${tab}`} />
          {more ? <p className="sm mut">Showing the first {LIST_LIMIT} of each list. Narrow the view in the tree to see the rest.</p> : null}
        </>
      )}
    </div>
  );
}

function Body({ tab, resources, alarms, review, now, filtered, canWrite, portal, role, allHref }: {
  tab: MonitoringTab; resources: ResourceItem[]; alarms: ManagedAlarmItem[]; review: ResourceItem[]; now: number; filtered: boolean; canWrite: boolean; portal: boolean; role: string; allHref: string;
}) {
  if (tab === "coverage-gaps" || tab === "sync-runs") {
    return <div className="card"><EmptyState title="Coming soon" detail={tab === "coverage-gaps" ? "Resources that should be monitored but have no alarms will be listed here." : "The history of alarm syncs per account will be listed here."} /></div>;
  }
  // nothing at all, and no filter in the way: no AWS account is connected yet
  if (resources.length === 0 && alarms.length === 0 && !filtered) {
    return (
      <div className="card" data-testid="empty-no-account">
        <EmptyState title="Connect an AWS account" detail="Monitoring starts when a customer’s AWS account is connected. Onboarding takes three steps." action={<Link className="btn pri" href="/customers">Open customers</Link>} />
      </div>
    );
  }
  if (tab === "needs-review") {
    if (review.length === 0) {
      return (
        <div className="card" data-testid="empty-review">
          <EmptyState title="Nothing to review" detail={filtered ? "No resource in this view lost its Monitoring tag." : "Every resource still carries its Monitoring tag."} action={filtered ? <Link className="btn" href={allHref}>All customers</Link> : undefined} />
        </div>
      );
    }
    const note = portal ? "This is a read-only view." : `Changing monitoring needs the Operator role. You are signed in as ${role === "ADMIN" ? "Admin" : role === "OPERATOR" ? "Operator" : "Viewer"}.`;
    return <NeedsReviewTable items={review} now={now} canWrite={canWrite} readOnlyReason={canWrite ? undefined : note} />;
  }
  if (tab === "resources") {
    return resources.length ? <ResourcesTable items={resources} now={now} /> : <div className="card" data-testid="empty-list"><EmptyState title="No resources in this view" action={filtered ? <Link className="btn" href={allHref}>All customers</Link> : undefined} /></div>;
  }
  return alarms.length ? <AlarmsTable items={alarms} /> : <div className="card" data-testid="empty-list"><EmptyState title="No alarms in this view" action={filtered ? <Link className="btn" href={allHref}>All customers</Link> : undefined} /></div>;
}
