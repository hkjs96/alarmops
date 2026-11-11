/**
 * What happens when a tab outlives its session (signed out in another tab, or the 8 hours are over) — QA 최종 점검
 * P2-D, security 재검토 3 권고 1·4. One rule for the whole console:
 *
 *   - every server action is called through `callAction`. A session that is gone comes back as a failure with the code
 *     SESSION_ENDED — never as a promise that does not settle — so whatever said "Saving…" / "Removing…" /
 *     "Acknowledging…" stops saying it, and the shell puts up "Your session ended — sign in again. Nothing was
 *     changed." with a Sign in button that comes back to this address (components/SessionEnded.tsx).
 *     Nothing kept in the tab is removed for it: the same user signs in again and finds their draft.
 *   - signing out tells the other tabs of this browser (`broadcastSignOut`): they remove what they kept for the user
 *     (drafts) and show the same state, instead of looking signed in until the next click.
 *
 * No server-only import here: the middleware (edge) and the browser both use this file.
 */
import type { ActionFailure, ActionResult } from "./action-result";

/** the failure code, and the body of the middleware's 401 for a server action without a session */
export const SESSION_ENDED = "SESSION_ENDED";
/** the action was sent and nothing readable came back, with the session still there: applied or not is unknown */
export const NO_ANSWER = "NO_ANSWER";
export const SESSION_ENDED_TEXT = "Your session ended — sign in again. Nothing was changed.";
export const NO_ANSWER_TEXT = "No answer from the server, so it is not known whether this was applied. Reload to see how things are now.";
export const SESSION_ENDED_EVENT = "ao-session-ended";
export const AUTH_CHANNEL = "ao-auth";
/** localStorage: a time stamp, nothing about the user. Its `storage` event reaches tabs where BroadcastChannel is missing. */
export const SIGNED_OUT_KEY = "ao-signed-out";

/** "expired": the cookie is gone or no longer valid. "signed-out": the user pressed Sign out in another tab. */
export type EndReason = "expired" | "signed-out";
let ended: EndReason | null = null;
/** null while the tab is signed in as far as it knows */
export const sessionEndReason = (): EndReason | null => ended;
export function resetSessionEnded(): void { ended = null; }

export function announceSessionEnded(reason: EndReason = "expired"): void {
  // an explicit sign-out is the stronger statement (drafts were removed for it); the first reason stays otherwise
  if (ended !== "signed-out") ended = reason === "signed-out" ? reason : ended ?? reason;
  try { window.dispatchEvent(new Event(SESSION_ENDED_EVENT)); } catch { /* not in a browser */ }
}

const endedFailure = (): ActionFailure => ({ ok: false, code: SESSION_ENDED, message: SESSION_ENDED_TEXT, requestId: "" });

/** 401 from GET /auth/session = this tab has no session. Anything else (204, a network error) = cannot say so. */
export async function sessionGone(): Promise<boolean> {
  try { return (await fetch("/auth/session", { cache: "no-store", credentials: "same-origin" })).status === 401; } catch { return false; }
}

/**
 * The one way the page calls a server action: `await callAction(() => ackIncident(id, version))`.
 * Always settles with a result. A test (lib/session-ended.test.ts) fails when an action is called without it.
 */
export async function callAction<T>(send: () => Promise<ActionResult<T>>, probe: () => Promise<boolean> = sessionGone): Promise<ActionResult<T>> {
  // already known to be over: nothing is sent, the answer is the same
  if (ended) return endedFailure();
  let r: ActionResult<T> | undefined;
  try {
    r = await send();
  } catch (e) {
    // the middleware's 401 (body SESSION_ENDED), or — behind something that answers differently — whatever /auth/session says
    if ((e instanceof Error && e.message.trim() === SESSION_ENDED) || await probe()) { announceSessionEnded("expired"); return endedFailure(); }
    return { ok: false, code: NO_ANSWER, message: NO_ANSWER_TEXT, requestId: "" };
  }
  if (!r || typeof r !== "object") {
    if (await probe()) { announceSessionEnded("expired"); return endedFailure(); }
    return { ok: false, code: NO_ANSWER, message: NO_ANSWER_TEXT, requestId: "" };
  }
  // the action itself found no session (requireSession), or the API refused the session's token
  if (!r.ok && (r.code === "UNAUTHORIZED" || r.code === "UNAUTHENTICATED")) { announceSessionEnded("expired"); return endedFailure(); }
  return r;
}

/** Sign-out, said to the other tabs of this browser. Never throws: signing out does not depend on it. */
export function broadcastSignOut(): void {
  try {
    const c = new BroadcastChannel(AUTH_CHANNEL);
    c.postMessage({ type: "signed-out" });
    c.close();
  } catch { /* no BroadcastChannel: the storage event below does it */ }
  try { window.localStorage.setItem(SIGNED_OUT_KEY, String(Date.now())); } catch { /* storage refused */ }
}

/** Calls `cb` when another tab signed out. Returns the function that stops listening. */
export function onOtherTabSignOut(cb: () => void): () => void {
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(AUTH_CHANNEL);
    channel.onmessage = (e: MessageEvent) => { if ((e.data as { type?: unknown } | null)?.type === "signed-out") cb(); };
  } catch { channel = null; }
  const onStorage = (e: StorageEvent) => { if (e.key === SIGNED_OUT_KEY && e.newValue) cb(); };
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener("storage", onStorage); try { channel?.close(); } catch { /* closed */ } };
}
