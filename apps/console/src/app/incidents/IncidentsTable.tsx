"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type MouseEvent } from "react";
import { Avatar, Banner, Button, EmptyState, SevBadge, StatusBadge, cx } from "@alarmops/design-system";
import type { IncidentListItem } from "@/lib/api/types";
import { displayStatus, orgChainParts } from "@/lib/incidents";
import { age, groupDigits } from "@/lib/format";
import { useShell } from "@/components/ShellContext";
import { executeBulk, undoBulk } from "./actions";

export type IncidentRow = IncidentListItem & { href: string };

function ScopePath({ i }: { i: IncidentListItem }) {
  if (i.unmapped || !i.org.customer) {
    return (
      <span className="inc-path">
        <span className="st warn"><span className="mk tri" aria-hidden="true" />Unmapped account</span>
        <span className="sub">Not assigned to a customer · nobody is paged</span>
      </span>
    );
  }
  const [customer, ...rest] = orgChainParts(i);
  return (
    <span className="inc-path">
      <b>{customer}</b>
      {rest.map((p, n) => <span key={n}><span className="chain" aria-hidden="true">›</span>{p}</span>)}
    </span>
  );
}

function what(i: IncidentListItem): string {
  if (i.unmapped) return `${groupDigits(i.awsAccountIds[0] ?? "", 99)} · CloudWatch`;
  const src = i.source === "CLOUDWATCH" ? i.resourceTypes[0] : i.source === "PROMETHEUS" ? "Prometheus" : "Grafana";
  return [src, i.env].filter(Boolean).join(" · ");
}
const pathText = (i: IncidentListItem) => (i.org.customer ? orgChainParts(i).join(" › ") : "an unmapped account");

/**
 * Incidents table. Every row states customer › project › service and opens one panel. Column priority when the list
 * gets narrow (container width, not viewport): Paged drops first, then Age; Sev, Status, the path, the incident and
 * Acknowledge always stay; below that the rows become cards (globals.css, `.t.inc`).
 */
