"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { sectionFor } from "@/lib/nav";

export function SubNav() {
  const pathname = usePathname();
  const s = sectionFor(pathname);
  if (!s || s.sub.length === 0) return null;
  return (
    <nav className="tabs subnav" aria-label={`${s.label} sections`}>
      {s.sub.map((x) => (
        <Link key={x.href} href={x.href} aria-selected={pathname.startsWith(x.href)} aria-current={pathname.startsWith(x.href) ? "page" : undefined}>
          {x.label}
        </Link>
      ))}
    </nav>
  );
}
