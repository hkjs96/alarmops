"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition, type MouseEvent } from "react";
import { Avatar, Banner, Button, EmptyState, SevBadge, StatusBadge, cx } from "@alarmops/design-system";
import type { IncidentListItem } from "@/lib/api/types";
import { displayStatus, orgChainParts } from "@/lib/incidents";
import { age, groupDigits } from "@/lib/format";
import { useShell } from "@/components/ShellContext";
import { ackIncident, undoBulk } from "./actions";

export type IncidentRow = IncidentListItem & { href: string };

/** An acknowledged row stays where it is this long (or until the pointer leaves it, or the list changes). */
export const HOLD_MS = 5000;
/** A second press at the same spot this soon after an Acknowledge is a double tap, not a decision. */
export const DOUBLE_MS = 600;
const SAME_SPOT_PX = 24;

/**
 * Order of the rows while one is held: the order on screen when Acknowledge was pressed. The server list sorts
 * acknowledged incidents below the open ones, which would slide the next incident's Acknowledge under the same
 * finger (QA P1-1). Rows that arrive meanwhile go to the end.
 */
export function heldOrder<T extends { id: string }>(items: T[], frozen: string[] | null): T[] {
  if (!frozen) return items;
  const at = new Map(frozen.map((id, n) => [id, n]));
  return [...items].sort((a, b) => (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity));
}

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
export function IncidentsTable({ items, nowMs, openId, emptyKind, listKey = "", clearFiltersHref, allCustomersHref }: {
  items: IncidentRow[]; nowMs: number; openId?: string; emptyKind: string;
  /** changes when the list shows something else (filter, tab, search): a held row is let go */
  listKey?: string; clearFiltersHref?: string; allCustomersHref?: string;
}) {
  const router = useRouter();
  const shell = useShell();
  const acked = shell.acks;
  const [error, setError] = useState<string | null>(null);
  const [hold, setHold] = useState<{ id: string; order: string[] } | null>(null);
  const [changed, setChanged] = useState<Record<string, number>>({}); // id → the version that was refused (409)
  const [pending, start] = useTransition();
  const tableRef = useRef<HTMLTableElement>(null);
  const lastAck = useRef<{ t: number; x: number; y: number } | null>(null);
  const shown = heldOrder(items, hold?.order ?? null);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const release = useCallback(() => setHold(null), []);
  useEffect(() => {
    if (!hold) return;
    const t = setTimeout(release, HOLD_MS);
    return () => clearTimeout(t);
  }, [hold, release]);
  useEffect(() => { setHold(null); setChanged({}); }, [listKey]);

  /** true = a pointer press at the spot where an Acknowledge was pressed a moment ago: ignore it */
  const doubleTap = (e?: MouseEvent) => {
    const g = lastAck.current;
    return Boolean(e && g && e.detail > 0 && performance.now() - g.t < DOUBLE_MS
      && Math.abs(e.clientX - g.x) <= SAME_SPOT_PX && Math.abs(e.clientY - g.y) <= SAME_SPOT_PX);
  };

  const undoAck = (i: IncidentListItem, token: string, e?: MouseEvent) => {
    if (doubleTap(e)) return;
    start(async () => {
      const r = await undoBulk(token);
      shell.setAck(i.id, null);
      setHold(null);
      if (!r.ok) setError(r.message);
      else shell.toast(`Acknowledge undone in ${pathText(i)} · paging continues`);
      router.refresh();
    });
  };
  const doAck = (i: IncidentListItem, e?: MouseEvent) => {
    if (doubleTap(e)) return;
    if (e && e.detail > 0) lastAck.current = { t: performance.now(), x: e.clientX, y: e.clientY };
    // the row keeps its place from the moment of the press, before the server answers
    setHold({ id: i.id, order: shownRef.current.map((x) => x.id) });
    start(async () => {
      const r = await ackIncident(i.id, i.version);
      if (r.ok) {
        const token = r.data.undoToken;
        shell.setAck(i.id, token);
        shell.toast(`Acknowledged in ${pathText(i)} · ${i.title}`, { label: "Undo", onAction: () => undoAck(i, token) });
        router.refresh();
      } else if (r.code === "VERSION_CONFLICT") {
        // someone or something changed it since this list was loaded: nothing was acknowledged, the row says so
        setHold(null);
        setChanged((c) => ({ ...c, [i.id]: i.version }));
      } else {
        setHold(null);
        setError(r.message);
        router.refresh();
      }
    });
  };
  const reload = (id: string) => {
    setChanged((c) => { const n = { ...c }; delete n[id]; return n; });
    router.refresh();
  };

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
        const it = shownRef.current[idx];
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
              {shown.map((i) => {
                const ds = displayStatus(i);
                const cur = i.id === openId;
                const held = hold?.id === i.id;
                const stale = changed[i.id] === i.version;
                return (
                  <tr
                    key={i.id} data-id={i.id} data-testid="incident-row" aria-current={cur ? "true" : undefined}
                    data-held={held ? "1" : undefined}
                    className={cx(ds === "TRIGGERED" && "hot", ds === "ESCALATED" && "esc", cur && "cur", stale && "stale")}
                    onClick={(e) => rowClick(e, i.href)}
                    onPointerLeave={held ? (e) => { if (e.pointerType !== "touch") release(); } : undefined}
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
                      {stale ? (
                        <span className="ack-state warn" role="status">
                          <span className="ack-done">Changed since you loaded this list · not acknowledged</span>
                          <Button size="sm" onClick={() => reload(i.id)} aria-label={`Reload the list, ${i.title} changed`}>Reload</Button>
                        </span>
                      ) : i.status === "TRIGGERED" && !i.unmapped ? (
                        <Button size="sm" onClick={(e) => doAck(i, e)} disabled={pending} aria-label={`Acknowledge ${i.title}`}>Acknowledge</Button>
                      ) : acked[i.id] && i.status === "ACKNOWLEDGED" ? (
                        <span className="ack-state">
                          <span className="ack-done">Acknowledged <span aria-hidden="true">✓</span></span>
                          <span className="chain" aria-hidden="true">·</span>
                          <Button size="sm" onClick={(e) => undoAck(i, acked[i.id]!, e)} disabled={pending} aria-label={`Undo acknowledge of ${i.title}`}>Undo</Button>
                        </span>
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
