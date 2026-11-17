"use client";
import { useRouter } from "next/navigation";
import type { FormEvent, ReactNode } from "react";

/**
 * The filter form of the reveal list. It still works as a plain GET form; with script it builds the address itself and
 * leaves out every empty field, so "All customers" is "no customer" and never `customer=`.
 */
export function RevealFilters({ children }: { children: ReactNode }) {
  const router = useRouter();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(e.currentTarget)) if (typeof v === "string" && v.trim() !== "") p.set(k, v.trim());
    const s = p.toString();
    router.push("/settings/audit-log" + (s ? `?${s}` : ""));
  }
  return <form method="get" className="rr-filters" data-testid="reveal-filters" aria-label="Filter reveals" onSubmit={onSubmit}>{children}</form>;
}
