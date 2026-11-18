"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Card } from "@alarmops/design-system";
import type { AccountRecord, AccountStatus, ContactRecord } from "@/lib/api/types";
import { CONNECTION_LABEL, connectionOf, type CentralValues } from "@/lib/onboarding";
import { Stepper, STEPS, type StepKey } from "./Stepper";
import { AccountStep, OrganizationStep, type OrgNode } from "./OrgAndAccountSteps";
import { ConnectionPanel } from "./ConnectionPanel";
import { PeopleStep } from "./PeopleStep";
import { StateChip } from "./ui";

/**
 * Steps 2 to 5 of the customer wizard at /customers/<slug>/onboarding. Everything is saved by the step that made it (the
 * API is the store), so leaving and coming back shows the same state: the step is the only thing kept in the address
 * (`?step=`), never a value. Accounts, their last check and the people are loaded from the API by the page.
 */
export function OnboardingWizard(p: {
  customer: { id: string; name: string; slug: string }; initialOrg: OrgNode[]; initialAccounts: AccountRecord[]; initialStatuses: Record<string, AccountStatus | null>;
  initialContacts: ContactRecord[]; initialStep: StepKey; central: CentralValues; canWrite: boolean;
}) {
  const router = useRouter();
  const [step, setStepState] = useState<StepKey>(p.initialStep);
  const [org, setOrg] = useState(p.initialOrg);
  const [accounts, setAccounts] = useState(p.initialAccounts);
  const [statuses, setStatuses] = useState(p.initialStatuses);
  const [contacts, setContacts] = useState(p.initialContacts);
  const [sel, setSel] = useState<string | null>(p.initialAccounts[0]?.id ?? null);
  const name = p.customer.name;
  const heading = useRef<HTMLHeadingElement>(null);
  const [announce, setAnnounce] = useState("");
  const stepNo = STEPS.findIndex((s) => s.key === step) + 1;
  const stepLabel = STEPS[stepNo - 1]!.label;
  // after every step change (and on arrival from the customer step) the focus is on the step heading and the step is announced
  useEffect(() => { heading.current?.focus({ preventScroll: true }); setAnnounce(`Step ${stepNo} of ${STEPS.length}: ${stepLabel}`); }, [step, stepNo, stepLabel]);

  const setStep = (k: StepKey) => { setStepState(k); router.replace(`/customers/${p.customer.slug}/onboarding?step=${k}`, { scroll: false }); };
  const account = accounts.find((a) => a.id === sel) ?? null;
  const needs = contacts.filter((c) => c.needsAction).length;

  return (
    <div className="stack">
      <Stepper current={step} onSelect={setStep} enabled={() => true} />
      <h2 className="sr-only" tabIndex={-1} ref={heading} data-testid="step-heading">{name} · Step {stepNo} of {STEPS.length}: {stepLabel}</h2>
      <div className="sr-only" role="status" data-testid="step-announce">{announce}</div>
      {step === "organization" ? (
        <OrganizationStep customerId={p.customer.id} customerName={name} org={org} onOrg={setOrg} onNext={() => setStep("account")} canWrite={p.canWrite} />
      ) : null}
      {step === "account" ? (
        <AccountStep customerId={p.customer.id} customerName={name} org={org} accounts={accounts} canWrite={p.canWrite}
          onCreated={(a) => { setAccounts([...accounts, a]); setStatuses({ ...statuses, [a.id]: null }); setSel(a.id); setStep("connection"); }}
          onOpen={(a) => { setSel(a.id); setStep("connection"); }} />
      ) : null}
      {step === "connection" ? (
        account ? (
          <div className="stack">
            {accounts.length > 1 ? (
              <Card title="Account">
                <div className="ob-actions" role="group" aria-label="Choose an AWS account">
                  {accounts.map((a) => <button key={a.id} type="button" className={`btn${a.id === sel ? " pri" : ""}`} aria-pressed={a.id === sel} onClick={() => setSel(a.id)}>{a.awsAccountId}{a.alias ? ` · ${a.alias}` : ""}</button>)}
                </div>
              </Card>
            ) : null}
            <ConnectionPanel key={account.id} customerName={name} account={account} status={statuses[account.id] ?? null} central={p.central} canWrite={p.canWrite}
              onAccount={(a) => setAccounts(accounts.map((x) => (x.id === a.id ? a : x)))} onStatus={(s) => setStatuses({ ...statuses, [account.id]: s })} />
            <div className="ob-actions"><button type="button" className="btn pri" data-testid="conn-next" onClick={() => setStep("people")}>Continue to People</button></div>
          </div>
        ) : (
          <Card title={`${name} · Connection`}>
            <p className="sm" style={{ marginTop: 0 }} data-testid="conn-none">There is no AWS account yet, so there is nothing to connect.</p>
            <button type="button" className="btn pri" onClick={() => setStep("account")}>Add an AWS account</button>
          </Card>
        )
      ) : null}
      {step === "people" ? (
        <>
          <PeopleStep customerId={p.customer.id} customerName={name} contacts={contacts} onContacts={setContacts} canWrite={p.canWrite} />
          <Card title={`Setup of ${name}`} accent={needs || accounts.some((a) => connectionOf(statuses[a.id] ?? null) !== "CONNECTED") || !accounts.length ? "amber" : "green"}>
            <ul className="ob-list" data-testid="setup-summary">
              {accounts.length ? accounts.map((a) => {
                const c = connectionOf(statuses[a.id] ?? null);
                return <li key={a.id} className="row" data-testid="setup-account" data-conn={c}><span className="mono">{a.awsAccountId}</span><StateChip tone={c === "CONNECTED" ? "ok" : c === "FAILED" ? "fail" : "wait"} label={CONNECTION_LABEL[c]} /></li>;
              }) : <li className="row"><span>AWS account</span><StateChip tone="wait" label="Not added yet" /></li>}
              <li className="row"><span>People needing action</span><StateChip tone={needs ? "wait" : "ok"} label={needs ? `${needs} to verify` : "None"} /></li>
            </ul>
            <p className="sm" style={{ marginBottom: 0 }}>Anything unfinished stays here: come back to this page from the customer’s page at any time.</p>
            <div className="ob-actions" style={{ marginTop: 12 }}>
              <Link className="btn pri" href={`/customers/${p.customer.slug}`} data-testid="finish">Finish and open {name}</Link>
              <Link className="btn" href={`/c/${p.customer.slug}/call-order`}>Set the call order for {name}</Link>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
