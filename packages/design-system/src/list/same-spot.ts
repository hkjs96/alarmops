/**
 * The same-spot guard, one for the whole console. After an action that changes or removes a row (Acknowledge, Remove,
 * a confirmed dialog), a second pointer press at the same spot within SAME_SPOT_MS is a double tap, not a decision:
 * it does nothing — whatever happens to be under the pointer by then (the next row's button, an Undo, a Re-sort bar).
 * Keyboard activation (Enter / Space, `detail === 0`) is never held back.
 *
 * Use: `markSpot(e)` in the handler of the action; `installSameSpotGuard()` once (the shell does) swallows the
 * second press before any handler sees it. `isSameSpot(e)` is there for handlers that want to check themselves.
 */
export const SAME_SPOT_MS = 600;
export const SAME_SPOT_PX = 24;

interface Press { detail: number; clientX: number; clientY: number }
let last: { t: number; x: number; y: number } | null = null;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Remember where an action was pressed. A keyboard activation clears the mark (there is no spot). */
export function markSpot(e?: Press | null): void {
  last = e && e.detail > 0 ? { t: now(), x: e.clientX, y: e.clientY } : null;
}
/** true = a pointer press where an action was pressed a moment ago */
export function isSameSpot(e?: Press | null): boolean {
  return Boolean(e && last && e.detail > 0 && now() - last.t < SAME_SPOT_MS
    && Math.abs(e.clientX - last.x) <= SAME_SPOT_PX && Math.abs(e.clientY - last.y) <= SAME_SPOT_PX);
}
export function clearSpot(): void { last = null; }

let installed = false;
/** Document-level: the second press never reaches a button, a link or a row. Safe to call more than once. */
export function installSameSpotGuard(doc: Document = document): () => void {
  if (installed) return () => undefined;
  installed = true;
  const onClick = (e: MouseEvent) => {
    if (!isSameSpot(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  doc.addEventListener("click", onClick, true);
  return () => { installed = false; doc.removeEventListener("click", onClick, true); };
}
