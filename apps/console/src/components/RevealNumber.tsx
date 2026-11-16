"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@alarmops/design-system";
import type { RevealChannel } from "@/lib/api/types";
import { errorLine } from "@/lib/errors";
import { callAction } from "@/lib/session-ended";
import { revealContact } from "@/app/reveal/actions";

/** How long a full value stays on screen (D-35). After that, or on leaving the tab or the page, the masked text is back. */
export const REVEAL_SHOW_MS = 30_000;
const REASON_MAX = 500;
const LABEL: Record<RevealChannel, string> = { PHONE: "Number", EMAIL: "Email", SLACK: "Slack" };
const WHAT: Record<RevealChannel, string> = { PHONE: "number", EMAIL: "email", SLACK: "Slack handle" };

interface Shown { value: string; mode: "NORMAL" | "EMERGENCY"; until: number }

/**
 * One contact value (phone or email): the masked text, and — when the API says the caller may (`canReveal`) — a
 * "Show number" button that calls POST /contacts/{id}/reveal. D-35:
 *  - the server decides the mode; `requiresReason` (a MSP ADMIN who is not this customer's responder) asks for a typed reason first;
 *  - the full value lives only in this component's state, for REVEAL_SHOW_MS. It goes back to the masked text on the
 *    timer, on "Hide", when the tab is hidden and when the component goes away (navigation). It is never put in a
 *    URL, storage, a data attribute or the console log;
 *  - every press is logged by the API; the line under the value says so.
 */
export function RevealNumber({ contactId, name, customerName, channel, canReveal, requiresReason, hasPrimary = true, testId = "reveal" }: {
  contactId: string; name: string; customerName: string; channel: RevealChannel;
  canReveal: boolean; requiresReason: boolean;
  /** the customer has someone to notify about an emergency reveal (from the Responders list); false = say so instead of promising it */
  hasPrimary?: boolean; testId?: string;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  /** what a screen reader is told: once when the value appears, once when it hides — never the countdown */
  const [say, setSay] = useState("");
  const alive = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const errBox = useRef<HTMLDivElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const hide = useCallback(() => { setShown((s) => { if (s) setSay("Value hidden again."); return null; }); setReason(""); }, []);
  // re-mask on the timer; a hidden tab masks at once
  useEffect(() => {
    if (!shown) return;
    const tick = () => { const ms = shown.until - Date.now(); if (ms <= 0) hide(); else setLeft(Math.ceil(ms / 1000)); };
    tick();
    const t = setInterval(tick, 500);
    const onVis = () => { if (document.visibilityState === "hidden") hide(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", hide);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("pagehide", hide); };
  }, [shown, hide]);
  useEffect(() => { if (err) errBox.current?.focus({ preventScroll: true }); }, [err]);

  async function go(why?: string) {
    if (busy) return;
    setBusy(true); setErr(null);
    const r = await callAction(() => revealContact(contactId, channel, why));
    if (!alive.current) return;
    setBusy(false);
    if (!r.ok) {
      setAsking(requiresReason && r.code === "EMERGENCY_REASON_REQUIRED");
      setErr(errorLine(r, { what: `Showing the ${WHAT[channel]}`, where: customerName }));
      return;
    }
    setAsking(false); setReason("");
    setSay(`${LABEL[channel]} of ${name} shown for 30 seconds. ${r.data.mode === "EMERGENCY" ? "Emergency reveal, logged." : "Logged."}`);
    setShown({ value: r.data.value, mode: r.data.mode, until: Date.now() + REVEAL_SHOW_MS });
    // the value may lie under the top or bottom bar on a phone: bring it into view, and keep the focus on Hide
    setTimeout(() => { trigger.current?.focus({ preventScroll: true }); trigger.current?.scrollIntoView({ block: "center", behavior: "auto" }); }, 0);
  }

  const word = channel === "PHONE" ? "Show number" : channel === "EMAIL" ? "Show email" : "Show Slack handle";
  const reasonOk = reason.trim().length > 0 && reason.trim().length <= REASON_MAX;

  return (
    <span className="rv" data-testid={testId} data-revealed={shown ? "1" : "0"}>
      <span className="sr-only" role="status" data-testid={`${testId}-live`}>{say}</span>
      {shown ? (
        <>
          <span className="xs mut">{LABEL[channel]}</span>
          <span className="mono rv-value" data-testid={`${testId}-value`}>{shown.value}</span>
          <button type="button" className="btn sm rv-btn" data-testid={`${testId}-hide`} ref={trigger} onClick={hide}>Hide</button>
          {/* said once, when the value appears (and once more when it hides); the countdown is for the eyes only */}
          <span className="xs mut rv-note" data-testid={`${testId}-note`}>
            {shown.mode === "EMERGENCY" ? <>Emergency reveal · logged · {hasPrimary ? <>{customerName}’s primary responder notified</> : "no primary responder is set"}</> : <>Shown to you · logged</>}
            <span aria-hidden="true">{" · "}hides in {left} s</span>
          </span>
        </>
      ) : (
        <>
          {canReveal ? (
            <button type="button" className="btn sm rv-btn" data-testid={`${testId}-show`} ref={trigger} disabled={busy} aria-label={requiresReason ? `${word} for ${name} (emergency, logged)` : `${word} for ${name} (logged)`}
              aria-haspopup={requiresReason ? "dialog" : undefined}
              onClick={() => { if (requiresReason) { setErr(null); setReason(""); setAsking(true); } else void go(); }}>
              {busy ? "Opening…" : requiresReason ? `${word} (emergency)…` : word}
            </button>
          ) : null}
        </>
      )}
      {err && !asking ? <span className="co-err rv-err" role="alert" tabIndex={-1} ref={errBox} data-testid={`${testId}-err`}>{err}</span> : null}
      <ConfirmDialog
        open={asking} title={`${word} for ${name}?`} busy={busy} confirmDisabled={!reasonOk} defaultFocus="field"
        confirmLabel={busy ? "Working…" : `${word} and log`} cancelLabel="Cancel"
        onConfirm={() => { if (reasonOk) void go(reason.trim()); }} onCancel={() => { if (!busy) { setAsking(false); setErr(null); setTimeout(() => trigger.current?.focus(), 0); } }}
      >
        <p style={{ marginTop: 0 }} data-testid="reveal-explain">You are not a responder for {customerName}. Tell us why you need this contact.</p>
        <label className="cs-f"><span className="b sm">Reason (required)</span>
          <textarea className="inp cs-ta" data-testid="reveal-reason" rows={3} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="reveal-reason-n" />
        </label>
        <span className="xs mut" id="reveal-reason-n">{hasPrimary ? `${customerName}’s primary responder will be notified.` : "No primary responder is set; other admins will be notified."} The reveal is logged with your name and this reason. Up to {REASON_MAX} characters.</span>
        {err ? <div className="co-err cs-errbox" role="alert" data-testid="reveal-dialog-err"><span>{err}</span></div> : null}
      </ConfirmDialog>
    </span>
  );
}
