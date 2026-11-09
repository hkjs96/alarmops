// Screenshot script (not a test): node --experimental-strip-types e2e/shots.ts <outDir>
import { chromium } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://localhost:3107";
const out = process.argv[2] ?? "../../docs/qa/shots/console";
const PAY = "/incidents/inc-7f3a0c91b2d4-20261108181204";
const shots: [string, string][] = [["incidents", "/incidents"], ["incident", PAY]];

const browser = await chromium.launch();
for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 960 }, colorScheme: theme });
    for (const [name, path] of shots) {
      await page.goto(base + path, { waitUntil: "networkidle" });
      await page.screenshot({ path: `${out}/${name}-${width}${theme === "dark" ? "-dark" : ""}.png`, fullPage: true });
    }
    await page.close();
  }
}
await browser.close();
