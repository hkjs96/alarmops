import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner, Card, Mark, cx } from "@alarmops/design-system";
import { getApi, nowMs } from "@/lib/api";
import { ApiError, isHidden } from "@/lib/api/client";
import type { IncidentDetail, IncidentEvent, IncidentListResponse, NotificationLogEntry } from "@/lib/api/types";
import { parseQuery, type SP } from "@/lib/query";
import { incidentPanelPath, panelRouteMatches, parseScopeParams, scopeQuery, type PanelRoute } from "@/lib/scope";
import { age, groupDigits, kstHeading, kstTime } from "@/lib/format";
import { OutsideSlot } from "@/components/ShellContext";
import { IncidentsTable } from "./IncidentsTable";
import { FilterBar } from "./FilterBar";
import { IncidentPanel } from "./IncidentPanel";
import { IncidentDetailBody } from "./IncidentDetailBody";

function spToParams(sp: SP): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (one) p.set(k, one);
  }
  return p;
}

/**
 * Incidents list, wired to the scope filter in the query (?customer=&project=&service= or ?mine=1), with an optional
 * incident open beside it. The list and the panel are independent: the panel's scope is its path, the filter is the query.
 */
export async function IncidentsScreen({ sp, panel }: { sp: SP; panel?: PanelRoute }) {
  const scope = parseScopeParams(sp);
  if (scope.malformed) notFound();
  const q = parseQuery(sp);
  const api = await getApi();
  const now = nowMs();
  const nowIso = new Date(now).toISOString();

  // the panel first: a wrong panel address is Not found whatever the list would show
  let open: { inc: IncidentDetail; timeline: IncidentEvent[]; notifs: NotificationLogEntry[] } | null = null;
  if (panel) {
    try {
      const inc = await api.getIncident(panel.id);
      if (!panelRouteMatches(panel, inc.org)) notFound();
      const [timeline, notifs] = await Promise.all([api.getTimeline(panel.id), api.getNotifications(panel.id)]);
      open = { inc, timeline: timeline.items, notifs: notifs.items };
    } catch (e) {
      // not there, or not for this user (a 403 on a read is folded into the same Not found — security R-5)
      if (isHidden(e)) notFound();
      throw e;
    }
  }

  let data: IncidentListResponse | undefined;
  let error: ApiError | null = null;
  try {
    data = await api.listIncidents(q);
  } catch (e) {
    // unknown customer, project or service — or one this user may not see: the same Not found
    if (isHidden(e)) notFound();
    error = e instanceof ApiError ? e : new ApiError(500, "UNKNOWN", "Could not load incidents.", "");
  }

  const params = spToParams(sp);
  const listQuery = scopeQuery(scope.sel, params);
  const href = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    return "/incidents" + scopeQuery(scope.sel, p);
  };
  const hasFilters = Boolean(q.severity || q.source || q.assignee || q.q);
  const filtered = Boolean(scope.sel.customer || scope.sel.mine);
  const c = data?.counts;
  const listed = data?.items.length ?? 0;
  const activeN = c ? c.open + c.acknowledged : 0;
  const inc = open?.inc;
  const outsideFilter = inc && scope.sel.customer
    ? !(inc.org.customer?.slug === scope.sel.customer && (!scope.sel.project || inc.org.project?.slug === scope.sel.project) && (!scope.sel.service || inc.org.service?.slug === scope.sel.service))
    : false;

  return (
    <>
      <div className="page">
        <OutsideSlot counts={data?.outside ?? null} />
        <div className="ph">
          <div>
            <h1 tabIndex={-1}>Incidents</h1>
          </div>
          <div className="desc inc-now">{kstHeading(nowIso)}</div>
        </div>

        {data?.unmapped.map((u) => (
          <Banner key={u.awsAccountId} tone="amber" action={<Link className="btn sm" href={`/customers?mapAccount=${u.awsAccountId}`}>Map account →</Link>}>
            <b>{u.alertCount} alerts from an unmapped AWS account</b> <span className="mono sm">{groupDigits(u.awsAccountId)}</span> have no owner and won&apos;t escalate.
          </Banner>
        ))}

        {c ? (
          <div className="tiles" role="group" aria-label="Incident counts for the current filter" data-testid="tiles">
            <div className={cx("tile", c.open > 0 && "on")} data-testid="tile-open" title="Open = triggered or escalated, nobody has acknowledged it. The same meaning as the Incidents badge and the Outside this view line.">
              <div className="row"><span className="st trig"><Mark shape="dot" /></span><span className="ov">Open</span></div>
              <div className={cx("v", c.open > 0 && "red")}>{c.open}</div>
              <div className="d" title={`${c.triggered} triggered · ${c.escalated} escalated`}>
                {c.triggered} triggered · {c.escalated} escalated{c.meta?.triggeredSev1 ? ` · ${c.meta.triggeredSev1} SEV-1` : ""}
                {c.meta?.oldestTriggeredAt ? ` · oldest ${age(c.meta.oldestTriggeredAt, now)}` : ""}{c.meta?.escalatedNext ? ` · next step ${kstTime(c.meta.escalatedNext)}` : ""}
              </div>
            </div>
            <div className="tile">
              <div className="row"><span className="st ack"><Mark shape="ring" /></span><span className="ov">Acknowledged</span></div>
              <div className="v">{c.acknowledged}</div>
              <div className="d">{c.meta?.medianAckSec != null ? `median ack ${Math.floor(c.meta.medianAckSec / 60)}m ${Math.round(c.meta.medianAckSec % 60)}s` : "—"}</div>
            </div>
            <div className="tile">
              <div className="row"><span className="st res"><Mark shape="chk" /></span><span className="ov">Resolved · 24h</span></div>
              <div className="v">{c.resolved24h}</div>
              <div className="d">{c.meta?.resolvedAuto ?? 0} auto · {c.meta?.resolvedManual ?? 0} manual</div>
            </div>
            <div className="tile">
              <div className="row"><span className="st mute"><Mark shape="dash" /></span><span className="ov">Muted</span></div>
              <div className="v">{c.muted}</div>
              <div className="d">{c.meta?.maintenanceWindows ?? 0} maintenance windows</div>
            </div>
          </div>
        ) : null}

        <div className="row inc-filters">
          <div className="chips" role="group" aria-label="Status">
            <Link className={cx("chip", q.status === "active" && "on")} href={href({ status: undefined })} aria-current={q.status === "active" ? "true" : undefined}
              title="Active = not resolved yet: open (nobody has acknowledged) plus acknowledged">
              <span className="st trig"><Mark shape="dot" /></span>Active<span className="n">{c ? activeN : "—"}</span>
            </Link>
            <Link className={cx("chip", q.status === "ACKNOWLEDGED" && "on")} href={href({ status: "ACKNOWLEDGED" })} aria-current={q.status === "ACKNOWLEDGED" ? "true" : undefined}>
              <span className="st ack"><Mark shape="ring" /></span>Acknowledged<span className="n">{c?.acknowledged ?? "—"}</span>
            </Link>
            <Link className={cx("chip", q.status === "RESOLVED" && "on")} href={href({ status: "RESOLVED" })} aria-current={q.status === "RESOLVED" ? "true" : undefined}>
              <span className="st res"><Mark shape="chk" /></span>Resolved<span className="n">{c?.resolved24h ?? "—"}</span>
            </Link>
          </div>
          <span className="sp" />
          <FilterBar severity={q.severity} source={q.source} assignee={q.assignee} q={q.q} />
        </div>

        {error ? (
          <Card accent="red" title="Could not load incidents">
            <p className="sm" style={{ marginTop: 0 }}>{error.message}</p>
            <div className="row">
              <Link className="btn" href={href({})}>Retry</Link>
              {error.requestId ? <span className="mono xs faint">requestId {error.requestId}</span> : null}
            </div>
          </Card>
        ) : (
          <IncidentsTable
            items={data!.items.map((i) => ({ ...i, href: incidentPanelPath(i.org, i.id) + listQuery }))}
            nowMs={now}
            openId={inc?.id}
            listKey={listQuery}
            summary={c ? <span data-testid="inc-summary">{listed} listed · <b>{c.open} open</b> · {c.acknowledged} acknowledged</span> : undefined}
            emptyKind={q.status === "RESOLVED" ? "resolved incidents in the last 24h" : q.status === "ACKNOWLEDGED" ? "acknowledged incidents" : "active incidents"}
            clearFiltersHref={hasFilters ? href({ severity: undefined, source: undefined, assignee: undefined, q: undefined }) : undefined}
            allCustomersHref={filtered ? "/incidents" + scopeQuery({}, params) : undefined}
          />
        )}
        {data ? (
          <div className="row sm mut" style={{ marginTop: 10 }}>
            <span>Open a row to see the incident. Rows keep their place until you re-sort, or change the tab, the filter or the search.</span>
            <span className="sp" />
            <span className="inc-keys"><span className="kbd">J</span> <span className="kbd">K</span> move · <span className="kbd">A</span> acknowledge</span>
          </div>
        ) : null}
      </div>

      {open && inc ? (
        <IncidentPanel
          id={inc.id}
          path={inc.org.customer ? [inc.org.customer.name, inc.org.project?.name, inc.org.service?.name].filter((x): x is string => Boolean(x)) : null}
          pathLabel="Unmapped account"
          note={!inc.org.customer ? "Not assigned to a customer · nobody is paged" : outsideFilter ? "This incident is outside your list filter." : undefined}
          panelPath={incidentPanelPath(inc.org, inc.id)}
          listHref={"/incidents" + listQuery}
        >
          <IncidentDetailBody inc={inc} timeline={open.timeline} notifs={open.notifs} now={now} />
        </IncidentPanel>
      ) : null}
    </>
  );
}
