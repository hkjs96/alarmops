import { broadcastSignOut } from "./session-ended";
import { clearUserStorage } from "./user-storage";

/**
 * Signs out, now: what the console kept in this tab for the user goes first (drafts and the other `ao-…` keys), then
 * the session cookie (POST /auth/sign-out, which answers with a redirect to /login).
 *
 * The form is made here and attached to the document itself. It does not belong to the account menu or to any other
 * piece of the screen that may be gone by the time this runs — the menu closes as soon as something outside it is
 * pressed, a dialog's button for one (QA 재점검 P2-A: the POST was never sent).
 *
 * The other tabs of this browser are told (security 재검토 3 권고 4): they remove their own drafts and show
 * "signed out" instead of a console that only looks signed in. A session that is already gone changes nothing here:
 * /auth/sign-out needs no session and still ends on /login.
 */
export function signOutNow(doc: Document = document): void {
  clearUserStorage();
  broadcastSignOut();
  const form = doc.createElement("form");
  form.method = "post";
  form.action = "/auth/sign-out";
  form.hidden = true;
  form.setAttribute("data-sign-out", "");
  doc.body.appendChild(form);
  form.submit();
}
