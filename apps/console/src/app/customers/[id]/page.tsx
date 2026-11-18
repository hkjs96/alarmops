import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CustomerStatusBadge } from "@alarmops/design-system";
import { getApi, nowMs } from "@/lib/api";
import { ApiError, isHidden } from "@/lib/api/client";
import type { CustomerStatusResponse, Offboarding, PurgeLog } from "@/lib/api/types";
import { errorLine } from "@/lib/errors";
import { SubNav } from "@/components/SubNav";
import { CustomerStatusCard } from "../CustomerStatusCard";
import { OffboardingCard } from "../OffboardingCard";
import { ConnectionCard } from "../ConnectionCard";
import { ExportCard, LegalHoldCard, PurgeLogCard } from "../RetentionCards";

/**
 * Customer detail: the header with its status, the status card (ADMIN changes it), and for a terminated customer the
 * offboarding checklist. The address is the customer's slug (an id works too). Anything the user may not see is the
 * same Not found.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await getApi();
  const [tree, me] = await Promise.all([api.scopeTree(), api.me()]);
  const c = tree.customers.find((x) => x.slug === id || x.id === id);
  if (!c) notFound();

  // the status endpoints are ADMIN-only (D-41 style): other staff see the tag the scope tree carries
  let st: CustomerStatusResponse | null = null;
  let off: Offboarding | null = null;
  let purge: PurgeLog | null = null;
  let purgeError: ApiError | null = null;
  let error: ApiError | null = null;
  if (me.role === "ADMIN") {
    try {
      st = await api.getCustomerStatus(c.id);
      if (st.status === "TERMINATED") {
        try { off = await api.getOffboarding(c.id); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
      }
    } catch (e) {
      if (isHidden(e)) notFound();
      error = e instanceof ApiError ? e : new ApiError(500, "UNKNOWN", "Could not load the customer status.", "");
    }
    // D-45: legal hold, export window and the deletion record (ADMIN). A failure here does not hide the status card.
    try { purge = await api.getPurgeLog(c.id); } catch (e) { if (isHidden(e)) notFound(); purgeError = e instanceof ApiError ? e : new ApiError(500, "UNKNOWN", "Could not load the retention data.", ""); }
  }
  // never defaulted to ACTIVE: a status nobody told us is unknown, not active
  const status = st?.status ?? c.status ?? null;
  const portal = me.kind === "CUSTOMER";
  // ids of the staff the console already knows (the signed-in user); an id nobody can resolve is shown as it is
  const names: Record<string, string> = { [me.id]: me.name };

  return (
    <div className="page">
      <div className="ph">
        <div>
          <h1 tabIndex={-1}>{c.name}</h1>
          <div className="desc row" style={{ gap: 12 }}><span>Customer</span>{status ? <CustomerStatusBadge status={status} /> : <span className="sm mut" data-testid="status-unknown">Status unknown</span>}</div>
        </div>
      </div>
      <SubNav />
      <div className="stack">
        {portal ? null : error ? (
          <Card accent="red" title="Could not load the status">
            <p className="sm" style={{ marginTop: 0 }}>{errorLine(error)}</p>
            <div className="row"><Link className="btn" href={`/customers/${c.slug}`}>Retry</Link>{error.requestId ? <span className="mono xs faint">requestId {error.requestId}</span> : null}</div>
          </Card>
        ) : (
          <CustomerStatusCard customerId={c.id} customerName={c.name} status={status} statusChangedAt={st?.statusChangedAt ?? null} version={st ? st.version : null} />
        )}
        {!portal && me.role === "ADMIN" && status !== "TERMINATED" ? <ConnectionCard customerId={c.id} slug={c.slug} name={c.name} /> : null}
        {off ? <OffboardingCard customerId={c.id} customerName={c.name} off={off} /> : null}
        {portal ? null : purge ? (
          <>
            <LegalHoldCard customerId={c.id} customerName={c.name} hold={purge.legalHold} terminated={purge.customer.status === "TERMINATED"} names={names} />
            {purge.customer.status === "TERMINATED" ? <ExportCard customerSlug={c.slug} customerName={c.name} deadline={purge.schedule?.returnPeriodEndsAt ?? null} nowMs={nowMs()} onHold={purge.legalHold.active} /> : null}
            <PurgeLogCard log={purge} names={names} />
          </>
        ) : purgeError ? (
          <Card accent="red" title="Could not load the retention data">
            <p className="sm" style={{ marginTop: 0 }}>{errorLine(purgeError)}</p>
            <div className="row"><Link className="btn" href={`/customers/${c.slug}`}>Retry</Link></div>
          </Card>
        ) : (
          <Card title="Data retention">
            <p className="sm mut" style={{ margin: 0 }} data-testid="retention-role">The legal hold, the incident export and the deletion record need the Admin role. You are signed in as {me.role === "OPERATOR" ? "Operator" : "Viewer"}.</p>
          </Card>
        )}
        <Card title="Open in">
          <div className="row">
            <Link className="btn" href={`/incidents?customer=${c.slug}`}>Incidents of {c.name}</Link>
            <Link className="btn" href={`/c/${c.slug}/call-order`}>Call order of {c.name}</Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
