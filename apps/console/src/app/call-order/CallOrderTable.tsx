"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Mark, customerHasProblem, cx } from "@alarmops/design-system";
import type { CallOrderRow, PagingPathStep } from "@/lib/api/types";
import { STYLE_LABEL, callOrderPath, firstName, howText, parseScopeKey, partsText, repeatText, targetParts } from "@/lib/call-order/model";
import { setEditIntent, takeFocusRow } from "@/lib/call-order/flags";
import { useShell } from "@/components/ShellContext";

interface View { key: string; order: string[] }

/** Keeps every row where it is while the user stays in Call order: a save changes what a row says, never where it is. */
function stableOrder(rows: readonly CallOrderRow[], view: View | null, key: string): string[] {
  const now = rows.map((r) => r.key);
  if (!view || view.key !== key) return now;
  const have = new Set(now);
  const order = view.order.filter((k) => have.has(k));
  for (const k of now) {
    if (order.includes(k)) continue;
    // a new level (own steps just created) goes under the last row of its customer; nothing above it moves
    const cust = k.split("/")[0];
    let at = -1;
    order.forEach((o, n) => { if (o.split("/")[0] === cust) at = n; });
    order.splice(at < 0 ? order.length : at + 1, 0, k);
  }
  return order;
}

const HEALTH = { UNREACHABLE: { cls: "unr", label: "Unreachable" }, AT_RISK: { cls: "ar", label: "At risk" } } as const;

function First({ row }: { row: CallOrderRow }) {
  const s = row.steps[0];
  const customer = row.org.customer?.name ?? "";
  if (!s || s.nowIds.length === 0) {
    return <div><span className="mut b">nobody</span><div className="org">{s ? `${howText(s.channels)} ${partsText(targetParts(s, customer))}` : "no steps"}</div></div>;
  }
  if (s.targetType === "ALL_RESPONDERS") {
    const names = s.names.map(firstName);
    return (
      <div>
        <b data-testid="co-first">{names.slice(0, 4).join(", ")}{names.length > 4 ? ` +${names.length - 4} more` : ""}</b>
        <div className="org">everyone in Responders ({s.nowIds.length}), all at once · {howText(s.channels, false)}</div>
      </div>
    );
  }
  return (
    <div>
      <b data-testid="co-first">{s.names[0]}</b>{s.targetIsCustomerPerson ? <> ({customer})</> : null}
      <div className="org">{s.targetType === "ROTATION" ? `on shift in ${s.targetName} · ` : ""}{howText(s.channels, false)}</div>
    </div>
  );
}
/** short form for the Then column: "call Yuna Seo", "SMS Junho · Hanbit on-call", "call everyone (5)" */
function thenLine(s: PagingPathStep): string {
  const who = s.targetType === "ALL_RESPONDERS" ? `everyone (${s.nowIds.length})`
    : s.targetType === "ROTATION" ? `${s.names[0] ? firstName(s.names[0]) : "nobody"} · ${s.targetName}` : s.targetName ?? s.names[0] ?? "nobody";
  return `${howText(s.channels, false)} ${who}`;
}

