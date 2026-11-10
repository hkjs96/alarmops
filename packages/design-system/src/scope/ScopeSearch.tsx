"use client";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, useLayoutEffect } from "react";
import { cx } from "../cx";
import { searchScopes, type ScopeCustomerNode, type ScopeHit, type ScopeSel } from "./model";

export interface ScopeSearchProps {
  open: boolean;
  customers: ScopeCustomerNode[];
  /** the screen that gets filtered, e.g. "Incidents" */
  screen?: string;
  /** called with the chosen filter; the dialog closes */
  onPick: (sel: ScopeSel) => void;
  onClose: () => void;
}

const KIND: Record<ScopeHit["kind"], string> = { all: "Default", mine: "Filter", customer: "Customer", project: "Project", service: "Service" };

/**
 * "Filter to…" (Ctrl/⌘K, E14): the same filter as the tree, set by name. My customers first, the customer in bold on
 * every row. When several customers share the typed name nothing is preselected: Enter does nothing until one is chosen.
 */
export function ScopeSearch({ open, customers, screen = "this screen", onPick, onClose }: ScopeSearchProps) {
  const uid = useId();
  const [q, setQ] = useState("");
  const [cur, setCur] = useState<number | null>(null); // null = not moved yet: the view's preselection applies
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const view = useMemo(() => searchScopes(customers, q), [customers, q]);

  // Layout effect: the old query is gone before the first key can land in the box (typing right after Ctrl/⌘K used to append to it)
  useLayoutEffect(() => {
    if (!open) return;
    setQ("");
    setCur(null);
    const prev = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => prev?.focus?.();
  }, [open]);

  const idx = cur ?? view.preselect;
  useEffect(() => {
    if (open && idx >= 0) document.getElementById(`${uid}-o${idx}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, uid, idx]);

  if (!open) return null;
  const n = view.flat.length;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); if (n) setCur(idx < 0 ? 0 : Math.min(n - 1, idx + 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); if (n) setCur(idx < 0 ? n - 1 : Math.max(0, idx - 1)); return; }
    if (e.key === "Enter" && e.target === inputRef.current) {
      e.preventDefault();
      const h = view.flat[idx];
      if (h) onPick(h.sel); // nothing preselected and nothing chosen: Enter does nothing
      return;
    }
    if (e.key === "Tab") {
      const f = Array.from(boxRef.current?.querySelectorAll<HTMLElement>("input, button.ssearch-close") ?? []).filter((el) => el.offsetParent !== null || el === inputRef.current);
      if (f.length <= 1) { e.preventDefault(); inputRef.current?.focus(); return; }
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  let at = -1;
  return (
    <div className="ssearch-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={boxRef} className="ssearch" role="dialog" aria-modal="true" aria-label="Filter to a customer, project or service" onKeyDown={onKey}>
        <div className="ssearch-top">
          <b>Filter {screen} to…</b>
          <button type="button" className="btn ssearch-close" onClick={onClose}>Close</button>
        </div>
        <input
          ref={inputRef} className="ssearch-q" placeholder="Customer, project or service…" autoComplete="off" value={q}
          role="combobox" aria-expanded={true} aria-controls={`${uid}-l`} aria-autocomplete="list"
          aria-activedescendant={idx >= 0 ? `${uid}-o${idx}` : undefined} aria-label="Customer, project or service name"
          onChange={(e) => { setQ(e.target.value); setCur(null); }}
        />
        {view.ambiguous.length ? (
          <div className="ssearch-amb" role="alert">
            {view.ambiguous.length} customers have a match for “{q.trim()}”: {view.ambiguous.slice(0, 6).map((name, i) => <span key={name}>{i ? ", " : ""}<b>{name}</b></span>)}
            {view.ambiguous.length > 6 ? ` and ${view.ambiguous.length - 6} more` : ""}. Nothing is selected — choose one, or type the customer name too.
          </div>
        ) : null}
        <div className="ssearch-l" id={`${uid}-l`} role="listbox" aria-label="Matches">
          {n === 0 ? <div className="ssearch-none">No customer, project or service starts with “{q.trim()}”</div> : null}
          {view.groups.map((g, gi) => (
            <div key={gi} role="group" aria-label={g.label || "Without a customer"}>
              {g.label ? <div className="ssearch-g" aria-hidden="true">{g.label}</div> : null}
              {g.hits.map((h) => {
                at++;
                const i = at;
                return (
                  <div
                    key={h.key} id={`${uid}-o${i}`} role="option" aria-selected={i === idx} data-key={h.key}
                    className={cx("ssearch-o", i === idx && "cur")} onClick={() => onPick(h.sel)} onMouseMove={() => { if (cur !== i) setCur(i); }}
                  >
                    <span className="k">{KIND[h.kind]}</span>
                    <span className="x">
                      <span className="p">{h.path.map((p, pi) => <span key={pi}>{pi ? <span className="chain" aria-hidden="true">›</span> : null}{pi === 0 ? <b>{p}</b> : p}</span>)}</span>
                      {h.sub ? <span className="s">{h.sub}</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="ssearch-f" aria-hidden="true">
          <span><span className="kbd">↑↓</span> move</span><span><span className="kbd">Enter</span> filter {screen} to it</span><span><span className="kbd">Esc</span> close</span>
        </div>
      </div>
    </div>
  );
}
