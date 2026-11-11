"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Avatar, Banner, Button, EmptyState, SAME_SPOT_MS, SevBadge, StatusBadge, cx, isSameSpot, markSpot, useStableRows } from "@alarmops/design-system";
import type { IncidentListItem } from "@/lib/api/types";
import { displayStatus, orgChainParts } from "@/lib/incidents";
import { age, groupDigits, kstTime } from "@/lib/format";
import { RowMenu } from "@/components/RowMenu";
import { hasRole, roleReason, useShell } from "@/components/ShellContext";
import { errorText } from "@/lib/errors";
import { ackIncident, undoBulk } from "./actions";

export type IncidentRow = IncidentListItem & { href: string };

/** A second press at the same spot this soon after an Acknowledge is a double tap, not a decision (design-system list/same-spot: one rule for every list). */
export const DOUBLE_MS = SAME_SPOT_MS;

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
      {/* a line may break after a ›, never before it; without the <wbr> the whole path is one unbreakable word and the table overflows beside a panel (QA P2-B) */}
      {rest.map((p, n) => <span key={n}><span className="chain" aria-hidden="true">›</span><wbr />{p}</span>)}
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
 * the action always stay; below that the rows become cards (globals.css, `.t.inc`).
 *
 * Rows never move under the pointer (lib/stable-list.ts). Acknowledge, Undo, Resolve and any refresh change a row
 * where it stands; the bar above the list says what is waiting ("2 acknowledged in place · Re-sort", "3 new · Show")
 * and only its button — or a tab, filter or search change — sorts the list again. The action column has one fixed
 * width and every state of it is one line high, so a row changing state does not resize the others either.
 */