export function IncidentsTable({ items, nowMs, openId, emptyKind, clearFiltersHref, allCustomersHref }: {
  items: IncidentRow[]; nowMs: number; openId?: string; emptyKind: string; clearFiltersHref?: string; allCustomersHref?: string;
}) {
  const router = useRouter();
  const shell = useShell();
  const [error, setError] = useState<string | null>(null);
  const [acked, setAcked] = useState<Record<string, string>>({}); // id → undo token, for this visit
  const [pending, start] = useTransition();
  const tableRef = useRef<HTMLTableElement>(null);

  const undoAck = (i: IncidentListItem, token: string) => start(async () => {
    const r = await undoBulk(token);
    setAcked((a) => { const n = { ...a }; delete n[i.id]; return n; });
    if (!r.ok) setError(r.message);
    else shell.toast(`Acknowledge undone in ${pathText(i)} · paging continues`);
    router.refresh();
  });
  const doAck = (i: IncidentListItem) => start(async () => {
    const r = await executeBulk("ack", [i.id]);
    if (!r.ok) setError(r.message);
    else if (!r.data.updated.includes(i.id)) setError("This incident was already acknowledged. The list was reloaded.");
    else {
      const token = r.data.undoToken;
      setAcked((a) => ({ ...a, [i.id]: token }));
      shell.toast(`Acknowledged in ${pathText(i)} · ${i.title}`, { label: "Undo", onAction: () => undoAck(i, token) });
    }
    router.refresh();
  });

  // after a panel closes, focus returns to its row
  useEffect(() => {
    if (openId) return;
    let id: string | null = null;
    try { id = sessionStorage.getItem("ao-focus-row"); sessionStorage.removeItem("ao-focus-row"); } catch { /* no storage */ }
    if (id) tableRef.current?.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(id)}"] a.ttl`)?.focus();
  }, [openId]);

  // J/K move between rows, A acknowledges the focused row. Not while typing or inside the tree, a panel or a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tgt = e.target as HTMLElement;
      if (tgt.closest("input, select, textarea, [contenteditable], [role=tree], [role=dialog], [role=alertdialog], .panel")) return;
      const links = [...(tableRef.current?.querySelectorAll<HTMLAnchorElement>("a.ttl") ?? [])];
      if (!links.length) return;
      const idx = links.findIndex((l) => l === document.activeElement);
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        links[e.key === "j" ? Math.min(links.length - 1, idx + 1) : Math.max(0, idx - 1)]?.focus();
      } else if (e.key === "a" && idx >= 0) {
        const it = items[idx];
        if (it && it.status === "TRIGGERED" && !it.unmapped) doAck(it);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const rowClick = (e: MouseEvent<HTMLTableRowElement>, href: string) => {
    if ((e.target as HTMLElement).closest("a, button, input")) return;
    if (window.getSelection()?.toString()) return;
    router.push(href);
  };

  return (
    <>
      {error ? <Banner tone="red" action={<Button size="sm" onClick={() => setError(null)}>Dismiss</Button>}>{error}</Banner> : null}
      <div className="tw">
        {items.length === 0 ? (
          <EmptyState
            title={`No ${emptyKind} in ${shell.filtered ? shell.label : `all ${shell.totalCustomers} customers`}.`}
            action={clearFiltersHref || allCustomersHref ? (
              <span className="row" style={{ justifyContent: "center" }}>
                {clearFiltersHref ? <Link className="btn" href={clearFiltersHref}>Clear filters</Link> : null}
                {allCustomersHref ? <Link className="btn ghost" href={allCustomersHref}>Show all customers</Link> : null}
              </span>
            ) : undefined}
          />
        ) : (
          <table className="t inc" ref={tableRef}>
            <caption className="sr-only">Incidents</caption>
            <thead>
              <tr>
                <th scope="col">Sev</th><th scope="col">Status</th><th scope="col">Customer › project › service</th><th scope="col">Incident</th>
                <th scope="col" className="c-paged">Paged</th><th scope="col" className="r c-age">Age</th><th scope="col" className="c-act"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const ds = displayStatus(i);
                const cur = i.id === openId;
                return (
                  <tr
                    key={i.id} data-id={i.id} data-testid="incident-row" aria-current={cur ? "true" : undefined}
                    className={cx(ds === "TRIGGERED" && "hot", ds === "ESCALATED" && "esc", cur && "cur")}
                    onClick={(e) => rowClick(e, i.href)}
                  >
                    <td className="c-sev"><SevBadge severity={i.severity} hot /></td>
                    <td className="c-status"><StatusBadge status={ds} short /></td>
                    <td className="c-path" data-testid="row-path"><ScopePath i={i} /></td>
                    <td className="c-title">
                      <Link className="ttl" href={i.href}>{i.title}</Link>
                      <div className="org">{what(i)}</div>
                    </td>
                    <td className="c-paged">
                      {i.assignee ? (
                        <span className="who"><Avatar name={i.assignee.name} active={i.status === "TRIGGERED"} />{i.assignee.name}</span>
                      ) : <span className="mut sm">No owner · not escalating</span>}
                      {i.assigneeNote ? <div className="org">{i.assigneeNote}</div> : null}
                    </td>
                    <td className="r mono sm c-age"><span className="lbl" aria-hidden="true">Age </span>{age(i.triggeredAt, nowMs)}</td>
                    <td className="r c-act">
                      {i.status === "TRIGGERED" && !i.unmapped ? (
                        <Button size="sm" onClick={() => doAck(i)} disabled={pending} aria-label={`Acknowledge ${i.title}`}>Acknowledge</Button>
                      ) : acked[i.id] && i.status === "ACKNOWLEDGED" ? (
                        <Button size="sm" variant="ghost" onClick={() => undoAck(i, acked[i.id]!)} disabled={pending}>Undo acknowledge</Button>
                      ) : null}
                    </td>
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
