"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Card, ConfirmDialog, Mark } from "@alarmops/design-system";
import type { LegalHold, PurgeLog, PurgeStage } from "@/lib/api/types";
import { hasRole, roleReason, useShell } from "@/components/ShellContext";
import { errorLine } from "@/lib/errors";
import { kstDateTime } from "@/lib/format";
import { callAction } from "@/lib/session-ended";
import { setLegalHold } from "./actions";

const date = (iso: string) => kstDateTime(iso).slice(0, 10);

/**
 * Legal hold (D-45). While it is on, the daily retention job deletes nothing of this customer. ADMIN places it (a
 * reason is required) and releases it; both ask first and are audited by the API.
 */
export function LegalHoldCard({ customerId, customerName, hold, terminated }: { customerId: string; customerName: string; hold: LegalHold; terminated: boolean }) {
  const shell = useShell();
  const router = useRouter();
  const admin = hasRole(shell.user, "ADMIN");
  const trigger = useRef<HTMLButtonElement>(null);
  const errBox = useRef<HTMLDivElement>(null);
  const [ask, setAsk] = useState<"place" | "release" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (err) { errBox.current?.focus({ preventScroll: true }); errBox.current?.scrollIntoView({ block: "nearest" }); } }, [err]);
  const refocus = () => { setTimeout(() => trigger.current?.focus(), 0); };
  const need = ask === "place";
  const ready = (!need || reason.trim().length > 0) && reason.trim().length <= 500;

  async function confirm() {
    if (!ask || busy || !ready) return;
    setBusy(true); setErr(null);
    const r = await callAction(() => setLegalHold(customerId, ask === "place", reason.trim()));
    setBusy(false);
    if (!r.ok) { setErr(errorLine(r, { what: "Changing the legal hold", where: customerName })); return; }
    setAsk(null);
    refocus();
    shell.toast(ask === "place" ? `Legal hold placed on ${customerName}. Automatic deletion is paused.` : `Legal hold released for ${customerName}. Automatic deletion continues on schedule.`);
    router.refresh();
  }

  return (
    <Card title="Legal hold" accent={hold.active ? "amber" : undefined}>
      <div data-testid="legal-hold" data-active={hold.active ? "1" : "0"}>
        <p className="row" style={{ margin: "0 0 8px", gap: 8 }}>
          {hold.active
            ? <span className="st warn" data-testid="hold-state"><Mark shape="tri" />On hold</span>
            : <span className="st info" data-testid="hold-state"><Mark shape="ring" />No hold</span>}
        </p>
        {hold.active ? (
          <dl className="hold-dl" data-testid="hold-detail">
            <dt>Placed</dt><dd>{hold.at ? kstDateTime(hold.at) : "Unknown"}</dd>
            <dt>By</dt><dd className="mono">{hold.byUserId ?? "Unknown"}</dd>
            <dt>Reason</dt><dd>{hold.reason || "None recorded"}</dd>
          </dl>
        ) : null}
        <p className="sm mut" style={{ marginTop: 0 }} data-testid="hold-explain">
          While a legal hold is on, automatic deletion of this customer&apos;s data is paused: nothing is removed on the retention schedule, however much time has passed.
          {terminated ? "" : " It matters once the customer is terminated."} Use it when there is a dispute. Releasing it lets the daily job continue with whatever is then due.
        </p>
        <div className="row">
          <button ref={trigger} type="button" className="btn" data-testid={hold.active ? "hold-release" : "hold-place"} disabled={!admin} aria-describedby={!admin ? "hold-why" : undefined}
            onClick={() => { setAsk(hold.active ? "release" : "place"); setReason(""); setErr(null); shell.clearToast(); }}>
            {hold.active ? "Release legal hold…" : "Place legal hold…"}
          </button>
        </div>
        {!admin ? <p className="sm mut" id="hold-why" data-testid="hold-why" style={{ marginBottom: 0 }}>{roleReason(shell.user, "ADMIN", "Changing the legal hold")}</p> : null}
      </div>
      <ConfirmDialog
        open={ask !== null} title={ask === "place" ? `Place a legal hold on ${customerName}?` : `Release the legal hold on ${customerName}?`} busy={busy} confirmDisabled={!ready} defaultFocus="field"
        confirmLabel={busy ? "Working…" : ask === "place" ? "Place hold" : "Release hold"} cancelLabel="Cancel"
        onConfirm={() => { void confirm(); }} onCancel={() => { if (!busy) { setAsk(null); refocus(); } }}
      >
        {ask ? (
          <div>
            <p style={{ marginTop: 0 }} data-testid="hold-confirm-text">
              {ask === "place"
                ? "Automatic deletion of this customer's data stops until you release the hold. The change is recorded with your name and the reason."
                : "The daily retention job will delete whatever is due for this customer, which may be everything past its retention period. This cannot be undone."}
            </p>
            <label className="cs-f"><span className="b sm">{need ? "Reason (required)" : "Reason (optional)"}</span>
              <textarea className="inp cs-ta" data-testid="hold-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            {err ? <div className="co-err cs-errbox" role="alert" tabIndex={-1} ref={errBox} data-testid="hold-err" style={{ marginTop: 8 }}><span>{err}</span></div> : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}

/**
 * Export of the incident history of a TERMINATED customer (D-45): offered only until the end of the return period.
 * `deadline` and `nowMs` come from the server (the schedule of the purge log), so the button never promises a day the
 * API would refuse. The file is fetched from the console's own route and given to the browser; 409, 410 and 413 are
 * answered before any byte is sent and are worded here.
 */
export function ExportCard({ customerSlug, customerName, deadline, nowMs }: { customerSlug: string; customerName: string; deadline: string | null; nowMs: number }) {
  const shell = useShell();
  const admin = hasRole(shell.user, "ADMIN");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const errBox = useRef<HTMLDivElement>(null);
  useEffect(() => { if (err) errBox.current?.focus({ preventScroll: true }); }, [err]);
  const open = deadline !== null && nowMs < Date.parse(deadline);
  const why = !admin ? roleReason(shell.user, "ADMIN", "Exporting the incident history")
    : deadline === null ? "The return period of this customer is not known, so the export is not offered."
    : !open ? `The return period ended on ${date(deadline)}. The incident details were deleted and can no longer be exported.` : "";

  async function download() {
    if (busy || why) return;
    setBusy(true); setErr(null); shell.clearToast();
    try {
      const res = await fetch(`/customers/${encodeURIComponent(customerSlug)}/export.csv`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        let f = { code: "UNKNOWN", message: "Something went wrong.", requestId: "", details: {} as Record<string, unknown> };
        try { const j = (await res.json()) as { error?: Partial<typeof f> }; f = { ...f, ...(j.error ?? {}) }; } catch { /* not JSON */ }
        setErr(errorLine({ code: f.code, message: f.message, requestId: f.requestId, details: f.details }, { what: "Exporting the incident history", where: customerName }));
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]{1,120})"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `incidents-${customerSlug}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      shell.toast(`Exported the incident history of ${customerName} as ${name}.`);
    } catch {
      setErr("The download did not complete, so the file may be missing rows. Try again. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Export incident history">
      <div data-testid="export-card" data-open={open ? "1" : "0"}>
        <p className="sm mut" style={{ marginTop: 0 }}>
          Give {customerName} its incident history back as a CSV file: numbers, titles, severity, times and counts. No names or contact details.
          {deadline ? <> Available until <b data-testid="export-deadline">{date(deadline)}</b> (end of the return period).</> : null}
        </p>
        <div className="row">
          <button type="button" className="btn" data-testid="export-btn" disabled={busy || !!why} aria-describedby={why ? "export-why" : undefined} onClick={() => { void download(); }}>
            {busy ? "Preparing…" : "Export incident history (CSV)"}
          </button>
        </div>
        {why ? <p className="sm mut" id="export-why" data-testid="export-why" style={{ marginBottom: 0 }}>{why}</p> : null}
        {err ? <div className="co-err cs-errbox" role="alert" tabIndex={-1} ref={errBox} data-testid="export-err" style={{ marginTop: 8 }}><span>{err}</span></div> : null}
      </div>
    </Card>
  );
}

const STAGE: Record<PurgeStage, string> = {
  CONNECTIONS: "Connection details deleted",
  RETURN_PERIOD: "Contacts and incident details deleted",
  AUDIT_EXPIRY: "Audit and access logs deleted",
  SLA_EXPIRY: "SLA records deleted",
  LEGAL_HOLD_SET: "Legal hold placed",
  LEGAL_HOLD_RELEASED: "Legal hold released",
};
const COUNT_LABEL = (k: string) => k.replace(/([A-Z])/g, " $1").toLowerCase();
const who = (actor: string) => (actor === "system" ? "System (daily job)" : actor);

/**
 * The deletion record (D-45): one row per retention stage and per hold change, counts only, never content. This is the
 * data of the deletion certificate a customer may ask for.
 */
export function PurgeLogCard({ log }: { log: PurgeLog }) {
  const s = log.schedule;
  return (
    <Card title="Deletion record">
      <div data-testid="purge-log">
        <p className="sm mut" style={{ marginTop: 0 }}>
          What was deleted for {log.customer.name}, and when. This is the data of the deletion certificate: counts only, no content.
        </p>
        {log.entries.length === 0 ? (
          <p className="sm" data-testid="purge-empty" style={{ margin: "0 0 8px" }}>Nothing has been deleted yet.</p>
        ) : (
          <table className="pl-table" data-testid="purge-table">
            <thead><tr><th scope="col">Stage</th><th scope="col">Counts</th><th scope="col">Time</th><th scope="col">By</th></tr></thead>
            <tbody>
              {log.entries.map((e) => (
                <tr key={e.id} data-testid="purge-row" data-stage={e.stage}>
                  <td data-label="Stage"><b>{STAGE[e.stage] ?? e.stage}</b></td>
                  <td data-label="Counts">{Object.keys(e.counts).length ? Object.entries(e.counts).map(([k, v]) => `${v} ${COUNT_LABEL(k)}`).join(", ") : "No data deleted"}</td>
                  <td data-label="Time">{kstDateTime(e.at)}</td>
                  <td data-label="By" className={e.actor === "system" ? undefined : "mono"}>{who(e.actor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {s ? (
          <ul className="sm mut pl-sched" data-testid="purge-schedule">
            <li>Contacts and incident details are deleted on <b>{date(s.returnPeriodEndsAt)}</b> ({s.returnDays} days after termination).</li>
            <li>Audit and access logs are kept until <b>{date(s.auditExpiresAt)}</b> ({s.auditDays} days).</li>
            <li>Anonymised SLA records are kept until <b>{date(s.slaExpiresAt)}</b> ({s.slaDays} days).</li>
            {log.legalHold.active ? <li><b>Paused by the legal hold:</b> none of these dates apply until it is released.</li> : null}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
