"use client";
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cx } from "../cx";
import { isSameSpot, markSpot } from "../list/same-spot";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  /** the action, with the full path in it: "Save for Mirae Pay" */
  confirmLabel: string;
  cancelLabel?: string;
  /**
   * which button has the focus when the dialog opens. The default is the safe choice ("cancel"): Enter held down, or
   * pressed once too often, keeps things as they are. "confirm" only for a step that changes nothing by itself.
   */
  defaultFocus?: "confirm" | "cancel" | "field";
  /** the confirm button stays off until the form inside is complete (a reason, a typed name). The cancel button never is. */
  confirmDisabled?: boolean;
  /** shown first and loud: what this would break ("Nobody for Daon Retail would be reached") */
  warning?: ReactNode;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation for a change that reaches more than one thing, or that widens or discards (E6, E9): what changes,
 * before → after, the list it reaches. Tab stays inside, Esc cancels, focus returns to where it was.
 */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = "Cancel", defaultFocus = "cancel", confirmDisabled, warning, danger, busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    // "field": the first text field of the form inside, so a keyboard user starts typing; without one, the safe choice
    const field = defaultFocus === "field" ? ref.current?.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled])") : null;
    (field ?? ref.current?.querySelector<HTMLButtonElement>(`button[data-role="${defaultFocus === "field" ? "cancel" : defaultFocus}"]`))?.focus();
    return () => prev?.focus?.();
  }, [open, defaultFocus]);
  if (!open) return null;
  // The dialog closes on either button and whatever lies behind it comes up under the pointer: a second press at the
  // same spot must not reach it (list/same-spot). The dialog itself may have come up under a double click too.
  const press = (fn: () => void) => (e: MouseEvent) => { if (isSameSpot(e)) return; markSpot(e); fn(); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (e.key !== "Tab") { e.stopPropagation(); return; }
    const f = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled])") ?? []);
    const first = f[0];
    const last = f[f.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    // a press beside the buttons (a second click or tap that was meant for what is behind) does not take the focus off the safe choice
    <div className="dguard-scrim" onMouseDown={(e) => { if (!(e.target as HTMLElement).closest("button, a[href], input, select, textarea")) e.preventDefault(); }}>
      <div ref={ref} className="dguard cdlg" role="alertdialog" aria-modal="true" aria-labelledby="cdlg-h" aria-describedby="cdlg-b" onKeyDown={onKey} data-testid="confirm-dialog">
        <h3 id="cdlg-h">{title}</h3>
        <div id="cdlg-b" className="dguard-b cdlg-b">
          {warning ? <div className="cdlg-warn" role="alert" data-testid="confirm-warning">{warning}</div> : null}
          {children}
        </div>
        <div className="dguard-acts">
          <button type="button" data-role="confirm" className={cx("btn", danger ? "danger" : "pri")} disabled={busy || confirmDisabled} onClick={press(onConfirm)}>{confirmLabel}</button>
          <button type="button" data-role="cancel" className="btn" onClick={press(onCancel)}>{cancelLabel}</button>
        </div>
      </div>
    </div>
  );
}
