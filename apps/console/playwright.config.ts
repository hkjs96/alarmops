import { defineConfig } from "@playwright/test";

// PORT: 3107 by default; set another one when 3107 is taken by a server that is not yours.
const PORT = Number(process.env.PORT ?? 3107);
// A server left on the port has a mock store that earlier runs already changed, and unrelated tests fail on it
// (QA 재점검 P3-E). In CI, or with PW_NO_REUSE=1, the run starts its own server and fails if the port is taken.
const REUSE = !(process.env.CI || process.env.PW_NO_REUSE === "1");
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // one mock store is shared by the server: tests that acknowledge must not race the ones that count
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    // Safari has no scroll anchoring: the no-row-shift rule is run there as well when WebKit is installed
    // (`npx playwright install webkit`, then PW_WEBKIT=1). Only the spec that measures rows without scroll anchoring.
    ...(process.env.PW_WEBKIT === "1" ? [{ name: "webkit", use: { browserName: "webkit" as const }, testMatch: /zzzz-no-anchor\.spec\.ts$/ }] : []),
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: REUSE,
    env: { MOCK_API: "1", E2E_ALLOW_MOCK: "1" },
    timeout: 120_000,
  },
});
