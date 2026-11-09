"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Avatar, Banner, Button, EmptyState, SevBadge, StatusBadge, cx } from "@alarmops/design-system";
import type { BulkPreview, IncidentListItem } from "@/lib/api/types";
import { displayStatus, orgChainParts } from "@/lib/incidents";
import { age, groupDigits } from "@/lib/format";
import { ackIncident, executeBulk, previewBulk, undoBulk } from "./actions";

function OrgLine({ i }: { i: IncidentListItem }) {
  if (i.unmapped) {
    return (
      <div className="org">
        <span className="st warn" style={{ fontSize: 11 }}><span className="mk tri" aria-hidden="true" />Unmapped</span> · <span className="mono">{groupDigits(i.awsAccountIds[0] ?? "", 99)}</span> · CloudWatch
      </div>
    );
  }
  const parts = orgChainParts(i);
  const src = i.source === "CLOUDWATCH" ? i.resourceTypes[0] : i.source === "PROMETHEUS" ? "Prometheus" : "Grafana";
  return (
    <div className="org">
      {parts.map((p, n) => (
        <span key={p}>{n > 0 ? <span className="chain" aria-hidden="true">›</span> : null}{p}</span>
      ))}
      {src ? <> · {src}</> : null}
      {i.env ? <> · <span className="mono">{i.env}</span></> : null}
    </div>
  );
}

