"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "@alarmops/design-system";
import { callAction } from "@/lib/session-ended";
import { createCustomerAction } from "@/app/customers/onboarding-actions";
import { onboardingError, parseLoginDomains } from "@/lib/onboarding";
import { ErrorLine, Field } from "./ui";
import { Stepper } from "./Stepper";

/**
 * Step 1: the customer (POST /customers). Name and optional login domains of the customer portal. Saved as soon as it
 * is pressed: the next steps live at /customers/<slug>/onboarding, so leaving and coming back continues from there.
 * 409 ALREADY_EXISTS with an id → a link to the customer that exists. 422 → the public-mail sentence.
 */
export function NewCustomerForm({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; existing?: string; field?: "name" | "domains" } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canCreate) return;
    setErr(null);
    if (!name.trim()) { setErr({ text: "Give the customer a name (1 to 80 characters).", field: "name" }); return; }
    const parsed = parseLoginDomains(domains);
    if (!parsed.ok) { setErr({ text: parsed.message, field: "domains" }); return; }
    setBusy(true);
    const r = await callAction(() => createCustomerAction({ name: name.trim(), loginDomains: domains }));
    if (!r.ok) {
      setBusy(false);
      const existing = typeof r.details?.existingCustomerId === "string" ? r.details.existingCustomerId : undefined;
      const f = r.details?.field ?? (Array.isArray(r.details?.fields) ? (r.details.fields as { field?: string }[])[0]?.field : undefined);
      setErr({ text: onboardingError(r, "customer"), existing, field: f === "loginDomains" ? "domains" : "name" });
      return;
    }
    router.push(`/customers/${r.data.slug}/onboarding`);
  }

  return (
    <div className="stack">
    <Stepper current="customer" enabled={() => false} />
    <Card title="Customer">
      <form className="ob-form" onSubmit={(e) => { void submit(e); }} noValidate data-testid="new-customer-form">
        {!canCreate ? <div className="ob-note" role="status" data-testid="ob-role-note">Adding a customer needs the Admin role. Ask an admin to do this step.</div> : null}
        <Field id="nc-name" label="Customer name" hint="1 to 80 characters. Shown in the tree, in incidents and in the portal.">
          <input id="nc-name" className="inp" data-testid="nc-name" value={name} maxLength={80} autoComplete="off" required aria-required="true" disabled={!canCreate}
            aria-invalid={err?.field === "name" ? true : undefined} aria-describedby={`nc-name-h${err?.field === "name" ? " nc-err" : ""}`} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="nc-domains" label="Login domains (optional)" hint="Company e-mail domains whose people may sign in to the customer portal, for example mirae.example. Separate them with commas. Public mail domains such as gmail.com are not allowed.">
          <input id="nc-domains" className="inp" data-testid="nc-domains" value={domains} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="mirae.example, pay.mirae.example" disabled={!canCreate}
            aria-invalid={err?.field === "domains" ? true : undefined} aria-describedby={`nc-domains-h${err?.field === "domains" ? " nc-err" : ""}`} onChange={(e) => setDomains(e.target.value)} />
        </Field>
        <div id="nc-err">
          {err ? (
            <ErrorLine testid="nc-error">
              {err.text}
              {err.existing ? <> <Link href={`/customers/${err.existing}`} data-testid="nc-existing" style={{ fontWeight: 700 }}>Open the existing customer</Link></> : null}
            </ErrorLine>
          ) : null}
        </div>
        <div className="ob-actions">
          <button type="submit" className="btn pri" data-testid="nc-save" disabled={busy || !canCreate}>{busy ? "Saving…" : "Save customer and continue"}</button>
          <Link className="btn" href="/customers">Cancel</Link>
        </div>
      </form>
    </Card>
    </div>
  );
}
