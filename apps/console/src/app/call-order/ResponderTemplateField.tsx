"use client";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "@alarmops/design-system";
import type { CustomerTemplatePreview, ResponderTemplate } from "@/lib/api/types";
import { BlockedBox, EffectList } from "@/components/TemplateEffects";
import { useShell } from "@/components/ShellContext";
import { callAction } from "@/lib/session-ended";
import { blockedCustomers, isOutOfDate, skippedInactiveText, templateErrorText } from "@/lib/templates";
import { listTemplatesForCustomer, previewCustomerTemplate, setCustomerTemplate } from "./actions";
import "@/components/template-effects.css";

const NONE = "";
type Load = { status: "idle" } | { status: "loading" } | { status: "ready"; preview: CustomerTemplatePreview } | { status: "error"; message: string };

/**
 * The template of this customer's Responders: attach, detach or switch (D-64). Choosing one asks the server what the change does to
 * the list — who joins, who leaves, who stays because they were added directly — and whether it is refused (nobody left to call, a
 * D-38 limit); a refused change cannot be confirmed and there is no way around it. The change is saved only after the confirmation, with
 * the Responders version and the preview hash the preview was made for. Undo puts the previous template back the same way.
 */
export function ResponderTemplateField({ customer, customerName, templateId, templateName, disabledWhy, onApplied }: {
  customer: string; customerName: string;
  templateId: string | null; templateName: string | null;
  /** why it cannot be changed right now (role, steps being edited); null when it can */
  disabledWhy: string | null;
  onApplied: (version: number) => void;
}) {
  const router = useRouter();
  const shell = useShell();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<ResponderTemplate[] | null>(null);
  const [sel, setSel] = useState<string>(NONE);
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; reload: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const cur = templateId ?? NONE;

  const begin = async () => {
    setSel(cur); setLoad({ status: "idle" }); setErr(null); setOpen(true);
    shell.clearToast();
    if (!templates) {
      const r = await callAction(listTemplatesForCustomer);
      if (r.ok) setTemplates(r.data); else setErr({ text: templateErrorText(r, { what: "Changing the template", where: customerName }), reload: false });
    }
  };
  const close = () => { if (!busy) { setOpen(false); setTimeout(() => btn.current?.focus(), 0); } };

  // what the choice does, asked again when it changes
  useEffect(() => {
    if (!open || sel === cur) { setLoad({ status: "idle" }); return; }
    let cancelled = false;
    setLoad({ status: "loading" });
    void (async () => {
      const r = await callAction(() => previewCustomerTemplate(customer, sel === NONE ? null : sel));
      if (cancelled) return;
      if (!r.ok) { setLoad({ status: "error", message: templateErrorText(r, { what: "Changing the template", where: customerName }) }); return; }
      setLoad({ status: "ready", preview: r.data });
    })();
    return () => { cancelled = true; };
  }, [open, sel, cur, customer, customerName, nonce]);

  const ready = load.status === "ready" ? load.preview : null;
  const blocked = ready ? blockedCustomers(ready.blocking, () => customerName) : [];
  const toName = sel === NONE ? null : templates?.find((t) => t.id === sel)?.name ?? ready?.to?.name ?? "the template";
  const kind = sel === NONE ? "detach" : cur === NONE ? "attach" : "switch";
  const confirmLabel = busy ? "Saving…" : kind === "detach" ? `Detach ${templateName ?? "the template"}` : kind === "attach" ? `Attach ${toName}` : `Switch to ${toName}`;
  const title = kind === "detach" ? `Detach ${templateName ?? "the template"} from ${customerName}?` : kind === "attach" ? `Attach ${toName} to ${customerName}?` : `Switch ${customerName} to ${toName}?`;
  const canConfirm = Boolean(ready) && blocked.length === 0 && sel !== cur && !busy && !err?.reload;

  async function confirm() {
    if (!ready || !canConfirm) return;
    const [from, was] = [cur, templateName];
    setBusy(true); setErr(null);
    const r = await callAction(() => setCustomerTemplate(customer, sel === NONE ? null : sel, ready.version, ready.previewHash));
    setBusy(false);
    if (!r.ok) {
      setErr({ text: templateErrorText(r, { what: "Changing the template", where: customerName }), reload: isOutOfDate(r.code) && r.code === "VERSION_CONFLICT" });
      // the preview no longer holds: it is asked again, and the user confirms what is shown now
      if (r.code === "PREVIEW_STALE") setNonce((n) => n + 1);
      return;
    }
    setOpen(false);
    onApplied(r.data.version);
    const words = kind === "detach" ? `${templateName ?? "The template"} detached from ${customerName}` : kind === "attach" ? `${toName} attached to ${customerName}` : `${customerName} now uses ${toName}`;
    const skippedNote = skippedInactiveText(r.data.skippedInactive, "saved");
    shell.toast(`${words} · ${r.data.joins} joined, ${r.data.leaves} left${skippedNote ? ` · ${skippedNote}` : ""}`, {
      label: "Undo",
      onAction: async () => {
        const p = await callAction(() => previewCustomerTemplate(customer, from === NONE ? null : from));
        if (!p.ok) { shell.toast(`Could not undo — ${templateErrorText(p, { what: "Changing the template", where: customerName })}`); return; }
        if (p.data.blocking.length > 0) { shell.toast(`Could not undo — putting ${was ?? "no template"} back would leave nobody to call for ${customerName}. Nothing was changed.`); return; }
        const u = await callAction(() => setCustomerTemplate(customer, from === NONE ? null : from, p.data.version, p.data.previewHash));
        if (!u.ok) { shell.toast(`Could not undo — ${templateErrorText(u, { what: "Changing the template", where: customerName })}`); return; }
        onApplied(u.data.version);
        shell.toast(`Undone · ${customerName} ${from === NONE ? "uses no template again" : `uses ${was ?? "its previous template"} again`}`);
        router.refresh();
      },
    });
    router.refresh();
  }

  return (
    <div className="co-tplf" data-testid="co-template" data-template={templateId ?? ""}>
      <span className="sm" id={`${id}-cur`}>Template: {templateId ? <b data-testid="co-template-name">{templateName}</b> : <span data-testid="co-template-name">none</span>}</span>
      <button type="button" ref={btn} className="btn sm" data-testid="co-template-change" disabled={Boolean(disabledWhy)} aria-describedby={disabledWhy ? `${id}-why` : `${id}-cur`}
        aria-haspopup="dialog" onClick={() => { void begin(); }}>
        {templateId ? "Change template…" : "Attach a template…"}
      </button>
      {disabledWhy ? <span className="sm mut" id={`${id}-why`} data-testid="co-template-why">{disabledWhy}</span> : null}

      <div className="co-tplf-dlg">
        <ConfirmDialog open={open} title={sel === cur ? `Template of ${customerName}` : title} confirmLabel={confirmLabel} cancelLabel="Cancel" busy={busy}
          confirmDisabled={!canConfirm} onConfirm={() => { void confirm(); }} onCancel={close}>
          <div data-testid="co-template-dialog">
            <p style={{ marginTop: 0 }} className="sm">A template adds its MSP staff to the Responders of {customerName}. People added directly stay as they are. The order people are paged in is not part of a template.</p>
            <label htmlFor={`${id}-sel`} className="co-tplf-l">Template</label>
            <select id={`${id}-sel`} className="inp co-tplf-sel" value={sel} data-testid="co-template-select" disabled={busy || !templates} onChange={(e) => { setSel(e.target.value); setErr(null); }}>
              <option value={NONE}>No template{cur === NONE ? " (current)" : ""}</option>
              {(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}{t.id === cur ? " (current)" : ""} · {t.members.length === 1 ? "1 person" : `${t.members.length} people`}</option>)}
            </select>
            <div aria-live="polite" data-testid="co-template-preview">
              {sel === cur && !err ? <p className="sm mut">Choose another template, or No template, to see what it does to {customerName}.</p> : null}
              {load.status === "loading" ? <p className="sm mut" data-testid="co-template-loading">Checking what this does to {customerName}…</p> : null}
              {load.status === "error" ? <p className="co-err" role="alert" data-testid="co-template-preview-error">{load.message}</p> : null}
              {ready ? (
                <>
                  <p className="sm" data-testid="co-template-totals"><b>{customerName}</b>: {ready.totals.joins} will join, {ready.totals.leaves} will leave{ready.totals.warnings ? `, ${ready.totals.warnings} call order step${ready.totals.warnings === 1 ? "" : "s"} still name someone who leaves` : ""}.</p>
                  <BlockedBox blocked={blocked} testId="co-template-blocked" />
                  <EffectList effects={ready.effects} testId="co-template-effects" />
                  {ready.skippedInactive.length > 0 ? <p className="sm mut" data-testid="co-template-skipped">{skippedInactiveText(ready.skippedInactive, "preview")}</p> : null}
                </>
              ) : null}
            </div>
            {err ? (
              <div className="co-err co-tplf-err" role="alert" data-testid="co-template-error">
                <span>{err.text}</span>
                {err.reload ? <button type="button" className="btn sm" onClick={() => { setOpen(false); router.refresh(); }}>Reload</button> : null}
              </div>
            ) : null}
          </div>
        </ConfirmDialog>
      </div>
    </div>
  );
}
