import { test, expect, type Page } from "@playwright/test";

const PAY = "/incidents/inc-7f3a0c91b2d4-20261108181204";
const PAGES = ["/incidents", PAY, "/design", "/login", "/monitoring/alarms", "/oncall/now", "/customers", "/settings/msp-defaults"];

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.(googleapis|gstatic)\.com/.test(m.location().url)) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

for (const path of PAGES) {
  test(`renders ${path} without console errors`, async ({ page }) => {
    const errors = watchErrors(page);
    const res = await page.goto(path);
    expect(res?.status()).toBeLessThan(400);
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });
}

test("incidents list shows mockup data", async ({ page }) => {
  await page.goto("/incidents");
  await expect(page.getByTestId("incident-row")).toHaveCount(6);
  await expect(page.getByText("payments-db-1 FreeStorageSpace below 10 GB")).toBeVisible();
});

test("no horizontal scroll at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ["/incidents", PAY]) {
    await page.goto(p);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, p).toBeLessThanOrEqual(0);
  }
});

test("unknown incident shows Not found", async ({ page }) => {
  await page.goto("/incidents/does-not-exist");
  await expect(page.getByText("Not found")).toBeVisible();
});