export function CallOrderTable({ rows, listQuery, openKey, filterKey }: { rows: CallOrderRow[]; listQuery: string; openKey?: string; filterKey?: string }) {
  const shell = useShell();
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const body = useRef<HTMLTableSectionElement>(null);

  const order = useMemo(() => stableOrder(rows, shell.callOrderView.current as View | null, listQuery), [rows, listQuery, shell.callOrderView]);
  useEffect(() => { shell.callOrderView.current = { key: listQuery, order } satisfies View; }, [order, listQuery, shell.callOrderView]);

  const problems = useMemo(() => new Set(shell.customers.filter(customerHasProblem).map((c) => c.slug)), [shell.customers]);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const all = order.map((k) => byKey.get(k)).filter((r): r is CallOrderRow => Boolean(r));
  const onlyProblems = shell.problemsOnly && !showAll && !shell.sel.customer;
  const shown = onlyProblems ? all.filter((r) => problems.has(r.key.split("/")[0]!)) : all;
  const hiddenCustomers = new Set(all.filter((r) => !shown.includes(r)).map((r) => r.key.split("/")[0])).size;

  // after a save or a close the focus is back on the row that was open (E18)
  useEffect(() => {
    if (openKey) return;
    const k = takeFocusRow();
    if (!k) return;
    const a = [...(body.current?.querySelectorAll<HTMLAnchorElement>("a[data-key]") ?? [])].find((x) => x.dataset.key === k);
    a?.focus({ preventScroll: true });
  }, [openKey]);

  const open = (key: string, edit = false) => shell.requestLeave(() => {
    if (edit) setEditIntent({ scope: key });
    router.push(callOrderPath(parseScopeKey(key)) + listQuery);
  }, "continue");
  const onRow = (e: MouseEvent<HTMLTableRowElement>, key: string) => {
    if ((e.target as HTMLElement).closest("a, button") || window.getSelection()?.toString()) return;
    open(key);
  };
  const onKey = (e: KeyboardEvent<HTMLAnchorElement>, key: string) => {
    if (e.key.toLowerCase() === "e" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); open(key, true); }
  };

  return (
    <>
      {shell.problemsOnly && !shell.sel.customer ? (
        <div className="note co-note" data-testid="co-problems-note">
          {showAll
            ? <span><b>Only with problems</b> is on in the tree, and this list shows every customer anyway.</span>
            : <span><b>Only with problems</b> is on in the tree: {hiddenCustomers} customer{hiddenCustomers === 1 ? "" : "s"} without an open incident or a call-order problem {hiddenCustomers === 1 ? "is" : "are"} not listed.</span>}
          <button type="button" className="btn sm" onClick={() => setShowAll((v) => !v)}>{showAll ? "Only with problems" : "Show all customers"}</button>
        </div>
      ) : null}
      <div className="tw co-tw">
        <table className="t co" data-testid="co-table">
          <thead>
            <tr><th className="c-path">Customer › project › service</th><th className="c-style">Order</th><th className="c-first">Called first now</th><th className="c-then">Then</th><th className="c-reach">Reach</th></tr>
          </thead>
          <tbody ref={body}>
            {shown.map((r) => {
              const h = r.health && r.health.level !== "OK" ? HEALTH[r.health.level] : null;
              const customer = r.org.customer?.name ?? "";
              const label = [customer, r.org.project?.name, r.org.service?.name].filter(Boolean).join(" › ");
              return (
                <tr key={r.key} data-testid="co-row" data-key={r.key} className={cx(r.health?.level === "UNREACHABLE" && "hot", r.health?.level === "AT_RISK" && "amb", openKey === r.key && "cur")} onClick={(e) => onRow(e, r.key)}>
                  <td className="c-path">
                    <Link href={callOrderPath(parseScopeKey(r.key)) + listQuery} data-key={r.key} className="co-path" data-testid="co-path" aria-current={openKey === r.key ? "true" : undefined}
                      aria-label={`Call order for ${label}`} onKeyDown={(e) => onKey(e, r.key)}>
                      <span><b>{customer}</b>{r.org.project ? <span className="chain" aria-hidden="true">›</span> : null}</span>
                      {r.org.project ? <span>{r.org.project.name}{r.org.service ? <span className="chain" aria-hidden="true">›</span> : null}</span> : null}
                      {r.org.service ? <span>{r.org.service.name}</span> : null}
                    </Link>
                    {h ? <span className={cx("stag co-hin", h.cls)}>{h.label}</span> : null}
                    {filterKey === r.key && !r.own ? <span className="pill co-yf">your filter</span> : null}
                  </td>
                  <td className="c-style" data-l="Order">
                    <div>
                      <span data-testid="co-style">{STYLE_LABEL[r.style]}</span>
                      {r.level !== "CUSTOMER" && r.own ? <span className="pill accent co-own">Own steps</span> : null}
                      {!r.own && r.inheritedFrom ? <div className="org">inherits from {r.inheritedFrom.level === "CUSTOMER" ? customer : `${customer} › ${r.inheritedFrom.name}`}</div> : null}
                    </div>
                  </td>
                  <td className="c-first" data-l="Called first now"><First row={r} /></td>
                  <td className="c-then" data-l="Then">
                    <div>
                      {r.steps.slice(1).map((s, n) => <div key={n} className="co-then"><span className="mono">{s.atMin} min</span> {thenLine(s)}</div>)}
                      <div className="co-then mut">then {repeatText(r.repeatCount)}</div>
                    </div>
                  </td>
                  <td className="c-reach" data-l="Reach">
                    {r.health ? (
                      <div>
                        {h ? <span className={cx("stag", h.cls)} data-testid="co-reach">{h.label}</span> : <span className="st res"><Mark shape="chk" />OK</span>}
                        {h && r.health.first ? <div className="org">{r.health.first}{r.health.problems > 1 ? ` (+${r.health.problems - 1} more)` : ""}</div> : null}
                      </div>
                    ) : <span className="mut" title="Reach is worked out for the customer as a whole">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 ? <div className="empty"><div className="t1">No customers match.</div></div> : null}
      </div>
      <div className="sm mut co-foot">
        Projects and services with their own steps have their own row. Open a row to read its order; editing is inside the panel, for exactly the row you opened.
        <span className="co-keys"> <span className="kbd">Enter</span> open · <span className="kbd">E</span> edit</span>
      </div>
    </>
  );
}