export function IncidentsTable({ items, nowMs, emptyTitle, clearHref }: { items: IncidentListItem[]; nowMs: number; emptyTitle: string; clearHref?: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [undo, setUndo] = useState<{ token: string; count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const tableRef = useRef<HTMLTableElement>(null);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = items.length > 0 && items.every((i) => selected.has(i.id));

  const doAck = (i: IncidentListItem) => start(async () => {
    const r = await ackIncident(i.id, i.version);
    if (!r.ok) setError(r.code === "VERSION_CONFLICT" ? "Someone else updated this incident. The list was reloaded." : r.message);
    router.refresh();
  });

  const openBulk = (action: "ack" | "resolve") => start(async () => {
    const r = await previewBulk(action, [...selected]);
    if (r.ok) setPreview(r.data); else setError(r.message);
  });
  const runBulk = () => start(async () => {
    if (!preview) return;
    const r = await executeBulk(preview.action, preview.targets.map((t) => t.id));
    setPreview(null);
    if (r.ok) { setUndo({ token: r.data.undoToken, count: r.data.updated.length }); setSelected(new Set()); }
    else setError(r.message);
    router.refresh();
  });
  const runUndo = () => start(async () => {
    if (!undo) return;
    const r = await undoBulk(undo.token);
    setUndo(null);
    if (!r.ok) setError(r.message);
    router.refresh();
  });

  // J/K move between rows, A acknowledges the focused row.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest("input, select, textarea, [contenteditable]")) return;
      const links = [...(tableRef.current?.querySelectorAll<HTMLAnchorElement>("a.ttl") ?? [])];
      if (!links.length) return;
      const idx = links.findIndex((l) => l === document.activeElement);
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const n = e.key === "j" ? Math.min(links.length - 1, idx + 1) : Math.max(0, idx - 1);
        links[n]?.focus();
      } else if (e.key === "a" && idx >= 0) {
        const it = items[idx];
        if (it && it.status === "TRIGGERED") doAck(it);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      {error ? <Banner tone="red" action={<Button size="sm" onClick={() => setError(null)}>Dismiss</Button>}>{error}</Banner> : null}
      {undo ? (
        <Banner tone="green" action={<Button size="sm" onClick={runUndo} disabled={pending}>Undo</Button>}>
          Updated {undo.count} incident{undo.count === 1 ? "" : "s"}. You can undo for 5 minutes.
        </Banner>
      ) : null}
      {selected.size > 0 ? (
        <div className="row bulkbar" style={{ marginBottom: 12 }} role="region" aria-label="Bulk actions">
          <span className="sm b">{selected.size} selected</span>
          <span className="sp" />
          <Button onClick={() => openBulk("resolve")} disabled={pending}>Resolve {selected.size} selected</Button>
          <Button onClick={() => openBulk("ack")} disabled={pending}>Acknowledge {selected.size} selected</Button>
        </div>
      ) : null}
      {preview ? (
        <div className="card lb-accent" role="dialog" aria-modal="false" aria-labelledby="bulk-h" style={{ marginBottom: 12 }}>
          <div className="card-h"><h2 id="bulk-h" className="ov" style={{ margin: 0 }}>{preview.action === "ack" ? "Acknowledge" : "Resolve"} {preview.targets.length} incidents?</h2></div>
          <div className="card-b">
            <ul className="sm" style={{ margin: "0 0 10px", paddingLeft: 18 }}>
              {preview.targets.map((t) => <li key={t.id}><span className="mono xs faint">{t.key}</span> {t.title}</li>)}
            </ul>
            {preview.skipped.length ? <div className="xs mut" style={{ marginBottom: 10 }}>Skipped {preview.skipped.length}: {preview.skipped.map((s) => s.reason).join(", ")}</div> : null}
            <div className="row">
              <Button variant="primary" onClick={runBulk} disabled={pending || preview.targets.length === 0}>{preview.action === "ack" ? "Acknowledge" : "Resolve"} {preview.targets.length}</Button>
              <Button onClick={() => setPreview(null)}>Cancel</Button>
              <span className="xs mut">You can undo for 5 minutes.</span>
            </div>
          </div>
        </div>
      ) : null}

      <div className="tw">
        {items.length === 0 ? (
          <EmptyState title={emptyTitle} action={clearHref ? <Link className="btn" href={clearHref}>Clear filters</Link> : undefined} />
        ) : (
          <table className="t cards" ref={tableRef}>
            <caption className="sr-only">Incidents</caption>
            <thead>
              <tr>
                <th className="cbc"><input type="checkbox" className="cbx" aria-label="Select all" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(items.map((i) => i.id)))} /></th>
                <th scope="col">Sev</th><th scope="col">Status</th><th scope="col">Incident</th><th scope="col" className="r">Alerts</th>
                <th scope="col">Assignee</th><th scope="col">Escalation</th><th scope="col" className="r">Age</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const ds = displayStatus(i);
                return (
                  <tr key={i.id} className={cx(ds === "TRIGGERED" && "hot", ds === "ESCALATED" && "esc")} data-testid="incident-row">
                    <td className="cbc c-sel"><input type="checkbox" className="cbx" aria-label={`Select ${i.title}`} checked={selected.has(i.id)} onChange={() => toggle(i.id)} /></td>
                    <td className="c-sev"><SevBadge severity={i.severity} hot /></td>
                    <td className="c-status"><StatusBadge status={ds} short /></td>
                    <td className="c-title">
                      <Link className="ttl" href={`/incidents/${i.id}`} style={{ color: "var(--ink)" }}>{i.title}</Link>
                      <OrgLine i={i} />
                    </td>
                    <td className="r mono b c-alerts">{i.memberCount}</td>
                    <td className="c-who">
                      {i.assignee ? (
                        <span className="who"><Avatar name={i.assignee.name} active={i.status === "TRIGGERED"} />{i.assignee.name}</span>
                      ) : <span className="mut sm">No owner</span>}
                      {i.assigneeNote ? <div className="org">{i.assigneeNote}</div> : null}
                      {i.status === "TRIGGERED" && i.assignee ? (
                        <div className="show-m" style={{ marginTop: 8 }}>
                          <Button variant="primary" size="sm" onClick={() => doAck(i)} disabled={pending}>Acknowledge</Button>
                        </div>
                      ) : null}
                    </td>
                    <td className="c-esc">
                      {i.escalation && i.status === "TRIGGERED" ? (
                        <><span className="mono sm">{i.escalation.step + 1}/{i.escalation.totalSteps}</span> <span className="sm mut">· {i.escalation.summary}</span></>
                      ) : i.escalation ? <span className="sm mut">{i.escalation.summary}</span>
                        : i.status === "RESOLVED" ? <span className="sm mut">{i.resolvedVia === "AUTO" ? "auto-resolved" : "resolved"}</span>
                        : <span className="sm mut">— not escalating</span>}
                    </td>
                    <td className="r mono sm c-age">{age(i.triggeredAt, nowMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
