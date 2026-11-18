"use client";
import { useState } from "react";
import { Card, ConfirmDialog } from "@alarmops/design-system";
import type { ContactRecord, VerifyChannel } from "@/lib/api/types";
import { callAction } from "@/lib/session-ended";
import { createContactAction, listContactsAction, verifyBulkAction, verifyContactAction } from "@/app/customers/onboarding-actions";
import { CHANNEL_NAME, CHANNEL_STATE, onboardingError } from "@/lib/onboarding";
import { kstDateTime } from "@/lib/format";
import { ErrorLine, Field, StateChip } from "./ui";

const VERIFIABLE: VerifyChannel[] = ["EMAIL", "SMS"];
const hasValue = (c: ContactRecord, ch: VerifyChannel) => c.channels[ch].status !== "NOT_SET";

/**
 * Step 5: the customer's own people (kind CUSTOMER). The API keeps the e-mail and the number; the list only ever has the
 * masked form, so after saving the form is empty again. A channel is "verified" when the person opened the link
 * (GET shows, the button POSTs) or an admin marked it by hand after checking with the person.
 */
export function PeopleStep({ customerId, customerName, contacts, onContacts, canWrite }: {
  customerId: string; customerName: string; contacts: ContactRecord[]; onContacts: (c: ContactRecord[]) => void; canWrite: boolean;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [askBulk, setAskBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const needs = contacts.filter((c) => c.needsAction && VERIFIABLE.some((ch) => hasValue(c, ch) && c.channels[ch].status !== "VERIFIED"));
  async function reload() { const r = await callAction(() => listContactsAction(customerId)); if (r.ok) onContacts(r.data); }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canWrite) return;
    setErr(null); setAdded(null);
    if (!name.trim()) { setErr("Give the person a name."); return; }
    if (!email.trim() && !phone.trim()) { setErr("Give an e-mail address or a phone number, so there is something to verify."); return; }
    setBusy(true);
    const r = await callAction(() => createContactAction(customerId, { name: name.trim(), email: email.trim(), phone: phone.trim() }));
    setBusy(false);
    if (!r.ok) { setErr(onboardingError(r, "contact")); return; }
    onContacts([...contacts, r.data]);
    setAdded(`${r.data.name} added to ${customerName}. Their e-mail and number are stored and shown masked.`);
    setName(""); setEmail(""); setPhone("");
  }

  async function bulk() {
    setBulkBusy(true); setBulkMsg(null);
    const r = await callAction(() => verifyBulkAction(needs.map((c) => c.id)));
    setBulkBusy(false); setAskBulk(false);
    if (!r.ok) { setBulkMsg({ tone: "err", text: onboardingError(r, "verify") }); return; }
    const { sent, notSet, failed, throttled } = r.data;
    setBulkMsg({ tone: failed || throttled ? "err" : "ok", text: `${sent} link${sent === 1 ? "" : "s"} sent.${failed ? ` ${failed} could not be sent (no sender for that channel yet): verify those by hand.` : ""}${throttled ? ` ${throttled} were held back by the send limit.` : ""}${notSet.length ? ` ${notSet.length} channel${notSet.length === 1 ? " has" : "s have"} no value: ask the person to add it.` : ""}` });
    await reload();
  }

  return (
    <div className="stack">
      <Card title={`${customerName} · People`}>
        <p className="sm" style={{ marginTop: 0 }}>The customer’s own people, for notifications and portal sign-in. Verify a channel before anyone is paged on it. Who is paged first is set later in Call order.</p>
        <form className="ob-form" onSubmit={(e) => { void add(e); }} noValidate data-testid="contact-form" autoComplete="off">
          <Field id="ct-name" label="Name"><input id="ct-name" className="inp" data-testid="ct-name" value={name} maxLength={80} autoComplete="off" disabled={!canWrite} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="ob-grid2">
            <Field id="ct-email" label="E-mail"><input id="ct-email" className="inp" data-testid="ct-email" type="email" value={email} autoComplete="off" disabled={!canWrite} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field id="ct-phone" label="Phone" hint="For example 010-1234-5678."><input id="ct-phone" className="inp" data-testid="ct-phone" type="tel" value={phone} autoComplete="off" disabled={!canWrite} onChange={(e) => setPhone(e.target.value)} /></Field>
          </div>
          <div role="status" data-testid="ct-added">{added ? <div className="ob-info">{added}</div> : null}</div>
          {err ? <ErrorLine testid="ct-error">{err}</ErrorLine> : null}
          <div className="ob-actions"><button type="submit" className="btn" data-testid="ct-save" disabled={busy || !canWrite}>{busy ? "Saving…" : `Add person to ${customerName}`}</button></div>
        </form>
      </Card>

      <Card title={`People of ${customerName}`} actions={<span className="sm mut" data-testid="needs-count">Needs action: <b className="mono">{needs.length}</b></span>}>
        {needs.length ? (
          <div className="ob-actions" style={{ marginBottom: 12 }}>
            <button type="button" className="btn" data-testid="bulk-open" disabled={!canWrite || bulkBusy} onClick={() => setAskBulk(true)}>Send links to everyone who needs action ({needs.length})…</button>
          </div>
        ) : null}
        <div role="status" data-testid="bulk-result">{bulkMsg ? <div className={bulkMsg.tone === "ok" ? "ob-info" : "ob-note"} style={{ marginBottom: 12 }}>{bulkMsg.text}</div> : null}</div>
        {contacts.length ? (
          <ul className="ob-list" data-testid="contact-list">
            {contacts.map((c) => <ContactItem key={c.id} c={c} canWrite={canWrite} onChanged={reload} />)}
          </ul>
        ) : <p className="sm mut" data-testid="contact-empty">No people yet. You can also do this later from People.</p>}
      </Card>

      <ConfirmDialog
        open={askBulk} title={`Send verification links for ${customerName}?`} confirmLabel={`Send ${needs.length} link${needs.length === 1 ? "" : "s"} now`} cancelLabel="Do not send" defaultFocus="cancel" busy={bulkBusy}
        onConfirm={() => { void bulk(); }} onCancel={() => setAskBulk(false)}
      >
        <p style={{ marginTop: 0 }}>A link goes to each channel below. It opens a page where the person confirms; it expires after 24 hours.</p>
        <ul data-testid="bulk-targets">
          {needs.map((c) => <li key={c.id}><b>{c.name}</b>: {VERIFIABLE.filter((ch) => hasValue(c, ch) && c.channels[ch].status !== "VERIFIED").map((ch) => CHANNEL_NAME[ch]).join(", ")}</li>)}
        </ul>
        <p className="sm">Links that have been sent cannot be called back. If a link was sent by mistake, it simply expires; nothing changes until the person confirms.</p>
      </ConfirmDialog>
    </div>
  );
}