export function IncidentsTable({ items, nowMs, openId, emptyKind, listKey = "", summary, clearFiltersHref, allCustomersHref }: {
  items: IncidentRow[]; nowMs: number; openId?: string; emptyKind: string;
  /** changes when the list shows something else (filter, tab, search): the list is sorted again */
  listKey?: string;
  /** the counts line shown in the bar above the list */
  summary?: ReactNode;
  clearFiltersHref?: string; allCustomersHref?: string;
}) {
  const router = useRouter();
  const shell = useShell();
  const acked = shell.acks;
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<Record<string, number>>({}); // id → the version that was refused (409)
  const [busy, setBusy] = useState<Record<string, "ack" | "undo">>({}); // per row: one row waiting never locks another
  const [optim, setOptim] = useState<Record<string, number>>({}); // id → version acknowledged, until the list says so itself
  const tableRef = useRef<HTMLTableElement>(null);
  const focusLabel = useRef<string | null>(null);
  const canAck = hasRole(shell.user, "OPERATOR");
  const noAck = canAck ? undefined : roleReason(shell.user, "OPERATOR", "Acknowledging");

  const stable = useStableRows(items, listKey, { keep: shell.listView });
  const view = stable.view;
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => { setChanged({}); }, [listKey]);

  // A row whose content changes (acknowledged: the "escalated to …" note goes away) must not get shorter and pull the
  // rows below it up. Every row's height is remembered while it is unchanged; when its content changes it is held at
  // that height until the list is sorted again or its width changes.
  const seen = useRef<Record<string, { h: number; sig: string }>>({});
  const [locks, setLocks] = useState<Record<string, number>>({});
  const viewId = useRef<unknown>(null);
  const sigOf = (r: { item: IncidentRow; gone: boolean }) => `${r.item.version}|${r.gone}|${busy[r.item.id] ?? ""}|${optim[r.item.id] ?? ""}|${changed[r.item.id] ?? ""}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- measures after every render; it sets state only for a row not yet held, so it settles
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    if (viewId.current !== view.base) { // a new sort: start over
      viewId.current = view.base;
      seen.current = {};
      if (Object.keys(locks).length) { setLocks({}); return; }
    }
    let next: Record<string, number> | null = null;
    for (const r of view.rows) {
      const id = r.item.id;
      const sig = sigOf(r);
      const was = seen.current[id];
      if (locks[id] !== undefined) continue;
      if (was && was.sig !== sig) (next ??= { ...locks })[id] = was.h;
      else {
        const el = table.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(id)}"]`);
        if (el) seen.current[id] = { h: el.getBoundingClientRect().height, sig };
      }
    }
    if (next) setLocks(next);
  });
  useEffect(() => { void document.fonts?.ready.then(() => measure()); }, []);
  /** the heights as they are on screen now (fonts may have arrived since the last render); called right before a row changes */
  const measure = () => {
    for (const el of tableRef.current?.querySelectorAll<HTMLElement>("tr[data-id]:not([data-lock])") ?? []) {
      const was = seen.current[el.dataset.id!];
      if (was) was.h = el.getBoundingClientRect().height;
    }
  };
  useEffect(() => {
    const table = tableRef.current;
    if (!table || typeof ResizeObserver === "undefined") return;
    let w = table.getBoundingClientRect().width;
    const ro = new ResizeObserver(() => {
      const now = table.getBoundingClientRect().width;
      if (Math.abs(now - w) < 1) return;
      w = now; // the user resized, or opened or closed a panel: rows reflow anyway
      seen.current = {};
      setLocks({});
    });
    ro.observe(table);
    return () => ro.disconnect();
  }, [view.rows.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = stable.pending;
  const resort = (e: MouseEvent) => stable.resort(e);

  /** true = a pointer press at the spot where a row action was pressed a moment ago: ignore it */
  const doubleTap = (e?: MouseEvent) => isSameSpot(e);
  const setBusyFor = (id: string, v: "ack" | "undo" | null) => setBusy((b) => { const n = { ...b }; if (v) n[id] = v; else delete n[id]; return n; });
  const rowEl = (id: string) => tableRef.current?.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(id)}"]`);
  /** the control that had the focus is about to be replaced: the focus goes to what replaces it, or to the row's title */
  const keepFocus = (id: string) => { if (rowEl(id)?.querySelector(".c-act")?.contains(document.activeElement)) focusLabel.current = id; };
  /** after Undo the focus waits for the row's Acknowledge button to come back with the refreshed list */
  const wantButton = useRef<string | null>(null);
  useEffect(() => {
    const id = focusLabel.current;
    if (!id) return;
    const row = rowEl(id);
    const active = document.activeElement;
    // the user has moved on: leave the focus where they put it
    if (active && active !== document.body && !row?.contains(active)) { focusLabel.current = null; wantButton.current = null; return; }
    const button = row?.querySelector<HTMLElement>(".c-act button[aria-label^='Acknowledge'], .c-act .act-2");
    const target = button ?? row?.querySelector<HTMLElement>(".c-act [data-focus]") ?? row?.querySelector<HTMLElement>("a.ttl");
    if (target && target !== active) target.focus();
    if (busy[id] || (wantButton.current === id && !button)) return;
    focusLabel.current = null;
    wantButton.current = null;
  });

  const undoAck = async (i: IncidentListItem, token: string, fromRow = false) => {
    if (fromRow) focusLabel.current = i.id; // from the toast, the focus stays where it is
    measure();
    setBusyFor(i.id, "undo");
    const r = await undoBulk(token);
    shell.setAck(i.id, null);
    setOptim((o) => { const n = { ...o }; delete n[i.id]; return n; });
    setBusyFor(i.id, null);
    if (!r.ok) setError(r.code === "NOT_FOUND" ? "Undo is no longer available: it works once, for 5 minutes, for the person who acknowledged." : errorText(r, { what: "Undoing an acknowledgement" }));
    // someone touched the incident since: it is not put back, and that is said
    else if (!r.data.restored.includes(i.id)) setError(`Could not undo — ${i.title} was changed again since you acknowledged it. It stays as it is now.`);
    else { if (focusLabel.current === i.id) wantButton.current = i.id; shell.mark(i.id, "REOPENED"); shell.toast(`Acknowledge undone in ${pathText(i)} · paging continues`); }
    router.refresh();
  };
  const doAck = async (i: IncidentListItem, e?: MouseEvent) => {
    if (busy[i.id] || doubleTap(e) || !canAck) return;
    if (e) markSpot(e);
    keepFocus(i.id);
    measure();
    setBusyFor(i.id, "ack");
    const r = await ackIncident(i.id, i.version);
    setBusyFor(i.id, null);
    if (r.ok) {
      const token = r.data.undoToken;
      setOptim((o) => ({ ...o, [i.id]: i.version }));
      shell.setAck(i.id, token);
      shell.mark(i.id, null);
      shell.toast(`Acknowledged in ${pathText(i)} · ${i.title}`, { label: "Undo", onAction: () => { void undoAck(i, token); } });
      router.refresh();
    } else if (r.code === "VERSION_CONFLICT") {
      // someone or something changed it since this list was loaded: nothing was acknowledged, the row says so
      setChanged((c) => ({ ...c, [i.id]: i.version }));
    } else {
      setError(errorText(r, { what: "Acknowledging", where: pathText(i) }));
      router.refresh();
    }
  };
  const reload = (id: string, e: MouseEvent) => {
    if (doubleTap(e)) return;
    focusLabel.current = id;
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

  // J/K move between rows, A acknowledges the focused row. Not while typing or inside the tree, a panel, a menu or a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tgt = e.target as HTMLElement;
      if (tgt.closest("input, select, textarea, [contenteditable], [role=tree], [role=dialog], [role=alertdialog], [role=menu], .panel")) return;
      const links = [...(tableRef.current?.querySelectorAll<HTMLAnchorElement>("a.ttl") ?? [])];
      if (!links.length) return;
      const idx = links.findIndex((l) => l === document.activeElement);
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        links[e.key === "j" ? Math.min(links.length - 1, idx + 1) : Math.max(0, idx - 1)]?.focus();
      } else if (e.key === "a" && idx >= 0) {
        const r = viewRef.current.rows[idx];
        if (r && !r.gone && r.item.status === "TRIGGERED" && !r.item.unmapped && optim[r.item.id] !== r.item.version && changed[r.item.id] !== r.item.version) void doAck(r.item);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const rowClick = (e: MouseEvent<HTMLTableRowElement>, href: string) => {
    // the action cell is never part of the row link: a second press where Acknowledge was must do nothing at all
    if ((e.target as HTMLElement).closest("a, button, input, [role=menu], .c-act")) return;
    if (window.getSelection()?.toString()) return;
    router.push(href);
  };

  return (
    <>
      {error ? <Banner tone="red" action={<Button size="sm" onClick={() => setError(null)}>Dismiss</Button>}>{error}</Banner> : null}
      {/* in words on the page, not in a tooltip: a phone has no hover (QA 재점검 P3-A) */}
      {noAck ? <p className="list-why" data-testid="list-role-why">Read only. {noAck}</p> : null}
      {/* always here and always the same height: when it has something to say, nothing below it moves */}
      <div className={cx("list-bar", pending && "on")} data-testid="list-bar">
        {pending ? (
          <span className="list-bar-p" role="status">
            <span className="list-bar-t" data-testid="list-pending">{pending.text}</span>
            <Button size="sm" onClick={resort} title="Sort the list again. Rows keep their place until you ask.">{pending.button}</Button>
          </span>
        ) : <span className="sr-only" role="status" />}
        {summary ? <span className="list-bar-s">{summary}</span> : null}
      </div>
      <div className="tw">
        {view.rows.length === 0 ? (
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
                <th scope="col" className="c-sev">Sev</th><th scope="col" className="c-status">Status</th><th scope="col" className="c-pathh">Customer › project › service</th><th scope="col">Incident</th>
                <th scope="col" className="c-paged">Paged</th><th scope="col" className="r c-age">Age</th><th scope="col" className="c-act"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map(({ item: i, gone }) => {
                const m = gone ? shell.marks[i.id] : undefined;
                // acknowledged here a moment ago and the list has not caught up: the row already says so
                const ackedNow = !gone && i.status === "TRIGGERED" && optim[i.id] === i.version;
                const status = m === "RESOLVED" ? "RESOLVED" : m === "REOPENED" ? "TRIGGERED" : ackedNow ? "ACKNOWLEDGED" : i.status;
                const ds = displayStatus({ status, escalated: i.escalated });
                const cur = i.id === openId;
                const stale = !gone && changed[i.id] === i.version;
                const working = busy[i.id];
                const inPlace = gone || status !== view.base[i.id];
                const token = acked[i.id];
                return (
                  <tr
                    key={i.id} data-id={i.id} data-row-key={i.id} data-testid="incident-row" aria-current={cur ? "true" : undefined}
                    data-inplace={inPlace ? "1" : undefined} data-gone={gone ? "1" : undefined}
                    data-lock={locks[i.id] !== undefined ? "1" : undefined} style={locks[i.id] !== undefined ? ({ "--lock-h": `${locks[i.id]}px` } as CSSProperties) : undefined}
                    className={cx(ds === "TRIGGERED" && "hot", ds === "ESCALATED" && "esc", cur && "cur", stale && "stale", inPlace && status !== "TRIGGERED" && "dim")}
                    onClick={(e) => rowClick(e, i.href)}
                  >
                    <td className="c-sev"><SevBadge severity={i.severity} hot /></td>
                    <td className="c-status"><StatusBadge status={ds} short /></td>
                    <td className="c-path" data-testid="row-path"><ScopePath i={i} /></td>
                    <td className="c-title">
                      <Link className="ttl" href={i.href}>{i.title}</Link>
                      {stale
                        ? <div className="org warn" title="Changed since you loaded this list. It was not acknowledged.">Changed since loaded</div>
                        : <div className="org">{what(i)}</div>}
                    </td>
                    <td className="c-paged">
                      {i.assignee ? (
                        <span className="who"><Avatar name={i.assignee.name} active={status === "TRIGGERED"} />{i.assignee.name}</span>
                      ) : <span className="mut sm">No owner · not escalating</span>}
                      {i.assigneeNote ? <div className="org">{i.assigneeNote}</div> : null}
                    </td>
                    <td className="r mono sm c-age"><span className="lbl" aria-hidden="true">Age </span>{age(i.triggeredAt, nowMs)}</td>
                    <td className="r c-act">
                      {stale ? (
                        <span className="act warn">
                          <Button key="b" size="sm" className="act-2" data-list-action="incident.reload" onClick={(e) => reload(i.id, e)} aria-label={`Reload the list, ${i.title} changed`}>Reload</Button>
                          <span key="l" className="act-l" role="status" title="Changed since you loaded this list. It was not acknowledged.">Not acknowledged</span>
                        </span>
                      ) : gone ? (
                        <span className="act"><span key="l" className="act-l" role="status" tabIndex={-1} data-focus>
                          {m === "RESOLVED" ? <>Resolved <span aria-hidden="true">✓</span></> : m === "REOPENED" ? "Reopened · paging" : "Left this list"}
                        </span></span>
                      ) : working === "ack" ? (
                        <span className="act"><span key="l" className="act-l" role="status" tabIndex={-1} data-focus data-testid="ack-label">Acknowledging…</span></span>
                      ) : working === "undo" ? (
                        <span className="act"><span key="l" className="act-l" role="status" tabIndex={-1} data-focus>Undoing…</span></span>
                      ) : status === "TRIGGERED" && !i.unmapped ? (
                        <span className="act"><Button key="a" size="sm" data-list-action="incident.ack" disabled={!canAck} title={noAck} onClick={(e) => { void doAck(i, e); }} aria-label={`Acknowledge ${i.title}`}>Acknowledge</Button></span>
                      ) : status === "ACKNOWLEDGED" && (token || inPlace) ? (
                        <span className="act">
                          {/* Undo is not where Acknowledge was (QA P2-A): it is behind "…", at the other end of the cell, and in the toast */}
                          {token ? <RowMenu key="m" label={`More for ${i.title}`} items={[{ label: "Undo acknowledge", action: "incident.undo-ack", onSelect: () => { void undoAck(i, token, true); } }]} /> : null}
                          <span key="l" className="act-l" role="status" tabIndex={-1} data-focus data-testid="ack-label">
                            Acknowledged <span aria-hidden="true">✓</span>{i.acknowledgedAt && !ackedNow ? <span className="act-t"> {kstTime(i.acknowledgedAt)}</span> : null}
                          </span>
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
