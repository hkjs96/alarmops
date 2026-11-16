// D-35: "Show number" in Responders (normal, emergency with a typed reason, auto re-mask) and the reveal review list.
// Customers: mirae (Haeun, ADMIN, is a Responder via the Infra core template), hanbit (Haeun is NOT a Responder; Minjae is).
import { test, expect, type Page } from "@playwright/test";
import { appReady } from "./helpers/ready";

const signIn = async (page: Page, next: string, as = "admin") => {
  await page.goto(`/auth/dev-login?as=${as}&next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
  await appReady(page);
};
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
const person = (page: Page, name: string) => page.getByTestId("co-responders").getByTestId("co-cust-person").filter({ hasText: name });
const FULL_PHONE = /^010-\d{4}-\d{4}$/;

test.describe("Show number, normal (the customer's own Responder)", () => {
  test("the value shows with 'logged', then Hide puts the masked text back; nothing is kept", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/c/mirae/call-order");
    const yuna = person(page, "Yuna Seo");
    await expect(yuna.getByTestId("co-masked")).toHaveText(/010-••••-\d{4}/);
    const show = yuna.getByTestId("reveal-phone-show");
    await expect(show).toHaveText("Show number");
    expect((await show.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await show.click();
    const value = yuna.getByTestId("reveal-phone-value");
    await expect(value).toHaveText(FULL_PHONE);
    const text = (await value.textContent())!;
    await expect(yuna.getByTestId("reveal-phone-note")).toContainText("Shown to you · logged");
    // the masked text stays, and the full value is nowhere but on screen: not in the address, not in storage, not in an attribute
    await expect(yuna.getByTestId("co-masked")).toHaveText(/010-••••-\d{4}/);
    expect(page.url()).not.toContain(text);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.cookie]))).not.toContain(text);
    expect(await page.locator(`[data-value*="${text}"], [title*="${text}"], [href*="${text}"]`).count()).toBe(0);
    await yuna.getByTestId("reveal-phone-hide").click();
    await expect(yuna.getByTestId("reveal-phone-value")).toHaveCount(0);
    await expect(yuna.getByTestId("reveal-phone-show")).toBeVisible();
    expect(await page.content()).not.toContain(text);
  });

  test("email works too, and the value goes back to masked after 30 seconds", async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/c/mirae/call-order");
    const yuna = person(page, "Yuna Seo");
    await yuna.getByTestId("reveal-email-show").click();
    await expect(yuna.getByTestId("reveal-email-value")).toHaveText("yuna.seo@mirae.example");
    await page.clock.fastForward(15_000);
    await expect(yuna.getByTestId("reveal-email-value")).toBeVisible();
    await page.clock.fastForward(16_000);
    await expect(yuna.getByTestId("reveal-email-value")).toHaveCount(0);
    await expect(yuna.getByTestId("reveal-email-show")).toBeVisible();
  });

  test("leaving the page masks it again", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/c/mirae/call-order");
    await person(page, "Yuna Seo").getByTestId("reveal-phone-show").click();
    await expect(page.getByTestId("reveal-phone-value")).toBeVisible();
    await page.getByRole("link", { name: "Incidents" }).first().click();
    await expect(page).toHaveURL(/\/incidents/);
    await page.goBack();
    await appReady(page);
    await expect(page.getByTestId("reveal-phone-value")).toHaveCount(0);
    await expect(person(page, "Yuna Seo").getByTestId("reveal-phone-show")).toBeVisible();
  });

  test("an Operator who is a Responder may; one who is not has no button; a Viewer never has one", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/c/hanbit/call-order", "operator");
    const hy = person(page, "Hyunwoo Ahn");
    await expect(hy.getByTestId("reveal-phone-show")).toHaveText("Show number");
    await hy.getByTestId("reveal-phone-show").click();
    await expect(hy.getByTestId("reveal-phone-value")).toHaveText(FULL_PHONE);
    await expect(hy.getByTestId("reveal-phone-note")).toContainText("Shown to you · logged");
    await signIn(page, "/c/lumen/call-order", "operator");
    await expect(page.getByTestId("co-cust-person").first()).toBeVisible();
    await expect(page.getByTestId("co-responders").getByRole("button", { name: /^Show (number|email)/ })).toHaveCount(0);
    await signIn(page, "/c/hanbit/call-order", "viewer");
    await expect(page.getByTestId("co-cust-person").first()).toBeVisible();
    await expect(page.getByTestId("co-responders").getByRole("button", { name: /^Show (number|email)/ })).toHaveCount(0);
  });
});

test.describe("Show number, emergency (an Admin who is not the customer's Responder)", () => {
  test("a typed reason is required; the value shows with the emergency line and the review list has the row", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/c/hanbit/call-order");
    const eunbi = person(page, "Eunbi Song");
    const show = eunbi.getByTestId("reveal-phone-show");
    await expect(show).toHaveText("Show number (emergency)…");
    await show.click();
    const dlg = page.getByTestId("confirm-dialog");
    await expect(dlg).toBeVisible();
    await expect(page.getByTestId("reveal-explain")).toContainText("You are not a responder for Hanbit");
    await expect(dlg).toContainText("primary responder will be notified");
    const go = dlg.locator('button[data-role="confirm"]');
    await expect(go).toBeDisabled();
    await page.getByTestId("reveal-reason").fill("   ");
    await expect(go, "spaces are not a reason").toBeDisabled();
    await page.getByTestId("reveal-reason").fill("E2E: page 4711 got no answer from the rotation");
    await expect(go).toBeEnabled();
    await go.click();
    await expect(dlg).toHaveCount(0);
    await expect(eunbi.getByTestId("reveal-phone-value")).toHaveText(FULL_PHONE);
    await expect(eunbi.getByTestId("reveal-phone-note")).toContainText("Emergency reveal · logged");
    await expect(eunbi.getByTestId("reveal-phone-note")).toContainText("primary responder notified");

    // Cancel does nothing: no value, no log
    await person(page, "Sungmin Yoon").getByTestId("reveal-email-show").click();
    await dlg.locator('button[data-role="cancel"]').click();
    await expect(dlg).toHaveCount(0);
    await expect(person(page, "Sungmin Yoon").getByTestId("reveal-email-value")).toHaveCount(0);

    await page.goto("/settings/audit-log");
    await appReady(page);
    const rows = page.getByTestId("reveal-row");
    await expect(rows.first()).toContainText("E2E: page 4711 got no answer from the rotation");
    await expect(rows.first()).toContainText("Haeun Kim");
    await expect(rows.first()).toContainText("Eunbi Song");
    await expect(rows.first()).toContainText("Hanbit");
    await expect(rows.first().getByTestId("rr-row-mode")).toHaveText("▲Emergency");
    await expect(rows.first()).toContainText("Junho Park");
    await expect(page.getByTestId("reveal-table")).not.toContainText(FULL_PHONE);
    for (const r of await rows.all()) await expect(r).toHaveAttribute("data-mode", "EMERGENCY");
    expect(await page.content()).not.toMatch(/010-\d{4}-\d{4}/);
  });
});

test.describe("review list", () => {
  test("filters: all reveals, by customer, by date; a Viewer is told the role; no sideways scroll at 390", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/settings/audit-log");
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    await expect(page.getByTestId("reveal-row").first()).toBeVisible();
    await page.goto("/settings/audit-log?mode=ALL");
    await expect(page.getByTestId("reveal-row").filter({ has: page.locator('[data-testid="rr-row-mode"]', { hasText: "Normal" }) }).first()).toBeVisible();
    await page.goto("/settings/audit-log?mode=ALL&customer=daon");
    await expect(page.getByTestId("reveal-row")).toHaveCount(1);
    await expect(page.getByTestId("reveal-row")).toContainText("Soyeon Choi");
    await page.goto("/settings/audit-log?mode=ALL&from=2026-11-07&to=2026-11-07");
    await expect(page.getByTestId("reveal-row")).toHaveCount(2);
    for (const r of await page.getByTestId("reveal-row").all()) await expect(r).toContainText("2026-11-07");
    await page.goto("/settings/audit-log?mode=ALL&customer=nope");
    await expect(page.getByText("Not found")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/audit-log?mode=ALL");
    await appReady(page);
    await expect(page.getByTestId("reveal-row").first()).toBeVisible();
    await noHScroll(page);
    expect((await page.locator("thead").first().boundingBox())!.width).toBeLessThanOrEqual(1); // the header row is for screen readers only; rows are cards
    for (const el of await page.locator("select, input, .btn").all()) if (await el.isVisible()) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);

    await signIn(page, "/settings/audit-log", "viewer");
    await expect(page.getByTestId("rr-error")).toContainText("needs the Operator role");
  });

  test("an Operator sees only the customers they are a Responder of", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/settings/audit-log?mode=ALL", "operator");
    await expect(page.getByTestId("reveal-row").first()).toBeVisible();
    // Minjae is a Responder of Mirae Pay, Daon and Hanbit (not of Lumen): the Admin's rows for those show, nothing else
    await expect(page.getByTestId("reveal-table")).not.toContainText("Lumen");
    await page.goto("/settings/audit-log?mode=ALL&customer=lumen");
    await expect(page.getByText("Not found")).toBeVisible();
  });
});
