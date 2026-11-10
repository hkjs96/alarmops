"use client";
import { createContext, useContext, useLayoutEffect } from "react";
import type { ScopeSel } from "@alarmops/design-system";
import type { OutsideCounts } from "@/lib/api/types";

export interface ToastAction { label: string; href?: string; onAction?: () => void }
export interface ShellApi {
  /** current list filter (empty when the address has none or it is not valid) */
  sel: ScopeSel;
  /** "Mirae Pay › Core", "My customers" or "All customers" */
  label: string;
  filtered: boolean;
  totalCustomers: number;
  toast: (text: string, action?: ToastAction) => void;
  /** takes the toast away (a sheet or a confirmation is opening: nothing may lie over its buttons) */
  clearToast: () => void;
  /** incidents acknowledged in this visit, id → undo token. The row, the card and the panel share it, so Undo is offered wherever the incident shows. */
  acks: Readonly<Record<string, string>>;
  setAck: (id: string, undoToken: string | null) => void;
  setOutside: (o: OutsideCounts | null) => void;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const v = useContext(ShellContext);
  if (!v) throw new Error("useShell must be used inside ScopeShell");
  return v;
}

/** A page hands its "outside this view" counts to the filter line, which lives in the shell. */
export function OutsideSlot({ counts }: { counts: OutsideCounts | null }) {
  const { setOutside } = useShell();
  const key = counts ? `${counts.open}/${counts.unmapped}/${counts.acknowledged}` : "";
  useLayoutEffect(() => {
    setOutside(counts);
    return () => setOutside(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setOutside]);
  return null;
}

/** States the current filter inside a page body (stub screens). */
export function ScopeEcho() {
  const { label } = useShell();
  return <b data-testid="scope-echo">{label}</b>;
}
