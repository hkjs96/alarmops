import type { CustomerStatus } from "../scope/model";
import type { Shape } from "../severity";
import { Mark } from "./Mark";

/** Customer.status (D-42, D-43): colour, shape and text, never colour alone. */
const META: Record<CustomerStatus, { label: string; shape: Shape; cls: string }> = {
  ACTIVE: { label: "Active", shape: "chk", cls: "res" },
  SUSPENDED: { label: "Suspended", shape: "dash", cls: "susp" },
  TERMINATED: { label: "Terminated", shape: "dia", cls: "term" },
};

export function CustomerStatusBadge({ status }: { status: CustomerStatus }) {
  const m = META[status];
  return (
    <span className={`st ${m.cls}`} data-status={status} data-testid="customer-status-badge">
      <Mark shape={m.shape} />
      {m.label}
    </span>
  );
}
