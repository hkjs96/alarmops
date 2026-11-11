import Link from "next/link";
import { Avatar, Card, EmptyState, Mark, SevBadge, SourceChip, StatusBadge, Tabs, cx, type Shape } from "@alarmops/design-system";
import { safeExternalUrl } from "@/lib/safe-url";
import type { IncidentDetail, IncidentEvent, NotificationLogEntry, RemediationStage } from "@/lib/api/types";
import { displayStatus, orgChainParts } from "@/lib/incidents";
import { isSlug } from "@/lib/validate";
import { FAIL_REASON } from "@/lib/errors";
import { howText } from "@/lib/call-order/model";
import { snapshotPlanLabel } from "@/lib/call-order/plan-label";
import { duration, groupDigits, kstDateTime, kstTime } from "@/lib/format";
import { HeroActions } from "./[id]/HeroActions";

const EVENT_MARK: Record<IncidentEvent["kind"], { shape: Shape; st: string }> = {
  TRIGGERED: { shape: "dot", st: "trig" }, MERGED: { shape: "dot", st: "trig" }, ESCALATED: { shape: "tri", st: "esc" },
  NOTIFIED: { shape: "chk", st: "res" }, RENOTIFIED: { shape: "chk", st: "res" }, ACKED: { shape: "ring", st: "ack" },
  RESOLVED: { shape: "chk", st: "res" }, SUPPRESSED: { shape: "dash", st: "mute" }, MUTED: { shape: "dash", st: "mute" },
  REMEDIATION: { shape: "ring", st: "info" }, NOTE: { shape: "ring", st: "info" },
};
const CHANNEL: Record<NotificationLogEntry["channel"], string> = {
  SLACK_BOT: "Slack", SLACK_WEBHOOK: "Slack webhook", SLACK_DM: "Slack DM", EMAIL: "Email", SMS: "SMS", VOICE: "Voice call",
};
const STAGES: { key: RemediationStage; label: string }[] = [
  { key: "NOTIFIED", label: "Notified" }, { key: "PENDING_APPROVAL", label: "Pending approval" }, { key: "APPROVED", label: "Approved" },
  { key: "EXECUTING", label: "Executing" }, { key: "SUCCEEDED", label: "Succeeded" },
];

function Sparkline({ values, threshold }: { values: number[]; threshold: number }) {
  const min = Math.min(...values, threshold) * 0.9;
  const max = Math.max(...values, threshold) * 1.02;
  const y = (v: number) => 4 + (1 - (v - min) / (max - min)) * 48;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 600},${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1]!;
  return (
    <svg className="spark" viewBox="0 0 600 56" preserveAspectRatio="none" role="img" aria-label="Metric over the last 3 hours vs threshold">
      <line x1="0" y1={y(threshold)} x2="600" y2={y(threshold)} stroke="var(--red)" strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <polyline fill="none" stroke="var(--ink)" strokeWidth="1.6" points={pts} vectorEffect="non-scaling-stroke" />
      <circle cx="600" cy={y(last)} r="3" fill="var(--red)" />
    </svg>
  );
}

function Timeline({ events }: { events: IncidentEvent[] }) {
  if (!events.length) return <EmptyState title="No events yet" />;
  return (
    <div className="card-b tl">
      {events.map((e) => {
        const m = EVENT_MARK[e.kind];
        return (
          <div className="ev" key={e.id}>
            <span className={cx("m st", m.st)}><Mark shape={m.shape} /></span>
            <time className="tm" dateTime={e.at} title={kstDateTime(e.at)}>{kstTime(e.at, true)}</time>
            <div className="tx">{e.kind === "TRIGGERED" ? <><b>Triggered</b>{e.message.replace(/^Triggered/, "")}</> : e.message}{e.detail ? <span className="s">{e.detail}</span> : null}</div>
          </div>
        );
      })}
    </div>
  );
}

