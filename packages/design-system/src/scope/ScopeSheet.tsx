"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "../cx";
import { myCustomers, normalizeSel, otherCustomers, tokensOf, type ScopeCustomerNode, type ScopeSel } from "./model";
import { ScopeLegend } from "./ScopeTree";

export interface ScopeSheetProps {
  open: boolean;
  customers: ScopeCustomerNode[];
  value: ScopeSel;
  /** called with the chosen scope; the sheet closes */
  onApply: (sel: ScopeSel) => void;
  /** Close changes nothing */
  onClose: () => void;
}

type Step = 1 | 2 | 3;

function Tags({ open, health, own }: { open: number; health?: string; own?: boolean }) {
  return (
    <span className="stree-tags">
      {own ? <span className="stag own">Own steps</span> : null}
      {health === "UNREACHABLE" ? <span className="stag unr">Unreachable</span> : health === "AT_RISK" ? <span className="stag ar">At risk</span> : null}
      {open > 0 ? <span className="stag-n"><span className="sr-only">open incidents: </span>{open}</span> : null}
    </span>
  );
}

/**
 * Phone scope picker (T9): full-height sheet, Customer → Project → Service, 52px rows. Nothing is applied until a row
 * that states a whole scope is tapped ("All projects", a service, "Use X only"). Opens on the step that holds the current choice.
 */
export function ScopeSheet({ open, customers, value, onApply, onClose }: ScopeSheetProps) {
  const cur = normalizeSel(value);
  const [step, setStep] = useState<Step>(1);
  const [cSlug, setCSlug] = useState<string | undefined>();
  const [pSlug, setPSlug] = useState<string | undefined>();
  const [q, setQ] = useState("");
  const [legend, setLegend] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    setCSlug(cur.customer);
    setPSlug(cur.project);
    setStep(cur.service ? 3 : cur.project ? 2 : 1);
    setQ("");
    setLegend(false); // collapsed every time the sheet opens
    const prev = document.activeElement as HTMLElement | null;
    headRef.current?.focus();
    return () => prev?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const customer = customers.find((c) => c.slug === cSlug);
  const project = customer?.projects.find((p) => p.slug === pSlug);
  const s: Step = step === 3 && project ? 3 : step >= 2 && customer ? 2 : 1;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "Tab") return;
    const f = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input, [href]") ?? []);
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === headRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const tk = tokensOf(q);
  const match = (name: string) => !tk.length || tk.every((t) => name.toLowerCase().split(/\s+/).some((w) => w.startsWith(t)));
  const mine = myCustomers(customers).filter((c) => match(c.name));
  const other = otherCustomers(customers).filter((c) => match(c.name));
  const mineAll = myCustomers(customers).length;

  const Row = (p: { label: React.ReactNode; on?: boolean; onClick: () => void; tags?: React.ReactNode; next?: boolean; testid?: string }) => (
    <button type="button" className={cx("ssheet-row", p.on && "on")} aria-current={p.on ? "true" : undefined} onClick={p.onClick} data-testid={p.testid}>
      <span className="x">{p.label}</span>{p.tags}{p.next ? <span className="car" aria-hidden="true">›</span> : null}
    </button>
  );
  const customerRow = (c: ScopeCustomerNode) => (
    <Row key={c.slug} label={<b>{c.name}</b>} on={cur.customer === c.slug} next testid="sheet-customer"
      tags={<Tags open={c.openIncidents} health={c.callHealth} />}
      onClick={() => { setCSlug(c.slug); setPSlug(undefined); setStep(2); }} />
  );
  const title = s === 1 ? "Choose a customer" : s === 2 ? `Choose a project of ${customer!.name}` : `Choose a service of ${project!.name}`;

  return (
    <div className="ssheet-scrim">
      <div ref={ref} className="ssheet" role="dialog" aria-modal="true" aria-labelledby="ssheet-h" onKeyDown={onKey}>
        <div className="ssheet-top">
          {s > 1 ? <button type="button" className="btn ghost" onClick={() => setStep((s - 1) as Step)}>← Back</button> : null}
          <h2 id="ssheet-h" ref={headRef} tabIndex={-1}>{title}</h2>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="ssheet-steps" role="group" aria-label="Steps">
          <button type="button" aria-current={s === 1 ? "step" : undefined} onClick={() => setStep(1)}>1 · Customer</button>
          <button type="button" aria-current={s === 2 ? "step" : undefined} disabled={!customer} onClick={() => setStep(2)}>2 · Project</button>
          <button type="button" aria-current={s === 3 ? "step" : undefined} disabled={!project} onClick={() => setStep(3)}>3 · Service</button>
        </div>
        <div className="ssheet-body">
          {s === 1 ? (
            <>
              <Row label={<><b>All customers</b> <span className="mut">· {customers.length}</span></>} on={!cur.customer && !cur.mine} onClick={() => onApply({})} />
              {mineAll > 0 ? <Row label={<><b>My customers</b> <span className="mut">· {mineAll}</span></>} on={!cur.customer && Boolean(cur.mine)} onClick={() => onApply({ mine: true })} /> : null}
              <div className="ssheet-q">
                <input className="inp" placeholder="Find a customer…" aria-label="Find a customer by name" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              {mine.length ? <div className="ssheet-g">My customers · {mine.length}</div> : null}
              {mine.map(customerRow)}
              {other.length ? <div className="ssheet-g">{mineAll ? "Other customers" : "Customers"} · {other.length}</div> : null}
              {other.map(customerRow)}
              {!mine.length && !other.length ? <div className="ssheet-none">No customer starts with “{q.trim()}”</div> : null}
            </>
          ) : s === 2 ? (
            <>
              <Row label={<b>All projects</b>} on={cur.customer === customer!.slug && !cur.project} onClick={() => onApply({ customer: customer!.slug })} />
              {customer!.projects.map((p) => (
                <Row key={p.slug} label={p.name} next on={cur.customer === customer!.slug && cur.project === p.slug} testid="sheet-project"
                  tags={<Tags open={p.openIncidents} own={p.ownSteps} />}
                  onClick={() => { setPSlug(p.slug); setStep(3); }} />
              ))}
            </>
          ) : (
            <>
              <Row label={<b>All services</b>} on={cur.customer === customer!.slug && cur.project === project!.slug && !cur.service}
                onClick={() => onApply({ customer: customer!.slug, project: project!.slug })} />
              {project!.services.map((v) => (
                <Row key={v.slug} label={v.name} testid="sheet-service"
                  on={cur.customer === customer!.slug && cur.project === project!.slug && cur.service === v.slug}
                  tags={<Tags open={v.openIncidents} own={v.ownSteps} />}
                  onClick={() => onApply({ customer: customer!.slug, project: project!.slug, service: v.slug })} />
              ))}
            </>
          )}
          {/* in the flow under the rows: it never covers the list, the header or the button below */}
          <ScopeLegend className="ssheet-leg" open={legend} onToggle={() => setLegend((l) => !l)} />
        </div>
        {s === 2 ? (
          <div className="ssheet-foot"><button type="button" className="btn pri" onClick={() => onApply({ customer: customer!.slug })}>Use {customer!.name} only</button></div>
        ) : s === 3 ? (
          <div className="ssheet-foot"><button type="button" className="btn pri" onClick={() => onApply({ customer: customer!.slug, project: project!.slug })}>Use {customer!.name} › {project!.name} only</button></div>
        ) : null}
      </div>
    </div>
  );
}
