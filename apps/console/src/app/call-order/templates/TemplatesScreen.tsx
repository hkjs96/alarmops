"use client";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Card, ConfirmDialog, EmptyState } from "@alarmops/design-system";
import type { ResponderTemplate, StaffSummary, TemplatePreview } from "@/lib/api/types";
import { hasRole, roleReason, useShell } from "@/components/ShellContext";
import { BlockedBox, EffectList } from "@/components/TemplateEffects";
import { kstDateTime } from "@/lib/format";
import { callAction } from "@/lib/session-ended";
import {
  NAME_MAX, affectsText, blockedCustomers, customersText, draftKey, draftProblems, isChanged, proposalOf, saveGate, saveLabel, templateErrorText,
  isOutOfDate, type Draft, type PreviewState,
} from "@/lib/templates";
import { createTemplate, previewTemplate, saveTemplate } from "./actions";
import "./templates.css";

export interface TemplatesScreenProps { templates: ResponderTemplate[]; staff: StaffSummary[]; error?: string | null }

const WHAT = "Changing a template";

/** The people of a template as chips; while editing each has a remove button and a select adds from the MSP staff. */
function MembersField({ members, staff, names, editable, onChange, id, invalid }: {
  members: string[]; staff: StaffSummary[]; names: Record<string, string>; editable: boolean; onChange: (m: string[]) => void; id: string; invalid?: string;
}) {
  const [pick, setPick] = useState("");
  const free = staff.filter((s) => !members.includes(s.contactId));
  return (
    <div className="tp-members">
      <ul className="tp-chips" data-testid="tpl-members" aria-label="People in this template">
        {members.map((m) => (
          <li key={m} className="tp-chip" data-testid="tpl-member">
            <span>{names[m] ?? m}</span>
            {editable ? <button type="button" className="tp-x" aria-label={`Remove ${names[m] ?? m} from this template`} onClick={() => onChange(members.filter((x) => x !== m))}><span aria-hidden="true">✕</span></button> : null}
          </li>
        ))}
        {members.length === 0 ? <li className="sm mut">Nobody yet.</li> : null}
      </ul>
      {editable ? (
        <div className="tp-add">
          <label htmlFor={`${id}-add`} className="tp-l">Add staff</label>
          <select id={`${id}-add`} className="inp" value={pick} data-testid="tpl-add-select" onChange={(e) => setPick(e.target.value)} aria-describedby={invalid ? `${id}-mem-e` : undefined}>
            <option value="">+ Add staff…</option>
            {free.map((s) => <option key={s.contactId} value={s.contactId}>{s.name}{s.title ? ` · ${s.title}` : ""}</option>)}
          </select>
          <button type="button" className="btn" data-testid="tpl-add" disabled={!pick} onClick={() => { if (pick) { onChange([...members, pick]); setPick(""); } }}>Add</button>
        </div>
      ) : null}
      {invalid ? <p className="tp-bad" id={`${id}-mem-e`}>{invalid}</p> : null}
    </div>
  );
}

