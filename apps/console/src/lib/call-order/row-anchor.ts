/**
 * Keep the row you were looking at (#172, decision 11/27 "보던 행 고정").
 *
 * When the Call order panel closes the list widens and its rows lay out again (a row can wrap onto fewer lines), and the
 * scroll offset stays what it was — so the row under the user's eyes moves. Before the panel leaves, the panel notes
 * which row that was and where it sits in the viewport (`holdRow`); once the list has its new layout the list scrolls
 * by exactly the difference (`settleRow`). The anchor is the row that was edited while it is on screen, otherwise the
 * topmost row that is on screen.
 *
 * The correction is an instant jump, never smooth (prefers-reduced-motion is respected by not animating at all), and it
 * stops the moment the user scrolls, touches or presses a key. It moves no focus: focus return is the list's own effect.
 */
export interface RowAnchor { key: string; top: number }
export interface RowBox { key: string; top: number; bottom: number }

/** the row to hold: `preferKey` while any part of it is in view, else the topmost row in view; null when no row is in view */
export function pickAnchor(rows: RowBox[], viewH: number, preferKey?: string): RowAnchor | null {
  const vis = rows.filter((r) => r.key && r.bottom > 0 && r.top < viewH);
  const pick = vis.find((r) => r.key === preferKey) ?? [...vis].sort((a, b) => a.top - b.top)[0];
  return pick ? { key: pick.key, top: pick.top } : null;
}

/** how far to scroll (positive = down) so the row is back at the anchored viewport position; 0 inside the tolerance */
export function correction(anchor: RowAnchor, topNow: number, tolerance = 0.5): number {
  const d = topNow - anchor.top;
  return Math.abs(d) <= tolerance ? 0 : d;
}

const ROWS = "tr[data-row-key]";
let held: RowAnchor | null = null;

const boxes = (root: ParentNode): RowBox[] => [...root.querySelectorAll<HTMLElement>(ROWS)]
  .filter((e) => e.getClientRects().length > 0)
  .map((e) => { const b = e.getBoundingClientRect(); return { key: e.dataset.rowKey ?? "", top: b.top, bottom: b.bottom }; });

/** the nearest ancestor that scrolls on its own (the list column on desktop), else null: the window scrolls */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Called by the panel right before it asks the router to leave. Replaces any earlier note. */
export function holdRow(preferKey: string, root: ParentNode = document): void {
  const a = pickAnchor(boxes(root), window.innerHeight, preferKey);
  held = a && isScrolled(a.key, root) ? a : null;
}

/**
 * Nothing to hold while the view is at the top: the list just goes back to where it starts. Holding a row there would
 * scroll the page away from its top only because the panel's layout above the list differs from the list's own (#172 CI:
 * every row 156 px up after a save, with nothing scrolled). Only a view the user has scrolled has a place worth keeping.
 */
function isScrolled(key: string, root: ParentNode): boolean {
  const el = [...root.querySelectorAll<HTMLElement>(ROWS)].find((e) => e.dataset.rowKey === key && e.getClientRects().length > 0);
  if (!el) return false;
  const sp = scrollParent(el);
  return (sp ? sp.scrollTop : window.scrollY) > 0.5;
}

/** Scrolls so the held row is back at its place. Returns true while the row was found. */
export function restoreRow(anchor: RowAnchor, root: ParentNode = document): boolean {
  const el = [...root.querySelectorAll<HTMLElement>(ROWS)].find((e) => e.dataset.rowKey === anchor.key && e.getClientRects().length > 0);
  if (!el) return false;
  const d = correction(anchor, el.getBoundingClientRect().top);
  if (d === 0) return true;
  const sp = scrollParent(el);
  // behavior "instant" overrides any `scroll-behavior: smooth`: a correction is not an animation
  if (sp) sp.scrollTo({ top: sp.scrollTop + d, behavior: "instant" });
  else window.scrollBy({ top: d, behavior: "instant" });
  return true;
}

export function takeHeldRow(): RowAnchor | null {
  const a = held;
  held = null;
  return a;
}

/**
 * After the panel is gone: correct now (before paint), then every frame while the page settles (the shell animates its
 * columns for 180 ms; the list arrives from the server), for at most `ms`. Returns a function that stops it.
 */
export function settleRow(anchor: RowAnchor, ms = 600, root: ParentNode = document): () => void {
  let stopped = false;
  let raf = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    for (const ev of INPUTS) window.removeEventListener(ev, stop, true);
  };
  for (const ev of INPUTS) window.addEventListener(ev, stop, { capture: true, passive: true });
  const t0 = performance.now();
  restoreRow(anchor, root);
  const tick = () => {
    if (stopped) return;
    restoreRow(anchor, root);
    if (performance.now() - t0 >= ms) { stop(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return stop;
}
const INPUTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
