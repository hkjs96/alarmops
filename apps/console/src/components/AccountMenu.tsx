"use client";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@alarmops/design-system";
import type { Role } from "@/lib/api/types";
import { clearUserStorage } from "@/lib/user-storage";
import { useShell } from "./ShellContext";

export const ROLE_NAME: Record<Role, string> = { ADMIN: "Admin", OPERATOR: "Operator", VIEWER: "Viewer" };

/**
 * Who is signed in, with what role, and Sign out. Signing out removes what the console kept in this tab for the user
 * (drafts and the other `ao-…` sessionStorage keys) and then the session cookie (POST /auth/sign-out). An unsaved edit
 * is asked about first, like every other way out.
 */
export function AccountMenu({ name, role }: { name: string; role: Role }) {
  const shell = useShell();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); box.current?.querySelector<HTMLElement>("button")?.focus(); } };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc); };
  }, [open]);
  const signOut = () => shell.requestLeave(() => { clearUserStorage(); form.current?.submit(); }, "sign out");
  return (
    <div className="acct" ref={box}>
      <button type="button" className="acct-b" aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${name}, ${ROLE_NAME[role]}`} data-testid="account" onClick={() => setOpen((v) => !v)}>
        <Avatar name={name} active />
      </button>
      {open ? (
        <div className="acct-m" role="menu" aria-label="Account">
          <div className="acct-n"><b>{name}</b><span className="sm mut" data-testid="account-role">{ROLE_NAME[role]}</span></div>
          <form ref={form} method="post" action="/auth/sign-out" onSubmit={(e) => { e.preventDefault(); signOut(); }}>
            <button type="submit" role="menuitem" className="btn acct-out" data-testid="sign-out">Sign out</button>
          </form>
          <div className="xs mut">Signing out removes the drafts kept in this tab.</div>
        </div>
      ) : null}
    </div>
  );
}
