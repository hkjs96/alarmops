"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Banner, Card, ConfirmDialog, Mark } from "@alarmops/design-system";
import type { Shape } from "@alarmops/design-system";
import type { Offboarding, OffboardStep, OffboardStepKey, OffboardStepState } from "@/lib/api/types";
import { hasRole, roleReason, useShell } from "@/components/ShellContext";
import { errorLine } from "@/lib/errors";
import { kstDateTime } from "@/lib/format";
import { callAction } from "@/lib/session-ended";
import { markOffboardingStep } from "./actions";

const LABEL: Record<OffboardStepKey, string> = {
  PAGING_STOPPED: "Paging stopped",
  ALARMS_DELETED: "AlarmOps-managed alarms deleted",
  CUSTOMER_STACK_REMOVED: "Connection stack removed by the customer",
  ACCOUNTS_DISABLED: "AWS accounts disabled in AlarmOps",
  BUS_ALLOWLIST_REMOVED: "Removed from the central event bus allow list",
};
const HELP: Record<OffboardStepKey, string> = {
  PAGING_STOPPED: "Nobody is paged for this customer any more.",
  ALARMS_DELETED: "AlarmOps deletes only the alarms it manages (tagged ManagedBy=AlarmOps). If an account could not be reached, check it by hand and mark it done with a note.",
  CUSTOMER_STACK_REMOVED: "Only the customer can do this, in its own AWS account. Ask them to delete the connection stack, then mark it done.",
  ACCOUNTS_DISABLED: "The connection details (role ARN, ExternalId) are deleted when offboarding is complete.",
  BUS_ALLOWLIST_REMOVED: "The customer's accounts must no longer be allowed to send events to the central bus.",
};
const STATE: Record<OffboardStepState, { label: string; shape: Shape; cls: string }> = {
  DONE: { label: "Done", shape: "chk", cls: "res" },
  PENDING: { label: "Pending", shape: "ring", cls: "info" },
  MANUAL: { label: "Needs a person", shape: "tri", cls: "warn" },
};
const DAY = 86_400_000;

/**
 * The offboarding checklist of a terminated customer (D-43, D-45). Five steps, each DONE / PENDING / MANUAL. An ADMIN
 * marks a MANUAL step done; ALARMS_DELETED needs a note of what was checked (the API refuses it without).
 */
export function OffboardingCard({ customerId, customerName, off }: { customerId: string; customerName: string; off: Offboarding }) {
  const shell = useShell();
  const router = useRouter();
  const admin = hasRole(shell.user, "ADMIN");
  const [ask, setAsk] = useState<OffboardStep | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const noteNeeded = ask?.key === "ALARMS_DELETED";
  const ready = !noteNeeded || note.trim().length > 0;
  const done = off.steps.filter((s) => s.state === "DONE").length;
  const purge = new Date(Date.parse(off.startedAt) + 30 * DAY).toISOString();

  async function mark() {
    if (!ask || busy || !ready) return;
    setBusy(true); setErr(null);
    const r = await callAction(() => markOffboardingStep(customerId, ask.key, note.trim() || undefined));
    setBusy(false);
    if (!r.ok) { setErr(errorLine(r, { what: "Marking a step done", where: customerName })); setStale(r.code === "STEP_NOT_MANUAL" || r.code === "NOT_FOUND"); return; }
    const label = LABEL[ask.key];
    setAsk(null);
    shell.toast(`Marked done: ${label}.`);
    router.refresh();
  }

  return (
    <Card title="Offboarding checklist" actions={<span className="mono xs" data-testid="ob-progress">{done} of {off.steps.length} done</span>}>
      <div data-testid="offboarding" data-complete={off.completedAt ? "1" : undefined}>
        {off.residual.count > 0 ? (
          <Banner tone="amber">
            <span data-testid="ob-cleanup"><b>Cleanup needed.</b> Events still arriving from this customer: <b>{off.residual.count}</b>{off.residual.lastEventAt ? <>, last at {kstDateTime(off.residual.lastEventAt)}</> : null}. No incident is opened and nobody is paged. Finish the steps below: the alarms or the connection stack are still sending.</span>
          </Banner>
        ) : null}
        <p className="sm mut" style={{ marginTop: 0 }}>
          Terminated {kstDateTime(off.startedAt)}. Reason: {off.reason}
          {off.completedAt ? <> Completed {kstDateTime(off.completedAt)}.</> : null}
        </p>
        <ol className="ob-steps">
          {off.steps.map((s) => {
            const m = STATE[s.state];
            return (
              <li key={s.key} className="ob-step" data-testid={`ob-step-${s.key}`} data-state={s.state}>
                <span className={`st ${m.cls} ob-state`} data-testid="ob-state"><Mark shape={m.shape} />{m.label}</span>
                <div className="ob-main">
                  <div className="b">{LABEL[s.key]}</div>
                  <div className="sm mut">{HELP[s.key]}</div>
                  {s.detail ? <div className="sm ob-detail" data-testid="ob-detail">{s.detail}</div> : null}
                  {s.state === "DONE" && s.at ? <div className="xs mut">Done {kstDateTime(s.at)}{s.byUserId ? " by a person" : ""}</div> : null}
                </div>
                {s.state === "MANUAL" ? (
                  <button type="button" className="btn sm ob-mark" data-testid={`ob-mark-${s.key}`} disabled={!admin} aria-describedby={!admin ? "ob-why" : undefined}
                    aria-label={`Mark done: ${LABEL[s.key]}`} onClick={() => { setAsk(s); setNote(""); setErr(null); setStale(false); shell.clearToast(); }}>Mark done…</button>
                ) : null}
              </li>
            );
          })}
        </ol>
        {!admin ? <p className="sm mut" id="ob-why">{roleReason(shell.user, "ADMIN", "Marking a step done")}</p> : null}
        <p className="sm mut" style={{ marginBottom: 0 }} data-testid="ob-retention">
          Data: contacts and incident details of {customerName} are deleted on {kstDateTime(purge).slice(0, 10)} (30 days after termination). Until then an Admin can export its incident history as CSV for the customer.
        </p>
      </div>

      <ConfirmDialog
        open={ask !== null} title={ask ? `Mark done: ${LABEL[ask.key]}?` : ""} busy={busy} confirmDisabled={!ready} defaultFocus="field"
        confirmLabel={busy ? "Working…" : "Mark done"} cancelLabel="Not done yet"
        onConfirm={() => { void mark(); }} onCancel={() => { if (!busy) setAsk(null); }}
      >
        {ask ? (
          <div>
            <p style={{ marginTop: 0 }}>{HELP[ask.key]} Mark it done only when it really is: AlarmOps cannot check it for you.</p>
            {ask.detail ? <p className="sm mut">AlarmOps recorded: {ask.detail}</p> : null}
            <label className="cs-f"><span className="b sm">{noteNeeded ? "What did you check? (required)" : "Note (optional)"}</span>
              <textarea className="inp cs-ta" data-testid="ob-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {err ? (
              <div className="co-err" role="alert" data-testid="ob-err" style={{ marginTop: 8 }}>
                <span>{err}</span>
                {stale ? <button type="button" className="btn sm" onClick={() => { setAsk(null); router.refresh(); }}>Reload</button> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}