function Notifications({ items }: { items: NotificationLogEntry[] }) {
  if (!items.length) return <EmptyState title="No events yet" />;
  return (
    <div className="plist">
      {items.map((n) => (
        <div key={n.id}>
          <StatusBadge status={n.status === "SENT" ? "RESOLVED" : "TRIGGERED"} short />
          <span className="sr-only">{n.status === "SENT" ? "Sent" : "Failed"}</span>
          <div style={{ flex: 1 }}>
            <div className="sm"><b>{CHANNEL[n.channel]}</b> → {n.targetSummary}</div>
            {/* why it failed is for everyone (`reason`); the provider's own words only when the API sends them (internal operators and admins) */}
            <div className="xs mut">Step {n.escalationStep + 1}{n.attempt > 1 ? ` · attempt ${n.attempt}` : ""}{n.reason ? ` · ${FAIL_REASON[n.reason] ?? n.reason}` : ""}{n.error ? ` · ${n.error}` : ""}</div>
          </div>
          <time className="mono xs faint" dateTime={n.at}>{kstTime(n.at, true)}</time>
        </div>
      ))}
    </div>
  );
}

/** "Paging stopped at 03:16 — acknowledged by Haeun": once acknowledged, nobody else is called. */
export function pagingStopped(inc: Pick<IncidentDetail, "status" | "acknowledgedAt" | "acknowledgedBy">): string | null {
  if (inc.status !== "ACKNOWLEDGED" || !inc.acknowledgedAt) return null;
  const who = inc.acknowledgedBy?.name.split(" ")[0];
  return `Paging stopped at ${kstTime(inc.acknowledgedAt)} — acknowledged${who ? ` by ${who}` : ""}`;
}

function Stopped({ text }: { text: string }) {
  return <div className="paging-stopped" role="status" data-testid="paging-stopped"><span className="st ack"><Mark shape="ring" /></span><b>{text}</b></div>;
}

