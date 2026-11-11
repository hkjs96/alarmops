"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import { Banner, ConfirmDialog, Tombstone, cx, isSameSpot, markSpot, useStableRows } from "@alarmops/design-system";
import type {
  ChannelState, ContactChannelKey, CustomerPersonResponder, CustomerPersonRole, PagingHealth, PagingPathStep, PagingStep, ResponderDisplay, RespondersResponse,
  RotationSummary, StaffResponder, StaffSummary,
} from "@/lib/api/types";
import { computeHealth, plural, type Directory } from "@/lib/call-order/model";
import { errorLine, type Failure } from "@/lib/errors";
import { hasRole, roleReason, useShell } from "@/components/ShellContext";
import { addResponder, removeResponder, setResponderRole } from "./actions";

const CH_NAME: Record<ContactChannelKey, string> = { SLACK: "Slack DM", EMAIL: "Email", SMS: "SMS", VOICE: "Call" };
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

type StaffRow = StaffResponder & { id: string; status: string };
type PersonRow = CustomerPersonResponder & { id: string; status: string };
interface Ask {
  kind: "remove" | "role";
  id: string;
  name: string;
  staff: boolean;
  /** the role a customer person has now (and gets back on Undo) */
  role?: CustomerPersonRole;
  /** the server refused once because nobody would be reachable: say it, and send the confirmation with the retry */
  forced?: boolean;
}
/** what the customer's reach would be after a change, next to what it is now */
interface Outlook { unreachable: boolean; worse: string[] }

/**
 * Responders of the customer: MSP staff and the customer's own people (D-30). A customer person can be Pageable
 * (called, texted, part of "everyone") or Notify only. Contact details are masked here; showing a full value is the
 * Reveal flow of D-35, which this screen does not have yet.
 *
 * The list follows the console's one rule for lists (design-system list/): a change never moves a row under the
 * pointer. A removed person stays where they were as "Removed · Undo" until Done or leaving the panel; a person who
 * is added goes after the last row; Remove asks first, naming the person and the customer, with the safe choice
 * focused, and says loudly when the change would leave nobody reachable; a second press at the same spot within
 * 600 ms does nothing. Every write carries the version of the list the user saw (409 → "Changed — reload").
 */
