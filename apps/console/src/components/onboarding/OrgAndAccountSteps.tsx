"use client";
import { useState } from "react";
import { Card } from "@alarmops/design-system";
import type { AccountRecord, ProjectRecord, ServiceRecord } from "@/lib/api/types";
import { callAction } from "@/lib/session-ended";
import { createAccountAction, createProjectAction, createServiceAction } from "@/app/customers/onboarding-actions";
import { onboardingError, REMEDIATOR_WARNING, ROLE_ABOUT, ROLE_NAME } from "@/lib/onboarding";
import { groupDigits } from "@/lib/format";
import { ErrorLine, Field } from "./ui";

export interface OrgNode { project: ProjectRecord; services: ServiceRecord[] }

/** Step 2 (optional): projects and services as the API has them. One form saves a project with its first service; each project can take more services. */
export function OrganizationStep({ customerId, customerName, org, onOrg, onNext, canWrite }: {
  customerId: string; customerName: string; org: OrgNode[]; onOrg: (o: OrgNode[]) => void; onNext: () => void; canWrite: boolean;
}) {
  const [project, setProject] = useState("");
  const [service, setService] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canWrite) return;
    setErr(null); setSaved(null);
    if (!project.trim()) { setErr("Give the project a name."); return; }
    setBusy(true);
    const p = await callAction(() => createProjectAction(customerId, project.trim()));
    if (!p.ok) { setBusy(false); setErr(onboardingError(p, "project")); return; }
    let node: OrgNode = { project: p.data, services: [] };
    let msg = `Project “${p.data.name}” saved for ${customerName}.`;
    if (service.trim()) {
      const s = await callAction(() => createServiceAction(p.data.id, service.trim()));
      if (s.ok) { node = { project: { ...p.data, serviceCount: 1 }, services: [s.data] }; msg = `Project “${p.data.name}” and service “${s.data.name}” saved for ${customerName}.`; }
      else setErr(`Project “${p.data.name}” was saved, but its service was not. ${onboardingError(s, "service")}`);
    }
    onOrg([...org, node]);
    setBusy(false); setProject(""); setService(""); setSaved(msg);
  }
  async function addService(node: OrgNode, name: string): Promise<string | null> {
    const s = await callAction(() => createServiceAction(node.project.id, name));
    if (!s.ok) return onboardingError(s, "service");
    onOrg(org.map((o) => (o === node ? { project: { ...o.project, serviceCount: o.services.length + 1 }, services: [...o.services, s.data] } : o)));
    return null;
  }

  return (
    <Card title={`${customerName} · Organization`}>
      <p className="sm" style={{ marginTop: 0 }}>Optional. Projects and services let incidents and call orders be set for a part of the customer. You can add them later.</p>
      {org.length ? (
        <ul className="ob-list" data-testid="org-list" style={{ marginBottom: 16 }}>
          {org.map((o) => <OrgItem key={o.project.id} node={o} onAdd={addService} canWrite={canWrite} />)}
        </ul>
      ) : <p className="sm mut" data-testid="org-empty">No projects yet.</p>}
      <form className="ob-form" onSubmit={(e) => { void save(e); }} noValidate data-testid="org-form">
        <div className="ob-grid2">
          <Field id="org-project" label="Project name"><input id="org-project" className="inp" data-testid="org-project" value={project} maxLength={80} autoComplete="off" disabled={!canWrite} onChange={(e) => setProject(e.target.value)} /></Field>
          <Field id="org-service" label="First service (optional)"><input id="org-service" className="inp" data-testid="org-service" value={service} maxLength={80} autoComplete="off" disabled={!canWrite} onChange={(e) => setService(e.target.value)} /></Field>
        </div>
        <div role="status" data-testid="org-saved">{saved ? <div className="ob-info">{saved}</div> : null}</div>
        {err ? <ErrorLine testid="org-error">{err}</ErrorLine> : null}
        <div className="ob-actions">
          <button type="submit" className="btn" data-testid="org-save" disabled={busy || !canWrite}>{busy ? "Saving…" : `Save organization for ${customerName}`}</button>
          <button type="button" className="btn pri" data-testid="org-next" onClick={onNext}>{org.length ? "Continue to AWS account" : "Skip for now"}</button>
        </div>
      </form>
    </Card>
  );
}

function OrgItem({ node, onAdd, canWrite }: { node: OrgNode; onAdd: (n: OrgNode, name: string) => Promise<string | null>; canWrite: boolean }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setErr(null);
    const m = await onAdd(node, name.trim());
    setBusy(false);
    if (m) setErr(m); else setName("");
  }
  return (
    <li className="ob-item" data-testid="org-item" data-project={node.project.slug}>
      <div><b>{node.project.name}</b> <span className="sm mut">{node.services.length ? node.services.map((s) => s.name).join(" · ") : "No services yet"}</span></div>
      <form className="row" onSubmit={(e) => { void add(e); }} noValidate>
        <label className="sr-only" htmlFor={`svc-${node.project.id}`}>New service in {node.project.name}</label>
        <input id={`svc-${node.project.id}`} className="inp ob-in" style={{ maxWidth: 260 }} placeholder="New service name" value={name} maxLength={80} autoComplete="off" disabled={!canWrite} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn" disabled={busy || !canWrite || !name.trim()}>{busy ? "Adding…" : `Add service to ${node.project.name}`}</button>
      </form>
      {err ? <ErrorLine>{err}</ErrorLine> : null}
    </li>
  );
}

