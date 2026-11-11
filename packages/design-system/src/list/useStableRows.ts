"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { mergeView, pendingOf, pendingText, startView, type FreshMode, type StableItem, type StableRow, type StableView } from "./stable-list";
import { isSameSpot } from "./same-spot";

export interface StableRows<T> {
  view: StableView<T>;
  rows: StableRow<T>[];
  /** what is waiting ("2 acknowledged in place · 3 new") and the label of the button that applies it; null when nothing waits */
  pending: { text: string; button: string } | null;
  /** the explicit refresh: sort again / show what waits / drop the tombstones. A press that lands on it by accident (same spot, or the bar just appeared) does nothing. */
  resort: (e?: { detail: number; clientX: number; clientY: number }) => void;
}

/**
 * The on-screen rows of a list (lib: ./stable-list). Rows keep their place whatever the server sends; a row that left
 * stays as `gone` (the list renders it as a tombstone); new rows wait ("wait") or go after the last row ("append").
 * The order is taken again only when `listKey` changes (filter, tab, another customer) or `resort()` is called.
 * `keep` holds the view across remounts of the list (list ↔ panel): pass a ref that lives in the shell.
 */
export function useStableRows<T extends StableItem>(items: readonly T[], listKey: string, opts: { fresh?: FreshMode; keep?: { current: unknown } } = {}): StableRows<T> {
  const fresh = opts.fresh ?? "wait";
  const keep = opts.keep;
  const [stored, setView] = useState<StableView<T>>(() => {
    const kept = keep?.current as StableView<T> | null | undefined;
    return kept && kept.key === listKey ? mergeView(kept, items, fresh) : startView(items, listKey);
  });
  let view = stored;
  if (view.key !== listKey) view = startView(items, listKey);
  else if (view.src !== items) view = mergeView(view, items, fresh);
  if (view !== stored) setView(view);
  useEffect(() => { if (keep) keep.current = view; }, [keep, view]);

  const pending = pendingText(pendingOf(view));
  const has = Boolean(pending);
  const shownAt = useRef(0);
  useEffect(() => { if (has) shownAt.current = performance.now(); }, [has]);
  const resort = useCallback((e?: { detail: number; clientX: number; clientY: number }) => {
    // the bar may have come up under a second tap
    if (e && e.detail > 0 && (isSameSpot(e) || performance.now() - shownAt.current < 600)) return;
    setView(startView(items, listKey));
  }, [items, listKey]);
  return { view, rows: view.rows, pending, resort };
}