function Escalation({ inc, now }: { inc: IncidentDetail; now: number }) {
  const snap = inc.assignmentSnapshot;
  const esc = inc.escalation;
  const stopped = pagingStopped(inc);
  const plan = snapshotPlanLabel(snap);
  if (!snap || esc.state === "NEVER_ESCALATING") {
    return (
      <Card title="Escalation">
        {stopped ? <Stopped text={stopped} /> : <div className="sm mut">{inc.unmapped ? "No owner — unmapped account, not escalating." : "No paging steps."}</div>}
      </Card>
    );
  }
  const base = Date.parse(snap.capturedAt);
  const customer = inc.org.customer?.name;
  const callOrderSlug = inc.org.customer && isSlug(inc.org.customer.slug) ? inc.org.customer.slug : null;
  // acknowledged: only what was actually sent. The calls that will not happen are not listed.
  const steps = stopped ? snap.steps.filter((s) => s.index <= esc.step) : snap.steps;
  return (
    <Card bodyless title="Escalation" actions={<span className="mono xs">{stopped ? `stopped at step ${esc.step + 1}/${esc.totalSteps}` : `step ${esc.step + 1}/${esc.totalSteps} · repeat ${esc.repeat}/${esc.repeatCount}`}</span>}>
      <div className="plist">
        {steps.map((s) => {
          const at = new Date(base + s.atMin * 60_000).toISOString();
          const done = s.index < esc.step || (s.index === esc.step && inc.status !== "RESOLVED");
          const who = s.targetType === "ALL_RESPONDERS" ? (s.label ?? "everyone in Responders") : s.resolved.map((r) => `${r.name}${r.via ? ` (${r.via})` : ""}`).join(", ");
          const chans = howText(s.channels, false); // the same words as the call-order sentence
          const isNext = s.index === esc.step + 1 && esc.nextAt && inc.status === "TRIGGERED";
          return (
            <div key={s.index}>
              <span className={cx("ord", s.index === 0 && "first")}>{s.index + 1}</span>
              <Avatar name={s.resolved[0]?.name ?? who} label={s.targetType === "ALL_RESPONDERS" ? "ALL" : undefined} />
              <div style={{ flex: 1 }}>
                <div className="b">{who}</div>
                <div className="xs mut">
                  {done ? <>{chans} <span aria-label="sent">✓</span> {kstTime(at)}</> : <>{chans} at {kstTime(at)}{isNext ? ` · in ${duration(new Date(now).toISOString(), Date.parse(at))} if no ack` : ""}</>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {stopped ? <div style={{ padding: "10px 16px", borderTop: "1px solid var(--grid)" }}><Stopped text={stopped} /></div> : null}
      <div className="xs mut" style={{ padding: "10px 16px", borderTop: "1px solid var(--grid)" }}>
        {stopped ? null : <div>Then repeats {snap.repeatCount === 1 ? "once" : `${snap.repeatCount} times`}.</div>}
        <div className="row" style={{ marginTop: 4, gap: 6 }}>
          {plan ? <span className="pill accent" data-testid="plan-label">{plan}</span> : null}
          {callOrderSlug ? <Link className="tap" href={`/call-order?customer=${callOrderSlug}`}>Call order for {customer}</Link> : null}
        </div>
        {inc.severity === "SEV_1" ? <div style={{ marginTop: 4 }}>SEV-1 · pages through maintenance windows</div> : esc.mutedByMaintenance || esc.state === "MUTED" ? <div style={{ marginTop: 4 }}>Muted by maintenance ({inc.severity.replace("_", "-")})</div> : null}
      </div>
    </Card>
  );
}

/** Incident detail content. Rendered inside the scope Panel (side panel on desktop, the whole view on a phone). */
export function IncidentDetailBody({ inc, timeline, notifs, now }: { inc: IncidentDetail; timeline: IncidentEvent[]; notifs: NotificationLogEntry[]; now: number }) {
  const ds = displayStatus(inc);
  const why = inc.why;
  const rem = inc.remediation;
  const stageIdx = rem ? STAGES.findIndex((s) => s.key === rem.stage) : -1;
  const stopped = pagingStopped(inc);
  // once acknowledged or resolved, the calls that were still to come are not shown as if they would happen
  const paged = inc.status === "TRIGGERED" ? inc.paged : inc.paged.filter((p) => p.done);

  return (
    <div className="inc-detail">
      <div className="crumb">{inc.key}</div>

      <section className={cx("card", ds === "TRIGGERED" ? "lb-red" : ds === "ESCALATED" ? "lb-orange" : ds === "RESOLVED" ? "lb-green" : undefined)} style={{ marginBottom: 20 }} aria-labelledby="inc-title">
        <div className="card-b">
          <div className="row" style={{ gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <SevBadge severity={inc.severity} hot />
            <StatusBadge status={ds} suffix={inc.status === "TRIGGERED" ? duration(inc.triggeredAt, now) : undefined} />
            <span className="mono xs faint">opened {kstTime(inc.triggeredAt, true)} KST · {inc.memberCount} alerts</span>
          </div>
          <div className="row inc-hero" style={{ alignItems: "flex-start", gap: 20 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 id="inc-title" className="inc-title">{inc.title}</h3>
              <div className="sm mut">
                {/* the customer › project › service path is in the panel band, once */}
                {inc.awsAccountIds[0] ? <>AWS <span className="mono">{groupDigits(inc.awsAccountIds[0], 4)}</span></> : inc.details.source}
                {inc.region ? <> · {inc.region}</> : null}
                {inc.env === "prd" ? <> · <span className="pill prd">Production</span></> : null}
              </div>
              {paged.length || stopped || inc.org.customer ? (
                <div className="paged" data-testid="paged-line">
                  <span className="ov">Paged</span>
                  {paged.map((p, n) => (
                    <span key={n}>{n > 0 ? <span className="faint" aria-hidden="true">→ </span> : null}<span style={{ color: "var(--accent)" }}><span className={p.done ? "b" : undefined}>{p.label}</span> <span className="mono">{kstTime(p.at)}</span>{p.done ? " ✓" : ""}</span></span>
                  ))}
                  {stopped ? <span className="b" style={{ flexBasis: "100%" }}>{stopped}</span> : null}
                  {!stopped && snapshotPlanLabel(inc.assignmentSnapshot) ? <span className="pill accent" data-testid="paged-plan-label">{snapshotPlanLabel(inc.assignmentSnapshot)}</span> : null}
                  {inc.org.customer ? (
                    // who is paged is decided by the call order of this incident's own scope: one click to read it (and why)
                    <Link className="paged-co tap" data-testid="paged-call-order" href={`/c/${[inc.org.customer.slug, inc.org.project?.slug, inc.org.project ? inc.org.service?.slug : undefined].filter(Boolean).join("/")}/call-order`}
                      aria-label={`Open the call order of ${orgChainParts(inc).join(" › ")}`}>Call order →</Link>
                  ) : null}
                </div>
              ) : null}
            </div>
            <HeroActions id={inc.id} title={inc.title} pathText={inc.org.customer ? orgChainParts(inc).join(" › ") : "an unmapped account"} status={inc.status} version={inc.version} canEscalate={inc.escalation.state === "PAGING" || inc.escalation.state === "UNREACHABLE"} escalateWhy={inc.escalation.state === "MUTED" ? "Muted by a maintenance window" : inc.escalation.state === "NEVER_ESCALATING" ? "No call order applies: there is nobody to escalate to" : inc.escalation.state === "STOPPED_EXHAUSTED" ? "Every step has been sent" : undefined} acknowledgedAt={inc.acknowledgedAt} />
          </div>
        </div>
      </section>

      <div className="g-detail">
        <div className="stack" style={{ minWidth: 0 }}>
          {why ? (
            <Card title="Why it fired" actions={why.resourceId ? <Link className="sm tap" href={`/monitoring/resources/${encodeURIComponent(why.resourceId)}`}>Open resource →</Link> : null}>
              <div className="g3" style={{ border: "1px solid var(--rule)", marginBottom: 14 }}>
                <div style={{ padding: "12px 14px" }}>
                  <div className="ov">Current</div>
                  <div className="mono" style={{ fontSize: 24, fontWeight: 700, color: "var(--red)" }}>{why.current}</div>
                  <div className="xs mut">{why.metricKey} · {why.statistic} · {why.periodLabel}</div>
                </div>
                <div style={{ padding: "12px 14px" }}>
                  <div className="ov">Threshold</div>
                  <div className="mono" style={{ fontSize: 24, fontWeight: 700 }}>{why.threshold}</div>
                  <div className="row xs mut" style={{ gap: 6 }}><SourceChip source={why.thresholdSource} />{why.thresholdSourceNote}</div>
                </div>
                <div style={{ padding: "12px 14px" }}>
                  <div className="ov">Evaluation</div>
                  <div className="mono" style={{ fontSize: 24, fontWeight: 700 }}>{why.evaluation}</div>
                  <div className="row xs mut" style={{ gap: 6 }}><SourceChip source={why.evaluationSource} />{why.evaluationNote}</div>
                </div>
              </div>
              <Sparkline values={why.series} threshold={why.seriesThreshold} />
              <div className="row xs faint" style={{ justifyContent: "space-between" }}>{why.seriesLabels.map((l) => <span key={l} className="mono">{l}</span>)}</div>
              <div className="note" style={{ marginTop: 12 }}><span className="mono xs faint">REASON</span><span style={{ overflowWrap: "anywhere" }}>{why.reason}</span></div>
            </Card>
          ) : null}

          {rem ? (
            <Card accent="amber" title={<><h2 className="ov" style={{ margin: 0 }}>Auto-fix</h2><span className="pill">{rem.mode === "NOTIFY_ONLY" ? "Notify only" : "Approval required"}</span></>}
              actions={<span className="xs faint mono">{rem.id}{rem.expiresAt ? ` · expires ${kstTime(rem.expiresAt)}` : ""}</span>}>
              <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="b" style={{ fontSize: 15 }}>{rem.action} <span className="mono" style={{ fontWeight: 400 }}>{rem.target}</span></div>
                  <div className="sm mut" style={{ marginTop: 2, overflowWrap: "anywhere" }}>Triggered by an unauthorized change: {rem.trigger}</div>
                </div>
                {rem.slackThreadUrl ? (safeExternalUrl(rem.slackThreadUrl, { slack: true })
                  ? <a className="btn" href={safeExternalUrl(rem.slackThreadUrl, { slack: true })!} target="_blank" rel="noopener noreferrer">Open Slack thread ↗</a>
                  : <span className="sm mut mono" style={{ overflowWrap: "anywhere" }}>{rem.slackThreadUrl}</span>) : null}
              </div>
              {rem.mode === "NOTIFY_ONLY" ? (
                <div className="note" style={{ marginTop: 14 }}>Notify-only mode — no action will run.</div>
              ) : (
                <>
                  <div className="stage" style={{ marginTop: 16 }} aria-label={`Stage: ${STAGES[stageIdx]?.label ?? rem.stage}`}>
                    {STAGES.map((s, n) => (
                      <span key={s.key} className={cx(n < stageIdx && "done", n === stageIdx && "cur")}><b />{s.label}{s.key === "NOTIFIED" ? ` ${kstTime(rem.notifiedAt)}` : ""}</span>
                    ))}
                  </div>
                  <div className="note" style={{ marginTop: 14 }}>
                    <span className="st info"><Mark shape="ring" /></span>
                    <span>Approve in <b>Slack</b>{rem.slackChannel ? ` (${rem.slackChannel})` : ""} or with the <b>email link</b>. Only people with the <b>Auto-fix approver</b> role{inc.org.service ? ` for ${inc.org.service.name}` : ""} can approve: {rem.approvers.join(", ")}. Runs with the customer&apos;s auto-fix permission in AWS.</span>
                  </div>
                </>
              )}
            </Card>
          ) : null}

          <section className="card" aria-label="Incident activity">
            <Tabs label="Incident activity" items={[
              { id: "timeline", label: "Timeline", content: <Timeline events={timeline} /> },
              { id: "alerts", label: "Alerts", count: inc.alerts.length || inc.memberCount, content: inc.alerts.length ? (
                <div className="plist">{inc.alerts.map((a) => (
                  <div key={a.id}>
                    <SevBadge severity={a.severity} />
                    <div style={{ flex: 1 }}><div className="sm b">{a.title}</div><div className="xs mut mono" style={{ overflowWrap: "anywhere" }}>{a.fingerprint}</div></div>
                    <span className="mono xs mut">{a.eventCount}×</span>
                  </div>
                ))}</div>
              ) : <EmptyState title="No alert details" /> },
              { id: "notifications", label: "Notifications", count: notifs.length, content: <Notifications items={notifs} /> },
              { id: "suppression", label: "Suppression", count: inc.suppression.length, content: inc.suppression.length ? (
                <div className="plist">{inc.suppression.map((s, n) => (
                  <div key={n}><StatusBadge status="MUTED" short /><div style={{ flex: 1 }}><div className="sm b">{s.reason}</div><div className="xs mut">{s.detail}</div></div><time className="mono xs faint" dateTime={s.at}>{kstTime(s.at, true)}</time></div>
                ))}</div>
              ) : <EmptyState title="Nothing suppressed" /> },
            ]} />
          </section>
        </div>

        <aside className="stack" style={{ minWidth: 0 }}>
          <Escalation inc={inc} now={now} />
          <Card dashed title="Root cause analysis" actions={<span className="pill">After PoC</span>} style={{ minHeight: 178 }}>
            <div className="sm mut">A read-only investigation agent will summarize likely causes here, using the customer&apos;s Reader role.</div>
            <div style={{ marginTop: 14, display: "grid", gap: 7 }} aria-hidden="true">
              <div className="skel" style={{ height: 8, width: "92%" }} /><div className="skel" style={{ height: 8, width: "76%" }} /><div className="skel" style={{ height: 8, width: "84%" }} />
            </div>
          </Card>
          <Card title="Details">
            <dl className="kv">
              <dt>Source</dt><dd>{inc.details.source}</dd>
              <dt>Resource</dt><dd className="mono sm">{inc.details.resource}</dd>
              <dt>Alarm</dt><dd className="sm">{inc.details.alarm}</dd>
              {inc.details.runbookUrl ? <><dt>Runbook</dt><dd>{safeExternalUrl(inc.details.runbookUrl) ? <a className="tap" href={safeExternalUrl(inc.details.runbookUrl)!} target="_blank" rel="noopener noreferrer">{inc.details.runbookLabel ?? "Runbook"} ↗</a> : <span className="sm mono" style={{ overflowWrap: "anywhere" }}>{inc.details.runbookUrl}</span>}</dd></> : null}
              {inc.details.lastTime ? <><dt>Last time</dt><dd className="sm">{inc.details.lastTime}</dd></> : null}
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}
