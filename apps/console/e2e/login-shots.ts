// Login-flow persona capture (not a test): node --experimental-strip-types e2e/login-shots.ts <outDir>
import { chromium } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://localhost:3107";
const out = process.argv[2] ?? "../../docs/qa/shots/console";
const PAY = "/incidents/inc-7f3a0c91b2d4-20261108181204";

const browser = await chromium.launch();
for (const width of [390, 1440]) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 960 } });
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + PAY, { waitUntil: "networkidle" });
  const loginUrl = page.url();
  await page.screenshot({ path: `${out}/login-${width}.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const controls = await page.locator("main a, main button, main input").evaluateAll((els) =>
    els.map((e) => { const r = e.getBoundingClientRect(); return `${e.tagName}:${(e.textContent ?? "").trim()}:${Math.round(r.width)}x${Math.round(r.height)}`; }));
  const mainText = (await page.locator("main").innerText()).replace(/\n+/g, " | ");
  const t0 = Date.now();
  const target = page.locator("main a:not([aria-disabled=true]), main button:not([disabled])").first();
  await target.click();
  await page.waitForLoadState("networkidle");
  const ms = Date.now() - t0;
  await page.screenshot({ path: `${out}/login-landed-${width}.png` });
  console.log(JSON.stringify({ width, loginUrl, mainText, controls, overflow, landed: page.url(), h1: await page.locator("main h1").first().innerText(), ms, errors }, null, 1));
  await page.close();
}
await browser.close();
