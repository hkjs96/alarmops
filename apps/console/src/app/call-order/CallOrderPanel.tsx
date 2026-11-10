"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, ConfirmDialog, DirtyGuard, Mark, Panel, cx } from "@alarmops/design-system";
import type { PagingConfigInput, PagingStep } from "@/lib/api/types";
import {
  PLAN_LABEL, STYLE_LABEL, callOrderPath, depthOf, diffConfig, labelOf, levelOf, pagedNow, parseScopeKey, partsText, pathOf, plural, reachOf, reachText,
  resolveStep, sameConfig, scopeKey, sentenceParts, sourceOf, targetParts, toInput, validateConfig, namesOf, howText, repeatText,
  type CoScope, type Directory, type ScopeNames,
} from "@/lib/call-order/model";
import { announceDrafts, clearDraft, loadDraft, saveDraft, type CallOrderDraft } from "@/lib/call-order/draft-store";
import { setBackGuard, setEditIntent, setFocusRow, takeBackGuard, takeEditIntent } from "@/lib/call-order/flags";
import { scopeQuery } from "@/lib/scope";
import { useShell } from "@/components/ShellContext";
import type { PanelData } from "./CallOrderScreen";
import { removeOwnSteps, saveCallOrder } from "./actions";
import { Sentence } from "./Sentence";
import { StepEditor } from "./StepEditor";
import { RespondersCard } from "./RespondersCard";

interface Meta { creating: boolean; widenedFrom?: string; baseVersion: number | null }
interface Pending { proceed: () => void; leavingTo?: string }
const shortDate = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "Asia/Seoul" }).format(new Date(iso));
/**
 * Browser Back over an unsaved edit. It cannot be refused: when the page hears of it the address has changed and the
 * router has usually taken the panel off the screen already (so a listener owned by the panel never runs). This one
 * listener belongs to the module instead. It steps forward again and leaves a note (flags.ts); the panel that comes
 * back — or the one that never left — opens the same Save / Keep draft / Discard dialog. Nothing typed is lost in
 * between, because the draft is in sessionStorage.
 */
const nav = { bypassUntil: 0, restoringUntil: 0, dirtyKey: null as string | null, leftKey: null as string | null, leftAt: 0 };
const passing = () => Date.now() < nav.bypassUntil;
const BACK_EVENT = "ao-co-back-asked";
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    const now = Date.now();
    if (passing()) return;
    if (now < nav.restoringUntil) { nav.restoringUntil = 0; window.dispatchEvent(new Event(BACK_EVENT)); return; } // our own step forward arrived
    const k = nav.dirtyKey ?? (now - nav.leftAt < 1000 ? nav.leftKey : null);
    if (!k) return;
    nav.restoringUntil = now + 3000;
    setBackGuard(k);
    window.history.go(1);
  });
}
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/**
 * The call order of exactly one level (D-33). Opens read-only: the sentence with real names, who is paged, the steps,
 * where they come from. `Edit` (or E) shows the editor; nothing is typed into before that. Saving is for this level
 * only — a wider level is a separate, explained step — and every way out of an unsaved edit asks first.
 */
