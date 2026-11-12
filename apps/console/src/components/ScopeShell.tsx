"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  OutsideLine, ScopeLine, ScopeSearch, ScopeSheet, ScopeTree, clampTreeWidth, cx, followsPressAttr, installSameSpotGuard, lastActionPress, normalizeSel, placeClearOfPress, readSession, resolveSel, sameSel, selKey, selLabel, writeSession,
  TREE_DEFAULT_WIDTH, type ScopeCustomerNode, type ScopeLevel, type ScopeSel,
} from "@alarmops/design-system";
import type { OutsideCounts } from "@/lib/api/types";
import { clearLevel, isPanelPath, parseScopeParams, scopeQuery } from "@/lib/scope";
import { ShellContext, type LeaveGuard, type LocalMark, type ShellApi, type ShellUser, type ToastAction } from "./ShellContext";
import { claimStorageFor } from "@/lib/user-storage";
import { NotFoundBody } from "./NotFoundBody";
import { SessionEnded } from "./SessionEnded";
import { TopNav } from "./TopNav";
import { panelListPath, sectionFor } from "@/lib/nav";
import { AUTO_RAIL_BELOW, DEFAULT_RAIL_MAX, PREFS_KEY } from "@/lib/shell-prefs";

interface Prefs { col: boolean | null; w: number }
interface Toast {
  id: number; text: string; action?: ToastAction; at: number;
  /** "top" when the control that was pressed is where the toast usually stands (design-system list/same-spot) */
  place: "bottom" | "top";
  /** the pressed control's box: a pointer press inside it does nothing on this toast */
  follows?: string;
}
/** A toast's button does nothing this soon after the toast appeared: it may have come up under a second tap. */
const TOAST_ARM_MS = 600;

