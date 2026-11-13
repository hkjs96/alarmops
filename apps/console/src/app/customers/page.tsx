import Link from "next/link";
import { Card, CustomerStatusBadge, EmptyState } from "@alarmops/design-system";
import { getApi } from "@/lib/api";
import { SubNav } from "@/components/SubNav";
import { ScopeEcho } from "@/components/ShellContext";
import type { SP } from "@/lib/query";
import { parseScopeParams } from "@/lib/scope";

/**
 * Customers: one card per customer with its status. The full list (sources, coverage, setup) is still to be built
 * (docs/ui/screens/customers.md); this carries what D-43 needs: the status, and the way to the customer's page.
 * Cards rather than a table, so the same markup holds at 390 px.
 */
export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const scope = parseScopeParams(await searchParams);
  const all = (await (await getApi()).scopeTree()).customers;
  // the filter of the address (the tree) narrows the list, like on the other screens
  const customers = scope.sel.customer ? all.filter((c) => c.slug === scope.sel.customer) : scope.sel.mine ? all.filter((c) => c.mine) : all;
  return (
    <div className="page">
      <div className="ph"><div><h1 tabIndex={-1}>Customers</h1><div className="desc">Status and offboarding. The full customer list is not built yet.</div></div></div>
      <SubNav />
      <p className="sm mut">Showing <ScopeEcho />.</p>
      {customers.length === 0 ? <Card><EmptyState title="No customers yet" detail="Customers appear here once they are connected." /></Card> : (
        <ul className="cust-list" data-testid="customer-list">
          {customers.map((c) => (
            <li key={c.id} className="cust-item" data-testid="customer-item" data-slug={c.slug} data-row-key={c.id}>
              <Link className="cust-name" href={`/customers/${c.slug}`}>{c.name}</Link>
              <CustomerStatusBadge status={c.status ?? "ACTIVE"} />
              <span className="sm mut">Open incidents <b className="mono">{c.openIncidents}</b></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
