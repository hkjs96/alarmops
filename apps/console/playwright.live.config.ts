import { defineConfig } from "@playwright/test";

/**
 * Project `live`: the console with MOCK_API unset — packages/api on the SQL store — against a real Postgres.
 * LIVE_DATABASE_URL = a LOCAL server's admin URL (CI: the postgres:16 service; locally e.g. /opt/pglocal binaries).
 * e2e-live/prepare.mjs creates a fresh database `alarmops_live` from the migrations + db seed before the server starts.
 * Without LIVE_DATABASE_URL no server is started and every test is skipped with that reason.
 *
 * `next dev` on purpose: the dev sign-in of the live mode exists only when NODE_ENV is not production
 * (lib/mode.ts liveDevLogin), and `next start` always runs as production.
 */
const PORT = Number(process.env.LIVE_PORT ?? 3117);
const DB = process.env.LIVE_DATABASE_URL;
const appUrl = (() => { if (!DB) return ""; const u = new URL(DB); u.pathname = "/alarmops_live"; return u.toString(); })();

export default defineConfig({
  testDir: "./e2e-live",
  timeout: 120_000,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{ name: "live", use: { browserName: "chromium" } }],
  webServer: DB ? {
    command: `node e2e-live/prepare.mjs && npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      MOCK_API: "", NODE_ENV: "development", LIVE_DEV_LOGIN: "1", DATABASE_URL: appUrl, LIVE_DATABASE_URL: DB,
      SESSION_SECRET: "live-e2e-only-session-secret-0123456789abcdef", TICK_SECRET: "live-e2e-only-tick-secret-0123456789abcdef",
      NEXT_DIST_DIR: ".next-live",
    },
    stdout: "pipe",
  } : undefined,
});
