"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Card, ConfirmDialog, EmptyState } from "@alarmops/design-system";
import type { CustomerStatusValue, Role, UserItem, UserKind, UserStatus } from "@/lib/api/types";
import { kstDateTime } from "@/lib/format";
import { callAction } from "@/lib/session-ended";
import { NAME_MAX, ROLE_HELP, ROLE_LABEL, STATUS_LABEL, STATUS_MARK, newUserProblems, normalizeEmail, outsideFence, rowRules, userErrorText } from "@/lib/users";
import { addUserAccount, changeUserAccount } from "./actions";
import "./users.css";

export interface UsersFilters { kind: UserKind | ""; customerId: string; status: UserStatus | ""; role: Role | "" }
export interface UsersScreenProps {
  users: UserItem[];
  customers: { id: string; name: string; status: CustomerStatusValue }[];
  meId: string;
  /** ACTIVE staff ADMINs with all customers, counted without the list filter */
  activeAdmins: number;
  /** SSO_ALLOWED_DOMAINS as the console knows it; empty = not configured here */
  fenceDomains: string[];
  filters: UsersFilters;
  /** the list could not be read: the filters and the add form still work */
  error?: string | null;
}

type Ask = { type: "role" | "disable" | "enable" | "move" | "google"; user: UserItem };
const ROLES: Role[] = ["ADMIN", "OPERATOR", "VIEWER"];

