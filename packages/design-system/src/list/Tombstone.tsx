"use client";
import type { MouseEvent, ReactNode } from "react";
import { isSameSpot, markSpot } from "./same-spot";

export interface TombstoneProps {
  /** what happened to the row: "Removed", "Own steps removed" */
  label: ReactNode;
  /** who or what it was, for the Undo button's accessible name: "Junho Park" */
  name: string;
  detail?: ReactNode;
  /** absent: the row cannot be put back from here */
  onUndo?: () => void;
  busy?: boolean;
  undoLabel?: string;
  /** name of the list action, for the e2e rule (assertNoRowShift covers every data-list-action) */
  action?: string;
}

/**
 * What a removed row leaves in its place ("Removed · Undo") until the list is refreshed or left. It goes where the
 * row's text was — never where the row's buttons were — so the pointer that pressed Remove is not over Undo.
 */
export function Tombstone({ label, name, detail, onUndo, busy, undoLabel = "Undo", action }: TombstoneProps) {
  const undo = (e: MouseEvent) => { if (isSameSpot(e)) return; markSpot(e); onUndo?.(); };
  return (
    <span className="tomb" role="status" data-testid="tombstone">
      <span className="tomb-t"><b>{label}</b>{detail ? <span className="tomb-d"> · {detail}</span> : null}</span>
      {onUndo ? <button type="button" className="btn sm tomb-u" disabled={busy} data-list-action={action} aria-label={`${undoLabel}: put ${name} back`} onClick={undo}>{busy ? "Undoing…" : undoLabel}</button> : null}
    </span>
  );
}
