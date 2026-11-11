"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { EmptyState } from "@alarmops/design-system";
import { sectionFor } from "@/lib/nav";

/**
 * The one "Not found" body. An address that does not exist and an address the user may not see render exactly this,
 * with no name from the address in it (API §2, scope-variants.md E5/E20). The way back is the list of the screen the
 * address belongs to (a Call order address goes back to Call order — QA P3-K); that is read from the shape of the
 * address only, never from whether anything in it exists.
 */
export function NotFoundBody() {
  const section = sectionFor(usePathname() ?? "") ?? sectionFor("/incidents")!;
  return (
    <div className="page" data-testid="not-found">
      <div className="ph"><div><h1 tabIndex={-1}>Not found</h1></div></div>
      <div className="card">
        <EmptyState
          title="There is nothing to show at this address."
          detail="Check the link, or go back to the list."
          action={<Link className="btn" href={section.href} data-testid="not-found-back">Back to {section.label}</Link>}
        />
      </div>
    </div>
  );
}
