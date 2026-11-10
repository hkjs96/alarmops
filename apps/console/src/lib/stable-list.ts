/**
 * A list that never moves rows under the pointer.
 *
 * The order on screen is fixed when the list is first shown and changes only when the user asks: the Re-sort / Show
 * button, a tab, filter or search change (a new `key`), or leaving the screen. Whatever arrives meanwhile — the
 * user's own Acknowledge, Undo or Resolve, or a server refresh — is applied in place:
 *   - a row that changed keeps its position and shows its new state;
 *   - a row that no longer belongs to the list stays where it was, marked `gone`;
 *   - a row that is new is not inserted; it is counted and announced.
 * QA P1-1 and P1-A were both "the next incident's Acknowledge slid under the pointer"; this removes the class.
 */
export interface StableRow<T> { item: T; gone: boolean }
export interface StableView<T> {
  key: string;
  /** the server list this view was last merged with */
  src: readonly T[];
  rows: StableRow<T>[];
  /** status of each row when the order was last sorted */
  base: Record<string, string>;
  /** in the server list, not on screen yet */
  fresh: T[];
}
type Row = { id: string; status: string };

export function startView<T extends Row>(items: readonly T[], key: string): StableView<T> {
  return { key, src: items, rows: items.map((item) => ({ item, gone: false })), base: Object.fromEntries(items.map((i) => [i.id, i.status])), fresh: [] };
}

export function mergeView<T extends Row>(view: StableView<T>, items: readonly T[]): StableView<T> {
  if (view.rows.length === 0) return startView(items, view.key); // nothing on screen: nothing can move
  const byId = new Map(items.map((i) => [i.id, i]));
  const shown = new Set(view.rows.map((r) => r.item.id));
  return {
    ...view,
    src: items,
    rows: view.rows.map((r) => { const now = byId.get(r.item.id); return now ? { item: now, gone: false } : { item: r.item, gone: true }; }),
    fresh: items.filter((i) => !shown.has(i.id)),
  };
}

export interface Pending { acknowledged: number; reopened: number; changed: number; gone: number; fresh: number; reordered: boolean; any: boolean }

export function pendingOf<T extends Row>(view: StableView<T>): Pending {
  let acknowledged = 0, reopened = 0, changed = 0, gone = 0;
  for (const r of view.rows) {
    const was = view.base[r.item.id];
    if (r.gone) gone++;
    else if (r.item.status === was) continue;
    else if (r.item.status === "ACKNOWLEDGED") acknowledged++;
    else if (r.item.status === "TRIGGERED") reopened++;
    else changed++;
  }
  const onScreen = view.rows.filter((r) => !r.gone).map((r) => r.item.id);
  const shown = new Set(onScreen);
  const server = view.src.filter((i) => shown.has(i.id)).map((i) => i.id);
  const reordered = onScreen.some((id, n) => id !== server[n]);
  const fresh = view.fresh.length;
  return { acknowledged, reopened, changed, gone, fresh, reordered, any: reordered || gone > 0 || fresh > 0 };
}

/** "2 acknowledged in place · 3 new" and the button that applies the server's list. */
export function pendingText(p: Pending): { text: string; button: string } | null {
  if (!p.any) return null;
  const parts = [
    p.acknowledged ? `${p.acknowledged} acknowledged in place` : "",
    p.reopened ? `${p.reopened} reopened in place` : "",
    p.changed ? `${p.changed} changed in place` : "",
    p.gone ? `${p.gone} no longer in this list` : "",
    p.fresh ? `${p.fresh} new` : "",
  ].filter(Boolean);
  const moves = p.reordered || p.gone > 0;
  return { text: parts.join(" · ") || "Order changed", button: p.fresh ? (moves ? "Show and re-sort" : "Show") : "Re-sort" };
}
