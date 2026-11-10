// Screenshot script (not a test): node --experimental-strip-types e2e/call-order-shots.ts [outDir]
// Call order at 1440 / 1280 / 390: list, read, edit, confirm, guard. Output is gitignored (docs/qa/shots).
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://localhost:3107";
const out = process.argv[2] ?? "../../docs/qa/shots/console-call-order";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const [width, height] of [[1440, 900], [1280, 800], [390, 844]] as const) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page: Page = await ctx.newPage();
  const shot = (name: string, full = width === 390) => page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: full });
  await page.goto(base + "/auth/dev-login?next=/call-order", { waitUntil: "networkidle" });
  await shot("list");
  await page.goto(base + "/call-order?customer=daon", { waitUntil: "networkidle" });
  await shot("list-filtered");
  await page.goto(base + "/c/mirae/call-order?customer=mirae", { waitUntil: "networkidle" });
  await shot("read");
  await page.goto(base + "/c/hanbit/fulfilment/orders-api/call-order", { waitUntil: "networkidle" });
  await shot("read-own");
  await page.goto(base + "/c/mirae/core/checkout/call-order", { waitUntil: "networkidle" });
  await shot("read-inherited");
  await page.goto(base + "/c/lumen/call-order", { waitUntil: "networkidle" });
  await shot("read-at-risk");
  // edit (own steps, one service)
  await page.goto(base + "/c/hanbit/fulfilment/orders-api/call-order", { waitUntil: "networkidle" });
  await page.getByTestId("co-edit").click();
  await page.getByLabel("Step 2 minutes").fill("4");
  await shot("edit");
  // guard: leaving with unsaved changes
  await page.keyboard.press("Escape");
  await page.getByTestId("dirty-guard").waitFor();
  await page.screenshot({ path: `${out}/guard-${width}.png` });
  await page.getByTestId("dirty-guard").getByRole("button", { name: "Discard changes" }).click();
  // confirm: a customer-level save reaches several services
  await page.goto(base + "/c/mirae/call-order?customer=mirae", { waitUntil: "networkidle" });
  await page.getByTestId("co-edit").click();
  await page.getByLabel("Step 2 minutes").fill("12");
  await page.getByTestId("co-save").click();
  await page.getByTestId("confirm-dialog").waitFor();
  await page.screenshot({ path: `${out}/confirm-${width}.png` });
  await page.getByTestId("confirm-dialog").getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Escape");
  await page.getByTestId("dirty-guard").getByRole("button", { name: "Discard changes" }).click();
  // widen
  await page.goto(base + "/c/hanbit/fulfilment/orders-api/call-order", { waitUntil: "networkidle" });
  await page.getByTestId("co-edit").click();
  await page.getByRole("button", { name: "Edit the whole customer instead…" }).click();
  await page.screenshot({ path: `${out}/widen-${width}.png` });
  await ctx.close();
}
await browser.close();