export function TemplatesScreen({ templates, staff, error }: TemplatesScreenProps) {
  const router = useRouter();
  const shell = useShell();
  const admin = hasRole(shell.user, "ADMIN");
  const roleWhy = roleReason(shell.user, "ADMIN", WHAT);
  const baseId = useId();

  const names: Record<string, string> = {};
  for (const s of staff) names[s.contactId] = s.name;
  for (const t of templates) for (const m of t.members) names[m.contactId] = m.name;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = templates.find((t) => t.id === selectedId) ?? null;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({ name: "", members: [] });
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; stale: boolean } | null>(null);
  const [result, setResult] = useState<{ text: string; undo?: { id: string; name: string; members: string[] } } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const errRef = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState(0);
  const say = (text: string, undo?: { id: string; name: string; members: string[] }) => { setResult({ text, undo }); setSaid((n) => n + 1); };
  useEffect(() => { if (said > 0) resultRef.current?.focus(); }, [said]);
  useEffect(() => { if (err) errRef.current?.focus({ preventScroll: true }); }, [err]);

  const saved: Draft = selected ? { name: selected.name, members: selected.members.map((m) => m.contactId) } : { name: "", members: [] };

  // the effect of the draft on the customers, asked again 250 ms after the last change
  const key = draftKey(draft);
  useEffect(() => {
    if (!editing || !selected || !admin) return;
    const d = draft;
    if (!isChanged(saved, d) || Object.keys(draftProblems(d)).length > 0) { setPreview({ status: "idle" }); return; }
    setPreview({ status: "loading", key: draftKey(d) });
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await callAction(() => previewTemplate(selected.id, proposalOf(saved, d)));
      if (cancelled) return;
      if (!r.ok) { setPreview({ status: "error", key: draftKey(d), message: templateErrorText(r, { what: WHAT }) }); return; }
      // the template changed under us: this preview is of a newer version than the one the user is editing
      if (r.data.version !== selected.version) { setPreview({ status: "error", key: draftKey(d), message: templateErrorText({ code: "VERSION_CONFLICT", message: "" }) }); setErr({ text: templateErrorText({ code: "VERSION_CONFLICT", message: "" }), stale: true }); return; }
      setPreview({ status: "ready", key: draftKey(d), preview: r.data });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, editing, selectedId, selected?.version, nonce, admin]);

  const open = (t: ResponderTemplate) => {
    setSelectedId(t.id); setCreating(false); setEditing(false); setErr(null); setResult(null); setPreview({ status: "idle" });
  };
  const startEdit = () => {
    if (!selected) return;
    setDraft({ name: selected.name, members: selected.members.map((m) => m.contactId) });
    setPreview({ status: "idle" }); setErr(null); setResult(null); setEditing(true);
  };
  const stopEdit = () => { setEditing(false); setErr(null); setPreview({ status: "idle" }); setConfirm(false); };

  const gate = saveGate({ admin, roleWhy, saved, draft, preview, busy });
  const ready: TemplatePreview | null = preview.status === "ready" && preview.key === draftKey(draft) ? preview.preview : null;
  const cname = (id: string) => ready?.customers.find((c) => c.id === id)?.name ?? "a customer";
  const blocked = ready ? blockedCustomers(ready.blocking, cname) : [];

  async function doSave() {
    if (!selected || !ready || busy || !gate.enabled) return;
    setBusy(true); setErr(null);
    const r = await callAction(() => saveTemplate(selected.id, proposalOf(saved, draft), selected.version, ready.previewHash));
    setBusy(false);
    setConfirm(false);
    if (!r.ok) {
      setErr({ text: templateErrorText(r, { what: WHAT, name: draft.name.trim() }), stale: isOutOfDate(r.code) });
      // a preview that no longer holds is asked again; a refusal by name or blocking keeps the draft as it is
      if (r.code === "PREVIEW_STALE") setNonce((n) => n + 1);
      return;
    }
    const before = { id: selected.id, name: selected.name, members: saved.members };
    setEditing(false); setPreview({ status: "idle" });
    say(`Saved “${r.data.name}” for ${customersText(r.data.customers.length)} · ${r.data.affected === 1 ? "1 changed" : `${r.data.affected} changed`}. People added directly were not touched.`, before);
    router.refresh();
  }

  /** Undo: the old name and people back, through the same preview and save (so a refusal still holds) */
  async function undo() {
    const u = result?.undo;
    const cur = templates.find((t) => t.id === u?.id);
    if (!u || !cur || busy) return;
    setBusy(true); setErr(null);
    const prop = { name: u.name, members: u.members };
    const p = await callAction(() => previewTemplate(u.id, prop));
    if (!p.ok) { setBusy(false); setErr({ text: templateErrorText(p, { what: "Undoing the change" }), stale: isOutOfDate(p.code) }); return; }
    if (p.data.blocking.length > 0) {
      setBusy(false);
      setErr({ text: `Not undone. Putting the old people back would leave nobody to call for ${customersText(new Set(p.data.blocking.map((b) => b.customerId)).size)}. Nothing was changed. Edit the template instead.`, stale: false });
      return;
    }
    const r = await callAction(() => saveTemplate(u.id, prop, p.data.version, p.data.previewHash));
    setBusy(false);
    if (!r.ok) { setErr({ text: templateErrorText(r, { what: "Undoing the change" }), stale: isOutOfDate(r.code) }); return; }
    say(`Undone. “${r.data.name}” has its previous people again.`);
    router.refresh();
  }

  const nSave = ready?.totals.customers ?? selected?.customers.length ?? 0;

  return (
    <>
      <p className="sm mut tp-intro">Saved groups of MSP staff. A template adds those people to the Responders of every customer that uses it. Customer people are never in a template: add them per customer.</p>
      <div className="tp-bar">
        {admin
          ? <button type="button" className="btn pri" data-testid="tpl-new" onClick={() => { setCreating(true); setSelectedId(null); setEditing(false); setResult(null); setErr(null); }}>New template</button>
          : <p className="sm mut" data-testid="tpl-readonly-why" role="note">{roleWhy} You can read every template.</p>}
      </div>

      <div className="tp-result" role="status" tabIndex={-1} ref={resultRef} data-testid="tpl-result">
        {result ? (
          <>
            <span aria-hidden="true">✓</span><span>{result.text}</span>
            {result.undo && admin ? <button type="button" className="btn sm" data-testid="tpl-undo" disabled={busy} onClick={() => { void undo(); }}>{busy ? "Undoing…" : "Undo"}</button> : null}
          </>
        ) : null}
      </div>
      {err && !selected && !creating ? <div className="co-err tp-err" role="alert" tabIndex={-1} ref={errRef} data-testid="tpl-error">{err.text}</div> : null}

      {creating && admin ? (
        <CreateForm staff={staff} names={names} baseId={baseId}
          onCancel={() => setCreating(false)}
          onDone={(t) => { setCreating(false); setSelectedId(t.id); say(`Created “${t.name}” with ${t.members.length === 1 ? "1 person" : `${t.members.length} people`}. No customer uses it yet: attach it in a customer’s Responders.`); router.refresh(); }} />
      ) : null}

      <Card title="Templates">
        {error ? (
          <div className="co-err" role="alert" data-testid="tpl-load-error"><span>{error}</span> <button type="button" className="btn sm" onClick={() => router.refresh()}>Try again</button></div>
        ) : templates.length === 0 ? (
          <EmptyState title="No templates yet" detail={admin ? "Create the first one with New template." : "An admin can create the first one."} />
        ) : (
          <table className="tp-table" data-testid="tpl-table">
            <thead><tr><th scope="col">Template</th><th scope="col">MSP staff</th><th scope="col">Customers</th><th scope="col">Last edited</th></tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} data-testid="tpl-row" data-template={t.id} aria-current={t.id === selectedId ? "true" : undefined} className={t.id === selectedId ? "on" : undefined}>
                  <td className="tp-c-name"><button type="button" className="tp-open" data-testid="tpl-open" aria-label={`Open template ${t.name}`} onClick={() => open(t)}>{t.name}</button></td>
                  <td data-label="MSP staff">{t.members.length === 1 ? "1 person" : `${t.members.length} people`}: {t.members.map((m) => m.name).join(", ")}</td>
                  <td data-label="Customers" data-testid="tpl-count">{t.customers.length}</td>
                  <td data-label="Last edited">{kstDateTime(t.updatedAt)}{t.updatedByName ? ` · ${t.updatedByName}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {selected ? (
        <Card title={<h2 className="ov" style={{ margin: 0 }} data-testid="tpl-detail-h">{selected.name}</h2>}
          actions={admin && !editing ? <button type="button" className="btn" data-testid="tpl-edit" onClick={startEdit}>Edit template</button> : null} data-testid="tpl-detail">
          {!admin ? <p className="sm mut" data-testid="tpl-why" role="note">{roleWhy}</p> : null}

          {!editing ? (
            <>
              <h3 className="tp-h">People ({selected.members.length})</h3>
              <MembersField members={selected.members.map((m) => m.contactId)} staff={staff} names={names} editable={false} onChange={() => {}} id={baseId} />
              <h3 className="tp-h">Used by {customersText(selected.customers.length)}</h3>
              {selected.customers.length === 0
                ? <p className="sm mut">No customer uses it yet. Attach it in a customer’s Responders.</p>
                : <ul className="tp-cust" data-testid="tpl-customers">{selected.customers.map((c) => <li key={c.id}>{c.name}</li>)}</ul>}
              <p className="sm mut">A template only says who is in Responders. The order people are paged in is set in each customer’s call order or rotation.</p>
            </>
          ) : (
            <form className="tp-form" onSubmit={(e: FormEvent) => { e.preventDefault(); if (gate.enabled) setConfirm(true); }} noValidate aria-label={`Edit ${selected.name}`}>
              <div className="tp-f">
                <label htmlFor={`${baseId}-name`} className="tp-l">Name</label>
                <input id={`${baseId}-name`} className="inp" type="text" value={draft.name} maxLength={NAME_MAX + 20} autoComplete="off" data-testid="tpl-name"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-invalid={Boolean(draftProblems(draft).name)} />
                {draftProblems(draft).name ? <p className="tp-bad">{draftProblems(draft).name}</p> : null}
              </div>
              <div className="tp-f">
                <span className="tp-l">People</span>
                <MembersField members={draft.members} staff={staff} names={names} editable onChange={(m) => setDraft({ ...draft, members: m })} id={baseId} invalid={draftProblems(draft).members} />
              </div>

              <div className="tp-preview" aria-live="polite" data-testid="tpl-preview">
                {preview.status === "idle" ? <p className="sm mut" data-testid="tpl-preview-idle">{isChanged(saved, draft) ? "Fix the problem above to see what this change does." : "Change the name or the people to see what it does to each customer."}</p> : null}
                {preview.status === "loading" ? <p className="sm mut" data-testid="tpl-preview-loading">Checking what this change does…</p> : null}
                {preview.status === "error" ? <p className="tp-bad" data-testid="tpl-preview-error">{preview.message} <button type="button" className="btn sm" onClick={() => setNonce((n) => n + 1)}>Check again</button></p> : null}
                {ready ? (
                  <>
                    <h3 className="tp-h" data-testid="tpl-affects">{affectsText(ready.totals.customers)}</h3>
                    <p className="sm mut" data-testid="tpl-totals">{ready.totals.joins} will join, {ready.totals.leaves} will leave{ready.totals.warnings ? `, ${ready.totals.warnings} call order step${ready.totals.warnings === 1 ? "" : "s"} still name someone who leaves` : ""}.</p>
                    <BlockedBox blocked={blocked} />
                    <ul className="tp-fx" data-testid="tpl-customers-fx">
                      {ready.customers.map((c) => {
                        const bad = blocked.some((b) => b.customerId === c.id);
                        return (
                          <li key={c.id} data-testid="tpl-fx-customer" data-customer={c.id} data-blocked={bad ? "1" : undefined}>
                            <div className="tp-fx-h"><b>{c.name}</b>{bad ? <span className="tp-blk"><span aria-hidden="true">✕</span> Blocked</span> : null}</div>
                            <EffectList effects={c.effects} />
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : null}
              </div>

              {err ? (
                <div className="co-err tp-err" role="alert" tabIndex={-1} ref={errRef} data-testid="tpl-error">
                  <span>{err.text}</span>
                  {err.stale ? <button type="button" className="btn sm" data-testid="tpl-reload" onClick={() => { stopEdit(); router.refresh(); }}>Reload</button> : null}
                </div>
              ) : null}

              <div className="tp-acts">
                <button type="submit" className="btn pri" data-testid="tpl-save" disabled={!gate.enabled} aria-describedby={gate.reason ? `${baseId}-why` : undefined}>{saveLabel(nSave)}</button>
                <button type="button" className="btn" data-testid="tpl-discard" onClick={stopEdit} disabled={busy}>Discard</button>
              </div>
              {gate.reason ? <p className="sm mut" id={`${baseId}-why`} data-testid="tpl-save-why">{gate.reason}</p> : null}
            </form>
          )}
        </Card>
      ) : null}

      <div className="tp-dlgwrap">
        <ConfirmDialog
          open={confirm && Boolean(ready) && Boolean(selected)}
          title={`${saveLabel(nSave)}?`}
          confirmLabel={busy ? "Saving…" : saveLabel(nSave)}
          cancelLabel="Cancel" busy={busy}
          onConfirm={() => { void doSave(); }} onCancel={() => { if (!busy) setConfirm(false); }}
        >
          {ready && selected ? (
            <div data-testid="tpl-dialog">
              <p style={{ marginTop: 0 }}>{affectsText(ready.totals.customers)}: {ready.totals.joins} will join, {ready.totals.leaves} will leave. It is saved for all of them at once and written to the audit log. People added directly to a customer are not removed.</p>
              {draft.name.trim() !== selected.name ? <p>Name: <s>{selected.name}</s> → <b>{draft.name.trim()}</b></p> : null}
              <ul className="tp-fx tp-fx-dlg" data-testid="tpl-dialog-customers">
                {ready.customers.map((c) => (
                  <li key={c.id}><b>{c.name}</b><EffectList effects={c.effects} testId="tpl-dialog-effects" /></li>
                ))}
              </ul>
              <p className="sm mut">You can undo this right after saving.</p>
            </div>
          ) : null}
        </ConfirmDialog>
      </div>
    </>
  );
}

function CreateForm({ staff, names, baseId, onCancel, onDone }: { staff: StaffSummary[]; names: Record<string, string>; baseId: string; onCancel: () => void; onDone: (t: ResponderTemplate) => void }) {
  const [d, setD] = useState<Draft>({ name: "", members: [] });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const p = draftProblems(d);
  const bad = Object.keys(p).length > 0;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (bad || busy) return;
    setBusy(true); setErr(null);
    const r = await callAction(() => createTemplate({ name: d.name.trim(), members: d.members }));
    setBusy(false);
    if (!r.ok) { setErr(templateErrorText(r, { what: "Creating a template", name: d.name.trim() })); return; }
    onDone(r.data);
  }
  return (
    <Card title="New template">
      <form className="tp-form" onSubmit={(e) => { void submit(e); }} noValidate aria-label="New template" data-testid="tpl-create-form">
        <div className="tp-f">
          <label htmlFor={`${baseId}-new-name`} className="tp-l">Name</label>
          <input id={`${baseId}-new-name`} ref={first} className="inp" type="text" value={d.name} maxLength={NAME_MAX + 20} autoComplete="off" data-testid="tpl-new-name" onChange={(e) => setD({ ...d, name: e.target.value })} aria-invalid={touched && Boolean(p.name)} />
          {touched && p.name ? <p className="tp-bad">{p.name}</p> : null}
        </div>
        <div className="tp-f">
          <span className="tp-l">People</span>
          <MembersField members={d.members} staff={staff} names={names} editable onChange={(m) => setD({ ...d, members: m })} id={`${baseId}-new`} invalid={touched ? p.members : undefined} />
        </div>
        <p className="sm mut">A new template is used by no customer yet, so there is nothing to preview. Attach it in a customer’s Responders.</p>
        {err ? <div className="co-err tp-err" role="alert" data-testid="tpl-create-error">{err}</div> : null}
        <div className="tp-acts">
          <button type="submit" className="btn pri" data-testid="tpl-create" disabled={busy}>{busy ? "Creating…" : "Create template"}</button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
