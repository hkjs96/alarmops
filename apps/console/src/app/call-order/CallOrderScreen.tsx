import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@alarmops/design-system";
import { getApi } from "@/lib/api";
import { ApiError, isHidden } from "@/lib/api/client";
import type { CallOrderListResponse, PagingHealth, PagingPath, RespondersResponse, RotationSummary, StaffSummary } from "@/lib/api/types";
import type { SP } from "@/lib/query";
import { parseScopeParams, scopeQuery } from "@/lib/scope";
import { namesOf, scopeKey, type CoScope } from "@/lib/call-order/model";
import { SubNav } from "@/components/SubNav";
import { CallOrderTable } from "./CallOrderTable";
import { CallOrderPanel } from "./CallOrderPanel";
import { DraftsLine } from "./DraftsLine";

export interface PanelData {
  scope: CoScope;
  path: PagingPath;
  health: PagingHealth;
  responders: RespondersResponse;
  rotations: RotationSummary[];
  staff: StaffSummary[];
}

/**
 * Call order: who gets called, in what order (D-30). The list is filtered by the query (the tree); a row opens the
 * panel of exactly that level. The panel's scope is its path, the list filter is the query — independent (E5).
 */
export async function CallOrderScreen({ sp, panel }: { sp: SP; panel?: CoScope }) {
  const scope = parseScopeParams(sp);
  if (scope.malformed) notFound();
  const api = await getApi();

  let open: PanelData | null = null;
  if (panel) {
    try {
      // names and ids come from the tree this user may see: an unknown slug and a hidden one are the same Not found
      const node = (await api.scopeTree()).customers.find((c) => c.slug === panel.customer);
      if (!node || !namesOf(node, panel)) notFound();
      const [path, health, responders, rotations, staff] = await Promise.all([
        api.pagingPath(panel), api.pagingHealth(node.id), api.getResponders(node.id), api.listRotations({ customerId: node.id }), api.listStaff(),
      ]);
      open = { scope: panel, path, health, responders, rotations, staff };
    } catch (e) {
      if (isHidden(e)) notFound();
      throw e;
    }
  }

  let data: CallOrderListResponse | undefined;
  let error: ApiError | null = null;
  try {
    data = await api.callOrderList({ customer: scope.sel.customer, project: scope.sel.project, service: scope.sel.service, mine: scope.sel.mine });
  } catch (e) {
    if (isHidden(e)) notFound();
    error = e instanceof ApiError ? e : new ApiError(500, "UNKNOWN", "Could not load the call order.", "");
  }
  const listQuery = scopeQuery(scope.sel);

  return (
    <>
      <div className="page">
        <div className="ph">
          <div>
            <h1 tabIndex={-1}>Call order</h1>
            <div className="desc">Who gets called, in what order</div>
          </div>
        </div>
        <SubNav />
        <DraftsLine listQuery={listQuery} openKey={open ? scopeKey(open.scope) : undefined} />
        {error || !data ? (
          <Card accent="red" title="Could not load the call order">
            <p className="sm" style={{ marginTop: 0 }}>{error?.message}</p>
            <div className="row">
              <Link className="btn" href={"/call-order" + listQuery}>Retry</Link>
              {error?.requestId ? <span className="mono xs faint">requestId {error.requestId}</span> : null}
            </div>
          </Card>
        ) : (
          <CallOrderTable rows={data.rows} listQuery={listQuery} openKey={open ? scopeKey(open.scope) : undefined} filterKey={scope.sel.project ? scopeKey(scope.sel as CoScope) : undefined} />
        )}
      </div>
      {open ? <CallOrderPanel key={scopeKey(open.scope)} data={open} listHref={"/call-order" + listQuery} listQuery={listQuery} /> : null}
    </>
  );
}
