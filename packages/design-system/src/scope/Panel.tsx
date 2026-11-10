"use client";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../cx";
import { initials } from "../severity";

export interface PanelProps {
  /** what the panel shows, e.g. "Incident" */
  kind: string;
  /** full path, customer first: ["Mirae Pay", "Core", "Payments API"]. null = no customer (pathLabel is shown) */
  path: string[] | null;
  /** shown instead of the path when there is none, e.g. "Unmapped account" */
  pathLabel?: string;
  /** one line inside the band, e.g. the panel is outside the list filter */
  note?: ReactNode;
  onClose: () => void;
  /** copies the panel's own address (without the list filter); resolves when copied */
  onCopyLink?: () => void | Promise<void>;
  /** focus the heading when the panel appears (default true) */
  autoFocus?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * Side panel for one scoped thing (E4). Neutral header band: initials + full path, Copy link, close.
 * When the layout has no room beside the list, CSS makes it the whole view and shows "← Back to the list".
 */
export function Panel({ kind, path, pathLabel, note, onClose, onCopyLink, autoFocus = true, children, footer, className }: PanelProps) {
  const head = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  const key = path?.join("/") ?? pathLabel ?? "";
  useEffect(() => {
    if (autoFocus) head.current?.focus({ preventScroll: true });
  }, [autoFocus, key]);
  const copy = async () => {
    try {
      await onCopyLink?.();
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); }
  };
  return (
    <aside className={cx("panel", className)} aria-label="Detail panel" onKeyDown={onKey} data-testid="panel">
      <div className="panel-back"><button type="button" className="btn ghost" onClick={onClose}>← Back to the list</button></div>
      <header className="panel-band">
        <span className={cx("panel-id", !path && "none")} aria-hidden="true">{path ? initials(path[0] ?? "") : "–"}</span>
        <div className="panel-tt">
          <div className="ov">{kind}</div>
          <h2 ref={head} tabIndex={-1} className="panel-path" data-testid="panel-path">
            {path ? path.map((p, n) => (
              // the › stays with the name before it, so a wrapped line never starts with a separator
              <span key={n}>{n === 0 ? <b>{p}</b> : p}{n < path.length - 1 ? <span className="chain" aria-hidden="true">›</span> : null}</span>
            )) : <b>{pathLabel ?? "—"}</b>}
          </h2>
          {note ? <div className="panel-note">{note}</div> : null}
        </div>
        <div className="panel-acts">
          {onCopyLink ? <button type="button" className="btn sm" onClick={copy}>{copied ? "Copied" : "Copy link"}</button> : null}
          <button type="button" className="btn sm panel-x" aria-label="Close panel" title="Close (Esc)" onClick={onClose}><span className="panel-xl">Close </span>×</button>
        </div>
        <span className="sr-only" role="status">{copied ? "Link copied" : ""}</span>
      </header>
      <div className="panel-body">{children}</div>
      {footer ? <div className="panel-foot">{footer}</div> : null}
    </aside>
  );
}
