/**
 * The same-spot guard, one for the whole console. After an action that changes or removes a row (Acknowledge, Remove,
 * a confirmed dialog), a second pointer press at the same spot within SAME_SPOT_MS is a double tap, not a decision:
 * it does nothing — whatever happens to be under the pointer by then (the next row's button, an Undo, a Re-sort bar).
 * Keyboard activation (Enter / Space, `detail === 0`) is never held back.
 *
 * Use: `markSpot(e)` in the handler of the action; `installSameSpotGuard()` once (the shell does) swallows the
 * second press before any handler sees it. `isSameSpot(e)` is there for handlers that want to check themselves.
 *
 * The same rule for what an action brings up later (QA P2-N). 600 ms covers a double tap; a toast with Undo comes
 * when the server has answered and stays for seconds, and the "did it take?" tap comes 1–3 s after the first. So the
 * guard also remembers the control that was pressed (every `[data-list-action]`, and whatever `markSpot` was given):
 *   - `placeClearOfPress()` says where a message raised by that press may stand: its usual place at the bottom,
 *     or the top when the pressed control reaches into the band the message would occupy;
 *   - an element that carries `data-follows-press` (from `followsPressAttr()`) takes no pointer press inside the
 *     pressed control's box for as long as it is on the screen — the fallback where the two overlap anyway
 *     (a viewport too short to keep them apart).
 */
export const SAME_SPOT_MS = 600;
export const SAME_SPOT_PX = 24;

/** What a message raised by a press keeps clear of for this long (a toast lives 9 s). */
export const PRESS_FOLLOW_MS = 10_000;
/** A message at the bottom of the viewport may take this much of it (phone: bottom menu 56 + gap 8 + toast up to 96 + the home-indicator inset). */
export const BOTTOM_BAND_PX = 200;

interface Press { detail: number; clientX: number; clientY: number; currentTarget?: unknown; target?: unknown }
export interface PressBox { left: number; top: number; right: number; bottom: number }
/** the last pointer press on an action: when, where, and the box of the control that was pressed (touch slop not included) */
export interface ActionPress { t: number; x: number; y: number; box: PressBox }
let last: { t: number; x: number; y: number } | null = null;
let pressed: ActionPress | null = null;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const ACTION = "[data-list-action]";
const isElement = (v: unknown): v is Element => typeof Element !== "undefined" && v instanceof Element;

function notePress(e: Press, el: Element | null): void {
  if (e.detail <= 0) { pressed = null; return; }
  const r = el?.getBoundingClientRect();
  // a control without a box (not laid out) counts as the point that was pressed
  const box = r && (r.width > 0 || r.height > 0) ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY };
  pressed = { t: now(), x: e.clientX, y: e.clientY, box };
}

/** Remember where an action was pressed. A keyboard activation clears the mark (there is no spot). */
export function markSpot(e?: Press | null): void {
  last = e && e.detail > 0 ? { t: now(), x: e.clientX, y: e.clientY } : null;
  if (!e) { pressed = null; return; }
  const el = isElement(e.currentTarget) ? e.currentTarget : isElement(e.target) ? (e.target.closest(`${ACTION}, button, a, [role=menuitem]`) ?? e.target) : null;
  notePress(e, el);
}
/** true = a pointer press where an action was pressed a moment ago */
export function isSameSpot(e?: Press | null): boolean {
  return Boolean(e && last && e.detail > 0 && now() - last.t < SAME_SPOT_MS
    && Math.abs(e.clientX - last.x) <= SAME_SPOT_PX && Math.abs(e.clientY - last.y) <= SAME_SPOT_PX);
}
export function clearSpot(): void { last = null; pressed = null; }

/** The last pointer press on an action, while what it raised may still be on the screen; null after a keyboard activation. */
export function lastActionPress(maxAgeMs: number = PRESS_FOLLOW_MS): ActionPress | null {
  return pressed && now() - pressed.t < maxAgeMs ? pressed : null;
}
/** The pressed control's box with the touch slop around it. */
export function pressBox(press: ActionPress): PressBox {
  const b = press.box;
  return { left: b.left - SAME_SPOT_PX, top: b.top - SAME_SPOT_PX, right: b.right + SAME_SPOT_PX, bottom: b.bottom + SAME_SPOT_PX };
}
/**
 * Where a message raised by the last press stands: "bottom", its usual place, unless the pressed control (slop
 * included) reaches into the bottom `band` of the viewport — then "top". One rule for every width, and it does not
 * depend on how wide the text came out.
 */
export function placeClearOfPress(viewportHeight: number, press: ActionPress | null = lastActionPress(), band: number = BOTTOM_BAND_PX): "bottom" | "top" {
  return press && pressBox(press).bottom > viewportHeight - band ? "top" : "bottom";
}
/** Value for `data-follows-press` on what the press raised: the guard lets no pointer press through inside this box. */
export function followsPressAttr(press: ActionPress | null = lastActionPress()): string | undefined {
  if (!press) return undefined;
  const b = pressBox(press);
  return [b.left, b.top, b.right, b.bottom].map((v) => Math.round(v)).join(",");
}
function atFollowedPress(e: MouseEvent): boolean {
  if (e.detail <= 0 || !isElement(e.target)) return false;
  const raised = e.target.closest("[data-follows-press]");
  const v = raised?.getAttribute("data-follows-press")?.split(",").map(Number);
  if (!v || v.length !== 4 || v.some((n) => !Number.isFinite(n))) return false;
  return e.clientX >= v[0]! && e.clientX <= v[2]! && e.clientY >= v[1]! && e.clientY <= v[3]!;
}

let installed = false;
/** Document-level: the second press never reaches a button, a link or a row. Safe to call more than once. */
export function installSameSpotGuard(doc: Document = document): () => void {
  if (installed) return () => undefined;
  installed = true;
  const onClick = (e: MouseEvent) => {
    if (isSameSpot(e) || atFollowedPress(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // every action of a list is remembered, whether or not its handler marks the spot
    const action = isElement(e.target) ? e.target.closest(ACTION) : null;
    if (action && !action.matches(":disabled, [aria-disabled=true]")) notePress(e, action);
  };
  doc.addEventListener("click", onClick, true);
  return () => { installed = false; doc.removeEventListener("click", onClick, true); };
}
