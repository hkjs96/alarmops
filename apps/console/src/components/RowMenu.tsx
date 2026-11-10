"use client";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

export interface RowMenuItem { label: string; onSelect: () => void }

/**
 * "…" on a row: the secondary actions (Undo acknowledge). It sits away from the row's primary button, and the menu
 * opens beside it without taking room in the layout. Opening it moves nothing.
 */
export function RowMenu({ label, items, disabled }: { label: string; items: RowMenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState<{ x: number; y: number; up: boolean; kb: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const place = (kb: boolean) => {
    const r = btn.current!.getBoundingClientRect();
    const width = 208;
    const up = r.bottom + 64 > window.innerHeight - 64;
    setOpen({ x: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), y: up ? r.top - 4 : r.bottom + 4, up, kb });
  };
  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    if (open) setOpen(null); else place(e.detail === 0);
  };
  const isOpen = Boolean(open);
  useLayoutEffect(() => {
    if (open?.kb) menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open?.kb, isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const close = () => setOpen(null);
    const away = (e: Event) => { if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(); };
    // the menu follows its button when something scrolls; it is fixed, so it takes no room either way
    const follow = () => place(false);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", close);
    };
  }, [isOpen]);

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!open) return;
    const all = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(null); btn.current?.focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus(); }
    else if (e.key === "Tab") setOpen(null);
  };

  return (
    <span className="rmenu" onKeyDown={onKey}>
      <button ref={btn} type="button" className="btn sm rmenu-b" aria-haspopup="menu" aria-expanded={Boolean(open)} aria-label={label} title={label} disabled={disabled} onClick={toggle}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div ref={menu} className="rmenu-m" role="menu" aria-label={label} onClick={(e) => e.stopPropagation()}
          style={{ left: open.x, top: open.up ? undefined : open.y, bottom: open.up ? window.innerHeight - open.y : undefined }}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className="rmenu-i" onClick={() => { setOpen(null); it.onSelect(); }}>{it.label}</button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
