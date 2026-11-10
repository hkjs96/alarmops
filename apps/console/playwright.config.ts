import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3107);
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // one mock store is shared by the server: tests that acknowledge must not race the ones that count
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: true,
    env: { MOCK_API: "1", E2E_ALLOW_MOCK: "1" },
    timeout: 120_000,
  },
});
