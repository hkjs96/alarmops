import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@alarmops/design-system";
import { getApi, isMock } from "@/lib/api";
import { ApiError, isHidden } from "@/lib/api/client";
import type { AccountRecord, AccountStatus, ContactRecord } from "@/lib/api/types";
import { errorLine } from "@/lib/errors";
import { NO_CENTRAL } from "@/lib/onboarding";
import { MOCK_CENTRAL, centralValues } from "@/lib/server/central";
import { roleAtLeast } from "@/lib/roles";
import { SubNav } from "@/components/SubNav";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import type { StepKey } from "@/components/onboarding/Stepper";
import type { OrgNode } from "@/components/onboarding/OrgAndAccountSteps";

const STEP_KEYS: StepKey[] = ["organization", "account", "connection", "people"];

/**
 * Steps 2 to 5 of the onboarding wizard for one customer. The address is the customer's slug (an id works too) and
 * `?step=`; nothing else. Everything shown is read from the API, so a customer that was left half way opens at the
 * same state: its accounts with the last check, its people, the kit.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ step?: string | string[] }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const api = await getApi();
  const [tree, me] = await Promise.all([api.scopeTree(), api.me()]);
  const c = tree.customers.find((x) => x.slug === id || x.id === id);
  if (!c || me.kind === "CUSTOMER") notFound();
  const canWrite = roleAtLeast(me.role, "ADMIN");

  let org: OrgNode[] = [];
  let accounts: AccountRecord[] = [];
  const statuses: Record<string, AccountStatus | null> = {};
  let contacts: ContactRecord[] = [];
  let error: ApiError | null = null;
  try {
    const projects = await api.listProjects(c.id);
    org = await Promise.all(projects.map(async (project) => ({ project, services: await api.listServices(project.id) })));
    // the accounts (with the ExternalId) and the people are for Admins; other staff see the steps read-only without them
    if (canWrite) {
      accounts = await api.listAccounts(c.id);
      await Promise.all(accounts.map(async (a) => { statuses[a.id] = await api.getAccountStatus(a.id).catch(() => null); }));
      contacts = (await api.listContacts({ customerId: c.id })).items;
    }
  } catch (e) {
    if (isHidden(e)) notFound();
    error = e instanceof ApiError ? e : new ApiError(500, "UNKNOWN", "Could not load the onboarding data.", "");
  }

  const asked = Array.isArray(sp.step) ? sp.step[0] : sp.step;
  const initialStep: StepKey = STEP_KEYS.find((k) => k === asked) ?? (accounts.length ? "connection" : org.length ? "account" : "organization");

  return (
    <div className="page">
      <div className="ph">
        <div>
          <h1 tabIndex={-1}>{c.name}</h1>
          <div className="desc">Onboarding · <Link href={`/customers/${c.slug}`}>Back to the customer</Link></div>
        </div>
      </div>
      <SubNav />
      {error ? (
        <Card accent="red" title="Could not load the onboarding data">
          <p className="sm" style={{ marginTop: 0 }}>{errorLine(error)}</p>
          <div className="row"><Link className="btn" href={`/customers/${c.slug}/onboarding`}>Retry</Link></div>
        </Card>
      ) : (
        <>
          {canWrite ? null : <div className="ob-note" role="status" style={{ marginBottom: 16 }} data-testid="ob-role-note">Onboarding needs the Admin role. You can read the organization here; the accounts, kit and people are for Admins.</div>}
          <OnboardingWizard customer={{ id: c.id, name: c.name, slug: c.slug }} initialOrg={org} initialAccounts={accounts} initialStatuses={statuses} initialContacts={contacts}
            initialStep={initialStep} central={isMock() ? (c.slug.startsWith("no-central") ? NO_CENTRAL : MOCK_CENTRAL) : centralValues()} canWrite={canWrite} />
        </>
      )}
    </div>
  );
}
