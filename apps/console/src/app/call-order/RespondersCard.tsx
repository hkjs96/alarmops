"use client";
import { useState, type FormEvent } from "react";
import { cx } from "@alarmops/design-system";
import type { ChannelState, ContactChannelKey, CustomerPersonRole, PagingPathStep, ResponderDisplay, RespondersResponse, StaffSummary } from "@/lib/api/types";
import { useShell } from "@/components/ShellContext";
import { addResponder, removeResponder, setResponderRole } from "./actions";

const CH_NAME: Record<ContactChannelKey, string> = { SLACK: "Slack", EMAIL: "Email", SMS: "SMS", VOICE: "Call" };
const STATE: Record<Exclude<ChannelState, "VERIFIED">, string> = { UNVERIFIED: "not verified", EXPIRED: "link expired", LINK_SENT: "link sent", NOT_SET: "not set" };
const ROLE: Record<CustomerPersonRole, string> = { PAGEABLE: "Pageable", NOTIFY_ONLY: "Notify only" };

function Channels({ p }: { p: ResponderDisplay }) {
  const bad = (Object.entries(p.channels) as [ContactChannelKey, ChannelState][]).filter(([, s]) => s !== "VERIFIED");
  if (bad.length === 0) return null;
  return <span className="co-chbad">{bad.map(([k, s]) => <span key={k} className="co-cv">{CH_NAME[k]} · {STATE[s as Exclude<ChannelState, "VERIFIED">]}</span>)}</span>;
}
const Masked = ({ p }: { p: ResponderDisplay }) => (
  <span className="mono xs co-mask" data-testid="co-masked">{[p.emailMasked, p.phoneMasked].filter(Boolean).join(" · ") || "no contact on file"}</span>
);

/**
 * Responders of the customer: MSP staff and the customer's own people (D-30). A customer person can be Pageable
 * (called, texted, part of "everyone") or Notify only. Contact details are masked here; showing a full value is the
 * Reveal flow of D-35, which this screen does not have yet.
 */
