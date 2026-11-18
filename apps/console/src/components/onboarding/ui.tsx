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
 * One value with its Copy button. The clipboard is written inside the click handler (a user gesture, synchronously started);
 * when the browser refuses (insecure context, permission) the text is selected so Ctrl+C / long-press works, and the status says so.
 * The value is only in this component's props and in the DOM: never in an address, storage or a log line.
 */
export function CopyValue({ label, value, testid, mono = true }: { label: string; value: string; testid?: string; mono?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "select">("idle");
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
    setState("select");
  };
  const copy = () => {
    if (timer.current) clearTimeout(timer.current);
    let p: Promise<void> | undefined;
    try { p = navigator.clipboard?.writeText(value); } catch { p = undefined; }
    if (!p) { selectText(); return; }
    p.then(() => { setState("copied"); timer.current = setTimeout(() => setState("idle"), 4000); }, selectText);
  };
  return (
    <>
      {mono ? <code ref={code} data-testid={testid ? `${testid}-value` : undefined}>{value}</code> : <span ref={code} data-testid={testid ? `${testid}-value` : undefined} className="ob-code">{value}</span>}
      <span className="row" style={{ gap: 8 }}>
        <button type="button" className="btn sm" onClick={copy} aria-label={`Copy ${label}`} data-testid={testid ? `${testid}-copy` : undefined}>Copy</button>
        <span className="sm mut" role="status" data-testid={testid ? `${testid}-state` : undefined}>{state === "copied" ? "Copied" : state === "select" ? "Selected. Press Ctrl+C (or Copy on your phone)." : ""}</span>
      </span>
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
