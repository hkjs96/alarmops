"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Mark } from "@alarmops/design-system";
import type { RoleTone } from "@/lib/onboarding";

/** A state in words + shape + colour (never colour alone). */
export function StateChip({ tone, label, testid }: { tone: RoleTone; label: string; testid?: string }) {
  const m = tone === "ok" ? { cls: "res", shape: "chk" as const } : tone === "fail" ? { cls: "trig", shape: "dot" as const } : tone === "wait" ? { cls: "warn", shape: "tri" as const } : { cls: "mute", shape: "dash" as const };
  return <span className={`st ob-st ${m.cls}`} data-tone={tone} data-testid={testid}><Mark shape={m.shape} />{label}</span>;
}

/**
 * One value with its Copy button. The clipboard is written inside the click handler (a user gesture); when the browser
 * refuses (insecure context, permission) the text is selected so Ctrl+C / long-press works. What happened is told through
 * `announce`: the screen has ONE live region for all copy buttons (no empty status region per button), the button itself
 * says "Copied" for a few seconds. The value lives only in props and the DOM: never in an address, storage or a log line.
 * `disabled` (with the reason shown by the caller) is for a value that is not there yet.
 */
export function CopyValue({ label, value, testid, mono = true, announce, disabled }: {
  label: string; value: string; testid?: string; mono?: boolean; announce: (message: string) => void; disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const code = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const selectText = () => {
    const el = code.current;
    if (!el) return;
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
    announce(`Could not copy ${label} automatically. It is selected: press Ctrl+C, or long-press to copy.`);
  };
  const copy = () => {
    if (timer.current) clearTimeout(timer.current);
    let p: Promise<void> | undefined;
    try { p = navigator.clipboard?.writeText(value); } catch { p = undefined; }
    if (!p) { selectText(); return; }
    p.then(() => { setCopied(true); announce(`Copied ${label}`); timer.current = setTimeout(() => setCopied(false), 4000); }, selectText);
  };
  return (
    <>
      {mono ? <code ref={code} data-testid={testid ? `${testid}-value` : undefined}>{value}</code> : <span ref={code} data-testid={testid ? `${testid}-value` : undefined} className="ob-code">{value}</span>}
      <button type="button" className="btn ob-btn" onClick={copy} disabled={disabled} aria-label={`Copy ${label}`} data-testid={testid ? `${testid}-copy` : undefined}>{copied ? "Copied" : "Copy"}</button>
    </>
  );
}

/** A message that takes the reader's attention once: role=alert, focusable so a keyboard user lands on it. */
export function ErrorLine({ children, testid }: { children: ReactNode; testid?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); ref.current?.scrollIntoView({ block: "nearest" }); }, [children]);
  return <div ref={ref} className="ob-err" role="alert" tabIndex={-1} data-testid={testid ?? "ob-error"}>{children}</div>;
}

export function Field({ label, hint, children, id }: { label: string; hint?: ReactNode; children: ReactNode; id: string }) {
  return (
    <div className="ob-field">
      <label className="lab" htmlFor={id} style={{ marginBottom: 0 }}>{label}</label>
      {children}
      {hint ? <div className="hint" id={`${id}-h`} style={{ fontSize: 13, marginTop: 0 }}>{hint}</div> : null}
    </div>
  );
}
