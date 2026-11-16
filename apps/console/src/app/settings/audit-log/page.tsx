import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, EmptyState } from "@alarmops/design-system";
import { getApi } from "@/lib/api";
import { ApiError, isHidden } from "@/lib/api/client";
import type { ContactRevealEntry, ContactRevealQuery } from "@/lib/api/types";
import { SubNav } from "@/components/SubNav";
import { kstDateTime } from "@/lib/format";
import { isSlug } from "@/lib/validate";
import type { SP } from "@/lib/query";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: string | undefined) => (v && DAY.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);
const CHANNEL: Record<ContactRevealEntry["channel"], string> = { PHONE: "Phone", EMAIL: "Email", SLACK: "Slack" };

/**
 * Settings › Audit log, the review view of contact reveals (D-35): who opened whose contact, for which customer and
 * why, when, and who was told. Never a contact value. Emergency reveals first by default, because those are the ones
 * somebody has to look at. ADMIN sees every customer; other staff see the customers they are Responders of. A portal
 * user has no such list (404).
 */
export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const api = await getApi();
  const me = await api.me();
  if (me.kind === "CUSTOMER") notFound();

  const modeParam = one(sp.mode);
  const mode: ContactRevealQuery["mode"] | "ALL" = modeParam === "ALL" ? "ALL" : modeParam === "NORMAL" ? "NORMAL" : "EMERGENCY";
  const customer = isSlug(one(sp.customer)) ? one(sp.customer) : undefined;
  const from = day(one(sp.from));
  const to = day(one(sp.to));
  const cursor = /^\d{1,6}$/.test(one(sp.cursor) ?? "") ? one(sp.cursor) : undefined;
  const filtered = mode !== "EMERGENCY" || Boolean(customer || from || to);

  let items: ContactRevealEntry[] = [];
  let next: string | null = null;
  let customers: { slug: string; name: string }[] = [];
  let error: string | null = null;
  if (me.role === "VIEWER") {
    error = "The reveal log needs the Operator role. You are signed in as Viewer.";
  } else {
    try {
      customers = (await api.scopeTree()).customers.map((c) => ({ slug: c.slug, name: c.name }));
      const r = await api.listContactReveals({
        ...(mode !== "ALL" ? { mode } : {}), ...(customer ? { customer } : {}),
        ...(from ? { from: `${from}T00:00:00+09:00` } : {}), ...(to ? { to: `${to}T23:59:59+09:00` } : {}), ...(cursor ? { cursor } : {}),
      });
      items = r.items; next = r.nextCursor;
    } catch (e) {
      if (isHidden(e) && !(e instanceof ApiError && e.status === 403)) notFound();
      error = e instanceof ApiError && e.status === 403 ? "You do not have access to the reveal log." : "Could not load the reveal log. Try again.";
    }
  }
  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (modeParam) p.set("mode", mode);
    if (customer) p.set("customer", customer);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  return (
    <div className="page">
      <div className="ph"><div><h1 tabIndex={-1}>Audit log</h1><div className="desc">Who opened whose contact details, and why. The values themselves are never kept.</div></div></div>
      <SubNav />
      <Card title={mode === "EMERGENCY" ? "Emergency reveals" : mode === "NORMAL" ? "Normal reveals" : "All reveals"}>
        <form method="get" className="rr-filters" data-testid="reveal-filters" aria-label="Filter reveals">
          <label><span>Show</span>
            <select className="inp" name="mode" defaultValue={mode} data-testid="rr-mode">
              <option value="EMERGENCY">Emergency reveals only</option>
              <option value="NORMAL">Normal reveals only</option>
              <option value="ALL">All reveals</option>
            </select>
          </label>
          <label><span>Customer</span>
            <select className="inp" name="customer" defaultValue={customer ?? ""} data-testid="rr-customer">
              <option value="">All customers</option>
              {customers.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
          </label>
          <label><span>From (KST)</span><input className="inp" type="date" name="from" defaultValue={from ?? ""} data-testid="rr-from" /></label>
          <label><span>To (KST)</span><input className="inp" type="date" name="to" defaultValue={to ?? ""} data-testid="rr-to" /></label>
          <button type="submit" className="btn pri" data-testid="rr-apply">Apply filters</button>
          {filtered ? <Link className="btn" href="/settings/audit-log" data-testid="rr-clear">Clear filters</Link> : null}
        </form>
        {error ? <div className="co-err" role="alert" data-testid="rr-error">{error}</div> : items.length === 0 ? (
          <EmptyState title={mode === "EMERGENCY" && !filtered ? "No emergency reveals" : "No reveals match"} detail={filtered ? "Change or clear the filters to see more." : "Nobody has opened a contact outside their own customers."} />
        ) : (
          <>
            <p className="sm mut" data-testid="rr-count">{items.length} {items.length === 1 ? "reveal" : "reveals"}{next ? " on this page" : ""}, newest first.</p>
            <table className="rr-table" data-testid="reveal-table">
              <thead><tr><th scope="col">When</th><th scope="col">Type</th><th scope="col">Who</th><th scope="col">Contact</th><th scope="col">Customer</th><th scope="col">Reason</th><th scope="col">Told</th></tr></thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} data-testid="reveal-row" data-mode={e.mode}>
                    <td data-label="When">{kstDateTime(e.at)}</td>
                    <td data-label="Type"><span className="rr-mode" data-testid="rr-row-mode"><span aria-hidden="true">{e.mode === "EMERGENCY" ? "▲" : "●"}</span>{e.mode === "EMERGENCY" ? "Emergency" : "Normal"}</span></td>
                    <td data-label="Who">{e.actor.name}</td>
                    <td data-label="Contact">{e.contact.name} · {CHANNEL[e.channel]}</td>
                    <td data-label="Customer">{e.org.customer?.name ?? "—"}</td>
                    <td data-label="Reason">{e.reason ?? "—"}</td>
                    <td data-label="Told">{e.notified.length ? e.notified.map((n) => n.name).join(", ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {next ? <p><Link className="btn" href={qs({ cursor: next })} data-testid="rr-older">Older reveals</Link></p> : null}
          </>
        )}
      </Card>
    </div>
  );
}
