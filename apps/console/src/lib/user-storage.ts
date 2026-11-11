/**
 * What the console keeps in the browser for the signed-in user: sessionStorage keys that start with `ao-` (drafts,
 * the one-shot notes between list and panel, the tree's width). It belongs to one user (security review 권고 1):
 *   - sign-out removes all of it (`clearUserStorage`), together with the session cookie (/auth/sign-out);
 *   - when another user turns up in the same tab, what the previous one left is removed before anything reads it
 *     (`claimStorageFor`). Drafts are keyed by user id as well (draft-store.ts), so they are never listed for
 *     someone else even if this did not run.
 * An expired session does not remove anything: the same user signs in again and finds their draft; a different user
 * triggers the removal above.
 */
const PREFIX = "ao-";
export const OWNER_KEY = "ao-user";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
function store(): Store | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

/** Removes every `ao-…` key of sessionStorage. Returns how many were removed. */
export function clearUserStorage(s: Store | null = store()): number {
  try {
    if (!s) return 0;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(PREFIX)) keys.push(k); }
    keys.forEach((k) => s.removeItem(k));
    return keys.length;
  } catch {
    return 0;
  }
}

/** Call with the signed-in user's id before reading anything. true = another user's data was found and removed. */
export function claimStorageFor(userId: string, s: Store | null = store()): boolean {
  try {
    if (!s) return false;
    const was = s.getItem(OWNER_KEY);
    if (was === userId) return false;
    // no owner on record (a tab from before this rule) counts as someone else's: nothing is inherited
    const removed = clearUserStorage(s);
    s.setItem(OWNER_KEY, userId);
    return was !== null || removed > 0;
  } catch {
    return false;
  }
}