function ContactItem({ c, canWrite, onChanged }: { c: ContactRecord; canWrite: boolean; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const [manual, setManual] = useState<VerifyChannel | null>(null);
  const [note, setNote] = useState("");

  async function link(ch: VerifyChannel) {
    setBusy(ch); setMsg(null);
    const r = await callAction(() => verifyContactAction(c.id, ch, "link"));
    setBusy(null);
    if (!r.ok) {
      if (r.code === "VERIFICATION_UNAVAILABLE" || r.code === "NOT_CONFIGURED") { setManual(ch); setMsg({ tone: "warn", text: onboardingError({ ...r, code: "VERIFICATION_UNAVAILABLE" }, "verify") }); return; }
      setMsg({ tone: "err", text: onboardingError(r, "verify") });
      return;
    }
    setMsg({ tone: "ok", text: `Link sent to ${c.name} by ${CHANNEL_NAME[ch]}. It expires ${r.data.expiresAt ? kstDateTime(r.data.expiresAt) : "in 24 hours"}.` });
    await onChanged();
  }
  async function markManual(ch: VerifyChannel) {
    if (!note.trim()) { setMsg({ tone: "err", text: "Say how you checked it, for example “Confirmed by phone with the person”." }); return; }
    setBusy(ch); setMsg(null);
    const r = await callAction(() => verifyContactAction(c.id, ch, "manual", note));
    setBusy(null);
    if (!r.ok) { setMsg({ tone: "err", text: onboardingError(r, "verify") }); return; }
    setManual(null); setNote("");
    setMsg({ tone: "ok", text: `${CHANNEL_NAME[ch]} of ${c.name} marked as verified by hand. This is recorded with your name.` });
    await onChanged();
  }

  return (
    <li className="ob-item" data-testid="contact-item" data-name={c.name}>
      <div className="row"><b>{c.name}</b>
        <span className="mono sm" data-testid="contact-email">{c.emailMasked ?? ""}</span><span className="mono sm" data-testid="contact-phone">{c.phoneMasked ?? ""}</span></div>
      {VERIFIABLE.filter((ch) => hasValue(c, ch)).map((ch) => {
        const s = c.channels[ch];
        const st = CHANNEL_STATE[s.status];
        return (
          <div key={ch} className="ob-verify" data-testid={`ch-${ch}`} data-status={s.status}>
            <span style={{ minWidth: 70 }}>{CHANNEL_NAME[ch]}</span>
            <StateChip tone={st.tone} label={st.label} testid={`ch-${ch}-state`} />
            {s.status === "LINK_SENT" && s.expiresAt ? <span className="sm mut">expires {kstDateTime(s.expiresAt)}</span> : null}
            {s.status === "VERIFIED" && s.via ? <span className="sm mut">{s.via.startsWith("admin:") ? "by hand" : "by link"}</span> : null}
            {s.status !== "VERIFIED" ? (
              <>
                <button type="button" className="btn sm" data-testid={`send-${ch}`} disabled={!canWrite || busy !== null} onClick={() => { void link(ch); }}>{busy === ch ? "Sending…" : s.status === "LINK_SENT" ? `Send ${CHANNEL_NAME[ch]} link again` : s.status === "EXPIRED" ? `Send a new ${CHANNEL_NAME[ch]} link` : `Send ${CHANNEL_NAME[ch]} link`}</button>
                <button type="button" className="btn sm" data-testid={`manual-${ch}`} disabled={!canWrite || busy !== null} aria-expanded={manual === ch} onClick={() => { setManual(manual === ch ? null : ch); setMsg(null); }}>Mark as verified by hand…</button>
              </>
            ) : null}
          </div>
        );
      })}
      {manual ? (
        <div className="ob-form" data-testid="manual-form">
          <Field id={`mn-${c.id}`} label={`How did you check the ${CHANNEL_NAME[manual]} of ${c.name}?`} hint="Only mark it after you have confirmed the address or number with the person. The note and your name are kept.">
            <textarea id={`mn-${c.id}`} className="inp" rows={2} style={{ minHeight: 64, paddingTop: 8 }} data-testid="manual-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="ob-actions">
            <button type="button" className="btn pri" data-testid="manual-confirm" disabled={busy !== null} onClick={() => { void markManual(manual); }}>{busy ? "Saving…" : `Mark ${CHANNEL_NAME[manual]} of ${c.name} as verified`}</button>
            <button type="button" className="btn" onClick={() => { setManual(null); setNote(""); }}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div role="status" data-testid="contact-msg">{msg ? <div className={msg.tone === "ok" ? "ob-info" : msg.tone === "warn" ? "ob-note" : "ob-err"}>{msg.text}</div> : null}</div>
    </li>
  );
}
