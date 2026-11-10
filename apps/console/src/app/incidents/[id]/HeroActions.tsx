"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Banner, Button } from "@alarmops/design-system";
import type { IncidentStatus } from "@/lib/api/types";
import { useShell } from "@/components/ShellContext";
import { kstTime } from "@/lib/format";
import { ackIncident, escalateIncident, resolveIncident, undoBulk } from "../actions";

/** After Acknowledge the primary button's place only says "Acknowledged ✓ 03:16" this long before Resolve… is offered there. */
export const ACK_SETTLE_MS = 5000;

/**
 * The incident's actions in the panel. One primary spot: Acknowledge (Triggered) → a label that does nothing for 5 s →
 * Resolve…, which asks first. Nothing that changes the incident ever appears under the finger that just acknowledged
 * (QA P1-2, P2-A): Mute and Escalate keep their places (Escalate is switched off, not removed), and Undo is a link on
 * its own line below, at the other side from the primary spot. It is also in the toast and in the list row's "…".
 */
export function HeroActions({ id, title, pathText, status, version, canEscalate, acknowledgedAt }: {
  id: string; title: string;
  /** "Mirae Pay › Core › Payments API", or "an unmapped account" */
  pathText: string;
  status: IncidentStatus; version: number; canEscalate: boolean; acknowledgedAt?: string | null;
}) {
  const router = useRouter();
  const shell = useShell();
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<{ conflict: boolean; msg: string } | null>(null);
  const [fresh, setFresh] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const spotRef = useRef<HTMLSpanElement>(null);
  const resolveRef = useRef<HTMLButtonElement>(null);
  const ackRef = useRef<HTMLButtonElement>(null);
  /** the primary spot is about to change what it holds: keep the keyboard focus on it */
  const refocus = useRef(false);
  const token = shell.acks[id];

  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => { refocus.current = document.activeElement === spotRef.current; setFresh(false); }, ACK_SETTLE_MS);
    return () => clearTimeout(t);
  }, [fresh]);
  useEffect(() => { if (confirm) keepRef.current?.focus(); }, [confirm]);
  // another incident in the same panel slot starts clean
  useEffect(() => { setFresh(false); setConfirm(false); setErr(null); }, [id]);
  useEffect(() => {
    if (!refocus.current) return;
    const el = spotRef.current ?? resolveRef.current ?? (pending ? null : ackRef.current); // while it is being sent, wait for what replaces the button
    if (el) { el.focus(); refocus.current = false; }
  });

  const fail = (r: { code: string; message: string }) => setErr({ conflict: r.code === "VERSION_CONFLICT", msg: r.message || "Failed." });
  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    try { await fn(); } finally { setPending(false); }
    router.refresh();
  };
  const undo = (t: string) => run(async () => {
    const r = await undoBulk(t);
    shell.setAck(id, null);
    setFresh(false);
    if (!r.ok) fail(r);
    else { setErr(null); shell.mark(id, "REOPENED"); shell.toast(`Acknowledge undone in ${pathText} · paging continues`); }
  });
  const ack = () => {
    refocus.current = document.activeElement === ackRef.current;
    return run(async () => {
      const r = await ackIncident(id, version);
      if (!r.ok) fail(r);
      else {
        const t = r.data.undoToken;
        setErr(null);
        setFresh(true);
        shell.setAck(id, t);
        shell.mark(id, null);
        shell.toast(`Acknowledged in ${pathText} · ${title}`, { label: "Undo", onAction: () => { void undo(t); } });
      }
    });
  };
  const escalate = () => run(async () => {
    const r = await escalateIncident(id, version);
    if (!r.ok) fail(r); else setErr(null);
  });
  const resolve = () => run(async () => {
    const r = await resolveIncident(id, version);
    if (!r.ok) fail(r);
    else { setErr(null); shell.setAck(id, null); shell.mark(id, "RESOLVED"); }
    setConfirm(false);
  });

  if (status === "RESOLVED") return null;
  const acked = fresh || status === "ACKNOWLEDGED";
  return (
    <div className="hero-actions-wrap">
      {confirm ? (
        <div className="resolve-ask" role="alertdialog" aria-labelledby="resolve-ask-t" aria-describedby="resolve-ask-d"
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setConfirm(false); } }}>
          <div id="resolve-ask-t" className="b">Resolve this incident in {pathText}?</div>
          <div id="resolve-ask-d" className="sm mut">{title} · It leaves the active list for everyone. Paging does not start again unless the alarm fires again.</div>
          <div className="row hero-actions">
            <Button variant="danger" onClick={() => { void resolve(); }} disabled={pending}>Resolve incident</Button>
            {/* where Resolve was: a second tap keeps the incident open */}
            <Button ref={keepRef} variant="primary" size="lg" onClick={() => setConfirm(false)} disabled={pending}>Keep it open</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="row hero-actions">
            <Button disabled title="Maintenance windows are not built yet">Mute 1h</Button>
            <Button onClick={() => { void escalate(); }} disabled={pending || !canEscalate || acked} title={acked ? "Acknowledged: paging has stopped" : undefined}>Escalate now</Button>
            {!acked ? (
              <Button ref={ackRef} variant="primary" size="lg" onClick={() => { void ack(); }} disabled={pending}>Acknowledge</Button>
            ) : fresh ? (
              <span ref={spotRef} className="ack-spot" role="status" tabIndex={-1} data-testid="panel-acked">
                <span><span className="ack-spot-w">Acknowledged <span aria-hidden="true">✓</span></span>{acknowledgedAt ? <> <span className="ack-spot-t">{kstTime(acknowledgedAt)}</span></> : null}</span>
              </span>
            ) : (
              <Button ref={resolveRef} variant="primary" size="lg" onClick={() => { shell.clearToast(); setConfirm(true); }} disabled={pending} aria-haspopup="dialog">Resolve…</Button>
            )}
          </div>
          {acked && token ? (
            <div className="hero-sub">
              <button type="button" className="lnk-btn" onClick={() => { void undo(token); }} disabled={pending} data-testid="panel-undo">Undo acknowledge</button>
              <span className="sm mut">paging starts again</span>
            </div>
          ) : null}
        </>
      )}
      {err ? (
        <div style={{ marginTop: 10 }}>
          <Banner tone="red" action={<Button size="sm" onClick={() => { setErr(null); router.refresh(); }}>Reload</Button>}>
            {err.conflict ? "Someone else updated this incident. Nothing was changed — reload to see it as it is now." : err.msg}
          </Banner>
        </div>
      ) : null}
    </div>
  );
}
