"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Mark } from "@alarmops/design-system";
import { digestCount, type Digest } from "@/lib/api/types";
import { kstDateTime } from "@/lib/format";

/**
 * D-46: the business-hours summary in the top nav, for MSP staff. N = incidents of suspended customers (nobody was paged
 * for them) + terminated customers that still send events ("cleanup needed"), in the window of the latest 10:00 KST
 * digest, for the customers this user may see (the API scopes it). It opens a short list; nothing here pages anyone.
 * Shape + words, not colour alone: the mark is a triangle when there is something to look at, a ring when there is not.
 */
export function DigestBadge({ digest }: { digest: Digest }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const n = digestCount(digest);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open]);

  return (
    <div className="dg-wrap" ref={wrap}>
      <button ref={btn} type="button" className="dg-badge" data-testid="digest-badge" aria-expanded={open} aria-controls="digest-panel" aria-haspopup="true"
        aria-label={`Business-hours summary: ${n}`} title="Alarms of suspended customers and cleanup of terminated ones, from the latest 10:00 summary. Nobody was paged for these." onClick={() => setOpen((v) => !v)}>
        <span className="dg-mark"><Mark shape={n > 0 ? "tri" : "ring"} /></span>
        <span aria-hidden="true"><span className="dg-long">Business-hours summary: </span><span className="dg-short">Summary </span>{n}</span>
      </button>
      {open ? (
        <div className="dg-panel" id="digest-panel" role="region" aria-label="Business-hours summary" data-testid="digest-panel">
          <p className="sm mut" style={{ marginTop: 0 }}>
            Summary of {kstDateTime(digest.from).slice(0, 16)} to {kstDateTime(digest.to).slice(0, 16)} (KST): the 10:00 summary of the latest business day. Nobody was paged for these.
          </p>
          {!digest.empty ? (
            <p className="b" data-testid="digest-meaning" style={{ margin: "0 0 8px" }}>
              {digest.totals.suspendedCustomers + digest.totals.residualCustomers} customer{digest.totals.suspendedCustomers + digest.totals.residualCustomers === 1 ? "" : "s"} need attention: {digest.totals.suspendedIncidents} incident{digest.totals.suspendedIncidents === 1 ? "" : "s"} of suspended customers and {digest.totals.residualCustomers} terminated customer{digest.totals.residualCustomers === 1 ? "" : "s"} still sending events. The number {n} in the top bar counts those {digest.totals.suspendedIncidents} incident{digest.totals.suspendedIncidents === 1 ? "" : "s"} and {digest.totals.residualCustomers} customer{digest.totals.residualCustomers === 1 ? "" : "s"}.
            </p>
          ) : null}
          {digest.empty ? <p data-testid="digest-empty">Nothing to look at: no alarms from suspended customers and no cleanup needed.</p> : null}
          {digest.suspended.length ? (
            <>
              <div className="b">Suspended customers ({digest.totals.suspendedIncidents} incident{digest.totals.suspendedIncidents === 1 ? "" : "s"})</div>
              <ul data-testid="digest-suspended">
                {digest.suspended.map((s) => (
                  <li key={s.customerId}><Link href={`/customers/${encodeURIComponent(s.customerId)}`} onClick={() => setOpen(false)}>{s.customerName}</Link>: {s.incidents} incident{s.incidents === 1 ? "" : "s"}, last at {kstDateTime(s.lastAt).slice(0, 16)}</li>
                ))}
              </ul>
            </>
          ) : null}
          {digest.terminatedResiduals.length ? (
            <>
              <div className="b">Cleanup needed ({digest.totals.residualCustomers} terminated customer{digest.totals.residualCustomers === 1 ? "" : "s"})</div>
              <ul data-testid="digest-residuals">
                {digest.terminatedResiduals.map((r) => (
                  <li key={r.customerId}><Link href={`/customers/${encodeURIComponent(r.customerId)}`} onClick={() => setOpen(false)}>{r.customerName}</Link>: still sending events ({r.totalEvents} so far), last at {kstDateTime(r.lastEventAt).slice(0, 16)}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
