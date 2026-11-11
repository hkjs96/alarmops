/**
 * Two one-shot notes between the list and the panel, kept in sessionStorage because the edit state is never in the
 * address (shell-scope §7: a link always opens the read view).
 */
const EDIT = "ao-co-edit";
export const FOCUS_ROW = "ao-focus-row";

export interface EditIntent { scope: string; widenedFrom?: string }
export function setEditIntent(i: EditIntent): void {
  try { sessionStorage.setItem(EDIT, JSON.stringify(i)); } catch { /* the panel opens in the read view */ }
}
/** Returns the intent if it is for this scope, and forgets it either way. */
export function takeEditIntent(scope: string): EditIntent | null {
  try {
    const raw = sessionStorage.getItem(EDIT);
    if (!raw) return null;
    sessionStorage.removeItem(EDIT);
    const i = JSON.parse(raw) as EditIntent;
    return i && i.scope === scope && (i.widenedFrom === undefined || typeof i.widenedFrom === "string") ? i : null;
  } catch {
    return null;
  }
}
export function setFocusRow(key: string): void {
  try { sessionStorage.setItem(FOCUS_ROW, key); } catch { /* focus goes to the page instead */ }
}
export function takeFocusRow(): string | null {
  try { const v = sessionStorage.getItem(FOCUS_ROW); if (v) sessionStorage.removeItem(FOCUS_ROW); return v; } catch { return null; }
}

/**
 * Browser Back cannot be refused: by the time the page hears of it the address has changed and the router is already
 * leaving. The editor steps forward again and leaves this note, so the panel that comes back knows it has to ask
 * (Save / Keep draft / Discard) instead of quietly showing the read view.
 */
const BACK = "ao-co-back";
const BACK_TTL_MS = 3000;
export function setBackGuard(scope: string, now = Date.now()): void {
  try { sessionStorage.setItem(BACK, `${now}|${scope}`); } catch { /* the draft is still kept; only the question is lost */ }
}
/**
 * True once, for this scope, and only right after the Back it was left for. A panel of another scope leaves the note
 * alone (Back from one panel to another shows that other panel for a moment before the step forward).
 */
export function takeBackGuard(scope: string, now = Date.now()): boolean {
  try {
    const v = sessionStorage.getItem(BACK);
    if (v === null) return false;
    const i = v.indexOf("|");
    const at = Number(v.slice(0, i));
    const fresh = now - at >= 0 && now - at < BACK_TTL_MS;
    if (!fresh) { sessionStorage.removeItem(BACK); return false; }
    if (v.slice(i + 1) !== scope) return false;
    sessionStorage.removeItem(BACK);
    return true;
  } catch {
    return false;
  }
}
