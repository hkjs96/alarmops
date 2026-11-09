import "server-only";
import { createHttpApi, type ConsoleApi } from "./client";
import { createMockApi, createStore } from "./mock/mock-api";
import { MOCK_NOW } from "./mock/fixtures";

const g = globalThis as unknown as { __aoMockStore?: ReturnType<typeof createStore> };

export const isMock = () => process.env.MOCK_API === "1";

/** Server-side API accessor. MOCK_API=1 → in-memory fixtures; otherwise HTTP to API_BASE_URL. */
export function getApi(): ConsoleApi {
  if (isMock()) {
    g.__aoMockStore ??= createStore();
    return createMockApi(g.__aoMockStore);
  }
  return createHttpApi({ baseUrl: process.env.API_BASE_URL ?? "http://localhost:3107" });
}

/** "Now" used for relative times. Frozen in mock mode so the screens match the mockup. */
export function nowMs(): number {
  return isMock() ? Date.parse(MOCK_NOW) : Date.now();
}
