"use client";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "../cx";
import {
  buildTree, clampTreeWidth, highlightParts, normalizeSel, selKey, selLabel, tokensOf, treeKey,
  MY_KEY, OTHER_KEY, TREE_MAX_WIDTH, TREE_MIN_WIDTH,
  type ScopeCustomerNode, type ScopeSel, type TreeRow,
} from "./model";
import { readSession, writeSession } from "./storage";

export interface ScopeTreeProps {
  customers: ScopeCustomerNode[];
  value: ScopeSel;
  onChange: (sel: ScopeSel) => void;
  /** collapsed to the 45px rail */
  rail: boolean;
  onRailChange: (rail: boolean) => void;
  /** expanded width, 200–360 */
  width: number;
  onWidthChange: (width: number) => void;
  /** what the tree sits beside, for the rail's label */
  beside?: "list" | "panel";
  /** first name of the signed-in user, for tooltips */
  me?: string;
  /** sessionStorage key for expansion, "Only with problems" and the legend */
  storageKey?: string;
  className?: string;
}

interface Stored { o?: Record<string, boolean>; op?: Record<string, boolean>; prob?: boolean; leg?: boolean }

const HEALTH = {
  UNREACHABLE: { cls: "unr", label: "Unreachable", tip: "Nobody in Responders can be called or texted." },
  AT_RISK: { cls: "ar", label: "At risk", tip: "First on shift has no verified phone." },
} as const;

function Tags({ row }: { row: TreeRow }) {
  const collapsed = row.hasKids && !row.expanded;
  if (row.kind === "root" || (row.kind === "group" && row.expanded)) return null;
  const h = row.health ? HEALTH[row.health] : null;
  return (
    <span className="stree-tags">
      {row.ownSteps ? <span className="stag own" title="Own steps: this project or service has its own call order instead of the customer's">Own steps</span> : null}
      {row.ownInside > 0 && collapsed ? <span className="stag-in" role="img" aria-label="Contains own steps" title={`Contains ${row.ownInside} level${row.ownInside === 1 ? "" : "s"} with own steps. Expand to see.`} /> : null}
      {h ? <span className={cx("stag", h.cls)} title={`${h.label}: ${h.tip}`}>{h.label}</span> : null}
      {row.openIncidents > 0 ? (
        <span className="stag-n" title={`${row.openIncidents} open incident${row.openIncidents === 1 ? "" : "s"}`}>
          <span className="sr-only">open incidents: </span>{row.openIncidents}
        </span>
      ) : null}
    </span>
  );
}

/**
 * What the tree's tags mean, in plain words. One link, collapsed until asked for; the tree and the phone sheet share it.
 */
export function ScopeLegend({ open, onToggle, className }: { open: boolean; onToggle: () => void; className?: string }) {
  const id = useId();
  return (
    <div className={cx("stree-leg", className)}>
      <button type="button" className="stree-legt" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        What do these mean?<span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <ul className="stree-legl" id={id}>
          <li><span className="stag-n">2</span><span>Open incidents here: triggered or escalated, and nobody has acknowledged them yet.</span></li>
          <li><span className="stag unr">Unreachable</span><span>If something breaks now, nobody for this customer can be called or texted.</span></li>
          <li><span className="stag ar">At risk</span><span>The person who is called first has no verified phone number.</span></li>
          <li><span className="stag own">Own steps</span><span>This project or service has its own call order instead of the customer&apos;s.</span></li>
          <li><span className="stag-in" /><span>Something inside has its own call order. Expand to see which.</span></li>
        </ul>
      ) : null}
    </div>
  );
}

const TreeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M3 2.5v9.5h4M3 6.5h4" />
    <rect x="8.5" y="4.5" width="5" height="4" fill="currentColor" stroke="none" />
    <rect x="8.5" y="10" width="5" height="4" fill="currentColor" stroke="none" />
  </svg>
);

/**
 * Customer › project › service tree (T2–T8). Always docked: expanded (200–360px) or a 45px rail. The name chooses
 * and expands; the arrow only expands. The parent owns the filter (value/onChange) and the rail/width state.
 */