/** Step 3: the AWS account of the customer. 12 digits; the ExternalId is made by the server and shown in the next step. */
export function AccountStep({ customerId, customerName, org, accounts, onCreated, onOpen, canWrite }: {
  customerId: string; customerName: string; org: OrgNode[]; accounts: AccountRecord[]; onCreated: (a: AccountRecord) => void; onOpen: (a: AccountRecord) => void; canWrite: boolean;
}) {
  const [id, setId] = useState("");
  const [alias, setAlias] = useState("");
  const [env, setEnv] = useState("");
  const [svc, setSvc] = useState("");
  const [caps, setCaps] = useState({ alarmWriterEnabled: false, tagWriterEnabled: false, remediatorEnabled: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const digits = id.replace(/[\s-]/g, "");
  const services = org.flatMap((o) => o.services.map((s) => ({ id: s.id, label: `${o.project.name} › ${s.name}` })));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canWrite) return;
    setErr(null);
    if (!/^[0-9]{12}$/.test(digits)) { setErr("An AWS account id is exactly 12 digits. Check it and try again."); return; }
    setBusy(true);
    const r = await callAction(() => createAccountAction(customerId, { awsAccountId: digits, alias, environment: env, serviceId: svc, ...caps }));
    setBusy(false);
    if (!r.ok) { setErr(onboardingError(r, "account")); return; }
    setId(""); setAlias(""); setEnv(""); setSvc(""); setCaps({ alarmWriterEnabled: false, tagWriterEnabled: false, remediatorEnabled: false });
    onCreated(r.data);
  }

  return (
    <div className="stack">
      <Card title={`${customerName} · AWS account & roles`}>
        <form className="ob-form" onSubmit={(e) => { void save(e); }} noValidate data-testid="account-form">
          <Field id="ac-id" label="AWS account id" hint="12 digits, from the customer’s AWS console.">
            <input id="ac-id" className="inp mono" data-testid="ac-id" inputMode="numeric" autoComplete="off" value={id} maxLength={14} placeholder="123456789012" disabled={!canWrite}
              aria-invalid={err && !/^[0-9]{12}$/.test(digits) ? true : undefined} aria-describedby="ac-id-h" onChange={(e) => setId(e.target.value)} />
          </Field>
          <div className="ob-grid2">
            <Field id="ac-alias" label="Alias (optional)"><input id="ac-alias" className="inp" data-testid="ac-alias" value={alias} maxLength={80} autoComplete="off" disabled={!canWrite} onChange={(e) => setAlias(e.target.value)} /></Field>
            <Field id="ac-env" label="Environment">
              <select id="ac-env" className="inp" data-testid="ac-env" value={env} disabled={!canWrite} onChange={(e) => setEnv(e.target.value)}>
                <option value="">Not set</option><option value="PRD">PRD</option><option value="STG">STG</option><option value="DEV">DEV</option>
              </select>
            </Field>
          </div>
          {services.length ? (
            <Field id="ac-svc" label="Service (optional)">
              <select id="ac-svc" className="inp" data-testid="ac-svc" value={svc} disabled={!canWrite} onChange={(e) => setSvc(e.target.value)}>
                <option value="">Not assigned</option>{services.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Field>
          ) : null}
          <p className="sm" style={{ margin: 0 }}>Region: <b className="mono">ap-northeast-2</b> (Seoul). Connection stacks are created there.</p>
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: "grid", gap: 8 }}>
            <legend className="lab">Roles</legend>
            {(["reader", "eventForwarder"] as const).map((k) => (
              <label key={k} className="ob-cap"><input type="checkbox" checked disabled aria-label={`${ROLE_NAME[k]} (required)`} /><span className="t"><b>{ROLE_NAME[k]} · required</b><small>{ROLE_ABOUT[k]} Cannot be turned off.</small></span></label>
            ))}
            {([["alarmWriter", "alarmWriterEnabled", " (recommended)"], ["tagWriter", "tagWriterEnabled", ""], ["remediator", "remediatorEnabled", ""]] as const).map(([role, key, tag]) => (
              <label key={role} className="ob-cap" data-testid={`ac-cap-${role}`}>
                <input type="checkbox" checked={caps[key]} disabled={!canWrite} onChange={(e) => setCaps({ ...caps, [key]: e.target.checked })} />
                <span className="t"><b>{ROLE_NAME[role]}{tag} · optional, off by default</b><small>{ROLE_ABOUT[role]}</small>
                  {role === "remediator" ? <small data-testid="ac-remediator-warning" style={caps.remediatorEnabled ? { color: "var(--ink)", fontWeight: 600 } : undefined}>{REMEDIATOR_WARNING}</small> : null}
                </span>
              </label>
            ))}
          </fieldset>
          {err ? <ErrorLine testid="ac-error">{err}</ErrorLine> : null}
          <div className="ob-actions">
            <button type="submit" className="btn pri" data-testid="ac-save" disabled={busy || !canWrite}>{busy ? "Saving…" : `Save AWS account for ${customerName}`}</button>
          </div>
        </form>
      </Card>
      {accounts.length ? (
        <Card title="Accounts of this customer">
          <ul className="ob-list" data-testid="account-list">
            {accounts.map((a) => (
              <li key={a.id} className="ob-item" data-testid="account-item" data-account={a.awsAccountId}>
                <div className="row"><b className="mono">{groupDigits(a.awsAccountId)}</b>{a.alias ? <span>{a.alias}</span> : null}{a.environment ? <span className="mono sm">{a.environment}</span> : null}</div>
                <div className="ob-actions"><button type="button" className="btn" onClick={() => onOpen(a)} data-testid="account-open">Open kit and check for {a.awsAccountId}</button></div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
