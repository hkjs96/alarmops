import { test, expect, type Page } from "@playwright/test";

const OLD_PAY = "/incidents/inc-7f3a0c91b2d4-20261108181204";
const PAY = "/c/mirae/core/payments-api/incident/inc-7f3a0c91b2d4-20261108181204";
const PAGES = ["/incidents", PAY, "/design", "/login", "/monitoring/alarms", "/call-order", "/people", "/maintenance", "/oncall/now", "/customers", "/settings/msp-defaults"];

const signIn = (page: Page, next = "/incidents") => page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);

test("sessionless request redirects to /login", async ({ page }) => {
  await page.goto("/incidents");
  await expect(page).toHaveURL(/\/login\?next=%2Fincidents/);
  await expect(page.locator("main h1")).toHaveText("Sign in");
});

test("dev sign-in issues an httpOnly session cookie", async ({ page, context }) => {
  await signIn(page, PAY);
  await expect(page).toHaveURL(new RegExp(PAY + "$"));
  const c = (await context.cookies()).find((x) => x.name === "ao_session");
  expect(c?.httpOnly).toBe(true);
});

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
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
  await expect(page.getByTestId("incident-row")).toHaveCount(7);
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

test("/login?ended=1: the signed-out notice, no horizontal scroll at 390px, light and dark", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/login?ended=1");
    await expect(page.getByTestId("login-ended")).toHaveText("You were signed out. If you can't sign back in, contact your administrator.");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, scheme).toBeLessThanOrEqual(0);
  }
  await page.goto("/login");
  await expect(page.getByTestId("login-ended")).toHaveCount(0);
});

test("/auth/ended?from=layout with a live session: a plain page, no redirect loop, 44px controls at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const res = await page.goto("/auth/ended?from=layout");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/\/auth\/ended\?from=layout$/);
  await expect(page.locator("h1")).toHaveText("Something went wrong — try again");
  for (const el of [page.getByRole("link", { name: "Try again" }), page.getByRole("button", { name: "Sign out" })]) {
    const box = await el.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("unknown incident shows Not found", async ({ page }) => {
  await signIn(page, "/incidents/does-not-exist");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});

test("the old incident address redirects to the one panel path", async ({ page }) => {
  await signIn(page, OLD_PAY);
  await expect(page).toHaveURL(new RegExp(PAY + "$"));
  await expect(page.getByTestId("panel-path")).toHaveText("Mirae Pay›Core›Payments API");
});

test("panel and filter addresses are behind the session too", async ({ page }) => {
  await page.goto(PAY + "?customer=mirae");
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByTestId("panel")).toHaveCount(0);
});
