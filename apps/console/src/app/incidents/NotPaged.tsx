import { Mark } from "@alarmops/design-system";
import type { PagingSuppressed } from "@/lib/api/types";

/** D-43: the customer was suspended or terminated when this incident opened, so nobody was paged. Shape + text, not colour alone. */
export function notPagedText(p: NonNullable<PagingSuppressed>): string {
  return p === "CUSTOMER_SUSPENDED" ? "Not paged (customer suspended)" : "Not paged (customer terminated)";
}

export function NotPaged({ reason, detail }: { reason: PagingSuppressed | undefined; detail?: boolean }) {
  if (!reason) return null;
  return (
    <span className="np" data-testid="not-paged" data-reason={reason}>
      <span className="st warn"><Mark shape="dash" /></span>
      <span>{notPagedText(reason)}</span>
      {detail ? <span className="np-d">Alarms from this customer are recorded, but nobody is paged for them. Incidents opened during this period are not paged later, even if the customer is resumed.</span> : null}
    </span>
  );
}