export function CallOrderPanel({ data, listHref, listQuery }: { data: PanelData; listHref: string; listQuery: string }) {
  const { scope, path, health, responders, rotations, staff } = data;
  const shell = useShell();
  const router = useRouter();
  const key = scopeKey(scope);
  const node = shell.customers.find((c) => c.slug === scope.customer);
  const names: ScopeNames = useMemo(() => ({
    customer: path.customer.name,
    project: path.path.find((p) => p.level === "PROJECT")?.name,
    service: path.path.find((p) => p.level === "SERVICE")?.name,
  }), [path]);
  const label = labelOf(names);
  const level = levelOf(scope).toLowerCase();
  const dir: Directory = useMemo(() => ({ customerName: names.customer, staff: responders.staff, people: responders.people, rotations, allStaff: staff }), [names.customer, responders, rotations, staff]);
  const reach = useMemo(() => (node ? reachOf(node, scope) : { services: [], kept: [] }), [node, scope]);
  const source = node ? sourceOf(node, scope) : scope;
  const sourceLabel = node ? labelOf(namesOf(node, source) ?? names) : names.customer;
  const base: PagingConfigInput = useMemo(() => toInput({ style: path.style, plan: path.plan, sharedRotationId: path.sharedRotationId, repeatCount: path.repeatCount, steps: path.steps }), [path]);

  const [mode, setMode] = useState<"read" | "edit">("read");
  const [value, setValue] = useState<PagingConfigInput>(base);
  const [meta, setMeta] = useState<Meta>({ creating: false, baseVersion: path.version });
  const [kept, setKept] = useState<CallOrderDraft | null>(null);
  const [guard, setGuard] = useState<Pending | null>(null);
  const [confirm, setConfirm] = useState<{ after?: () => void } | null>(null);
  const [widen, setWiden] = useState<CoScope | null>(null);
  const [askCancel, setAskCancel] = useState(false);
  const [askRemove, setAskRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [tried, setTried] = useState(false);
  const focusField = useRef(false);

  const editing = mode === "edit";
  const dirty = editing && !sameConfig(value, base);
  const stale = editing && !busy && (meta.creating ? path.own : !path.own || meta.baseVersion !== path.version);
  const check = useMemo(() => validateConfig(value, dir), [value, dir]);
  const before = useMemo(() => ({ steps: path.steps, repeatCount: path.repeatCount }), [path]);
  const liveSteps = useMemo(() => value.steps.map((s) => resolveStep(s, dir)), [value.steps, dir]);
  const shownSteps = editing ? liveSteps : path.steps;
  const paged = pagedNow(shownSteps);
  const notified = path.customerNotified.filter((n) => !paged.some((p) => p.id === n.contactId));
  const wide = reach.services.length > 1 || Boolean(meta.widenedFrom);
  const describe = useCallback((s: PagingStep) => partsText(targetParts(resolveStep(s, dir), names.customer)), [dir, names.customer]);
  const changes = diffConfig(base, value, describe);
  const saveLabel = `${meta.creating ? "Save own steps for" : "Save for"} ${label}`;

  /* ---- entering and leaving the editor ---- */
  const enterEdit = useCallback((widenedFrom?: string) => {
    const d = loadDraft(key);
    if (d) { setValue(d.value); setMeta({ creating: d.creating, widenedFrom: d.widenedFrom ?? widenedFrom, baseVersion: d.baseVersion }); }
    else { setValue(base); setMeta({ creating: !path.own, widenedFrom, baseVersion: path.own ? path.version : null }); }
    setError(null); setConflict(false); setTried(false);
    focusField.current = true;
    setMode("edit");
  }, [key, base, path.own, path.version]);
  const toRead = useCallback(() => { setMode("read"); setKept(loadDraft(key)); }, [key]);

  // a row's E key, "Resume", and the widen step arrive here as a one-shot note; otherwise the panel opens to read
  useEffect(() => {
    const intent = takeEditIntent(key);
    if (takeBackGuard(key) && loadDraft(key)) {
      // Back was pressed over an unsaved edit and the editor stepped forward again: same editor, same question
      nav.restoringUntil = 0;
      enterEdit();
      setGuard({ proceed: () => window.history.back(), leavingTo: "go back" });
    } else if (intent) enterEdit(intent.widenedFrom);
    else setKept(loadDraft(key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!editing || !focusField.current) return;
    focusField.current = false;
    const el = document.querySelector<HTMLInputElement>(".co-panel [data-first-field]") ?? document.querySelector<HTMLInputElement>(".co-panel .co-edit input");
    el?.focus();
    el?.select?.();
  }, [editing]);

  // the draft is written as it is typed: a reload, a crash or "Keep draft" all find it under this scope, and only this scope
  useEffect(() => {
    if (!editing) return;
    if (dirty) saveDraft({ scope: key, label, baseVersion: meta.baseVersion, creating: meta.creating, widenedFrom: meta.widenedFrom, value }, Date.now());
    else clearDraft(key);
    announceDrafts();
  }, [editing, dirty, key, label, meta, value]);

  const leaveNow = useCallback((proceed: () => void) => {
    nav.bypassUntil = Date.now() + 1500;
    shell.setLeaveGuard(null);
    proceed();
  }, [shell]);

  /* ---- the guard: every exit of an unsaved edit (nav, tree, Ctrl/⌘K, Esc, another row, browser back) ---- */
  useEffect(() => {
    if (!dirty) return;
    shell.setLeaveGuard((proceed, leavingTo) => setGuard({ proceed, leavingTo }));
    const onClick = (e: MouseEvent) => {
      if (passing() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.origin !== window.location.origin || a.closest("[data-guard-pass]")) return;
      if (a.pathname === window.location.pathname && a.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      const href = a.pathname + a.search + a.hash;
      setGuard({ proceed: () => router.push(href), leavingTo: /\/incident\//.test(a.pathname) ? "open incident" : "continue" });
    };
    // Back is handled by the module's listener above; if this panel is still on screen when the step forward arrives, it asks here
    const onBack = () => setGuard({ proceed: () => window.history.back(), leavingTo: "go back" });
    document.addEventListener("click", onClick, true);
    window.addEventListener(BACK_EVENT, onBack);
    return () => {
      shell.setLeaveGuard(null);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(BACK_EVENT, onBack);
    };
  }, [dirty, shell, router]);

  // which scope has an unsaved edit right now — and, for a moment after the panel is taken away, which one had
  useEffect(() => { nav.dirtyKey = dirty ? key : nav.dirtyKey === key ? null : nav.dirtyKey; }, [dirty, key]);
  useEffect(() => () => {
    if (nav.dirtyKey !== key) return;
    nav.dirtyKey = null; nav.leftKey = key; nav.leftAt = Date.now();
  }, [key]);

  const close = () => shell.requestLeave(() => { setFocusRow(key); router.push(listHref); }, "continue");

  /* ---- save ---- */
  const doSave = async (after?: () => void) => {
    setBusy(true); setError(null);
    const wasCreating = meta.creating;
    const res = await saveCallOrder(scope, value, wasCreating ? null : meta.baseVersion);
    if (!res.ok) {
      setBusy(false);
      // the draft stays exactly as typed; nothing is overwritten on either side
      if (res.code === "VERSION_CONFLICT" || res.code === "ALREADY_EXISTS") setConflict(true);
      else setError(res.message + (res.requestId ? ` (requestId ${res.requestId})` : ""));
      return;
    }
    const newVersion = res.data.version;
    clearDraft(key); announceDrafts();
    setMode("read");
    const text = `${wasCreating ? "Own steps created for" : "Saved for"} ${label} · ${changes.length ? changes.join(", ") : "same steps"} · ${reachText(reach)}`;
    // Undo only for a save that was applied without a confirmation (one service): store the previous value again (API-CONTRACT §8.8)
    const undo = wide ? undefined : {
      label: "Undo",
      onAction: async () => {
        const r = wasCreating ? await removeOwnSteps(scope, newVersion) : await saveCallOrder(scope, base, newVersion);
        shell.toast(r.ok ? `Undone · ${label} is back to how it was` : r.code === "VERSION_CONFLICT" ? `Could not undo — ${label} was changed again` : `Could not undo — ${r.message}`);
      },
    };
    setFocusRow(key);
    if (after) leaveNow(after); else router.push(listHref);
    shell.toast(text, undo);
  };
  const attemptSave = (after?: () => void) => {
    if (!editing || busy) return;
    setTried(true);
    if (stale || conflict) return;
    if (check.errors.length) {
      const bad = check.errors[0]!;
      const sel = bad.stepIndex !== undefined ? `[data-step="${bad.stepIndex}"] [data-field="${bad.field ?? "atMin"}"]` : bad.field === "repeat" ? "[data-field=repeat]" : null;
      (sel ? document.querySelector<HTMLElement>(`.co-panel ${sel}`) : null)?.focus();
      return;
    }
    if (!meta.creating && !dirty) { shell.toast(`Nothing to save — no value changed for ${label}`); return; }
    if (wide) { shell.clearToast(); setConfirm({ after }); } else void doSave(after);
  };

  const stateRef = useRef({ editing, modal: false, attemptSave, enterEdit });
  stateRef.current = { editing, modal: Boolean(guard || confirm || widen || askCancel || askRemove), attemptSave, enterEdit };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = stateRef.current;
      if (s.modal || document.querySelector(".ssearch, .ssheet")) return;
      if (s.editing && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); s.attemptSave(); return; }
      if (!s.editing && e.key.toLowerCase() === "e" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && !e.defaultPrevented) { e.preventDefault(); s.enterEdit(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const cancelEdit = () => { if (dirty) setAskCancel(true); else { clearDraft(key); announceDrafts(); toRead(); } };
  const discard = () => { clearDraft(key); announceDrafts(); setMode("read"); setKept(null); };

  /* ---- widening: a separate, explained step (E6) ---- */
  const origin = meta.widenedFrom ? parseScopeKey(meta.widenedFrom) : null;
  const originLabel = origin && node ? labelOf(namesOf(node, origin) ?? names) : null;
  const wider: CoScope[] = [...(scope.service ? [{ customer: scope.customer, project: scope.project }] : []), ...(scope.project ? [{ customer: scope.customer }] : [])];
  const goWide = (w: CoScope) => {
    const go = () => { setEditIntent({ scope: scopeKey(w), widenedFrom: meta.widenedFrom ?? key }); router.push(callOrderPath(w) + listQuery); };
    if (dirty) setGuard({ proceed: go, leavingTo: "continue" }); else go();
  };
  const widenInfo = widen && node ? { names: namesOf(node, widen)!, reach: reachOf(node, widen), src: sourceOf(node, widen) } : null;
  const widenOwn = widenInfo ? scopeKey(widenInfo.src) === scopeKey(widen!) : false;

  const remove = async () => {
    setBusy(true);
    const r = await removeOwnSteps(scope, path.version);
    setBusy(false); setAskRemove(false);
    if (!r.ok) { if (r.code === "VERSION_CONFLICT") setConflict(true); else setError(r.message); return; }
    clearDraft(key); announceDrafts(); setMode("read"); setFocusRow(parentKey);
    leaveNow(() => router.push(listHref));
    shell.toast(`Own steps removed for ${label} · it follows ${parentLabel} again`);
  };
  const parent: CoScope = scope.service && node?.projects.find((p) => p.slug === scope.project)?.ownSteps ? { customer: scope.customer, project: scope.project } : { customer: scope.customer };
  const parentKey = scopeKey(parent);
  const parentLabel = node ? labelOf(namesOf(node, parent) ?? names) : names.customer;

  const peopleHref = "/people" + scopeQuery(scope);
  const filterNote = shell.sel.customer && shell.sel.customer !== scope.customer ? `Different customer than your list filter (${shell.label}). The filter stays as it is.` : undefined;
  const copy = async () => { await navigator.clipboard.writeText(window.location.origin + callOrderPath(scope)); };
  const problemTone = health.level === "UNREACHABLE" ? "red" : "amber";
  const sentence = editing ? sentenceParts(liveSteps, value.repeatCount, names.customer, before) : sentenceParts(path.steps, path.repeatCount, names.customer);
  const issues = editing ? [...check.errors.map((i) => ({ ...i, err: true })), ...check.warnings.map((i) => ({ ...i, err: false }))] : [];

  const footer = editing ? (
    <>
      <span className={cx("co-dirty", dirty && "on")} data-testid="co-unsaved" aria-live="polite">{dirty ? <><Mark shape="dot" />Unsaved</> : null}</span>
      {path.updatedByName && !meta.creating ? <span className="sm mut co-by">Edited by {path.updatedByName}{path.updatedAt ? ` · ${shortDate(path.updatedAt)}` : ""}</span> : null}
      <span className="sp" />
      <button type="button" className="btn ghost" onClick={cancelEdit}>Cancel</button>
      <button type="button" className="btn pri co-save" data-testid="co-save" disabled={busy || stale || conflict} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={() => attemptSave()}>
        <span className="co-save-t">{busy ? "Saving…" : saveLabel}</span><span className="kbd hide-m" aria-hidden="true">Ctrl/⌘+Enter</span>
      </button>
    </>
  ) : (
    <>
      <span className="sm mut co-ro">{path.own
        ? (reach.services.length > 1 ? `Read only. An edit here reaches ${plural(reach.services.length, "service")}.` : "Read only until you press Edit.")
        : `Read only. To change these steps for everything that follows them, open ${sourceLabel}.`}</span>
      <span className="sp" />
      <button type="button" className="btn co-editbtn" data-testid="co-edit" aria-keyshortcuts="E" onClick={() => enterEdit()}>
        <span className="co-save-t">{path.own ? `Edit call order for ${label}` : `Create own steps for ${label}…`}</span><span className="kbd hide-m" aria-hidden="true">E</span>
      </button>
    </>
  );

  return (
    <>
      <Panel className="co-panel" kind={editing ? `Call order · editing at ${level} level` : `Call order · ${level} level`} path={pathOf(names)} note={filterNote} onClose={close} onCopyLink={copy} footer={footer}>
        <div className={cx("stack", editing ? "co-edit" : "co-read")} data-testid={editing ? "co-edit-view" : "co-read-view"} data-scope={key}>
          {!editing && kept ? (
            <div className="banner accent co-draft" data-testid="co-draft-here">
              <span className="co-draft-t"><b>Draft for {label}</b> · not saved, kept in this tab only</span>
              <span className="co-draft-a">
                <button type="button" className="btn sm" onClick={() => enterEdit()}>Resume</button>
                <button type="button" className="btn sm ghost" onClick={discard}>Discard</button>
              </span>
            </div>
          ) : null}

          {health.level !== "OK" ? (
            <Banner tone={problemTone}>
              <div data-testid="co-health">
                <div><span className={cx("stag", health.level === "UNREACHABLE" ? "unr" : "ar")}>{health.level === "UNREACHABLE" ? "Unreachable" : "At risk"}</span>{" "}
                  <b>{health.level === "UNREACHABLE"
                    ? `If something breaks now, nobody for ${names.customer} is reached.`
                    : `Some calls for ${names.customer} depend on contacts that are not verified, or on a gap in a rotation.`}</b></div>
                <ul className="co-probs">{health.problems.map((p, n) => <li key={n}>{p.message}</li>)}</ul>
                <div className="sm">Worked out from the customer-level steps of {names.customer}, its Responders and the next 14 days of shifts.{" "}
                  <Link className="co-lnk" href={"/people" + scopeQuery({ customer: scope.customer })}>Check their contacts in People →</Link></div>
              </div>
            </Banner>
          ) : null}

          {editing ? (
            <div className="co-lv" data-testid="co-level">
              <div className="ov co-lv-h">Level you are editing</div>
              <div className="co-lv-r"><span className="ov">{level}</span><span><b>{label}</b><small>{meta.creating ? `no own steps yet · follows ${sourceLabel}` : `own steps · pages for ${reachText(reach)}`}</small></span></div>
              {origin && originLabel ? (
                <div className="co-lv-w">
                  <span className="sm">Widened from the row you opened.</span>
                  <button type="button" className="btn sm" onClick={() => shell.requestLeave(() => router.push(callOrderPath(origin) + listQuery), "continue")}>← Back to {originLabel.split(" › ").pop()}</button>
                </div>
              ) : null}
              {wider.length ? (
                <div className="co-lv-w">
                  <span className="sm mut">Need to change more than {names.service ?? names.project}?</span>
                  {wider.map((w) => (
                    <button key={scopeKey(w)} type="button" className="btn sm" onClick={() => { shell.clearToast(); setWiden(w); }}>
                      {w.project ? `Edit project ${names.project} instead…` : "Edit the whole customer instead…"}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {editing && meta.creating ? (
            <div className="co-inh" data-testid="co-creating">
              <div className="b">Creating own steps for {label}</div>
              <div>Started from the steps of {sourceLabel}. Nothing changes until you save. After saving, {reach.services.length
                ? <><b>{reachText(reach)}</b> of {label} stop following {sourceLabel}</>
                : <><b>no service changes right now</b></>}. {sourceLabel} itself is not changed.</div>
            </div>
          ) : null}

          {editing && (conflict || stale) ? (
            <Banner tone="amber">
              <div data-testid="co-conflict">
                <div><b>Changed — reload.</b> Someone else changed the call order of {label} while you were editing{path.updatedByName && stale ? ` (${path.updatedByName})` : ""}. Nothing was saved, and your draft is kept as you typed it.</div>
                {stale && !conflict ? (
                  <>
                    <div className="co-cmp"><span className="ov">Now saved</span><span>{partsText(sentenceParts(path.steps, path.repeatCount, names.customer))}</span></div>
                    <div className="co-cmp"><span className="ov">Your draft</span><span>{partsText(sentenceParts(liveSteps, value.repeatCount, names.customer))}</span></div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <button type="button" className="btn sm" data-testid="co-rebase" onClick={() => setMeta((m) => ({ ...m, creating: !path.own, baseVersion: path.own ? path.version : null }))}>Keep my draft and compare it with what is saved now</button>
                      <button type="button" className="btn sm ghost" onClick={discard}>Discard my draft</button>
                    </div>
                  </>
                ) : (
                  <div className="row" style={{ marginTop: 8 }}>
                    <button type="button" className="btn sm" data-testid="co-reload" onClick={() => { setConflict(false); router.refresh(); }}>Reload what is saved now</button>
                  </div>
                )}
              </div>
            </Banner>
          ) : null}

          {editing ? (
            <StepEditor value={value} onChange={setValue} dir={dir} customerName={names.customer} showErrors={tried} issues={check.errors} />
          ) : null}

          <section aria-labelledby="co-now">
            <div className="ov co-h" id="co-now">If something breaks now{editing ? <span className="co-live"> · updates as you type</span> : null}</div>
            <Sentence parts={sentence} live={editing} />
            {editing ? (
              <div className="co-issues" role="alert" data-testid="co-issues">
                {issues.map((i, n) => <div key={n} className={i.err ? "co-err" : "co-warn"}><Mark shape={i.err ? "dot" : "tri"} /><span>{i.err ? "" : "Warning: "}{i.message}</span></div>)}
                {error ? <div className="co-err"><Mark shape="dot" /><span>Could not save: {error}</span></div> : null}
              </div>
            ) : null}
            <p className="sm co-paged" data-testid="co-paged">
              <b>Paged ({paged.length})</b>{paged.length ? <>: {paged.map((p) => p.name).join(", ")}</> : null}
              {" · "}<b>Also notified ({notified.length})</b>{notified.length ? <>: {notified.map((p) => p.name).join(", ")}</> : null}.{" "}
              <Link href={peopleHref} className="co-lnk">Open them in People →</Link>
            </p>
          </section>

          {!editing ? (
            <>
              <section aria-labelledby="co-steps">
                <div className="ov co-h" id="co-steps">Steps</div>
                <ol className="co-steps" data-testid="co-steps">
                  {path.steps.map((s, i) => (
                    <li key={i} className="co-step">
                      <span className={cx("ord", i === 0 && "first")}>{i + 1}</span>
                      <span className="mono b nowrap">{s.atMin} min</span>
                      <span className="co-step-t">{targetParts(s, names.customer).map((p, n) => (p.k === "b" ? <b key={n}>{p.t}</b> : <span key={n}>{p.t}</span>))}</span>
                      <span className="sm co-step-h">{howText(s.channels).replace(/ \+ /g, " · ")}</span>
                    </li>
                  ))}
                  <li className="co-step"><span /><span className="mono sm mut nowrap">then</span><span className="sm mut">{repeatText(path.repeatCount)}</span><span /></li>
                </ol>
              </section>
              <dl className={cx("co-from", !path.own && "inh")} data-testid="co-from">
                <dt>{path.own ? "Comes from" : "Inherited from"}</dt>
                <dd>{path.own ? (
                  <><b>{label}</b> · {scope.project ? "own steps" : "customer steps"} · {STYLE_LABEL[path.style]}, started from {PLAN_LABEL[path.plan]}{path.edited ? " (edited)" : ""} · used by {reachText(reach)}
                    {path.updatedByName ? ` · edited by ${path.updatedByName}${path.updatedAt ? `, ${shortDate(path.updatedAt)}` : ""}` : ""}.</>
                ) : (
                  <><b>{sourceLabel}</b>. {names.service ?? names.project} has no steps of its own and follows it.{" "}
                    <Link className="co-lnk" href={callOrderPath(source) + listQuery}>Open the call order of {sourceLabel} →</Link></>
                )}</dd>
              </dl>
            </>
          ) : null}

          {node ? (
            <div className="card co-tree">
              <div className="card-h"><span className="ov">Where steps come from · {names.customer}</span></div>
              <ul>
                {[{ s: { customer: node.slug } as CoScope, name: node.name, own: true, from: "" },
                  ...node.projects.flatMap((p) => [
                    { s: { customer: node.slug, project: p.slug } as CoScope, name: p.name, own: Boolean(p.ownSteps), from: node.name },
                    ...p.services.map((v) => ({ s: { customer: node.slug, project: p.slug, service: v.slug } as CoScope, name: v.name, own: Boolean(v.ownSteps), from: p.ownSteps ? p.name : node.name })),
                  ])].map((r) => {
                  const k = scopeKey(r.s);
                  const d = depthOf(r.s);
                  // while editing, a wider level of this customer is never a plain click
                  const isWider = editing && d < depthOf(scope) && (k === scope.customer || k === `${scope.customer}/${scope.project}`);
                  return (
                    <li key={k}>
                      <Link href={callOrderPath(r.s) + listQuery} className={cx(`l${d}`, k === key && "cur")} aria-current={k === key ? "true" : undefined} data-guard-pass={isWider ? "" : undefined}
                        onClick={isWider ? (e) => { e.preventDefault(); shell.clearToast(); setWiden(r.s); } : undefined}>
                        <span className={d === 1 ? "b" : undefined}>{r.name}</span>
                        {d === 1 ? <span className="pill">Customer steps</span> : r.own ? <span className="pill accent">Own steps</span> : <span className="sm mut">inherits {r.from}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <RespondersCard customer={scope.customer} customerName={names.customer} responders={responders} staff={staff} steps={path.steps} canEdit={!editing} />

          {editing && path.own && scope.project && !meta.creating ? (
            <div className="row co-rm">
              <span className="sm mut">No longer needed?</span>
              <button type="button" className="btn danger sm" onClick={() => { shell.clearToast(); setAskRemove(true); }}>Remove own steps of {label}…</button>
              <span className="sm mut">It would inherit from {parentLabel} again.</span>
            </div>
          ) : null}
        </div>
      </Panel>

      <DirtyGuard
        open={Boolean(guard)} scopeLabel={label} leavingTo={guard?.leavingTo}
        body={<>Nothing has been saved for <b>{label}</b> yet. Save it, keep it as a draft for later, or discard it. A kept draft stays in this tab and belongs to {label} only.</>}
        onSave={() => { const g = guard!; setGuard(null); attemptSave(g.proceed); }}
        onKeepDraft={() => { const g = guard!; setGuard(null); leaveNow(g.proceed); }}
        onDiscard={() => { const g = guard!; setGuard(null); discard(); leaveNow(g.proceed); }}
        onCancel={() => setGuard(null)}
      />

      <ConfirmDialog open={Boolean(confirm)} title={`${saveLabel}?`} confirmLabel={saveLabel} busy={busy}
        onConfirm={() => { const c = confirm!; setConfirm(null); void doSave(c.after); }} onCancel={() => setConfirm(null)}>
        {originLabel ? <p className="co-c-w"><b>Wider than the row you opened.</b> You opened {originLabel}; this saves {label}.</p> : null}
        <div className="ov">Before → after</div>
        {changes.length ? <ul className="co-chg" data-testid="co-changes">{changes.map((c) => <li key={c}>{c}</li>)}</ul> : <p>Same steps as {sourceLabel}, now as own steps.</p>}
        <Sentence parts={sentenceParts(liveSteps, value.repeatCount, names.customer, before)} />
        {reach.services.length ? (
          <>
            <div>This changes who is paged for <b>{plural(reach.services.length, "service")}</b>:</div>
            <ul data-testid="co-affected">{reach.services.map((s) => <li key={s}>{names.customer} › {s}</li>)}</ul>
          </>
        ) : <div>No service follows these steps right now.</div>}
        <div>{reach.kept.length ? `Not changed: ${reach.kept.join(", ")} (own steps).` : "Nothing else is changed."} This save has no Undo.</div>
      </ConfirmDialog>

      <ConfirmDialog open={Boolean(widen && widenInfo)} defaultFocus="cancel"
        title={widen?.project ? `Edit all of project ${widenInfo?.names.project} instead?` : `Edit the whole customer ${names.customer} instead?`}
        confirmLabel={widenInfo ? `Edit ${labelOf(widenInfo.names)} · ${plural(widenInfo.reach.services.length, "service")}` : ""} cancelLabel={`Stay on ${label}`}
        onConfirm={() => { const w = widen!; setWiden(null); goWide(w); }} onCancel={() => setWiden(null)}>
        {widenInfo ? (
          <>
            <p>You opened <b>{label}</b> ({plural(reach.services.length, "service")}). This step switches the panel to <b>{labelOf(widenInfo.names)}</b>.</p>
            <div><b>What widens:</b> {widenOwn
              ? <>the steps of {labelOf(widenInfo.names)} page for <b>{plural(widenInfo.reach.services.length, "service")}</b>:</>
              : <>{labelOf(widenInfo.names)} has no own steps yet. Creating them would change <b>{plural(widenInfo.reach.services.length, "service")}</b>:</>}</div>
            <ul data-testid="co-widen-list">{widenInfo.reach.services.map((s) => <li key={s}>{names.customer} › {s}</li>)}</ul>
            {widenInfo.reach.kept.length ? <div>Not reached: {widenInfo.reach.kept.join(", ")} (own steps).{path.own ? <b> {label} has its own steps, so it would not change.</b> : null}</div> : null}
            <p>The panel header changes to {labelOf(widenInfo.names)}. Your list filter stays as it is. You can go back to {names.service ?? names.project} in one click.</p>
          </>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog open={askCancel} defaultFocus="cancel" danger title={`Discard changes for ${label}?`} confirmLabel="Discard changes" cancelLabel="Keep editing"
        onConfirm={() => { setAskCancel(false); discard(); }} onCancel={() => setAskCancel(false)}>
        <p>What you changed for {label} has not been saved: {changes.join(", ") || "the steps"}.</p>
      </ConfirmDialog>

      <ConfirmDialog open={askRemove} defaultFocus="cancel" danger busy={busy} title={`Remove own steps of ${label}?`} confirmLabel={`Remove own steps of ${label}`} cancelLabel="Keep them"
        onConfirm={() => void remove()} onCancel={() => setAskRemove(false)}>
        <p>{label} would follow <b>{parentLabel}</b> again{reach.services.length ? <>. This changes who is paged for <b>{plural(reach.services.length, "service")}</b>:</> : "."}</p>
        <ul>{reach.services.map((s) => <li key={s}>{names.customer} › {s}</li>)}</ul>
        <p>The steps of {parentLabel} are not changed. This has no Undo.</p>
      </ConfirmDialog>
    </>
  );
}
