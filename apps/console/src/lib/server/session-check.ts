import "server-only";
import { mockMode } from "../mode";
import { SESSION_COOKIE, sessionSecret, verifySession } from "../auth/session";
import { authForSession } from "./backend";

/**
 * Is the session of this cookie still a session? The cookie must verify AND, against the real API, its user must
 * still resolve to a principal (sessionPrincipal: ACTIVE user, ACTIVE customer for a portal user, consistent contact
 * link). "unknown" = the store did not answer: the caller must not call that "signed out".
 * Mock mode has no user status: a valid cookie is a session.
 */
export async function sessionState(cookie: string | undefined): Promise<"signed-in" | "signed-out" | "unknown"> {
  let mock = false;
  try { mock = mockMode(); } catch { mock = false; }
  const s = await verifySession(cookie, sessionSecret(process.env, mock));
  if (!s) return "signed-out";
  if (mock) return "signed-in";
  try {
    return (await authForSession(s.sub)) ? "signed-in" : "signed-out";
  } catch {
    return "unknown";
  }
}

export { SESSION_COOKIE };