export function ScopeTree(props: ScopeTreeProps) {
  const { customers, value, onChange, rail, onRailChange, width, onWidthChange, beside = "list", me = "you", storageKey = "ao-scope-tree" } = props;
  const uid = useId();
  const [query, setQuery] = useState("");
  const [problems, setProblems] = useState(false);
  const [legend, setLegend] = useState(false);
  const [maps, setMaps] = useState<{ o: Record<string, boolean>; op: Record<string, boolean>; oq: Record<string, boolean> }>({ o: {}, op: {}, oq: {} });
  const [cur, setCur] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [refused, setRefused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const railRef = useRef<HTMLButtonElement>(null);
  const colRef = useRef<HTMLButtonElement>(null);
  const ta = useRef({ text: "", at: 0 });
  const focusAfter = useRef<"tree" | "rail" | "collapse" | null>(null);

  // remembered for the session: expansion, Only with problems, legend
  useEffect(() => {
    const s = readSession<Stored>(storageKey);
    if (s) {
      setMaps((m) => ({ ...m, o: s.o ?? {}, op: s.op ?? {} }));
      setProblems(Boolean(s.prob));
      setLegend(s.leg === true);
    }
    setLoaded(true);
  }, [storageKey]);
  useEffect(() => {
    if (loaded) writeSession(storageKey, { o: maps.o, op: maps.op, prob: problems, leg: legend } satisfies Stored);
  }, [loaded, storageKey, maps.o, maps.op, problems, legend]);

  const searching = query.trim().length > 0;
  const mode: "o" | "op" | "oq" = searching ? "oq" : problems ? "op" : "o";
  const view = useMemo(
    () => buildTree(customers, { sel: value, query, problemsOnly: problems, expanded: maps[mode] }),
    [customers, value, query, problems, maps, mode],
  );
  const rows = view.rows;

  // when the filter changes, the chosen branch opens again even if it was collapsed by hand
  const vKey = selKey(value);
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const first = lastKey.current === null;
    if (lastKey.current === vKey) return;
    lastKey.current = vKey;
    const v = normalizeSel(value);
    if (first || !v.customer) return;
    const c = customers.find((x) => x.slug === v.customer);
    const drop = [v.customer, v.project ? `${v.customer}/${v.project}` : "", c ? (c.mine ? MY_KEY : OTHER_KEY) : ""].filter(Boolean);
    setMaps((m) => {
      const strip = (map: Record<string, boolean>) => { const n = { ...map }; for (const k of drop) delete n[k]; return n; };
      return { ...m, o: strip(m.o), op: strip(m.op) };
    });
  }, [loaded, vKey, value, customers]);

  const curKey = rows.some((r) => r.key === cur)
    ? cur
    : ((searching && rows.find((r) => r.hit)) || rows.find((r) => r.selected) || rows[0])?.key ?? null;
  const curIdx = rows.findIndex((r) => r.key === curKey);

  useEffect(() => {
    const f = focusAfter.current;
    if (!f) return;
    focusAfter.current = null;
    (f === "tree" ? treeRef.current : f === "rail" ? railRef.current : colRef.current)?.focus();
  });
  useEffect(() => {
    if (curIdx < 0) return;
    // Not scrollIntoView: Chrome then starts keyboard navigation from that row, and the first Tab on a fresh page
    // would skip the skip link, the menu and the tree (QA P2-1). Moving scrollTop has no such side effect.
    const el = document.getElementById(`${uid}-n${curIdx}`);
    const box = el?.closest<HTMLElement>(".stree-s");
    if (!el || !box) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const head = el.classList.contains("hdr") ? 0 : 28; // sticky group heading
    if (r.top < b.top + head) box.scrollTop -= b.top + head - r.top;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  }, [uid, curIdx, curKey]);

  const toggle = (key: string) => {
    const r = rows.find((x) => x.key === key);
    if (!r?.hasKids) return;
    setMaps((m) => ({ ...m, [mode]: { ...m[mode], [key]: !r.expanded } }));
    setCur(key);
  };
  const pick = (key: string) => {
    const r = rows.find((x) => x.key === key);
    if (!r) return;
    if (r.sel === null) { toggle(key); return; }
    setCur(key);
    setAmbiguous(false);
    setRefused(false);
    // a pick ends the search: the full tree comes back with the chosen branch open
    setMaps((m) => {
      const strip = (map: Record<string, boolean>) => { const n = { ...map }; delete n[key]; return n; };
      return searching ? { o: strip(m.o), op: strip(m.op), oq: {} } : { ...m, [mode]: strip(m[mode]) };
    });
    if (searching) setQuery("");
    onChange(r.sel);
  };

  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key === "Tab") return;
    const now = Date.now();
    const buf = now - ta.current.at < 700 ? ta.current.text : "";
    const res = treeKey(rows, curKey, e.key, { searching, ambiguous, typeahead: buf, customers });
    if (!res.handled) return;
    e.preventDefault();
    if (e.key.startsWith("Arrow")) { setAmbiguous(false); setRefused(false); }
    if (res.typeahead !== undefined) ta.current = { text: res.typeahead, at: now };
    if (res.refuse) { setRefused(true); return; }
    if (res.toggle) { toggle(res.toggle); return; }
    if (res.pick) { pick(res.pick); return; }
    if (res.openGroup) setMaps((m) => ({ ...m, [mode]: { ...m[mode], [res.openGroup!]: true } }));
    if (res.cur) setCur(res.cur);
  };
  const clearSearch = () => {
    setQuery(""); setMaps((m) => ({ ...m, oq: {} })); setCur(null); setAmbiguous(false); setRefused(false);
    searchRef.current?.focus();
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && query) { e.preventDefault(); clearSearch(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); treeRef.current?.focus(); return; }
    if (e.key === "Enter" && searching) {
      e.preventDefault();
      if (view.hits === 1 && view.onlyHit) pick(view.onlyHit);
      else { setAmbiguous(view.hits > 1); treeRef.current?.focus(); }
    }
  };

  // resize handle: drag or arrow keys, 200–360px
  const drag = useRef<{ x: number; w: number } | null>(null);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: width };
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onWidthChange(clampTreeWidth(drag.current.w + e.clientX - drag.current.x));
  };
  const onUp = () => { drag.current = null; setDragging(false); };
  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    onWidthChange(clampTreeWidth(width + (e.key === "ArrowRight" ? 16 : -16)));
  };

  const label = selLabel(customers, value);
  if (rail) {
    const v = normalizeSel(value);
    const parts = label.split(" › ");
    return (
      <aside className={cx("stree rail", props.className)} aria-label="Customer tree, collapsed">
        <button
          ref={railRef} type="button" className="stree-rail" aria-expanded={false}
          aria-label={`Open the customer tree beside the ${beside}. Showing: ${label}`}
          title={`Open the customer tree beside the ${beside}`}
          onClick={() => { focusAfter.current = "tree"; onRailChange(false); }}
        >
          <span className="chv" aria-hidden="true">»</span>
          <span className="ico"><TreeIcon /></span>
          <span className="vt">
            {parts.map((p, n) => (
              <span key={n}>{n > 0 ? <span className="chain" aria-hidden="true">›</span> : null}{n === 0 || !v.customer ? <b>{p}</b> : p}</span>
            ))}
          </span>
        </button>
      </aside>
    );
  }

  const tokens = tokensOf(query);
  const real = rows.filter((r) => r.kind !== "root" && r.kind !== "group").length;
  let hint: React.ReactNode = null;
  if (refused) hint = <><b>{view.hits} matches</b> · nothing selected. Use <span className="kbd">↑</span><span className="kbd">↓</span> to choose one, then Enter.</>;
  else if (searching && view.hits === 1) hint = <><b>1 match</b> · Enter selects it</>;
  else if (searching && view.hits > 1) hint = <><b>{view.hits} matches</b> in {view.hitCustomers} customer{view.hitCustomers === 1 ? "" : "s"} · nothing is selected until you choose one</>;

  const renderRow = (r: TreeRow) => {
    const i = rows.indexOf(r);
    const tip = r.filterInside ? `Your filter is inside: ${label}. Expand to see it.`
      : r.key === MY_KEY ? `Show only the ${r.count} customers ${me} covers`
      : r.key === OTHER_KEY ? `Customers ${me} does not cover` : r.label;
    const collapsed = r.hasKids && !r.expanded;
    // one clean accessible name per row: the name, then what its tags say
    const name = [
      r.label + (r.count != null ? ` · ${r.shown != null && r.shown !== r.count ? `${r.shown} of ${r.count}` : r.count}` : ""),
      r.filterInside ? "your filter is inside" : "",
      r.ownSteps ? "own steps" : "",
      r.ownInside > 0 && collapsed ? "contains own steps" : "",
      r.kind !== "root" && !(r.kind === "group" && r.expanded) && r.health ? HEALTH[r.health].label.toLowerCase() : "",
      r.kind !== "root" && !(r.kind === "group" && r.expanded) && r.openIncidents > 0 ? `${r.openIncidents} open incident${r.openIncidents === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(", ");
    return (
      <div
        key={r.key} id={`${uid}-n${i}`} role="treeitem" aria-level={r.level} aria-selected={r.selected}
        aria-expanded={r.hasKids ? r.expanded : undefined} aria-label={name} data-key={r.key}
        className={cx("stree-n", `d${r.depth}`, r.kind === "group" && "hdr", r.kind === "root" && "root", r.selected && "on", r.filterInside && "oni", r.key === curKey && "cur")}
        onClick={() => pick(r.key)}
      >
        {r.hasKids ? (
          <button
            type="button" className="tg" tabIndex={-1} aria-label={`${r.expanded ? "Collapse" : "Expand"} ${r.label}`}
            title={`${r.expanded ? "Collapse" : "Expand"} (does not change what is shown)`}
            onClick={(e) => { e.stopPropagation(); toggle(r.key); }}
          >{r.expanded ? "▾" : "▸"}</button>
        ) : r.kind === "root" ? null : <span className="tg" />}
        <span className="x" title={tip}>
          {r.hit ? highlightParts(r.label, tokens).map((p, n) => (p.mark ? <mark key={n}>{p.text}</mark> : <span key={n}>{p.text}</span>)) : r.label}
          {r.kind === "group" ? <span className="mut"> · {r.shown != null && r.shown !== r.count ? `${r.shown} of ${r.count}` : r.count}</span> : null}
          {r.kind === "root" ? <span className="mut"> · {r.count}</span> : null}
          {r.filterInside ? <span className="sr-only"> (your filter is inside)</span> : null}
        </span>
        {r.filterInside ? <span className="stree-in" aria-hidden="true">filter inside</span> : null}
        <Tags row={r} />
      </div>
    );
  };

  return (
    <aside className={cx("stree", dragging && "rsz", props.className)} style={{ width, ["--stree-w" as string]: `${width}px` }} aria-label="Customer tree">
      <div className="stree-h">
        <span className="stree-qw">
          <input
            ref={searchRef} className="inp" placeholder="Find by name…" autoComplete="off" value={query}
            aria-label="Filter the tree by customer, project or service name"
            onChange={(e) => { setQuery(e.target.value); setCur(null); setAmbiguous(false); setRefused(false); if (!e.target.value.trim()) setMaps((m) => ({ ...m, oq: {} })); }}
            onKeyDown={onSearchKey}
          />
          {query ? <button type="button" className="stree-qx" aria-label="Clear the search" title="Clear" onClick={clearSearch}>×</button> : null}
        </span>
        <button
          ref={colRef} type="button" className="btn sm" aria-expanded={true} aria-label="Collapse the tree to a narrow rail" title="Collapse the tree to a narrow rail"
          onClick={() => { focusAfter.current = "rail"; onRailChange(true); }}
        >«</button>
      </div>
      <button
        type="button" className="stree-prob" role="switch" aria-checked={problems}
        title="Show only customers that have an open incident or a call-order health problem"
        onClick={() => { setProblems((p) => !p); setCur(null); }}
      >
        <span className="sw"><span className="mk chk" /></span><span>Only with problems</span><span className="n">{view.problemCount}</span>
      </button>
      <div className={cx("stree-hint", refused && "warn")} role="status">{hint}</div>
      <div
        ref={treeRef} className="stree-t" role="tree" tabIndex={0} aria-label="Customers, projects and services"
        aria-activedescendant={curIdx >= 0 ? `${uid}-n${curIdx}` : undefined} onKeyDown={onTreeKey}
      >
        <div className="stree-r" role="presentation">{rows.filter((r) => r.kind === "root").map(renderRow)}</div>
        <div className="stree-s" role="presentation">
          {rows.filter((r) => r.kind !== "root").map(renderRow)}
          {real === 0 ? (
            <div className="stree-none">
              {searching ? `No customer, project or service starts with “${query.trim()}”` : problems ? "No customer has an open incident or a call-order problem." : "No customers."}
            </div>
          ) : null}
        </div>
      </div>
      <div
        className="stree-rz" role="separator" aria-orientation="vertical" tabIndex={0} title="Drag to resize"
        aria-label="Resize the tree (arrow keys, 200 to 360 px)" aria-valuemin={TREE_MIN_WIDTH} aria-valuemax={TREE_MAX_WIDTH} aria-valuenow={width}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onResizeKey}
      />
      {/* last in the tree, one line until asked for (shell-scope §2.2) */}
      <ScopeLegend open={legend} onToggle={() => setLegend((l) => !l)} />
    </aside>
  );
}
