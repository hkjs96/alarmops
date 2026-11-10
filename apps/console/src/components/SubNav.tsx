"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { sectionFor } from "@/lib/nav";

export function SubNav() {
  const pathname = usePathname();
  const s = sectionFor(pathname);
  if (!s || s.sub.length === 0) return null;
  // the tab with the longest matching address; a panel (/c/…) belongs to the section's first tab
  const on = s.sub.filter((x) => pathname === x.href || pathname.startsWith(x.href + "/")).sort((a, b) => b.href.length - a.href.length)[0] ?? (pathname.startsWith("/c/") ? s.sub[0] : undefined);
  return (
    <nav className="tabs subnav" aria-label={`${s.label} sections`}>
      {s.sub.map((x) => (
        <Link key={x.href} href={x.href} aria-selected={x === on} aria-current={x === on ? "page" : undefined}>
          {x.label}
        </Link>
      ))}
    </nav>
  );
}
