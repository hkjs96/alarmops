import "server-only";
import { createHttpApi, type ConsoleApi } from "./client";
import { createMockApi, createStore } from "./mock/mock-api";
import { MOCK_NOW } from "./mock/fixtures";
import { apiBaseUrl, mockMode } from "../mode";
import { requireSession } from "../auth";

const g = globalThis as unknown as { __aoMockStore?: ReturnType<typeof createStore> };

// C-1: fail at module load if mock mode is switched on in production.
mockMode();

export const isMock = () => mockMode();

/**
 * Server-side API accessor. Requires a session; forwards it as the user's token (C-2).
 * MOCK_API=1 → in-memory fixtures (non-production only); otherwise HTTP to API_BASE_URL (required, C-3).
 */
export async function getApi(): Promise<ConsoleApi> {
  const session = await requireSession();
  if (isMock()) {
    g.__aoMockStore ??= createStore();
    return createMockApi(g.__aoMockStore);
  }
  return createHttpApi({ baseUrl: apiBaseUrl(), headers: () => ({ authorization: `Bearer ${session.token}` }) });
}

/** "Now" used for relative times. Frozen in mock mode so the screens match the mockup. */
export function nowMs(): number {
  return isMock() ? Date.parse(MOCK_NOW) : Date.now();
}
