"use client";
import { useEffect, useRef, useState } from "react";
import { Card, ConfirmDialog } from "@alarmops/design-system";
import type { AccountRecord, AccountStatus } from "@/lib/api/types";
import { callAction } from "@/lib/session-ended";
import { accountStatusAction, checkAccountAction, setCapabilityAction } from "@/app/customers/onboarding-actions";
import { pollUntilChecked, POLL_INTERVAL_MS, POLL_MAX } from "@/lib/onboarding-poll";
import {
  CAP_KEY, CONNECTION_LABEL, REMEDIATOR_WARNING, ROLE_ABOUT, ROLE_NAME, ROLE_OFF, connectionOf, kitMissing, kitParams, kitText, SOURCE_WORDS, onboardingError, roleLines, type CentralValues, type RoleLine,
} from "@/lib/onboarding";
import { kstDateTime } from "@/lib/format";
import { CopyValue, ErrorLine, StateChip } from "./ui";

type Phase = "idle" | "queuing" | "checking" | "timeout";
const OPTIONAL = ["alarmWriter", "tagWriter", "remediator"] as const;

/**
 * Step 4 for one AWS account: the connection kit (what the customer needs), the capabilities, what the operator does next
 * (text only: nothing here runs the allow-list workflow), and the connection check with its per-role result.
 */
