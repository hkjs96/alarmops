"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { announceDrafts } from "@/lib/call-order/draft-store";
import { safeNextPath } from "@/lib/safe-next";
import { SESSION_ENDED_EVENT, announceSessionEnded, onOtherTabSignOut, sessionEndReason, type EndReason } from "@/lib/session-ended";
import { clearUserStorage } from "@/lib/user-storage";

/** /login?next=<this address>, the address checked by the same rule as every other `next` (lib/safe-next.ts) */
export function signInHref(loc: Pick<Location, "pathname" | "search" | "hash">): string {
  const next = safeNextPath(loc.pathname + loc.search + loc.hash, "");
  return "/login" + (next && next !== "/" ? `?next=${encodeURIComponent(next)}` : "");
}

/**
 * The state of a tab whose session is over (QA 최종 점검 P2-D, security 재검토 3 권고 1·4). It comes up when a server
 * action came back SESSION_ENDED (lib/session-ended.ts `callAction`) or when another tab signed out. It is a question
 * with one answer — Sign in, back to this address — and it cannot be put aside: what is behind it belongs to a session
 * that no longer exists, and nothing pressed there would be applied.
 *
 *   - expired / cookie gone: nothing was changed and nothing is removed; a draft is still there after signing in.
 *   - signed out in another tab: what this tab kept for the user (drafts) is removed first, as sign-out promises.
 */
export function SessionEnded() {
  const [why, setWhy] = useState<EndReason | null>(null);
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const show = () => setWhy(sessionEndReason());
    window.addEventListener(SESSION_ENDED_EVENT, show);
    const off = onOtherTabSignOut(() => {
      clearUserStorage();
      announceDrafts();
      announceSessionEnded("signed-out");
    });
    show();
    return () => { window.removeEventListener(SESSION_ENDED_EVENT, show); off(); };
  }, []);
  useEffect(() => { if (why) link.current?.focus(); }, [why]);
  if (!why) return null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // one control: Tab stays on it, Esc does not close it, and no shortcut of the screen behind hears the key
    if (e.key === "Tab" || e.key === "Escape") e.preventDefault();
    e.stopPropagation();
    link.current?.focus();
  };
  return (
    <div className="dguard-scrim sess-scrim">
      <div className="dguard" role="alertdialog" aria-modal="true" aria-labelledby="sess-h" aria-describedby="sess-b" data-testid="session-ended" data-reason={why} onKeyDown={onKey}>
        <h3 id="sess-h">{why === "signed-out" ? "You signed out in another tab — sign in again." : "Your session ended — sign in again. Nothing was changed."}</h3>
        <div id="sess-b" className="dguard-b">
          {why === "signed-out"
            ? "This tab is signed out with it. The drafts kept in this tab were removed, as signing out does."
            : `What you just pressed was not applied, and nothing else was changed.${/\/incidents?(\/|$)|\/incident\//.test(window.location.pathname) ? " Paging goes on as before: an incident you acknowledged here was not acknowledged, so its people are still being called." : ""} A draft you were writing is kept in this tab: sign in as the same person and it is offered again.`}
        </div>
        <div className="dguard-acts">
          <a ref={link} className="btn pri" data-guard-pass="" data-testid="session-sign-in" href={signInHref(window.location)}>Sign in</a>
        </div>
      </div>
    </div>
  );
}
