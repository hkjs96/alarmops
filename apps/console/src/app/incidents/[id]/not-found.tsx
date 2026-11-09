import Link from "next/link";
import { EmptyState } from "@alarmops/design-system";

/** Out-of-scope and missing look the same (API §2). */
export default function NotFound() {
  return (
    <div className="page">
      <div className="card"><EmptyState title="Not found" action={<Link className="btn" href="/incidents">Back to incidents</Link>} /></div>
    </div>
  );
}
