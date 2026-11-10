"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar, cx } from "@alarmops/design-system";
import { NAV, sectionFor } from "@/lib/nav";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Top menu. The Incidents badge is one number: open incidents in all customers (triggered or escalated, nobody
 * acknowledged). It does not change with the filter. Links carry the list filter so it follows the user across screens.
 */
export function TopNav({ openCount, userName, scopeQuery, onOpenFinder }: { openCount: number; userName: string; scopeQuery: string; onOpenFinder?: () => void }) {
  const pathname = usePathname();
  const active = sectionFor(pathname)?.key;
  const item = (s: (typeof NAV)[number], short = false) => (
    <Link key={s.key} href={s.href + scopeQuery} className={cx(active === s.key && "on")} aria-current={active === s.key ? "page" : undefined}>
      {short ? s.short ?? s.label : s.label}
      {s.key === "incidents" && openCount > 0 ? (
        <span className="cnt" data-testid={short ? undefined : "nav-badge"} title={`${openCount} open incident${openCount === 1 ? "" : "s"} in all customers. Open = triggered or escalated, nobody has acknowledged it. This number does not change with the filter.`}>
          <span className="sr-only">open in all customers: </span>{openCount}
        </span>
      ) : null}
    </Link>
  );
  const settings = NAV.find((s) => s.key === "settings")!;
  return (
    <>
      <header className="top">
        <Link href={"/incidents" + scopeQuery} className="logo" aria-label="AlarmOps home"><i />AlarmOps</Link>
        <nav className="nav hide-m" aria-label="Main">{NAV.map((s) => item(s))}</nav>
        <div className="top-r">
          <span className="health">PIPELINE OK · TICK 12s</span>
          {onOpenFinder ? (
            <button type="button" className="btn hide-m finder-btn" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K"
              title="Filter this screen to a customer, project or service. You stay on this screen." onClick={onOpenFinder}>
              Filter to…<span className="kbd" aria-hidden="true">Ctrl K</span>
            </button>
          ) : null}
          <Link href={settings.href + scopeQuery} className={cx("btn ghost show-m-flex", active === "settings" && "on")}>Settings</Link>
          <ThemeToggle />
          <Avatar name={userName} active />
        </div>
      </header>
      <nav className="bnav" aria-label="Main (mobile)">{NAV.filter((s) => s.key !== "settings").map((s) => item(s, true))}</nav>
    </>
  );
}
