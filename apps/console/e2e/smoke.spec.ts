import { test, expect, type Page } from "@playwright/test";

const PAY = "/incidents/inc-7f3a0c91b2d4-20261108181204";
const PAGES = ["/incidents", PAY, "/design", "/login", "/monitoring/alarms", "/oncall/now", "/customers", "/settings/msp-defaults"];

const signIn = (page: Page, next = "/incidents") => page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);

test("sessionless request redirects to /login", async ({ page }) => {
  await page.goto("/incidents");
  await expect(page).toHaveURL(/\/login\?next=%2Fincidents/);
  await expect(page.locator("main h1")).toHaveText("Sign in");
});

test("dev sign-in issues an httpOnly session cookie", async ({ page, context }) => {
  await signIn(page, PAY);
  await expect(page).toHaveURL(new RegExp(PAY));
  const c = (await context.cookies()).find((x) => x.name === "ao_session");
  expect(c?.httpOnly).toBe(true);
});

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.(googleapis|gstatic)\.com/.test(m.location().url)) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

for (const path of PAGES) {
  test(`renders ${path} without console errors`, async ({ page }) => {
    const errors = watchErrors(page);
    const res = await signIn(page, path);
    expect(res?.status()).toBeLessThan(400);
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });
}

test("incidents list shows mockup data", async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId("incident-row")).toHaveCount(6);
  await expect(page.getByText("payments-db-1 FreeStorageSpace below 10 GB")).toBeVisible();
});

test("no horizontal scroll at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  for (const p of ["/incidents", PAY]) {
    await page.goto(p);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, p).toBeLessThanOrEqual(0);
  }
});

test("unknown incident shows Not found", async ({ page }) => {
  await signIn(page, "/incidents/does-not-exist");
  await expect(page.getByText("Not found")).toBeVisible();
});
