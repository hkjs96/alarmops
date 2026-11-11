"use client";
import { createContext, useContext, useLayoutEffect } from "react";
import type { ScopeCustomerNode, ScopeSel } from "@alarmops/design-system";
import type { OutsideCounts, Role } from "@/lib/api/types";
import { roleAtLeast } from "@/lib/roles";

export interface ToastAction { label: string; href?: string; onAction?: () => void }
export type LocalMark = "RESOLVED" | "REOPENED";
export interface ShellUser { id: string; name: string; role: Role }
/** What the console offers follows GET /me; what is allowed is decided by the API (a 403 is worded by lib/errors.ts). */
export const hasRole = (user: Pick<ShellUser, "role">, min: Role): boolean => roleAtLeast(user.role, min);
/** Why an action is not offered: "Changing the call order needs the Admin role. You are signed in as Operator." */
export function roleReason(user: Pick<ShellUser, "role">, min: Role, what: string): string {
  const n: Record<Role, string> = { ADMIN: "Admin", OPERATOR: "Operator", VIEWER: "Viewer" };
  return `${what} needs the ${n[min]} role. You are signed in as ${n[user.role]}.`;
}
export interface ShellApi {
  /** the signed-in user (GET /me): id for what is kept per user in the browser, role for what to offer */
  user: ShellUser;
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
  /** what the user did in this visit to an incident that may have left the list: its row stays and says so */
  marks: Readonly<Record<string, LocalMark>>;
  mark: (id: string, m: LocalMark | null) => void;
  /** the incidents list's on-screen order (lib/stable-list.ts). Kept here so opening or closing a panel does not re-sort it; dropped on leaving Incidents. */
  listView: { current: unknown };
  setOutside: (o: OutsideCounts | null) => void;
  /** the scope tree (customer › project › service with ownSteps, callHealth, openIncidents) the shell was rendered with */
  customers: readonly ScopeCustomerNode[];
  /** the tree's "Only with problems" switch; lists that follow it (Call order) read it here */
  problemsOnly: boolean;
  /** the Call order list's on-screen row order, kept while the user stays in Call order (list ↔ panel) */
  callOrderView: { current: unknown };
  /**
   * Every way out of the current view goes through this (shell-scope §6): with an unsaved edit registered, the edit's
   * own Save / Keep draft / Discard dialog decides whether `proceed` runs; without one it runs at once.
   */
  requestLeave: (proceed: () => void, leavingTo?: string) => void;
  /** an editor with unsaved changes registers here; null when it is clean or gone */
  setLeaveGuard: (guard: LeaveGuard | null) => void;
}
/** `leavingTo` of the one exit that cannot keep a draft: sign-out removes what this tab kept for the user */
export const SIGN_OUT = "sign out";
export type LeaveGuard = (proceed: () => void, leavingTo?: string) => void;

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
