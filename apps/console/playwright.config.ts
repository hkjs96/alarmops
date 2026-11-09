import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3107);
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/incidents`,
    reuseExistingServer: true,
    env: { MOCK_API: "1" },
    timeout: 120_000,
  },
});
