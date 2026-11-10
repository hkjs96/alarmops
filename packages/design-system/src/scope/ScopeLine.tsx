"use client";
import { useState, type MouseEvent, type ReactNode } from "react";
import { cx } from "../cx";
import { initials } from "../severity";

export type ScopeLevel = "customer" | "project" | "service";

export interface ScopeLineProps {
  customer?: string;
  project?: string;
  service?: string;
  /** the My customers filter (only without a customer) */
  mine?: boolean;
  totalCustomers: number;
  mineCustomers: number;
  /** × on a segment clears that level only; "customer" = back to All customers */
  onClear: (level: ScopeLevel) => void;
  /** phone: the line is one button that opens the sheet */
  onOpenPicker?: () => void;
  /** phone: a search button beside the line opens "Filter to…" (desktop has it in the top bar, Ctrl/⌘K) */
  onOpenSearch?: () => void;
  /** right side on desktop, second row on a phone (e.g. <OutsideLine/>) */
  outside?: ReactNode;
  /** replaces the path with fixed text (Settings: MSP-wide) */
  locked?: ReactNode;
}

const Chain = () => <span className="chain" aria-hidden="true">›</span>;

/** The one place that states the list filter (T1): text only. The tree (desktop) or the sheet (phone) is the control. */
export function ScopeLine(p: ScopeLineProps) {
  const X = ({ level, label }: { level: ScopeLevel; label: string }) => (
    <button type="button" className="sline-x" aria-label={label} title={label} onClick={() => p.onClear(level)}>×</button>
  );
  const head = p.mine ? "My customers" : "All customers";
  const headN = p.mine ? p.mineCustomers : p.totalCustomers;
  const filtered = Boolean(p.customer || p.mine);

  if (p.locked) {
    return (
      <div className="sline" role="region" aria-label="Filter">
        <span className="lb">Showing:</span>
        <span className="sline-path"><span className="sline-id all">ALL</span><span className="sg"><span className="t">{p.locked}</span></span></span>
      </div>
    );
  }
  return (
    <div className="sline" role="region" aria-label="Filter">
      <span className="lb">Showing:</span>
      <span className="sline-path sline-desk">
        {!p.customer ? (
          <span className="sg"><span className="t"><b>{head}</b> · {headN}</span>{p.mine ? <X level="customer" label="Show all customers" /> : null}</span>
        ) : (
          <>
            <span className="sline-id" aria-hidden="true">{initials(p.customer)}</span>
            <span className="sg"><span className="t"><b>{p.customer}</b></span><X level="customer" label={`Clear ${p.customer} · show all customers`} /></span>
            <Chain />
            {p.project ? (
              <>
                <span className="sg"><span className="t">{p.project}</span><X level="project" label={`Clear ${p.project} · show all of ${p.customer}`} /></span>
                <Chain />
                {p.service
                  ? <span className="sg"><span className="t">{p.service}</span><X level="service" label={`Clear ${p.service} · show all of ${p.project}`} /></span>
                  : <span className="sg"><span className="t mut">All services</span></span>}
              </>
            ) : <span className="sg"><span className="t mut">All projects</span></span>}
          </>
        )}
      </span>
      <span className="sline-m">
        <button type="button" className="sline-open" aria-haspopup="dialog" onClick={p.onOpenPicker}>
          {p.customer ? <span className="sline-id" aria-hidden="true">{initials(p.customer)}</span> : null}
          <span className="tx">
            <small>Showing</small>
            {!p.customer ? <span><b>{head}</b> · {headN}</span> : (
              <span>
                <span className="nw"><b>{p.customer}</b></span>{" "}
                <span className="nw"><Chain />{p.project ?? <span className="mut">All projects</span>}</span>
                {p.project ? <>{" "}<span className="nw"><Chain />{p.service ?? <span className="mut">All services</span>}</span></> : null}
              </span>
            )}
          </span>
          <span className="car" aria-hidden="true">▼</span>
        </button>
        {p.onOpenSearch ? (
          <button type="button" className="btn sline-clr sline-find" aria-haspopup="dialog" aria-label="Filter to a customer, project or service by name" onClick={p.onOpenSearch}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="7.5" cy="7.5" r="5" /><path d="M11.5 11.5 16 16" /></svg>
          </button>
        ) : null}
        {filtered ? <button type="button" className="btn sline-clr" aria-label="Clear the filter, show all customers" onClick={() => p.onClear("customer")}>×</button> : null}
      </span>
      {p.outside ? <><span className="sp sline-desk" /><span className="sline-out">{p.outside}</span></> : null}
    </div>
  );
}

export interface OutsideLineProps {
  /** open incidents the filter hides (includes the unmapped ones) */
  open: number;
  /** of `open`: from an AWS account not assigned to a customer */
  unmapped: number;
  acknowledged: number;
  /** where the link goes: the same list with the filter removed */
  href: string;
  onNavigate?: (e: MouseEvent<HTMLAnchorElement>) => void;
  /** e.g. "Mirae Pay › Core" or "My customers" */
  filterLabel: string;
  totalCustomers: number;
}

/** "Outside this view: 3 open (1 from an unmapped account) · 3 acknowledged" (T12). Open here + open in the list = the nav badge. */
export function OutsideLine(p: OutsideLineProps) {
  const [info, setInfo] = useState(false);
  if (!p.open && !p.acknowledged) {
    return <span className="outside calm" data-testid="outside-line">Outside this view: no incidents</span>;
  }
  const def = `Incidents in all ${p.totalCustomers} customers that your filter (${p.filterLabel}) hides. Open: triggered or escalated, nobody has acknowledged it. Open here plus the open incidents in this list is the number on the Incidents badge. From an unmapped account: alerts from an AWS account that is not assigned to a customer, so nobody is paged; they are part of the open count. Acknowledged: someone has taken it. The link shows them in Incidents with the filter removed.`;
  return (
    <span className="outside-w">
      <a className={cx("outside", !p.open && "calm")} href={p.href} onClick={p.onNavigate} title={def} data-testid="outside-line">
        {p.open ? <span className="mk tri" aria-hidden="true" /> : null}
        <span>
          Outside this view: <b>{p.open} open</b>{p.unmapped ? ` (${p.unmapped} from an unmapped account)` : ""} · {p.acknowledged} acknowledged
        </span>
      </a>
      <button type="button" className="outside-i" aria-expanded={info} aria-label="What do these numbers mean?" onClick={() => setInfo((v) => !v)}>?</button>
      {info ? <span className="outside-d" role="note">{def}</span> : null}
    </span>
  );
}
