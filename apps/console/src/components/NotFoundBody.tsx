import Link from "next/link";
import { EmptyState } from "@alarmops/design-system";

/**
 * The one "Not found" body. An address that does not exist and an address the user may not see render exactly this,
 * with no name from the address in it (API §2, scope-variants.md E5/E20).
 */
export function NotFoundBody() {
  return (
    <div className="page" data-testid="not-found">
      <div className="ph"><div><h1 tabIndex={-1}>Not found</h1></div></div>
      <div className="card">
        <EmptyState
          title="There is nothing to show at this address."
          detail="Check the link, or go back to the list."
          action={<Link className="btn" href="/incidents">Back to Incidents</Link>}
        />
      </div>
    </div>
  );
}
