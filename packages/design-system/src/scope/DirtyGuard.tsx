"use client";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface DirtyGuardProps {
  open: boolean;
  /** full path of what is being edited, customer first: "Mirae Pay › Core" */
  scopeLabel: string;
  /** what the user tried to do, e.g. "change the filter"; shapes the Keep draft label */
  leavingTo?: string;
  body?: ReactNode;
  onSave: () => void;
  onKeepDraft: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/** The one dialog for every way out of an unsaved edit (E15): Save / Keep draft / Discard / Cancel. */
export function DirtyGuard({ open, scopeLabel, leavingTo, body, onSave, onKeepDraft, onDiscard, onCancel }: DirtyGuardProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => prev?.focus?.();
  }, [open]);
  if (!open) return null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (e.key !== "Tab") return;
    const f = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const first = f[0];
    const last = f[f.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="dguard-scrim">
      <div ref={ref} className="dguard" role="alertdialog" aria-modal="true" aria-labelledby="dguard-h" aria-describedby="dguard-b" onKeyDown={onKey}>
        <h3 id="dguard-h">Unsaved changes for {scopeLabel}</h3>
        <div id="dguard-b" className="dguard-b">
          {body ?? "Nothing has been saved yet. Save it, keep it as a draft for later, or discard it."}
        </div>
        <div className="dguard-acts">
          <button type="button" className="btn pri" onClick={onSave}>Save for {scopeLabel}</button>
          <button type="button" className="btn" onClick={onKeepDraft}>{leavingTo ? `Keep draft and ${leavingTo}` : "Keep draft"}</button>
          <button type="button" className="btn danger" onClick={onDiscard}>Discard changes</button>
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
