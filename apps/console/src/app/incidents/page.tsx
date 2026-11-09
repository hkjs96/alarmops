import Link from "next/link";
import { Banner, Card, Mark, SevBadge, cx } from "@alarmops/design-system";
import { getApi, nowMs } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import { parseQuery, type SP } from "@/lib/query";
import { age, countdown, groupDigits, kstHeading, kstTime } from "@/lib/format";
import { IncidentsTable } from "./IncidentsTable";
import { FilterBar } from "./FilterBar";

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const q = parseQuery(sp);
  const api = getApi();
  const now = nowMs();
  const nowIso = new Date(now).toISOString();

  let data;
  let error: ApiError | null = null;
  try {
    data = await api.listIncidents(q);
  } catch (e) {
    error = e instanceof ApiError ? e : new ApiError(500, "UNKNOWN", "Could not load incidents.", "");
  }
  const oncall = await api.oncallNow(q.customerId).catch(() => []);

  const hasFilters = Boolean(q.severity || q.source || q.assignee || q.q || q.customerId);
  const href = (patch: Partial<Record<string, string | undefined>>) => {
    const p = new URLSearchParams();
    const merged = { status: q.status === "open" ? undefined : q.status, severity: q.severity, source: q.source, assignee: q.assignee, q: q.q, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/incidents?${s}` : "/incidents";
  };

  const c = data?.counts;
  const pending = (data?.items ?? []).filter((i) => i.status === "TRIGGERED" && i.escalation?.nextAt);

  return (
    <div className="page">
      <div className="ph">
        <div>
          <h1>Incidents</h1>
          <div className="desc">{kstHeading(nowIso)} · auto-refresh every 15s</div>
        </div>
      </div>

      {data?.unmapped.map((u) => (
        <Banner key={u.awsAccountId} tone="amber" action={<Link className="b" href={`/customers?mapAccount=${u.awsAccountId}`}>Map account →</Link>}>
          <b>{u.alertCount} alerts from an unmapped AWS account</b> <span className="mono sm">{groupDigits(u.awsAccountId)}</span> have no owner and won&apos;t escalate.
        </Banner>
      ))}

      {c ? (
        <div className="tiles" aria-label="Incident counts for the current filters">
          <div className={cx("tile", c.triggered > 0 && "on")}>
            <div className="row"><span className="st trig"><Mark shape="dot" /></span><span className="ov">Triggered</span></div>
            <div className={cx("v", c.triggered > 0 && "red")}>{c.triggered}</div>
            <div className="d">{c.meta?.triggeredSev1 ?? 0} SEV-1{c.meta?.oldestTriggeredAt ? ` · oldest ${age(c.meta.oldestTriggeredAt, now)}` : ""}</div>
          </div>
          <div className="tile">
            <div className="row"><span className="st esc"><Mark shape="tri" /></span><span className="ov">Escalated</span></div>
            <div className={cx("v", c.escalated > 0 && "orange")}>{c.escalated}</div>
            <div className="d">{c.meta?.escalatedNext ? `next step at ${kstTime(c.meta.escalatedNext)}` : "none pending"}</div>
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

      <div className="g-main">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="chips" role="group" aria-label="Status">
              <Link className={cx("chip", q.status === "open" && "on")} href={href({ status: undefined })} aria-current={q.status === "open" ? "true" : undefined}>
                <span className="st trig"><Mark shape="dot" /></span>Open<span className="n">{c?.open ?? "—"}</span>
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
              items={data!.items}
              nowMs={now}
              emptyTitle={q.status === "RESOLVED" ? "No resolved incidents in the last 24h." : q.status === "ACKNOWLEDGED" ? "No acknowledged incidents." : "No open incidents."}
              clearHref={hasFilters ? href({ severity: undefined, source: undefined, assignee: undefined, q: undefined }) : undefined}
            />
          )}
          {data ? (
            <div className="row xs mut" style={{ marginTop: 10 }}>
              <span>Showing {data.items.length} of {q.status === "open" ? c!.open : q.status === "ACKNOWLEDGED" ? c!.acknowledged : c!.resolved24h} {q.status === "open" ? "open" : (q.status ?? "open").toLowerCase()} · counts follow current filters</span>
              <span className="sp" />
              <span className="hide-m"><span className="kbd">J</span> <span className="kbd">K</span> move · <span className="kbd">A</span> ack</span>
            </div>
          ) : null}
        </div>

        <aside className="stack" aria-label="On-call">
          <Card bodyless title="On shift now" actions={<Link className="sm" href="/oncall/now">All customers</Link>}>
            <div className="plist">
              {oncall.map((o) => (
                <div key={o.name + o.rotation}>
                  <span className={cx("av", o.contactId && "on")} aria-hidden="true">{o.initials}</span>
                  <div style={{ flex: 1 }}>
                    <div><b>{o.name}</b> {o.rotation ? <span className="xs mut">{o.rotation}</span> : null}</div>
                    <div className="xs mut">{o.detail}</div>
                  </div>
                  {o.openCount > 0 ? <span className="mono xs mut" title="open incidents">{o.openCount} open</span> : null}
                </div>
              ))}
            </div>
            <div className="xs mut" style={{ padding: "8px 16px", borderTop: "1px solid var(--grid)" }}>
              Each incident follows its customer&apos;s paging steps (service › project › customer). Shared MSP rotations serve many customers.
            </div>
          </Card>
          {pending.length > 0 ? (
            <Card accent="orange" title="Escalation pending">
              <div className="stack">
                {pending.map((i) => {
                  const total = Date.parse(i.escalation!.nextAt!) - Date.parse(i.escalation!.baseAt ?? i.triggeredAt);
                  const pct = total > 0 ? Math.min(100, Math.max(0, ((now - Date.parse(i.escalation!.baseAt ?? i.triggeredAt)) / total) * 100)) : 0;
                  return (
                    <div key={i.id}>
                      <div className="row">
                        <SevBadge severity={i.severity} />
                        <Link className="b sm" style={{ color: "var(--ink)" }} href={`/incidents/${i.id}`}>{i.title.split(" ")[0]}</Link>
                        <span className="sp" />
                        <span className="mono sm" style={{ color: "var(--orange)" }}>{countdown(i.escalation!.nextAt!, now)}</span>
                      </div>
                      <div className="xs mut">{i.escalation!.nextLabel ?? i.escalation!.summary}</div>
                      <div className="prog" style={{ marginTop: 6 }}><i style={{ width: `${pct}%` }} /></div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
