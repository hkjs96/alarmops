"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Card, ConfirmDialog, CustomerStatusBadge } from "@alarmops/design-system";
import type { CustomerStatusValue } from "@/lib/api/types";
import { hasRole, roleReason, useShell } from "@/components/ShellContext";
import { errorLine } from "@/lib/errors";
import { kstDateTime } from "@/lib/format";
import { callAction } from "@/lib/session-ended";
import { changeCustomerStatus } from "./actions";

type Kind = "suspend" | "resume" | "terminate";
const TO: Record<Kind, CustomerStatusValue> = { suspend: "SUSPENDED", resume: "ACTIVE", terminate: "TERMINATED" };

/**
 * Status of one customer and the one place it is changed (D-43). ADMIN only: others see "Change status" disabled with
 * the reason, like Edit responders. `version` is the If-Match of the change (null = not readable for this user).
 */
export function CustomerStatusCard({ customerId, customerName, status, statusChangedAt, version }: {
  customerId: string; customerName: string; status: CustomerStatusValue | null; statusChangedAt: string | null; version: number | null;
}) {
  const shell = useShell();
  const router = useRouter();
  const admin = hasRole(shell.user, "ADMIN");
  const trigger = useRef<HTMLButtonElement>(null);
  /** the dialog's opener is gone by the time it closes (the options row folds): focus goes back to Change status */
  const refocus = () => { setTimeout(() => trigger.current?.focus(), 0); };
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState<Kind | null>(null);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; code: string } | null>(null);

  const terminated = status === "TERMINATED";
  const unknown = status === null;
  const why = !admin ? roleReason(shell.user, "ADMIN", "Changing a customer's status")
    : terminated ? "A terminated customer cannot change status. To use it again, connect it as a new customer."
    : unknown || version === null ? "The status of this customer is not available to you, so it cannot be changed here." : "";

  const begin = (k: Kind) => { setAsk(k); setReason(""); setTyped(""); setErr(null); setOpen(false); shell.clearToast(); };
  const close = () => { if (!busy) { setAsk(null); refocus(); } };
  const reasonOk = reason.trim().length > 0 && reason.trim().length <= 500;
  const nameOk = ask !== "terminate" || typed.trim() === customerName;
  const ready = reasonOk && nameOk;

  async function confirm() {
    if (!ask || status === null || version === null || busy || !ready) return;
    setBusy(true); setErr(null);
    const r = await callAction(() => changeCustomerStatus(customerId, { status: TO[ask], reason: reason.trim(), ...(ask === "terminate" ? { confirmName: typed.trim() } : {}) }, version));
    setBusy(false);
    if (!r.ok) { setErr({ text: errorLine(r, { what: "Changing a customer's status", where: customerName }), code: r.code }); return; }
    setAsk(null);
    refocus();
    shell.toast(ask === "suspend" ? `${customerName} suspended. Nobody is paged for its alarms.` : ask === "resume" ? `${customerName} resumed. Paging starts with the next alarm.`
      : r.data.commandsFailed?.length ? `${customerName} terminated. Deleting alarms failed for ${r.data.commandsFailed.length} account(s): finish it on the checklist.` : `${customerName} terminated. Offboarding has started.`);
    router.refresh();
  }

  const stale = err?.code === "VERSION_CONFLICT" || err?.code === "CUSTOMER_TERMINATED";
  const title = ask === "suspend" ? `Suspend ${customerName}?` : ask === "resume" ? `Resume ${customerName}?` : `Terminate ${customerName}?`;

  return (
    <Card title="Status" accent={status === "SUSPENDED" ? "amber" : undefined} actions={status ? <CustomerStatusBadge status={status} /> : <span className="sm mut">Status unknown</span>}>
      <div data-testid="customer-status" data-status={status} data-version={version ?? undefined}>
        <p className="sm" style={{ marginTop: 0 }}>
          {unknown ? <>The status of <b>{customerName}</b> is not available to your account, so it is not shown here.</> : status === "ACTIVE" ? <>Alarms from <b>{customerName}</b> page the call order as usual.</>
            : status === "SUSPENDED" ? <>Alarms from <b>{customerName}</b> are recorded, but <b>nobody is paged</b> (customer contacts and MSP staff). A business-hours summary is sent instead.</>
            : <>Paging for <b>{customerName}</b> has stopped and its offboarding is under way. This cannot be undone.</>}
        </p>
        <p className="sm mut" data-testid="status-changed-at">
          {unknown ? null : statusChangedAt ? <>Status changed {kstDateTime(statusChangedAt)}.</> : status === "ACTIVE" ? "The status has not been changed." : "When the status changed is not shown to your role."}
        </p>

        <div className="row cs-actions">
          <button type="button" ref={trigger} className="btn" data-testid="cs-change" aria-expanded={open} aria-controls="cs-options" disabled={Boolean(why)} aria-describedby={why ? "cs-why" : undefined}
            onClick={() => setOpen((o) => !o)}>Change status</button>
          {open && !why ? (
            <span className="row" id="cs-options" role="group" aria-label={`Change the status of ${customerName}`}>
              {status === "ACTIVE" ? <button type="button" className="btn" data-testid="cs-suspend" onClick={() => begin("suspend")}>Suspend…</button> : null}
              {status === "SUSPENDED" ? <button type="button" className="btn" data-testid="cs-resume" onClick={() => begin("resume")}>Resume…</button> : null}
              <button type="button" className="btn danger" data-testid="cs-terminate" onClick={() => begin("terminate")}>Terminate…</button>
            </span>
          ) : null}
        </div>
        {why ? <p className="sm mut cs-why" id="cs-why" data-testid="cs-why">{why}</p> : null}
      </div>

      <ConfirmDialog
        open={ask !== null} title={title} danger={ask === "terminate"} busy={busy} confirmDisabled={!ready} defaultFocus="field"
        confirmLabel={busy ? "Working…" : ask === "suspend" ? `Suspend ${customerName}` : ask === "resume" ? `Resume ${customerName}` : `Terminate ${customerName}`}
        cancelLabel={ask === "terminate" ? `Keep ${customerName}` : ask === "resume" ? "Keep suspended" : "Keep active"}
        warning={ask === "terminate" ? <>This cannot be undone.<small>Paging for {customerName} stops now. To use it again, it has to be connected as a new customer.</small></> : undefined}
        onConfirm={() => { void confirm(); }} onCancel={close}
      >
        {ask === "suspend" ? (
          <p data-testid="cs-explain">Alarms from this customer are recorded but nobody is paged (customer contacts and MSP staff). A business-hours summary is sent instead. Nothing is deleted, and you can resume at any time.</p>
        ) : null}
        {ask === "resume" ? (
          <p data-testid="cs-explain">Paging starts again with the next alarm from {customerName}. Incidents from the suspended period will not be paged, even after you resume. They stay marked “Not paged”.</p>
        ) : null}
        {ask === "terminate" ? (
          <div data-testid="cs-explain">
            <p style={{ marginTop: 0 }}>What happens when you terminate {customerName}:</p>
            <ul>
              <li>Paging stops now, for customer contacts and MSP staff.</li>
              <li>The alarms AlarmOps manages in its AWS accounts are deleted. Other alarms are not touched.</li>
              <li>The customer has to remove the connection stack from its own AWS account. You track this on the offboarding checklist.</li>
              <li>The data is kept for a limited time: contacts and incident details are deleted 30 days after termination. Connection details are deleted when offboarding is complete.</li>
            </ul>
          </div>
        ) : null}
        {ask ? (
          <div className="cs-form">
            <label className="cs-f"><span className="b sm">Reason (required)</span>
              <textarea className="inp cs-ta" data-testid="cs-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="cs-reason-n" />
            </label>
            <span className="xs mut" id="cs-reason-n">Saved in the audit log. Up to 500 characters.</span>
            {ask === "terminate" ? (
              <label className="cs-f"><span className="b sm">Type <span className="mono" data-testid="cs-name">{customerName}</span> to confirm</span>
                <input className="inp cs-in" data-testid="cs-confirm-name" type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} aria-invalid={typed !== "" && !nameOk} aria-describedby="cs-name-n" />
              </label>
            ) : null}
            {ask === "terminate" ? (
              <span className="xs" id="cs-name-n" role="status" data-testid="cs-name-hint" style={{ color: typed !== "" && !nameOk ? "var(--red)" : "var(--mut)" }}>
                {typed !== "" && !nameOk ? "The name does not match. Type it exactly as shown." : nameOk && typed !== "" ? "The name matches." : "The button stays off until the name matches."}
              </span>
            ) : null}
            {err ? (
              <div className="co-err" role="alert" data-testid="cs-err">
                <span>{err.text}</span>
                {stale ? <button type="button" className="btn sm" data-testid="cs-reload" onClick={() => { setAsk(null); refocus(); router.refresh(); }}>Reload</button> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}