export function RespondersCard({ customer, customerName, responders, staff, steps, canEdit }: {
  customer: string; customerName: string; responders: RespondersResponse; staff: StaffSummary[]; steps: PagingPathStep[]; canEdit: boolean;
}) {
  const shell = useShell();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [form, setForm] = useState({ name: "", email: "", phone: "", role: "NOTIFY_ONLY" as CustomerPersonRole });
  const on = editing && canEdit;
  const stepOf = (id: string) => steps.findIndex((s) => s.targetType === "PERSON" && s.targetId === id);
  const others = staff.filter((s) => !responders.staff.some((r) => r.contactId === s.contactId));
  const pageable = responders.staff.length + responders.people.filter((p) => p.role === "PAGEABLE").length;

  async function run(fn: () => Promise<{ ok: boolean; message?: string }>, done: string, undo?: () => Promise<{ ok: boolean; message?: string }>) {
    setBusy(true); setErr(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) { setErr(r.message ?? "Something went wrong."); return false; }
    shell.toast(done, undo ? { label: "Undo", onAction: async () => { const u = await undo(); shell.toast(u.ok ? `Undone · ${done}` : `Could not undo — ${u.message}`); } } : undefined);
    return true;
  }
  const addStaff = async () => {
    const s = others.find((x) => x.contactId === pick);
    if (!s) return;
    if (await run(() => addResponder(customer, { contactId: s.contactId }), `${s.name} added to Responders of ${customerName}`, () => removeResponder(customer, s.contactId))) setPick("");
  };
  const addPerson = async (e: FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) { setErr("Enter the person's name."); return; }
    if (!form.email.trim() && !form.phone.trim()) { setErr("Enter an email or a phone number."); return; }
    setBusy(true); setErr(null);
    const r = await addResponder(customer, { name, email: form.email, phone: form.phone, role: form.role });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    const id = r.data.contactId;
    // the typed address and number are not kept in the page once sent; the list shows them masked
    setForm({ name: "", email: "", phone: "", role: "NOTIFY_ONLY" });
    shell.toast(`${name} added to ${customerName} as ${ROLE[form.role]} · a confirmation link is sent`, { label: "Undo", onAction: async () => { const u = await removeResponder(customer, id); shell.toast(u.ok ? `Undone · ${name} removed from ${customerName}` : `Could not undo — ${u.message}`); } });
  };

  return (
    <section className="card co-resp" aria-labelledby="co-resp-h" data-testid="co-responders">
      <div className="card-h">
        <span className="ov" id="co-resp-h">Responders · {customerName}</span>
        <span className="sp" />
        {canEdit ? (
          <button type="button" className="btn sm" data-testid="co-resp-edit" aria-pressed={editing} onClick={() => { setEditing((v) => !v); setErr(null); }}>
            {editing ? "Done" : `Edit responders for ${customerName}`}
          </button>
        ) : null}
      </div>
      <div className="co-resp-b">
        <p className="sm mut co-resp-n">“Everyone in Responders” is these {pageable}: all MSP staff here plus the Pageable people of {customerName}. Responders belong to the whole customer, whatever level this panel shows.</p>
        {err ? <div className="co-err" role="alert">{err}</div> : null}

        <div className="ov co-resp-g">MSP staff ({responders.staff.length})</div>
        <ul className="co-people">
          {responders.staff.map((p) => (
            <li key={p.contactId} data-testid="co-staff">
              <div className="co-person">
                <div><b>{p.name}</b>{p.title ? <span className="sm mut"> · {p.title}</span> : null}{stepOf(p.contactId) >= 0 ? <span className="pill co-pl">step {stepOf(p.contactId) + 1}</span> : null}</div>
                <div className="sm mut">{p.source === "TEMPLATE" ? `from ${p.templateName ?? "a template"}` : "added directly"} · <Masked p={p} /></div>
                <Channels p={p} />
              </div>
              {on ? (p.source === "DIRECT"
                ? <button type="button" className="btn sm danger" disabled={busy} aria-label={`Remove ${p.name} from Responders of ${customerName}`}
                    onClick={() => run(() => removeResponder(customer, p.contactId), `${p.name} removed from Responders of ${customerName}`, () => addResponder(customer, { contactId: p.contactId }))}>Remove</button>
                : <span className="sm mut co-tpl">set by the template</span>) : null}
            </li>
          ))}
          {responders.staff.length === 0 ? <li className="sm mut">No MSP staff.</li> : null}
        </ul>
        {on ? (
          <div className="row co-addrow">
            <select className="inp" aria-label="MSP staff to add" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Add MSP staff…</option>
              {others.map((s) => <option key={s.contactId} value={s.contactId}>{s.name}{s.title ? ` · ${s.title}` : ""}</option>)}
            </select>
            <button type="button" className="btn" disabled={busy || !pick} onClick={addStaff}>Add to {customerName}</button>
          </div>
        ) : null}

        <div className="ov co-resp-g">{customerName} people ({responders.people.length})</div>
        <ul className="co-people">
          {responders.people.map((p) => (
            <li key={p.contactId} data-testid="co-cust-person">
              <div className="co-person">
                <div>
                  <b>{p.name}</b>{p.title ? <span className="sm mut"> · {p.title}</span> : null}
                  <span className={cx("pill co-pl", p.role === "PAGEABLE" && "prd")} data-testid="co-role">{ROLE[p.role]}</span>
                  {p.extras.includes("APPROVER") ? <span className="pill co-pl">Auto-fix approver</span> : null}
                  {p.extras.includes("PORTAL_USER") ? <span className="pill co-pl">Portal</span> : null}
                  {stepOf(p.contactId) >= 0 ? <span className="pill co-pl">step {stepOf(p.contactId) + 1}</span> : null}
                </div>
                <div className="sm mut">Notified for {p.scope.level === "CUSTOMER" ? `all of ${customerName}` : p.scope.name} · <Masked p={p} /></div>
                <Channels p={p} />
              </div>
              {on ? (
                <span className="co-pctl">
                  <select className="inp" aria-label={`Role of ${p.name}`} value={p.role} disabled={busy}
                    onChange={(e) => { const to = e.target.value as CustomerPersonRole; const was = p.role; void run(() => setResponderRole(customer, p.contactId, to), `${p.name} is now ${ROLE[to]} for ${customerName}`, () => setResponderRole(customer, p.contactId, was)); }}>
                    <option value="PAGEABLE">Pageable (calls, SMS)</option>
                    <option value="NOTIFY_ONLY">Notify only</option>
                  </select>
                  <button type="button" className="btn sm danger" disabled={busy} aria-label={`Remove ${p.name} from ${customerName}`}
                    onClick={() => run(() => removeResponder(customer, p.contactId), `${p.name} removed from Responders of ${customerName}`, () => addResponder(customer, { contactId: p.contactId, role: p.role }))}>Remove</button>
                </span>
              ) : null}
            </li>
          ))}
          {responders.people.length === 0 ? <li className="sm mut">No customer people yet.</li> : null}
        </ul>
        {on ? (
          <form className="co-newp" onSubmit={addPerson} data-testid="co-add-person">
            <div className="ov">Add a {customerName} person</div>
            <label><span className="lab">Name</span><input className="inp" value={form.name} maxLength={80} autoComplete="off" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label><span className="lab">Email</span><input className="inp" type="email" value={form.email} autoComplete="off" onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label><span className="lab">Phone</span><input className="inp" type="tel" value={form.phone} autoComplete="off" onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <label><span className="lab">Role</span>
              <select className="inp" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as CustomerPersonRole })}>
                <option value="NOTIFY_ONLY">Notify only (status mail)</option>
                <option value="PAGEABLE">Pageable (calls, SMS, part of “everyone”)</option>
              </select>
            </label>
            <button type="submit" className="btn" disabled={busy}>Add to {customerName}</button>
          </form>
        ) : null}
        <p className="sm mut co-resp-n" data-testid="co-mask-note">Contact details are masked. Showing a full address or number (Reveal, logged) is not available on this screen yet.</p>
      </div>
    </section>
  );
}
