"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  OutsideLine, ScopeLine, ScopeSheet, ScopeTree, clampTreeWidth, cx, normalizeSel, readSession, resolveSel, sameSel, selKey, selLabel, writeSession,
  TREE_DEFAULT_WIDTH, type ScopeCustomerNode, type ScopeLevel, type ScopeSel,
} from "@alarmops/design-system";
import type { OutsideCounts } from "@/lib/api/types";
import { clearLevel, isPanelPath, parseScopeParams, scopeQuery } from "@/lib/scope";
import { ShellContext, type ShellApi, type ToastAction } from "./ShellContext";
import { NotFoundBody } from "./NotFoundBody";
import { TopNav } from "./TopNav";

/** Below this width, opening a panel collapses the tree to its rail (the user can open it again beside the panel). */
export const AUTO_RAIL_BELOW = 1408;
/** Without a remembered choice the tree starts as a rail up to this width. */
const DEFAULT_RAIL_MAX = 1100;
const PREFS_KEY = "ao-scope-shell";

interface Prefs { col: boolean | null; w: number }
interface Toast { id: number; text: string; action?: ToastAction }

export function ScopeShell({ customers, userName, openCount, children }: { customers: ScopeCustomerNode[]; userName: string; openCount: number; children: ReactNode }) {
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
  const listPath = panelOpen ? "/incidents" : pathname;

  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);
  const [vw, setVw] = useState(1440);
  const [prefs, setPrefs] = useState<Prefs>({ col: null, w: TREE_DEFAULT_WIDTH });
  const [expandedBesidePanel, setExpandedBesidePanel] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [outside, setOutside] = useState<OutsideCounts | null>(null);
  const [toastState, setToast] = useState<Toast | null>(null);
  const focusTitle = useRef(false);

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

  const toast = useCallback((text: string, action?: ToastAction) => setToast({ id: Date.now(), text, action }), []);
  useEffect(() => {
    if (!toastState) return;
    const t = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(t);
  }, [toastState]);

  const setFilter = (next: ScopeSel, from: "tree" | "line" | "sheet") => {
    const n = normalizeSel(next);
    if (sameSel(n, sel) && valid) return; // choosing the filter that is already set leaves an open panel alone
    const keep = new URLSearchParams(search);
    focusTitle.current = from !== "tree";
    setToast(null);
    router.push(listPath + scopeQuery(n, keep));
    // a panel never stays open under a filter it was not opened from (T11)
    if (panelOpen) toast(`Panel closed · the list now shows ${selLabel(customers, n)}`);
  };
  const key = selKey(sel);
  useEffect(() => {
    if (!focusTitle.current) return;
    focusTitle.current = false;
    document.querySelector<HTMLElement>("#main h1")?.focus();
  }, [key, pathname]);

  const api: ShellApi = useMemo(
    () => ({ sel, label, filtered, totalCustomers: customers.length, toast, setOutside }),
    [sel, label, filtered, customers.length, toast],
  );

  const allHref = listPath + scopeQuery({}, new URLSearchParams(search));
  const outsideNode = outside && filtered && valid ? (
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
      <div className={cx("shell", ready && "ready", settings && "no-tree")} data-panel={panelOpen ? "1" : "0"} data-rail={rail ? "1" : "0"}>
        <TopNav openCount={openCount} userName={userName} scopeQuery={scopeQuery(sel)} />
        {settings ? (
          <ScopeLine totalCustomers={customers.length} mineCustomers={mineCount} onClear={() => undefined} locked={<><b>MSP-wide settings</b> · all {customers.length} customers</>} />
        ) : (
          <ScopeLine
            customer={resolved?.customer.name} project={resolved?.project?.name} service={resolved?.service?.name} mine={Boolean(sel.mine)}
            totalCustomers={customers.length} mineCustomers={mineCount}
            onClear={(level: ScopeLevel) => setFilter(clearLevel(sel, level), "line")}
            onOpenPicker={() => { setToast(null); setSheet(true); }}
            outside={outsideNode}
          />
        )}
        <div className="shell-lay">
          {settings ? null : (
            <ScopeTree
              customers={customers} value={sel} onChange={(s) => setFilter(s, "tree")}
              rail={rail} onRailChange={onRailChange}
              width={prefs.w} onWidthChange={(w) => save({ ...prefs, w })}
              beside={panelOpen ? "panel" : "list"} me={userName.split(" ")[0]}
            />
          )}
          <main id="main" className="shell-main">{valid ? children : <NotFoundBody />}</main>
        </div>
        {settings ? null : (
          <ScopeSheet open={sheet} customers={customers} value={sel} onClose={() => setSheet(false)} onApply={(s) => { setSheet(false); setFilter(s, "sheet"); }} />
        )}
        {toastState && !sheet ? (
          <div className="toast" role="status" key={toastState.id}>
            <span>{toastState.text}</span>
            {toastState.action?.href ? <Link className="btn sm" href={toastState.action.href} onClick={() => setToast(null)}>{toastState.action.label}</Link> : null}
            {toastState.action?.onAction ? <button type="button" className="btn sm" onClick={() => { const a = toastState.action!.onAction!; setToast(null); a(); }}>{toastState.action.label}</button> : null}
            <button type="button" className="btn sm ghost" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
          </div>
        ) : null}
      </div>
    </ShellContext.Provider>
  );
}