export function ScopeShell({ customers, user, openCount, children }: { customers: ScopeCustomerNode[]; user: ShellUser; openCount: number; children: ReactNode }) {
  const userName = user.name;
  const pathname = usePathname();
  const sp = useSearchParams();
  const router = useRouter();
  const search = sp.toString();

  const parsed = useMemo(() => parseScopeParams(new URLSearchParams(search)), [search]);
  const resolved = parsed.malformed ? undefined : resolveSel(customers, parsed.sel);
  const valid = resolved !== undefined;
  const sel: ScopeSel = useMemo(() => (valid ? parsed.sel : {}), [valid, parsed.sel]);
  const label = selLabel(customers, sel);
  const filtered = Boolean(sel.customer || sel.mine);
  const mineCount = customers.filter((c) => c.mine).length;

  const panelOpen = isPanelPath(pathname);
  const settings = pathname.startsWith("/settings");
  const listPath = panelOpen ? panelListPath(pathname) : pathname;

  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);
  const [vw, setVw] = useState(1440);
  const [prefs, setPrefs] = useState<Prefs>({ col: null, w: TREE_DEFAULT_WIDTH });
  const [expandedBesidePanel, setExpandedBesidePanel] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [finder, setFinder] = useState(false);
  const [acks, setAcks] = useState<Record<string, string>>({});
  const [marks, setMarks] = useState<Record<string, LocalMark>>({});
  const listView = useRef<unknown>(null);
  const callOrderView = useRef<unknown>(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const leaveGuard = useRef<LeaveGuard | null>(null);
  const setLeaveGuard = useCallback((g: LeaveGuard | null) => { leaveGuard.current = g; }, []);
  const requestLeave = useCallback((proceed: () => void, leavingTo?: string) => {
    if (leaveGuard.current) leaveGuard.current(proceed, leavingTo); else proceed();
  }, []);
  const shellRef = useRef<HTMLDivElement>(null);
  const [outside, setOutside] = useState<OutsideCounts | null>(null);
  const [toastState, setToast] = useState<Toast | null>(null);
  const focusTitle = useRef(false);

  // One rule for every list (design-system list/same-spot): a second press where a row action was just pressed does nothing.
  useEffect(() => installSameSpotGuard(), []);
  // before anything reads sessionStorage (layout effects run before every effect): what another user left in this tab goes
  useLayoutEffect(() => { claimStorageFor(user.id); }, [user.id]);
  useLayoutEffect(() => {
    const s = readSession<Prefs>(PREFS_KEY);
    if (s) setPrefs({ col: typeof s.col === "boolean" ? s.col : null, w: clampTreeWidth(Number(s.w) || TREE_DEFAULT_WIDTH) });
    setVw(window.innerWidth);
    setMounted(true);
    const on = () => setVw(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  // width transitions start only after the remembered state is on screen, so a reload does not animate
  useEffect(() => {
    if (!mounted) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [mounted]);
  useEffect(() => { if (!panelOpen) setExpandedBesidePanel(false); }, [panelOpen]);

  const save = (p: Prefs) => { setPrefs(p); writeSession(PREFS_KEY, p); };
  const autoRail = panelOpen && vw < AUTO_RAIL_BELOW && !expandedBesidePanel;
  const rail = mounted ? autoRail || (prefs.col ?? vw <= DEFAULT_RAIL_MAX) : false;
  const onRailChange = (r: boolean) => {
    const narrowWithPanel = panelOpen && vw < AUTO_RAIL_BELOW;
    if (r) {
      // beside a panel below 1408 the expansion was temporary: collapsing it does not change what is remembered
      if (narrowWithPanel && expandedBesidePanel) setExpandedBesidePanel(false);
      else save({ ...prefs, col: true });
    } else {
      save({ ...prefs, col: false });
      if (narrowWithPanel) setExpandedBesidePanel(true);
    }
  };

  // A toast never comes up over the control that was just pressed (QA P2-N): its Undo would be under the second,
  // "did it take?" tap. The guard knows the last pressed action; the toast stands at the top when that control is
  // in the part of the viewport the toast would take at the bottom, and is deaf to presses inside the control's box.
  const toast = useCallback((text: string, action?: ToastAction) => {
    const press = lastActionPress();
    setToast({ id: Date.now(), text, action, at: performance.now(), place: placeClearOfPress(window.innerHeight, press), follows: followsPressAttr(press) });
  }, []);
  useEffect(() => {
    if (!toastState) return;
    const t = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(t);
  }, [toastState]);

  const setAck = useCallback((id: string, token: string | null) => setAcks((a) => {
    if (token ? a[id] === token : !(id in a)) return a;
    const n = { ...a };
    if (token) n[id] = token; else delete n[id];
    return n;
  }), []);

  const mark = useCallback((id: string, m: LocalMark | null) => setMarks((a) => {
    if ((a[id] ?? null) === m) return a;
    const n = { ...a };
    if (m) n[id] = m; else delete n[id];
    return n;
  }), []);
  // the list keeps its order while the user stays in Incidents (list ↔ panel); leaving is a navigation: next time it is sorted
  const inIncidents = sectionFor(pathname)?.key === "incidents";
  useEffect(() => { if (!inIncidents) listView.current = null; }, [inIncidents]);
  const inCallOrder = sectionFor(pathname)?.key === "call-order";
  useEffect(() => { if (!inCallOrder) callOrderView.current = null; }, [inCallOrder]);
  // on a phone the filter line sticks to the top; whatever sticks below it needs its height
  useEffect(() => {
    const line = shellRef.current?.querySelector<HTMLElement>(".sline");
    if (!line || typeof ResizeObserver === "undefined") return;
    // also on the root: scroll-padding-top (globals.css) keeps a row scrolled into view clear of the line
    const set = () => {
      const h = `${Math.round(line.getBoundingClientRect().height)}px`;
      shellRef.current?.style.setProperty("--sline-h", h);
      document.documentElement.style.setProperty("--sline-h", h);
    };
    const ro = new ResizeObserver(set);
    ro.observe(line);
    set();
    return () => ro.disconnect();
  }, [settings]);

  const setFilter = (next: ScopeSel, from: "tree" | "line" | "sheet" | "search") => {
    const n = normalizeSel(next);
    if (sameSel(n, sel) && valid) return; // choosing the filter that is already set leaves an open panel alone
    const keep = new URLSearchParams(search);
    // an unsaved edit in the panel is asked about first; the filter changes only if the user lets go of it (T11, §6)
    requestLeave(() => {
      focusTitle.current = from !== "tree";
      setToast(null);
      router.push(listPath + scopeQuery(n, keep));
      // a panel never stays open under a filter it was not opened from (T11)
      if (panelOpen) toast(`Panel closed · the list now shows ${selLabel(customers, n)}`);
    }, "continue");
  };
  const key = selKey(sel);
  useEffect(() => {
    if (!focusTitle.current) return;
    focusTitle.current = false;
    document.querySelector<HTMLElement>("#main h1")?.focus();
  }, [key, pathname]);

  const clearToast = useCallback(() => setToast(null), []);
  const api: ShellApi = useMemo(
    () => ({ user, sel, label, filtered, totalCustomers: customers.length, toast, clearToast, setOutside, acks, setAck, marks, mark, listView, customers, problemsOnly, callOrderView, requestLeave, setLeaveGuard }),
    [user, sel, label, filtered, customers, toast, clearToast, acks, setAck, marks, mark, problemsOnly, requestLeave, setLeaveGuard],
  );

  // Ctrl/⌘K opens "Filter to…" on every screen that has a filter; Esc with the focus in the tree closes an open panel
  const listHref = listPath + scopeQuery(sel, new URLSearchParams(search));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if (settings) return;
        e.preventDefault();
        // a question is on the screen (confirm, unsaved changes): it is answered first, nothing opens over it (QA P3-D)
        if (document.querySelector("[role=alertdialog]")) return;
        setSheet(false);
        setFinder((v) => !v);
        return;
      }
      if (e.key === "Escape" && !e.defaultPrevented && panelOpen && (e.target as HTMLElement | null)?.closest?.(".stree")) {
        e.preventDefault();
        requestLeave(() => router.push(listHref), "continue");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settings, panelOpen, listHref, router, requestLeave]);

  const allHref = listPath + scopeQuery({}, new URLSearchParams(search));
  // the list's counts arrive after the first paint; the line keeps its place until then, so nothing jumps (QA P2-2)
  const expectsOutside = filtered && valid && !settings && listPath === "/incidents";
  const outsideNode = !outside && expectsOutside ? (
    <span className="outside-w" aria-hidden="true">
      <span className="outside calm pending" data-testid="outside-pending">Outside this view: …</span>
      <span className="outside-i pending" />
    </span>
  ) : outside && filtered && valid ? (
    <OutsideLine
      open={outside.open} unmapped={outside.unmapped} acknowledged={outside.acknowledged} href={allHref}
      filterLabel={label} totalCustomers={customers.length}
      onNavigate={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        const back = pathname + (search ? `?${search}` : "");
        focusTitle.current = true;
        router.push(allHref);
        toast("Showing all customers", { label: `Back to ${label}`, href: back });
      }}
    />
  ) : null;

  return (
    <ShellContext.Provider value={api}>
      <div ref={shellRef} className={cx("shell", mounted && "mounted", ready && "ready", settings && "no-tree")} data-panel={panelOpen ? "1" : "0"} data-rail={rail ? "1" : "0"}>
        <TopNav openCount={openCount} userName={userName} role={user.role} scopeQuery={scopeQuery(sel)} onOpenFinder={settings ? undefined : () => { setToast(null); setFinder(true); }} />
        {settings ? (
          <ScopeLine totalCustomers={customers.length} mineCustomers={mineCount} onClear={() => undefined} locked={<><b>MSP-wide settings</b> · all {customers.length} customers</>} />
        ) : (
          <ScopeLine
            customer={resolved?.customer.name} project={resolved?.project?.name} service={resolved?.service?.name} mine={Boolean(sel.mine)}
            totalCustomers={customers.length} mineCustomers={mineCount}
            onClear={(level: ScopeLevel) => setFilter(clearLevel(sel, level), "line")}
            onOpenPicker={() => { setToast(null); setSheet(true); }}
            onOpenSearch={() => { setToast(null); setFinder(true); }}
            outside={outsideNode}
          />
        )}
        <div className="shell-lay">
          {settings ? null : (
            <ScopeTree
              customers={customers} value={sel} onChange={(s) => setFilter(s, "tree")}
              rail={rail} onRailChange={onRailChange}
              width={prefs.w} onWidthChange={(w) => save({ ...prefs, w })}
              beside={panelOpen ? "panel" : "list"} me={userName.split(" ")[0]} onProblemsChange={setProblemsOnly}
            />
          )}
          <main id="main" className="shell-main">{valid ? children : <NotFoundBody />}</main>
        </div>
        {settings ? null : (
          <ScopeSheet open={sheet} customers={customers} value={sel} onClose={() => setSheet(false)} onApply={(s) => { setSheet(false); setFilter(s, "sheet"); }} />
        )}
        {settings ? null : (
          <ScopeSearch
            open={finder} customers={customers} screen={sectionFor(listPath)?.label ?? "this screen"}
            onClose={() => setFinder(false)} onPick={(s) => { setFinder(false); setFilter(s, "search"); }}
          />
        )}
        {toastState && !sheet && !finder ? (
          <div className={cx("toast", toastState.place === "top" && "top")} role="status" key={toastState.id} data-testid="toast" data-place={toastState.place} data-follows-press={toastState.follows}>
            <span className="toast-t" title={toastState.text}>{toastState.text}</span>
            {toastState.action?.href ? <Link className="btn sm" href={toastState.action.href} onClick={() => setToast(null)}>{toastState.action.label}</Link> : null}
            {toastState.action?.onAction ? <button type="button" className="btn sm" onClick={(e) => { if (e.detail > 0 && performance.now() - toastState.at < TOAST_ARM_MS) return; const a = toastState.action!.onAction!; setToast(null); a(); }}>{toastState.action.label}</button> : null}
            <button type="button" className="btn sm ghost" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
          </div>
        ) : null}
        <SessionEnded />
      </div>
    </ShellContext.Provider>
  );
}