export function ConnectionPanel({ customerName, account, status, central, canWrite, onAccount, onStatus }: {
  customerName: string; account: AccountRecord; status: AccountStatus | null; central: CentralValues; canWrite: boolean;
  onAccount: (a: AccountRecord) => void; onStatus: (s: AccountStatus) => void;
}) {
  const params = kitParams(account, central);
  const missing = kitMissing(params);
  const [copyMsg, setCopyMsg] = useState("");
  const [capBusy, setCapBusy] = useState<string | null>(null);
  const [capErr, setCapErr] = useState<string | null>(null);
  const [capNote, setCapNote] = useState<string | null>(null);
  const [askRem, setAskRem] = useState(false);

  async function setCap(role: (typeof OPTIONAL)[number], on: boolean) {
    const key = CAP_KEY[role];
    setCapBusy(role); setCapErr(null); setCapNote(null);
    const r = await callAction(() => setCapabilityAction(account.id, key, on));
    setCapBusy(null);
    if (!r.ok) { setCapErr(onboardingError(r, "account")); return; }
    onAccount(r.data);
    setCapNote(`${ROLE_NAME[role]} is now ${on ? "on" : "off"} for ${account.awsAccountId}. The parameters above changed: the customer has to update the stack with Enable${ROLE_NAME[role]}=${on} (a stack update flow is not built yet).`);
  }

  // ---- connection check ----
  const [phase, setPhase] = useState<Phase>("idle");
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function check() {
    if (phase === "queuing" || phase === "checking") return;
    setCheckErr(null); setPhase("queuing");
    const baseline = status?.lastCheckedAt ?? null;
    const q = await callAction(() => checkAccountAction(account.id));
    if (!alive.current) return;
    if (!q.ok) { setPhase("idle"); setCheckErr(onboardingError(q, "check", Date.now()) ); return; }
    setPhase("checking");
    const res = await pollUntilChecked({ baseline, cancelled: () => !alive.current, fetchStatus: () => callAction(() => accountStatusAction(account.id)) });
    if (!alive.current || res.kind === "cancelled") return;
    if (res.kind === "done") { onStatus(res.status); setPhase("idle"); return; }
    if (res.kind === "timeout") { if (res.last) onStatus(res.last); setPhase("timeout"); return; }
    setPhase("idle");
    setCheckErr(onboardingError(res.failure, "check"));
  }

  const checking = phase === "queuing" || phase === "checking";
  const blank: AccountStatus = { accountId: account.id, customerId: account.customerId, awsAccountId: account.awsAccountId, lastCheckedAt: null, firstEventAt: null, lastEventAt: null, stackVersion: null, disabled: false,
    roles: (["reader", "eventForwarder", "alarmWriter", "tagWriter", "remediator"] as const).map((key) => ({ key, required: key === "reader" || key === "eventForwarder", enabled: key === "reader" || key === "eventForwarder" || account[CAP_KEY[key as "alarmWriter"]], status: "UNKNOWN" as const, basis: "CHECK" as const })) };
  const lines: RoleLine[] = status || checking ? roleLines(status ?? blank) : [];
  const conn = connectionOf(status);
  const failing = lines.filter((l) => l.tone === "fail");

  return (
    <div className="stack" data-testid="conn-panel" data-account={account.awsAccountId}>
      <Card title={`Connection kit for ${customerName}`}>
        <p className="sm" style={{ marginTop: 0 }}>
          Give these values to {customerName}’s AWS administrator. They create the stack from <code>infra/customer-stack/template.yaml</code> in account <b className="mono">{account.awsAccountId}</b>, region <b className="mono">ap-northeast-2</b> (Seoul).
        </p>
        {missing > 0 ? (
          <div className="ob-note" role="status" style={{ marginBottom: 12 }} data-testid="kit-incomplete">
            This kit is not complete: {missing} value{missing === 1 ? " is" : "s are"} still missing. Fill {missing === 1 ? "it" : "them"} in before you send it. They come from {SOURCE_WORDS}.
          </div>
        ) : null}
        {!account.externalId ? <div className="ob-note" role="status">The ExternalId is shown to Admins only.</div> : null}
        <ul className="ob-kit" data-testid="kit-params">
          {params.map((p) => (
            <li key={p.name} data-testid={`kit-${p.name}`}>
              <span className="k">{p.name}</span>
              {p.value ? <CopyValue label={p.name} value={p.value} testid={`kit-${p.name}`} announce={setCopyMsg} disabled={p.placeholder} /> : <span className="sm mut">Not available to your role.</span>}
              {p.placeholder ? <span className="why ph-tag" data-testid={`kit-${p.name}-placeholder`}>Missing: this value is not set up in the console. Get it from {SOURCE_WORDS}. It cannot be copied until it is set.</span> : null}
              {p.note ? <span className="why">{p.note}</span> : null}
            </li>
          ))}
        </ul>
        {account.externalId ? (
          <div className="ob-actions" style={{ marginTop: 12 }}>
            {missing > 0 ? (
              <>
                <button type="button" className="btn ob-btn" disabled data-testid="kit-all-copy" aria-describedby="kit-all-why">Copy all parameters</button>
                <span className="sm" id="kit-all-why" data-testid="kit-all-why">Not available: {missing} value{missing === 1 ? " is" : "s are"} missing.</span>
              </>
            ) : <ul className="ob-kit" style={{ width: "100%" }}><li data-testid="kit-all"><span className="k">All parameters</span><CopyValue label="all parameters" value={kitText(params)} testid="kit-all" mono={false} announce={setCopyMsg} /></li></ul>}
          </div>
        ) : null}
        <div role="status" className="sm" data-testid="kit-copy-state" style={{ minHeight: 20, marginTop: 8 }}>{copyMsg}</div>
        <p className="sm mut" style={{ marginBottom: 0 }}>Send the ExternalId to the customer only. Do not paste it into an issue, a pull request or a chat room.</p>
      </Card>

      <Card title="Optional roles">
        <p className="sm" style={{ marginTop: 0 }}>Reader and EventForwarder are required and cannot be turned off. The others are off until you turn them on.</p>
        <div className="ob-list">
          {OPTIONAL.map((role) => {
            const key = CAP_KEY[role];
            const on = account[key];
            return (
              <label key={role} className="ob-cap" data-testid={`cap-${role}`}>
                <input type="checkbox" checked={on} disabled={!canWrite || capBusy !== null} aria-describedby={`cap-${role}-d`}
                  onChange={(e) => { if (role === "remediator" && e.target.checked) setAskRem(true); else void setCap(role, e.target.checked); }} />
                <span className="t"><b>{ROLE_NAME[role]}{role === "alarmWriter" ? " (recommended)" : ""}</b>
                  <small id={`cap-${role}-d`}>{ROLE_ABOUT[role]} Off: {ROLE_OFF[role]}</small>
                  {role === "remediator" ? <small data-testid="remediator-warning">{REMEDIATOR_WARNING}</small> : null}
                </span>
              </label>
            );
          })}
        </div>
        <div role="status" data-testid="cap-status">{capNote ? <div className="ob-info" style={{ marginTop: 10 }}>{capNote}</div> : null}</div>
        {capErr ? <ErrorLine>{capErr}</ErrorLine> : null}
      </Card>

      <Card title="What you do next">
        <ol className="sm" style={{ marginTop: 0, paddingLeft: 20, display: "grid", gap: 10 }} data-testid="next-steps">
          <li><b>Add the account to the bus allow-list, before the customer creates the stack.</b> Events sent before that are refused. In GitHub, open Actions › <code>bus-allowlist</code> › Run workflow on <code>main</code> and enter:
            <ul className="ob-kit" style={{ marginTop: 8 }} data-testid="allowlist-inputs">
              {([["action", "add"], ["account_id", account.awsAccountId], ["reference", account.id], ["confirm", account.awsAccountId]] as const).map(([k, v]) => (
                <li key={k}><span className="k">{k}</span><CopyValue label={k} value={v} testid={`al-${k}`} announce={setCopyMsg} /></li>
              ))}
            </ul>
            <span className="sm mut">The first choice in the action list is <code>remove</code>: change it to <code>add</code>. This console does not start the workflow; a person does, and approves the <code>central</code> environment.</span>
          </li>
          <li><b>Send the kit above to {customerName}</b> and ask them to create the stack in <code>ap-northeast-2</code>.</li>
          <li><b>Check the connection</b> below. EventForwarder turns OK when the first event arrives.</li>
        </ol>
      </Card>

      <Card title="Check connection" actions={status?.lastCheckedAt ? <span className="sm mut" data-testid="last-checked">Last checked {kstDateTime(status.lastCheckedAt)}</span> : <span className="sm mut" data-testid="last-checked">Not checked yet</span>}>
        <div className="ob-actions">
          <button type="button" className="btn pri" data-testid="check-btn" onClick={() => { void check(); }} disabled={!canWrite || checking} aria-describedby="check-status">
            {checking ? "Checking…" : "Check connection"}
          </button>
        </div>
        <div id="check-status" role="status" data-testid="check-status" className="sm" style={{ marginTop: 10, minHeight: 20 }} data-phase={phase}>
          {phase === "queuing" ? "Queuing the check…" : phase === "checking" ? `Checking… this usually takes a few seconds (up to ${Math.round((POLL_INTERVAL_MS * POLL_MAX) / 1000)} s).`
            : phase === "timeout" ? "The check was queued but no result has arrived yet. Wait a little and check again, or ask the platform team if the alarm engine is running."
            : status?.lastCheckedAt ? `${CONNECTION_LABEL[conn]}.` : ""}
        </div>
        {checkErr ? <ErrorLine testid="check-error">{checkErr}</ErrorLine> : null}

        {status || checking ? (
          <table className="rr-table" data-testid="role-table" style={{ marginTop: 12 }}>
            <caption className="sr-only">Result per role for account {account.awsAccountId}</caption>
            <thead><tr><th scope="col">Role</th><th scope="col">Needed</th><th scope="col">Result</th><th scope="col">Next step</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key} data-testid={`role-${l.key}`} data-tone={checking ? "wait" : l.tone}>
                  <td data-label="Role"><b>{l.name}</b></td>
                  <td data-label="Needed">{l.required ? "Required" : "Optional"}</td>
                  <td data-label="Result">{checking && l.tone !== "off" ? <StateChip tone="wait" label="Checking…" /> : <StateChip tone={l.tone} label={l.label} />}</td>
                  <td data-label="Next step" className="ob-next">{checking ? "" : l.next || (l.tone === "ok" ? "Nothing to do." : "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {status ? (
          <dl className="kv" style={{ marginTop: 12 }} data-testid="event-times">
            <dt>First event</dt><dd>{status.firstEventAt ? kstDateTime(status.firstEventAt) : "None yet"}</dd>
            <dt>Last event</dt><dd>{status.lastEventAt ? kstDateTime(status.lastEventAt) : "None yet"}</dd>
          </dl>
        ) : null}
        {!checking && failing.length ? <p className="sm" style={{ marginBottom: 0 }} data-testid="fail-summary">{failing.length} role{failing.length === 1 ? "" : "s"} failed. Fix {failing.length === 1 ? "it" : "them"} with the next step in the table, then check again.</p> : null}
      </Card>

      <ConfirmDialog
        open={askRem} title={`Turn on Remediator for ${account.awsAccountId}?`} danger confirmLabel="Turn on Remediator" cancelLabel="Keep it off" busy={capBusy !== null}
        warning={<>This lets AlarmOps act on {customerName}’s resources.<small>{REMEDIATOR_WARNING}</small></>}
        onConfirm={() => { setAskRem(false); void setCap("remediator", true); }} onCancel={() => setAskRem(false)}
      >
        <p>The customer also has to update the stack with <code>EnableRemediator=true</code> and <code>RemediatorCallerRoleArn</code>. Nothing is stopped or deleted without a person’s approval in Slack.</p>
      </ConfirmDialog>
    </div>
  );
}