export function RespondersCard({ customer, customerName, services, responders, staff, steps, customerSteps, customerRepeat, rotations, blocked, onEditingChange }: {
  customer: string; customerName: string;
  /** how many services of the customer there are: Responders belong to all of them */
  services: number;
  responders: RespondersResponse; staff: StaffSummary[];
  /** the steps shown in the panel (for the "step n" marks) */
  steps: PagingPathStep[];
  /** the customer-level steps: paging health is worked out from these (D-32) */
  customerSteps: readonly PagingStep[]; customerRepeat: number;
  rotations: RotationSummary[];
  /** why Responders cannot be edited right now (the steps are being edited); null when they can */
  blocked: string | null;
  onEditingChange?: (editing: boolean) => void;
}) {
  const shell = useShell();
  const router = useRouter();
  const admin = hasRole(shell.user, "ADMIN");
  const why = !admin ? roleReason(shell.user, "ADMIN", "Changing Responders") : blocked;
  const [editing, setEditing] = useState(false);
  const on = editing && !why;
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState<Record<string, "remove" | "undo" | "role" | "add">>({});
  const [ask, setAsk] = useState<Ask | null>(null);
  /** removed in this visit: who, and what puts them back */
  const [removed, setRemoved] = useState<Record<string, { name: string; staff: boolean; role?: CustomerPersonRole }>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  /** put back a moment ago: until the list says so itself, the row says it is coming back */
  const [restored, setRestored] = useState<Record<string, true>>({});
  const [pick, setPick] = useState("");
  const [form, setForm] = useState({ name: "", email: "", phone: "", role: "NOTIFY_ONLY" as CustomerPersonRole });
  const listRef = useRef<HTMLDivElement>(null);
  /** the version of the Responders list the next write is checked against: what the page shows, or what the last write returned */
  const ver = useRef(responders.version);
  if (responders.version > ver.current) ver.current = responders.version;

  const staffItems = useMemo<StaffRow[]>(() => responders.staff.map((p) => ({ ...p, id: p.contactId, status: p.source })), [responders.staff]);
  const peopleItems = useMemo<PersonRow[]>(() => responders.people.map((p) => ({ ...p, id: p.contactId, status: p.role })), [responders.people]);
  const staffRows = useStableRows(staffItems, `staff:${customer}`, { fresh: "append" });
  const peopleRows = useStableRows(peopleItems, `people:${customer}`, { fresh: "append" });
  const tombstones = [...staffRows.rows, ...peopleRows.rows].filter((r) => r.gone || removed[r.item.id]).length;

  const stepOf = (id: string) => steps.findIndex((s) => s.targetType === "PERSON" && s.targetId === id);
  const others = staff.filter((s) => !responders.staff.some((r) => r.contactId === s.contactId));
  const pageable = responders.staff.length + responders.people.filter((p) => p.role === "PAGEABLE").length;

  /* ---- what a change would do to the customer's reach (D-32), said before it is made ---- */
  const dir: Directory = useMemo(() => ({ customerName, staff: responders.staff, people: responders.people, rotations, allStaff: staff, slackChannel: responders.slackChannel }),
    [customerName, responders, rotations, staff]);
  const health = (d: Directory): PagingHealth => computeHealth(customerSteps, d, [], customerRepeat);
  function outlook(a: Ask): Outlook {
    const before = health(dir);
    const after = health(a.kind === "remove"
      ? { ...dir, staff: dir.staff.filter((p) => p.contactId !== a.id), people: dir.people.filter((p) => p.contactId !== a.id) }
      : { ...dir, people: dir.people.map((p) => (p.contactId === a.id ? { ...p, role: "NOTIFY_ONLY" as const } : p)) });
    const had = new Set(before.problems.map((p) => p.message));
    return { unreachable: Boolean(a.forced) || (after.level === "UNREACHABLE" && before.level !== "UNREACHABLE"), worse: after.problems.map((p) => p.message).filter((m) => !had.has(m)) };
  }
  const look = ask ? outlook(ask) : null;

  const setBusyFor = (id: string, v: "remove" | "undo" | "role" | "add" | null) => setBusy((b) => { const n = { ...b }; if (v) n[id] = v; else delete n[id]; return n; });
  const failed = (r: Failure) => {
    // the list moved on under the user: nothing was changed, and the next write must start from what is there now
    if (r.code === "VERSION_CONFLICT") { setConflict(true); setErr(null); return; }
    setErr(errorLine(r, { what: "Changing Responders", where: customerName }));
  };
  const lockHeight = (id: string) => {
    const el = listRef.current?.querySelector<HTMLElement>(`li[data-row-key="${CSS.escape(id)}"]`);
    if (el) setHeights((h) => ({ ...h, [id]: el.getBoundingClientRect().height }));
  };

  /* ---- remove (asked first) and its Undo, per person ---- */
  const undoRemove = async (id: string) => {
    const was = removed[id];
    if (!was || busy[id]) return;
    setBusyFor(id, "undo"); setErr(null);
    const r = await addResponder(customer, was.staff ? { contactId: id } : { contactId: id, role: was.role }, ver.current);
    setBusyFor(id, null);
    if (!r.ok) { failed(r); return; }
    ver.current = Math.max(ver.current, r.data.version);
    setRemoved((m) => { const n = { ...m }; delete n[id]; return n; });
    setRestored((m) => ({ ...m, [id]: true }));
    shell.toast(`${was.name} is back in Responders of ${customerName}`);
  };
  const doRemove = async (a: Ask, confirmUnreachable: boolean) => {
    lockHeight(a.id);
    setBusyFor(a.id, "remove"); setErr(null);
    const r = await removeResponder(customer, a.id, ver.current, confirmUnreachable);
    setBusyFor(a.id, null);
    if (!r.ok) {
      if (r.code === "WOULD_BE_UNREACHABLE") { shell.clearToast(); setAsk({ ...a, forced: true }); return; }
      failed(r);
      return;
    }
    ver.current = Math.max(ver.current, r.data.version);
    setRemoved((m) => ({ ...m, [a.id]: { name: a.name, staff: a.staff, role: a.role } }));
    setRestored((m) => { const n = { ...m }; delete n[a.id]; return n; });
    shell.toast(`${a.name} removed from Responders of ${customerName}`);
  };
  const doRole = async (a: { id: string; name: string }, to: CustomerPersonRole, was: CustomerPersonRole, confirmUnreachable = false, quiet = false) => {
    setBusyFor(a.id, "role"); setErr(null);
    const r = await setResponderRole(customer, a.id, to, ver.current, confirmUnreachable);
    setBusyFor(a.id, null);
    if (!r.ok) {
      if (r.code === "WOULD_BE_UNREACHABLE") { shell.clearToast(); setAsk({ kind: "role", id: a.id, name: a.name, staff: false, role: was, forced: true }); return; }
      failed(r);
      return;
    }
    ver.current = Math.max(ver.current, r.data.version);
    if (quiet) { shell.toast(`Undone · ${a.name} is ${ROLE[to]} for ${customerName} again`); return; }
    shell.toast(`${a.name} is now ${ROLE[to]} for ${customerName}`, { label: "Undo", onAction: () => { void doRole(a, was, to, false, true); } });
  };
  const askRemove = (e: MouseEvent, a: Ask) => {
    if (isSameSpot(e) || busy[a.id]) return;
    markSpot(e); // the dialog comes up under this press
    shell.clearToast();
    setAsk(a);
  };
  const onRole = (p: PersonRow, to: CustomerPersonRole) => {
    if (to === p.role || busy[p.id]) return;
    const a: Ask = { kind: "role", id: p.id, name: p.name, staff: false, role: p.role };
    // taking someone off the call list is asked about when it costs reach; making someone Pageable never does
    if (to === "NOTIFY_ONLY") { const o = outlook(a); if (o.unreachable || o.worse.length) { shell.clearToast(); setAsk(a); return; } }
    void doRole(a, to, p.role);
  };
  const confirmAsk = () => {
    const a = ask!;
    const sure = Boolean(look?.unreachable);
    setAsk(null);
    if (a.kind === "remove") void doRemove(a, sure); else void doRole(a, "NOTIFY_ONLY", a.role ?? "PAGEABLE", sure);
  };

  /* ---- add ---- */
  const addStaff = async (e: MouseEvent) => {
    const s = others.find((x) => x.contactId === pick);
    if (!s || isSameSpot(e) || busy.add) return;
    markSpot(e);
    setBusyFor("add", "add"); setErr(null);
    const r = await addResponder(customer, { contactId: s.contactId }, ver.current);
    setBusyFor("add", null);
    if (!r.ok) { failed(r); return; }
    ver.current = Math.max(ver.current, r.data.version);
    setPick("");
    shell.toast(`${s.name} added to Responders of ${customerName}`);
  };
  const addPerson = async (e: FormEvent) => {
    e.preventDefault();
    if (busy.add) return;
    const name = form.name.trim();
    if (!name) { setErr("Enter the person's name."); return; }
    if (!form.email.trim() && !form.phone.trim()) { setErr("Enter an email or a phone number."); return; }
    setBusyFor("add", "add"); setErr(null);
    const r = await addResponder(customer, { name, email: form.email, phone: form.phone, role: form.role }, ver.current);
    setBusyFor("add", null);
    if (!r.ok) { failed(r); return; }
    ver.current = Math.max(ver.current, r.data.version);
    // the typed address and number are not kept in the page once sent; the list shows them masked
    setForm({ name: "", email: "", phone: "", role: "NOTIFY_ONLY" });
    shell.toast(`${name} added to ${customerName} as ${ROLE[form.role]} · a confirmation link is sent`);
  };

  /** Done (or the steps editor taking over): the explicit refresh. Tombstones go, the list is taken as it is now. */
  const finish = () => {
    setEditing(false); setErr(null); setRemoved({}); setHeights({}); setRestored({});
    staffRows.resort(); peopleRows.resort();
  };
  useEffect(() => { onEditingChange?.(on); }, [on, onEditingChange]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the steps editor takes over
  useEffect(() => { if (blocked && editing) finish(); }, [blocked]);
  const reload = () => { setConflict(false); setErr(null); router.refresh(); };

  const tomb = (id: string, name: string, gone: boolean) => {
    const mine = removed[id];
    if (!mine && !gone) return null;
    if (!mine && restored[id]) return <span className="tomb" role="status"><span className="tomb-t"><b>{name}</b> · back in Responders…</span></span>;
    return (
      <Tombstone
        name={name} action="responder.undo-remove" busy={busy[id] === "undo"}
        label={<>{name} · {mine ? "Removed" : "No longer in Responders"}</>}
        detail={mine ? (on ? "kept here until you press Done" : undefined) : "changed by someone else"}
        onUndo={mine && on ? () => { void undoRemove(id); } : undefined}
      />
    );
  };
  const rowStyle = (id: string): CSSProperties | undefined => (heights[id] !== undefined ? { height: heights[id], boxSizing: "border-box" } : undefined);

  return (
    <section className="card co-resp" aria-labelledby="co-resp-h" data-testid="co-responders" data-editing={on ? "1" : undefined}>
      <div className="card-h">
        <span className="ov" id="co-resp-h">Responders · {customerName}</span>
        <span className="sp" />
        <button type="button" className="btn sm" data-testid="co-resp-edit" aria-pressed={on} disabled={Boolean(why)} aria-describedby={why ? "co-resp-why" : undefined}
          onClick={() => { if (editing) finish(); else { setEditing(true); setErr(null); } }}>
          {on ? "Done" : `Edit responders for ${customerName}`}
        </button>
      </div>
      <div className="co-resp-b" ref={listRef}>
        {why ? <p className="sm mut co-resp-n" id="co-resp-why" data-testid="co-resp-why">{why}</p> : null}
        <p className="sm mut co-resp-n">“Everyone in Responders” is these {pageable}: all MSP staff here plus the Pageable people of {customerName}. Responders belong to the whole customer, whatever level this panel shows.</p>
        {on ? <p className="sm co-resp-n" data-testid="co-resp-rule">Each change applies at once to all of {customerName}. Rows keep their place: a removed person stays as “Removed · Undo” until you press Done{tombstones ? ` (${tombstones} now)` : ""}.</p> : null}
        {conflict ? (
          <Banner tone="amber">
            <div data-testid="co-resp-conflict">
              <div><b>Changed — reload.</b> Someone else changed the Responders of {customerName} while you were editing. Your last change was not applied.</div>
              <div className="row" style={{ marginTop: 8 }}><button type="button" className="btn sm" data-testid="co-resp-reload" onClick={reload}>Reload the Responders of {customerName}</button></div>
            </div>
          </Banner>
        ) : null}
        {err ? <div className="co-err" role="alert" data-testid="co-resp-err">{err}</div> : null}

        <div className="ov co-resp-g">MSP staff ({responders.staff.length})</div>
        {on ? (
          <div className="row co-addrow">
            <select className="inp" aria-label="MSP staff to add" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Add MSP staff…</option>
              {others.map((s) => <option key={s.contactId} value={s.contactId}>{s.name}{s.title ? ` · ${s.title}` : ""}</option>)}
            </select>
            <button type="button" className="btn" disabled={Boolean(busy.add) || !pick || conflict} data-list-action="responder.add" onClick={(e) => { void addStaff(e); }}>Add to {customerName}</button>
          </div>
        ) : null}
        <ul className="co-people" data-testid="co-staff-list">
          {staffRows.rows.map(({ item: p, gone }) => {
            const t = tomb(p.id, p.name, gone);
            return (
              <li key={p.id} data-testid="co-staff" data-row-key={p.id} data-gone={t ? "1" : undefined} className={cx(t && "gone")} style={rowStyle(p.id)}>
                {t ?? (
                  <>
                    <div className="co-person">
                      <div><b>{p.name}</b>{p.title ? <span className="sm mut"> · {p.title}</span> : null}{stepOf(p.contactId) >= 0 ? <span className="pill co-pl">step {stepOf(p.contactId) + 1}</span> : null}</div>
                      <div className="sm mut">{p.source === "TEMPLATE" ? `from ${p.templateName ?? "a template"}` : "added directly"} · <Masked p={p} /></div>
                      <Channels p={p} />
                    </div>
                    {on ? (p.source === "DIRECT"
                      ? <button type="button" className="btn sm danger" disabled={Boolean(busy[p.id]) || conflict} data-list-action="responder.remove" aria-haspopup="dialog" aria-label={`Remove ${p.name} from Responders of ${customerName}`}
                          onClick={(e) => askRemove(e, { kind: "remove", id: p.id, name: p.name, staff: true })}>{busy[p.id] === "remove" ? "Removing…" : "Remove…"}</button>
                      : <span className="sm mut co-tpl">set by the template</span>) : null}
                  </>
                )}
              </li>
            );
          })}
          {staffRows.rows.length === 0 ? <li className="sm mut">No MSP staff.</li> : null}
        </ul>

        <div className="ov co-resp-g">{customerName} people ({responders.people.length})</div>
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
            <button type="submit" className="btn" disabled={Boolean(busy.add) || conflict} data-list-action="responder.add-person">Add to {customerName}</button>
          </form>
        ) : null}
        <ul className="co-people" data-testid="co-people-list">
          {peopleRows.rows.map(({ item: p, gone }) => {
            const t = tomb(p.id, p.name, gone);
            return (
              <li key={p.id} data-testid="co-cust-person" data-row-key={p.id} data-gone={t ? "1" : undefined} className={cx(t && "gone")} style={rowStyle(p.id)}>
                {t ?? (
                  <>
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
                        <select className="inp" aria-label={`Role of ${p.name}`} value={p.role} disabled={Boolean(busy[p.id]) || conflict} data-list-action="responder.role"
                          onChange={(e) => onRole(p, e.target.value as CustomerPersonRole)}>
                          <option value="PAGEABLE">Pageable (calls, SMS)</option>
                          <option value="NOTIFY_ONLY">Notify only</option>
                        </select>
                        <button type="button" className="btn sm danger" disabled={Boolean(busy[p.id]) || conflict} data-list-action="responder.remove" aria-haspopup="dialog" aria-label={`Remove ${p.name} from ${customerName}`}
                          onClick={(e) => askRemove(e, { kind: "remove", id: p.id, name: p.name, staff: false, role: p.role })}>{busy[p.id] === "remove" ? "Removing…" : "Remove…"}</button>
                      </span>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
          {peopleRows.rows.length === 0 ? <li className="sm mut">No customer people yet.</li> : null}
        </ul>
        <p className="sm mut co-resp-n" data-testid="co-mask-note">Contact details are masked. Showing a full address or number (Reveal, logged) is not available on this screen yet.</p>
      </div>

      <ConfirmDialog
        open={Boolean(ask)} danger
        title={ask?.kind === "role" ? `Make ${ask.name} Notify only for ${customerName}?` : `Remove ${ask?.name} from Responders of ${customerName}?`}
        confirmLabel={ask?.kind === "role" ? `Make ${ask.name} Notify only for ${customerName}` : `Remove ${ask?.name} from ${customerName}`}
        cancelLabel={ask?.kind === "role" ? `Keep ${ask.name} Pageable` : `Keep ${ask?.name}`}
        warning={look?.unreachable ? (
          <><span className="stag unr">Unreachable</span> After this, nobody for {customerName} is reached if something breaks.
            <small>{look.worse[0] ?? `No step of ${customerName} would reach a person who can be called, texted or messaged.`} Add someone else first, or keep {ask?.name}.</small></>
        ) : undefined}
        onConfirm={confirmAsk} onCancel={() => setAsk(null)}
      >
        {ask ? (
          <div data-testid="co-resp-confirm">
            {!look?.unreachable && look?.worse.length ? (
              <div className="cdlg-warn amber" data-testid="confirm-at-risk"><span className="stag ar">At risk</span> After this, {customerName} is harder to reach:
                <small>{look.worse.join(" ")}</small></div>
            ) : null}
            <p>
              {ask.kind === "remove"
                ? <><b>{ask.name}</b> will no longer be called or notified for <b>{customerName}</b>.</>
                : <><b>{ask.name}</b> will no longer be called or texted for <b>{customerName}</b>; they still get the status mail.</>}{" "}
              Responders belong to the whole customer: this applies to <b>all {plural(services, "service")} of {customerName}</b>, at every level.
            </p>
            <p>{ask.kind === "remove" && (ask.staff || ask.role === "PAGEABLE") || ask.kind === "role"
              ? <>“Everyone in Responders” goes from {pageable} to {Math.max(0, pageable - 1)}. </> : null}
              {ask.kind === "remove" ? <>Their row stays in place as “Removed · Undo” until you press Done or leave this panel.</> : <>You can change it back in the same place.</>}</p>
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
