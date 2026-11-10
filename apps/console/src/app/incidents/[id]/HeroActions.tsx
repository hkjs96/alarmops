"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type MouseEvent } from "react";
import { Banner, Button } from "@alarmops/design-system";
import type { IncidentStatus } from "@/lib/api/types";
import { useShell } from "@/components/ShellContext";
import { ackIncident, escalateIncident, resolveIncident, undoBulk } from "../actions";

/** Undo does nothing this soon after Acknowledge: it appears where Acknowledge was, possibly under a second tap. */
export const UNDO_ARM_MS = 600;
/** After Acknowledge the primary button's place says "Acknowledged ✓ · Undo" this long before Resolve is offered. */
export const ACK_SETTLE_MS = 5000;

/**
 * The incident's actions in the panel. One primary button: Acknowledge (Triggered) → Resolve (Acknowledged).
 * Acknowledge works like the list row: a toast with the full path and Undo, and the list row shows it too.
 * Resolve never appears under the finger that just acknowledged (QA P1-2): the spot shows "Acknowledged ✓ · Undo"
 * for 5 s first, and Resolve asks before it closes the incident.
 */
export function HeroActions({ id, title, pathText, status, version, canEscalate }: {
  id: string; title: string;
  /** "Mirae Pay › Core › Payments API", or "an unmapped account" */
  pathText: string;
  status: IncidentStatus; version: number; canEscalate: boolean;
}) {
  const router = useRouter();
  const shell = useShell();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<{ conflict: boolean; msg: string } | null>(null);
  const [fresh, setFresh] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const ackedAt = useRef(0);
  const token = shell.acks[id];

  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(false), ACK_SETTLE_MS);
    return () => clearTimeout(t);
  }, [fresh]);
  useEffect(() => { if (confirm) keepRef.current?.focus(); }, [confirm]);
  // another incident in the same panel slot starts clean
  useEffect(() => { setFresh(false); setConfirm(false); setErr(null); }, [id]);

  const fail = (r: { code: string; message: string }) => setErr({ conflict: r.code === "VERSION_CONFLICT", msg: r.message || "Failed." });
  const undoPress = (t: string, e: MouseEvent) => {
    if (e.detail > 0 && performance.now() - ackedAt.current < UNDO_ARM_MS) return; // the second half of a double tap
    undo(t);
  };
  const undo = (t: string) => start(async () => {
    const r = await undoBulk(t);
    shell.setAck(id, null);
    setFresh(false);
    if (!r.ok) fail(r);
    else { setErr(null); shell.toast(`Acknowledge undone in ${pathText} · paging continues`); }
    router.refresh();
  });
  const ack = () => start(async () => {
    ackedAt.current = performance.now();
    const r = await ackIncident(id, version);
    ackedAt.current = performance.now();
    if (!r.ok) fail(r);
    else {
      const t = r.data.undoToken;
      setErr(null);
      setFresh(true);
      shell.setAck(id, t);
      shell.toast(`Acknowledged in ${pathText} · ${title}`, { label: "Undo", onAction: () => undo(t) });
    }
    router.refresh();
  });
  const simple = (fn: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>) => start(async () => {
    const r = await fn();
    if (!r.ok) fail(r);
    else setErr(null);
    setConfirm(false);
    router.refresh();
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
            <Button variant="danger" onClick={() => simple(() => resolveIncident(id, version))} disabled={pending}>Resolve incident</Button>
            {/* where Resolve was: a second tap keeps the incident open */}
            <Button ref={keepRef} variant="primary" size="lg" onClick={() => setConfirm(false)} disabled={pending}>Keep it open</Button>
          </div>
        </div>
      ) : (
        <div className="row hero-actions">
          <Button disabled title="Maintenance windows are not built yet">Mute 1h</Button>
          {!acked ? <Button onClick={() => simple(() => escalateIncident(id))} disabled={pending || !canEscalate}>Escalate now</Button> : null}
          {!acked ? (
            <Button variant="primary" size="lg" onClick={ack} disabled={pending}>Acknowledge</Button>
          ) : fresh ? (
            <span className="ack-state big" role="status" data-testid="panel-acked">
              <span className="ack-done">Acknowledged <span aria-hidden="true">✓</span></span>
              <span className="chain" aria-hidden="true">·</span>
              {token ? <Button onClick={(e) => undoPress(token, e)} disabled={pending} aria-label="Undo acknowledge">Undo</Button> : null}
            </span>
          ) : (
            <>
              {token ? <Button variant="ghost" onClick={() => undo(token)} disabled={pending}>Undo acknowledge</Button> : null}
              <Button variant="primary" size="lg" onClick={() => { shell.clearToast(); setConfirm(true); }} disabled={pending} aria-haspopup="dialog">Resolve…</Button>
            </>
          )}
        </div>
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
