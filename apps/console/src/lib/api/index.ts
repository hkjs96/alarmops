import "server-only";
import { createHttpApi, type ConsoleApi } from "./client";
import { MOCK_USERS, createMockApi, createStore } from "./mock/mock-api";
import { MOCK_NOW } from "./mock/fixtures";
import { mockMode } from "../mode";
import { authForSession, inProcessFetch } from "../server/backend";
import { requireSession } from "../auth";

const g = globalThis as unknown as { __aoMockStore?: ReturnType<typeof createStore> };

// C-1: fail at module load if mock mode is switched on in production.
mockMode();

export const isMock = () => mockMode();

/**
 * Server-side API accessor. Requires a session; forwards it as the user's token (C-2).
 * MOCK_API=1 → in-memory fixtures (non-production only). Otherwise the real API (packages/api on the SQL store) in
 * this same process, through the same typed HTTP client the browser-facing `/api/v1/*` route uses: the request never
 * leaves the server, and the AuthContext is built here from the session's user id (D-09, never from the client).
 */
export async function getApi(): Promise<ConsoleApi> {
  const session = await requireSession();
  if (isMock()) {
    g.__aoMockStore ??= createStore({ customers: process.env.MOCK_CUSTOMERS === "34" ? 34 : 14 });
    // who the mock answers as comes from the session, like the real API reads the token
    return createMockApi(g.__aoMockStore, undefined, MOCK_USERS[session.sub] ?? { id: session.sub, contactId: "", name: session.name, email: session.email, role: "VIEWER" });
  }
  let auth: ReturnType<typeof authForSession> | undefined;
  return createHttpApi({ baseUrl: "http://in-process.invalid", fetch: inProcessFetch(() => (auth ??= authForSession(session.sub))) });
}

/** "Now" used for relative times. Frozen in mock mode so the screens match the mockup. */
export function nowMs(): number {
  return isMock() ? Date.parse(MOCK_NOW) : Date.now();
}
