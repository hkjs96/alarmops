// Screenshot script (not a test): node --experimental-strip-types e2e/scope-shots.ts [outDir]
// Incidents at 1440 / 1024 / 390: list, filtered, panel. Output is gitignored (docs/qa/shots).
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://localhost:3107";
const out = process.argv[2] ?? "../../docs/qa/shots/console-scope";
mkdirSync(out, { recursive: true });
const PANEL = "/c/mirae/core/payments-api/incident/inc-7f3a0c91b2d4-20261108181204";
const shots: [string, string][] = [
  ["list", "/incidents"],
  ["filtered", "/incidents?customer=mirae&project=core"],
  ["filtered-my", "/incidents?mine=1"],
  ["panel", PANEL],
  ["panel-filtered", PANEL + "?customer=mirae&project=core"],
];

const browser = await chromium.launch();
for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]] as const) {
    if (theme === "dark" && width === 1024) continue;
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    const page = await ctx.newPage();
    await page.goto(base + "/auth/dev-login?next=/incidents", { waitUntil: "networkidle" });
    for (const [name, path] of shots) {
      await page.goto(base + path, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/incidents-${name}-${width}${theme === "dark" ? "-dark" : ""}.png`, fullPage: width === 390 });
    }
    if (theme === "light" && width === 390) {
      await page.goto(base + "/incidents", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /^Showing/ }).click();
      await page.screenshot({ path: `${out}/sheet-1-customer-390.png` });
      await page.getByTestId("sheet-customer").filter({ hasText: "Daon Retail" }).click();
      await page.screenshot({ path: `${out}/sheet-2-project-390.png` });
      await page.getByTestId("sheet-project").filter({ hasText: "Commerce" }).click();
      await page.screenshot({ path: `${out}/sheet-3-service-390.png` });
    }
    await ctx.close();
  }
}
await browser.close();
