import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CustomerStatusBadge } from "@alarmops/design-system";
import { getApi } from "@/lib/api";
import { ApiError, isHidden } from "@/lib/api/client";
import type { CustomerStatusResponse, Offboarding } from "@/lib/api/types";
import { SubNav } from "@/components/SubNav";
import { CustomerStatusCard } from "../CustomerStatusCard";
import { OffboardingCard } from "../OffboardingCard";

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
  }
  const status = st?.status ?? c.status ?? "ACTIVE";

  return (
    <div className="page">
      <div className="ph">
        <div>
          <h1 tabIndex={-1}>{c.name}</h1>
          <div className="desc row" style={{ gap: 12 }}><span>Customer</span><CustomerStatusBadge status={status} /></div>
        </div>
      </div>
      <SubNav />
      <div className="stack">
        {error ? (
          <Card accent="red" title="Could not load the status">
            <p className="sm" style={{ marginTop: 0 }}>{error.message}</p>
            <div className="row"><Link className="btn" href={`/customers/${c.slug}`}>Retry</Link>{error.requestId ? <span className="mono xs faint">requestId {error.requestId}</span> : null}</div>
          </Card>
        ) : (
          <CustomerStatusCard customerId={c.id} customerName={c.name} status={status} statusChangedAt={st?.statusChangedAt ?? null} version={st ? st.version : null} />
        )}
        {off ? <OffboardingCard customerId={c.id} customerName={c.name} off={off} /> : null}
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
