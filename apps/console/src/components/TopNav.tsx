"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar, cx } from "@alarmops/design-system";
import { NAV, sectionFor } from "@/lib/nav";
import { ThemeToggle } from "./ThemeToggle";

export function TopNav({ unackedCount, userName }: { unackedCount: number; userName: string }) {
  const pathname = usePathname();
  const active = sectionFor(pathname)?.key;
  const items = NAV.map((s) => (
    <Link key={s.key} href={s.href} className={cx(active === s.key && "on")} aria-current={active === s.key ? "page" : undefined}>
      {s.label}
      {s.key === "incidents" && unackedCount > 0 ? (
        <span className="cnt" aria-label={`${unackedCount} not acknowledged`}>{unackedCount}</span>
      ) : null}
    </Link>
  ));
  return (
    <>
      <header className="top">
        <Link href="/incidents" className="logo" aria-label="AlarmOps home"><i />AlarmOps</Link>
        <nav className="nav hide-m" aria-label="Main">{items}</nav>
        <div className="top-r">
          <span className="health hide-m">PIPELINE OK · TICK 12s</span>
          <span className="sel hide-m" title="Customer filter (applies to every list)">
            <span className="k">Customer</span><b>All customers</b>
          </span>
          <ThemeToggle />
          <Avatar name={userName} active />
        </div>
      </header>
      <nav className="bnav" aria-label="Main (mobile)">{items}</nav>
    </>
  );
}
