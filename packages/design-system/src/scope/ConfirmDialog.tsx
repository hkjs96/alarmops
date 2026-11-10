"use client";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../cx";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  /** the action, with the full path in it: "Save for Mirae Pay" */
  confirmLabel: string;
  cancelLabel?: string;
  /** which button has the focus when the dialog opens. "cancel" for steps that widen or discard. */
  defaultFocus?: "confirm" | "cancel";
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation for a change that reaches more than one thing, or that widens or discards (E6, E9): what changes,
 * before → after, the list it reaches. Tab stays inside, Esc cancels, focus returns to where it was.
 */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = "Cancel", defaultFocus = "confirm", danger, busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>(`button[data-role="${defaultFocus}"]`)?.focus();
    return () => prev?.focus?.();
  }, [open, defaultFocus]);
  if (!open) return null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (e.key !== "Tab") { e.stopPropagation(); return; }
    const f = Array.from(ref.current?.querySelectorAll<HTMLElement>("button, a[href]") ?? []);
    const first = f[0];
    const last = f[f.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="dguard-scrim">
      <div ref={ref} className="dguard cdlg" role="alertdialog" aria-modal="true" aria-labelledby="cdlg-h" aria-describedby="cdlg-b" onKeyDown={onKey} data-testid="confirm-dialog">
        <h3 id="cdlg-h">{title}</h3>
        <div id="cdlg-b" className="dguard-b cdlg-b">{children}</div>
        <div className="dguard-acts">
          <button type="button" data-role="confirm" className={cx("btn", danger ? "danger" : "pri")} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
          <button type="button" data-role="cancel" className="btn" onClick={onCancel}>{cancelLabel}</button>
        </div>
      </div>
    </div>
  );
}