export function UsersScreen({ users: loaded, customers, meId, activeAdmins, fenceDomains, filters, error }: UsersScreenProps) {
  const router = useRouter();
  const cname = (id: string | null) => customers.find((c) => c.id === id)?.name ?? "a customer";
  // the text search never leaves the browser: it narrows the list already loaded (names and masked addresses), so no address fragment reaches the URL, history, proxy logs or Referer
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const users = needle ? loaded.filter((u) => `${u.name} ${u.emailMasked} ${u.kind === "CUSTOMER" ? cname(u.customerId) : "staff"}`.toLowerCase().includes(needle)) : loaded;
  const serverFiltered = Boolean(filters.kind || filters.customerId || filters.status || filters.role);
  const filtered = serverFiltered || needle !== "";
  // after Apply filters the results line takes the focus (not the body)
  const countRef = useRef<HTMLParagraphElement>(null);
  const filterKey = JSON.stringify(filters);
  const seenKey = useRef(filterKey);
  useEffect(() => {
    if (seenKey.current === filterKey) return;
    seenKey.current = filterKey;
    const t = setTimeout(() => countRef.current?.focus(), 120); // after the shell has moved the focus on a navigation
    return () => clearTimeout(t);
  }, [filterKey]);

  // ---- result line (role=status): the one place a finished change is said; it takes the focus when a dialog or form closes
  const [result, setResult] = useState("");
  const resultRef = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState(0);
  const say = (text: string) => { setResult(text); setSaid((n) => n + 1); };
  // after the commit: the line is display:none while empty, and an element that is not shown cannot take the focus
  useEffect(() => { if (said > 0) resultRef.current?.focus(); }, [said]);

  // ---- add user
  const [adding, setAdding] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);
  // ---- per-row dialogs
  const [ask, setAsk] = useState<Ask | null>(null);
  const [roleSel, setRoleSel] = useState<Role>("VIEWER");
  const [custSel, setCustSel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const errBox = useRef<HTMLDivElement>(null);
  useEffect(() => { if (err) { errBox.current?.focus({ preventScroll: true }); errBox.current?.scrollIntoView({ block: "nearest" }); } }, [err]);

  const begin = (type: Ask["type"], user: UserItem) => {
    setErr(null); setResult("");
    setRoleSel(user.role);
    setCustSel(customers.find((c) => c.id !== user.customerId && c.status !== "TERMINATED")?.id ?? "");
    setAsk({ type, user });
  };
  const close = () => { if (!busy) setAsk(null); };

  async function confirm() {
    if (!ask || busy) return;
    const { type, user } = ask;
    setBusy(true); setErr(null);
    const patch = type === "role" ? { role: roleSel } : type === "disable" ? { status: "DISABLED" as const } : type === "enable" ? { status: "ACTIVE" as const }
      : type === "move" ? { customerId: custSel } : { clearGoogleSub: true as const };
    const r = await callAction(() => changeUserAccount(user.id, patch));
    setBusy(false);
    if (!r.ok) { setErr(userErrorText(r, { what: "Changing a user", name: user.name })); return; }
    setAsk(null);
    say(type === "role" ? `${user.name} is now ${ROLE_LABEL[roleSel]}. It applies from their next action; they stay signed in.`
      : type === "disable" ? `${user.name} is disabled. They are signed out on their next action and cannot sign in until you enable them.`
      : type === "enable" ? (user.status === "PENDING" ? `${user.name} is activated. They can sign in with their Google account.` : `${user.name} is enabled. They can sign in with their Google account again.`)
      : type === "move" ? `${user.name} now belongs to ${cname(custSel)} and sees only that customer, read-only.`
      : `Google link cleared for ${user.name}. The next sign-in with their e-mail address links the Google account used then.`);
    router.refresh();
  }

  const same = ask?.type === "role" && ask.user.role === roleSel;
  const target = ask?.user;
  const movable = customers.filter((c) => c.id !== target?.customerId && c.status !== "TERMINATED");

  return (
    <>
      <div className="us-bar">
        <div>
          <p className="sm mut us-count" style={{ margin: 0 }} role="status" tabIndex={-1} ref={countRef} data-testid="us-count">{error ? "The list could not be loaded." : `${users.length} ${users.length === 1 ? "user" : "users"}${filtered ? " match the filters" : ""}. E-mail addresses are shown masked.`}</p>
          <p className="us-hint" data-testid="us-legend"><b>Active</b> can sign in. <b>Disabled</b> was turned off by an admin. <b>Pending</b> was added but not activated yet: they cannot sign in until you activate them.</p>
        </div>
        <button type="button" ref={addBtn} className="btn pri" data-testid="us-add" aria-expanded={adding} aria-controls="us-add-panel" onClick={() => { setAdding((a) => !a); setResult(""); }}>
          {adding ? "Close" : "Add user"}
        </button>
      </div>

      <div className="us-result" role="status" tabIndex={-1} ref={resultRef} data-testid="us-result">
        {result ? <><span aria-hidden="true">✓</span><span>{result}</span></> : null}
      </div>

      {adding ? (
        <AddUser customers={customers} fenceDomains={fenceDomains}
          onDone={(m) => { setAdding(false); say(m); router.refresh(); }}
          onCancel={() => { setAdding(false); setTimeout(() => addBtn.current?.focus(), 0); }} />
      ) : null}

      <Card title="People who can sign in">
        <Filters customers={customers} filters={filters} serverFiltered={serverFiltered} search={search} onSearch={setSearch} />
        {error ? (
          <div className="co-err" role="alert" data-testid="us-error"><span>{error}</span> <Link className="btn sm" href="/settings/users">Try again</Link></div>
        ) : users.length === 0 ? (
          <EmptyState title={filtered ? "No users match" : "No users yet"} detail={filtered ? "Change or clear the filters to see more." : "Add the first user above."} />
        ) : (
          <table className="us-table" data-testid="us-table">
            <thead><tr>
              <th scope="col">Name</th><th scope="col">E-mail</th><th scope="col">Type</th><th scope="col">Role</th><th scope="col">Status</th>
              <th scope="col">Last sign-in</th><th scope="col">Google linked</th><th scope="col">Actions</th>
            </tr></thead>
            <tbody>
              {users.map((u) => {
                const rules = rowRules(u, { meId, activeAdmins });
                const noteId = `us-note-${u.id}`;
                const off = (why: string | null, by?: string) => ({ disabled: Boolean(why), "aria-describedby": why ? (rules.notes.length ? noteId : by) : undefined });
                return (
                  <tr key={u.id} data-testid="us-row" data-user={u.id} data-status={u.status} data-role={u.role} data-kind={u.kind}>
                    <td className="us-c-name"><span className="us-name" data-testid="us-name">{u.name}</span>{u.id === meId ? <span className="us-you">You</span> : null}</td>
                    <td data-label="E-mail" className="us-mail">{u.emailMasked.split("@")[0]}@<wbr />{u.emailMasked.split("@")[1]}</td>
                    <td data-label="Type">{u.kind === "INTERNAL" ? "Staff" : `Portal · ${cname(u.customerId)}`}</td>
                    <td data-label="Role" data-testid="us-role">{ROLE_LABEL[u.role]}{u.kind === "CUSTOMER" ? " (read-only)" : ""}</td>
                    <td data-label="Status"><span className={`us-st ${u.status}`} data-testid="us-status"><span aria-hidden="true">{STATUS_MARK[u.status]}</span>{STATUS_LABEL[u.status]}</span></td>
                    <td data-label="Last sign-in">{u.lastLoginAt ? kstDateTime(u.lastLoginAt) : "Never"}</td>
                    <td data-label="Google linked" data-testid="us-google" id={`us-g-${u.id}`}><span aria-hidden="true">{u.googleBound ? "✓" : "–"}</span> {u.googleBound ? "Yes" : "No — links at first sign-in"}</td>
                    <td className="us-c-acts" data-label="Actions">
                      <div className="us-acts" role="group" aria-label={`Actions for ${u.name}`}>
                        {u.kind === "INTERNAL"
                          ? <button type="button" className="btn" data-testid="us-act-role" {...off(rules.role)} onClick={() => begin("role", u)}>Change role…</button>
                          : <button type="button" className="btn" data-testid="us-act-move" {...off(rules.move)} onClick={() => begin("move", u)}>Move to customer…</button>}
                        {u.status === "ACTIVE"
                          ? <button type="button" className="btn" data-testid="us-act-disable" {...off(rules.status)} onClick={() => begin("disable", u)}>Disable…</button>
                          : <button type="button" className="btn" data-testid="us-act-enable" onClick={() => begin("enable", u)}>{u.status === "PENDING" ? "Activate…" : "Enable…"}</button>}
                        <button type="button" className="btn" data-testid="us-act-google" {...off(rules.google, `us-g-${u.id}`)} onClick={() => begin("google", u)}>Clear Google link…</button>
                      </div>
                      {rules.notes.map((n) => <p key={n} className="us-note" id={noteId} data-testid="us-note">{n}</p>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <div className="us-dlgwrap">
      <ConfirmDialog
        open={ask !== null}
        title={!target ? "" : ask!.type === "role" ? `Change the role of ${target.name}` : ask!.type === "disable" ? `Disable ${target.name}?` : ask!.type === "enable" ? `${target.status === "PENDING" ? "Activate" : "Enable"} ${target.name}?`
          : ask!.type === "move" ? `Move ${target.name} to another customer` : `Clear the Google link of ${target.name}?`}
        confirmLabel={busy ? "Working…" : !target ? "" : ask!.type === "role" ? `Change role to ${ROLE_LABEL[roleSel]}` : ask!.type === "disable" ? `Disable ${target.name}` : ask!.type === "enable" ? `${target.status === "PENDING" ? "Activate" : "Enable"} ${target.name}`
          : ask!.type === "move" ? `Move to ${cname(custSel)}` : "Clear Google link"}
        cancelLabel="Cancel" danger={ask?.type === "disable" || ask?.type === "google"} busy={busy}
        confirmDisabled={same || (ask?.type === "move" && !custSel)}
        onConfirm={() => { void confirm(); }} onCancel={close}
      >
        {target && ask ? (
          <div data-testid="us-dialog" data-ask={ask.type}>
            <p style={{ marginTop: 0 }}><b>{target.name}</b> · {target.emailMasked} · {target.kind === "INTERNAL" ? `Staff, ${ROLE_LABEL[target.role]}` : `Portal user of ${cname(target.customerId)}`}</p>
            {ask.type === "role" ? (
              <>
                <p>Staff see every customer; the role decides what they may change. It applies from their next action. They stay signed in.</p>
                <div className="us-dlg-radios" role="radiogroup" aria-label="New role">
                  {ROLES.map((r) => (
                    <label key={r} className="us-radio"><input type="radio" name="us-role" value={r} checked={roleSel === r} onChange={() => setRoleSel(r)} data-testid={`us-role-${r}`} />
                      <div><b>{ROLE_LABEL[r]}{r === target.role ? " (current)" : ""}</b><span>{ROLE_HELP[r]}</span></div></label>
                  ))}
                </div>
                {same ? <p className="us-hint" role="status">Choose a different role to continue.</p> : null}
              </>
            ) : null}
            {ask.type === "disable" ? (
              <p>They are signed out on their next action and cannot sign in again until you enable them. Their history and audit records stay. Users are never deleted.</p>
            ) : null}
            {ask.type === "enable" ? (
              target.status === "PENDING"
                ? <p>They will be able to sign in with their Google account{target.kind === "INTERNAL" ? ". Staff addresses must be in the allowed domains or on the exception list" : ""}. Nothing else changes.</p>
                : <p>They can sign in again with their Google account{target.kind === "INTERNAL" ? ". Staff addresses must still be in the allowed domains or on the exception list" : ""}. Their role{target.kind === "CUSTOMER" ? " (read-only) and customer stay" : " stays"} as it was.</p>
            ) : null}
            {ask.type === "move" ? (
              <>
                <p>{target.name} belongs to <b>{cname(target.customerId)}</b>. After the move they see only the new customer, read-only, and nothing of {cname(target.customerId)}. Their Google link and history stay.</p>
                <label className="us-dlg-sel"><span className="us-l b sm">New customer</span>
                  <select className="inp" value={custSel} onChange={(e) => setCustSel(e.target.value)} data-testid="us-move-select">
                    {movable.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === "SUSPENDED" ? " (suspended)" : ""}</option>)}
                  </select>
                </label>
                <p className="us-hint">Terminated customers are not listed. A suspended customer can be chosen, but its portal users cannot sign in until it is resumed. A portal user linked to a contact of {cname(target.customerId)} cannot be moved.</p>
              </>
            ) : null}
            {ask.type === "google" ? (
              <>
                <p>AlarmOps remembers the Google account that first signed in as this user, and only that account can sign in. Clearing the link lets the <b>next</b> sign-in with this e-mail address link a new Google account.</p>
                <p>Use it when the person changed Google accounts. It does not end their current session. If you suspect someone else has the account, disable the user instead.</p>
              </>
            ) : null}
            {err ? <div className="co-err us-err" role="alert" tabIndex={-1} ref={errBox} data-testid="us-dialog-error">{err}</div> : null}
          </div>
        ) : null}
      </ConfirmDialog>
      </div>
    </>
  );
}

function Filters({ customers, filters, serverFiltered, search, onSearch }: { customers: UsersScreenProps["customers"]; filters: UsersFilters; serverFiltered: boolean; search: string; onSearch: (v: string) => void }) {
  const router = useRouter();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(e.currentTarget)) if (typeof v === "string" && v.trim() !== "") p.set(k, v.trim());
    const s = p.toString();
    router.push("/settings/users" + (s ? `?${s}` : ""));
  }
  return (
    <form key={JSON.stringify(filters)} method="get" className="us-filters" aria-label="Filter users" data-testid="us-filters" onSubmit={onSubmit}>
      <label><span>Type</span>
        <select className="inp" name="kind" defaultValue={filters.kind} data-testid="us-f-kind">
          <option value="">All</option><option value="INTERNAL">Staff</option><option value="CUSTOMER">Portal users</option>
        </select></label>
      <label><span>Customer</span>
        <select className="inp" name="customerId" defaultValue={filters.customerId} data-testid="us-f-customer">
          <option value="">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
      <label><span>Status</span>
        <select className="inp" name="status" defaultValue={filters.status} data-testid="us-f-status">
          <option value="">All</option><option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option><option value="PENDING">Pending</option>
        </select></label>
      <label><span>Role</span>
        <select className="inp" name="role" defaultValue={filters.role} data-testid="us-f-role">
          <option value="">All</option><option value="ADMIN">Admin</option><option value="OPERATOR">Operator</option><option value="VIEWER">Viewer</option>
        </select></label>
      <label><span>Search the list (name or masked e-mail)</span>
        <input className="inp" type="search" maxLength={100} value={search} onChange={(e) => onSearch(e.target.value)} autoComplete="off" data-testid="us-f-q" /></label>
      <button type="submit" className="btn pri" data-testid="us-apply">Apply filters</button>
      {serverFiltered || search ? <Link className="btn" href="/settings/users" data-testid="us-clear" onClick={() => onSearch("")}>Clear filters</Link> : null}
    </form>
  );
}

function AddUser({ customers, fenceDomains, onDone, onCancel }: {
  customers: UsersScreenProps["customers"]; fenceDomains: string[]; onDone: (message: string) => void; onCancel: () => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<UserKind>("INTERNAL");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role | "">("");
  const [customerId, setCustomerId] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const errBox = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => { if (err) errBox.current?.focus({ preventScroll: true }); }, [err]);

  const problems = newUserProblems({ kind, email, name, role, customerId });
  const blocked = Object.keys(problems).length > 0;
  const addr = normalizeEmail(email);
  const outside = kind === "INTERNAL" && addr !== null && outsideFence(addr, fenceDomains);
  const show = (f: keyof typeof problems) => (touched[f] && problems[f] ? problems[f] : null);
  const touch = (f: string) => setTouched((t) => ({ ...t, [f]: true }));
  const cust = customers.find((c) => c.id === customerId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (blocked) { setTouched({ email: true, name: true, role: true, customerId: true }); return; }
    if (busy) return;
    setBusy(true); setErr(null);
    const r = await callAction(() => addUserAccount(kind === "INTERNAL" ? { email, name, kind, role: role as Role } : { email, name, kind, customerId }));
    setBusy(false);
    if (!r.ok) { setErr(userErrorText(r, { what: "Adding a user" })); return; }
    const who = r.data.name;
    const passOn = `Tell them to open ${window.location.origin} and choose "Sign in with Google".`;
    onDone(kind === "INTERNAL"
      ? (outside
        ? `${who} was added as ${ROLE_LABEL[r.data.role]}, but they cannot sign in yet. Their address is outside the allowed domains. They can sign in only after it is added to the sign-in exception list (a deployment setting: ask whoever manages the console's deployment).`
        : `${who} was added as ${ROLE_LABEL[r.data.role]}. They can sign in with this Google account. ${passOn}`)
      : `${who} was added as a read-only portal user of ${cust?.name ?? "the customer"}. They can sign in with this Google account. ${passOn}`);
  }

  return (
    <Card title="Add user">
      <form className="us-form" id="us-add-panel" onSubmit={(e) => { void submit(e); }} noValidate data-testid="us-add-form" aria-label="Add user">
        <fieldset className="us-f"><legend>Who is this?</legend>
          <div className="us-radios">
            <label className="us-radio"><input type="radio" name={`${id}-kind`} checked={kind === "INTERNAL"} onChange={() => { setKind("INTERNAL"); setErr(null); }} data-testid="us-kind-staff" />
              <div><b>MSP staff</b><span>Sees every customer. You choose the role.</span></div></label>
            <label className="us-radio"><input type="radio" name={`${id}-kind`} checked={kind === "CUSTOMER"} onChange={() => { setKind("CUSTOMER"); setErr(null); }} data-testid="us-kind-portal" />
              <div><b>Customer portal user</b><span>Belongs to one customer. Always read-only.</span></div></label>
          </div>
        </fieldset>

        <div className="us-f">
          <label htmlFor={`${id}-name`} className="us-l">Name</label>
          <input id={`${id}-name`} ref={first} className={`inp${show("name") ? " bad" : ""}`} type="text" value={name} maxLength={NAME_MAX + 20} autoComplete="off" required
            onChange={(e) => setName(e.target.value)} onBlur={() => touch("name")} aria-invalid={Boolean(show("name"))} aria-describedby={show("name") ? `${id}-name-e` : undefined} data-testid="us-name-in" />
          {show("name") ? <p className="us-bad" id={`${id}-name-e`}>{show("name")}</p> : null}
        </div>

        <div className="us-f">
          <label htmlFor={`${id}-email`} className="us-l">E-mail (the Google account they sign in with)</label>
          <input id={`${id}-email`} className={`inp${show("email") ? " bad" : ""}`} type="email" inputMode="email" value={email} autoComplete="off" autoCapitalize="off" spellCheck={false} required
            onChange={(e) => setEmail(e.target.value)} onBlur={() => touch("email")} aria-invalid={Boolean(show("email"))} aria-describedby={`${id}-email-h${show("email") ? ` ${id}-email-e` : ""}`} data-testid="us-email-in" />
          <p className="us-hint" id={`${id}-email-h`}>Only the masked address is shown afterwards.</p>
          {show("email") ? <p className="us-bad" id={`${id}-email-e`}>{show("email")}</p> : null}
        </div>

        {kind === "INTERNAL" ? (
          <fieldset className="us-f"><legend>Role</legend>
            <div className="us-radios" role="radiogroup" aria-label="Role" aria-describedby={show("role") ? `${id}-role-e` : undefined}>
              {ROLES.map((r) => (
                <label key={r} className="us-radio"><input type="radio" name={`${id}-role`} checked={role === r} onChange={() => { setRole(r); touch("role"); }} data-testid={`us-newrole-${r}`} />
                  <div><b>{ROLE_LABEL[r]}</b><span>{ROLE_HELP[r]}</span></div></label>
              ))}
            </div>
            {show("role") ? <p className="us-bad" id={`${id}-role-e`}>{show("role")}</p> : null}
          </fieldset>
        ) : (
          <div className="us-f">
            <label htmlFor={`${id}-cust`} className="us-l">Customer (exactly one)</label>
            <select id={`${id}-cust`} className={`inp${show("customerId") ? " bad" : ""}`} value={customerId} onChange={(e) => { setCustomerId(e.target.value); touch("customerId"); }} onBlur={() => touch("customerId")}
              aria-invalid={Boolean(show("customerId"))} aria-describedby={`${id}-cust-h${show("customerId") ? ` ${id}-cust-e` : ""}`} data-testid="us-customer-in">
              <option value="">Choose a customer…</option>
              {customers.filter((c) => c.status !== "TERMINATED").map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === "SUSPENDED" ? " (suspended)" : ""}</option>)}
            </select>
            <p className="us-hint" id={`${id}-cust-h`}>Role: Viewer, always. Portal users never change anything. Terminated customers are not listed (they cannot get portal users). A suspended customer can be chosen, but its portal users cannot sign in until it is resumed.</p>
            {show("customerId") ? <p className="us-bad" id={`${id}-cust-e`}>{show("customerId")}</p> : null}
          </div>
        )}

        <p className="us-next" data-testid="us-next">
          {kind === "INTERNAL"
            ? <>What happens next: they can sign in with this Google account right away. Their address must be in the allowed domains{fenceDomains.length ? <> (<span className="mono">{fenceDomains.join(", ")}</span>)</> : null} or on the exception list, or the sign-in is refused.</>
            : <>What happens next: they can sign in with this Google account and will see only {cust ? <b>{cust.name}</b> : "that customer"}, read-only. No domain list applies to portal users.</>}
        </p>
        {kind === "INTERNAL" && fenceDomains.length === 0 ? <p className="us-hint" data-testid="us-fence-unknown">This console cannot check the address against the allowed domains here.</p> : null}
        <div role="status" data-testid="us-fence-status">
          {outside ? (
            <p className="us-warn" data-testid="us-fence-warn"><span aria-hidden="true">▲</span><span>This address is outside the allowed domains (<span className="mono">{fenceDomains.join(", ")}</span>). This person cannot sign in yet. They can sign in only after the address is added to the sign-in exception list (a deployment setting: ask whoever manages the console&apos;s deployment).</span></p>
          ) : null}
        </div>

        {err ? <div className="co-err" role="alert" tabIndex={-1} ref={errBox} data-testid="us-add-error">{err}</div> : null}
        <div className="us-form-acts">
          <button type="submit" className="btn pri" disabled={busy || blocked} data-testid="us-submit">{busy ? "Adding…" : "Add user"}</button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
        {blocked ? <p className="us-hint" data-testid="us-blocked">{Object.values(problems)[0]}</p> : null}
      </form>
    </Card>
  );
}
