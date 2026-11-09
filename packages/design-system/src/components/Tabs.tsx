"use client";
import { useId, useState, type ReactNode, type KeyboardEvent } from "react";

export interface TabItem {
  id: string;
  label: ReactNode;
  count?: number;
  content: ReactNode;
}

/** Underline tabs (no segmented pills). Keyboard: Left/Right arrows. */
export function Tabs({ items, initial, label }: { items: TabItem[]; initial?: string; label: string }) {
  const [active, setActive] = useState(initial ?? items[0]?.id);
  const base = useId();
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = items[(i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length]!;
    setActive(next.id);
    document.getElementById(`${base}-t-${next.id}`)?.focus();
  };
  return (
    <div>
      <div className="tabs" role="tablist" aria-label={label} style={{ padding: "0 8px" }}>
        {items.map((t, i) => (
          <button
            key={t.id}
            id={`${base}-t-${t.id}`}
            role="tab"
            type="button"
            aria-selected={active === t.id}
            aria-controls={`${base}-p-${t.id}`}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => setActive(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
            {t.count != null ? <span className="n">{t.count}</span> : null}
          </button>
        ))}
      </div>
      {items.map((t) => (
        <div key={t.id} id={`${base}-p-${t.id}`} role="tabpanel" aria-labelledby={`${base}-t-${t.id}`} hidden={active !== t.id}>
          {t.content}
        </div>
      ))}
    </div>
  );
}
