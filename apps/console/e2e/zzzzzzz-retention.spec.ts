// D-45 / D-46 / D-43: legal hold, export window, deletion record, digest badge, Escalate now on a suspended customer.
// Runs last (file name): the escalate test suspends a customer that has an open incident, which stays marked.
import { test, expect, type Page } from "@playwright/test";
import { appReady } from "./helpers/ready";

const signIn = async (page: Page, next: string, as = "admin") => {
  await page.goto(`/auth/dev-login?as=${as}&next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
  await appReady(page);
};
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
const dialog = (page: Page) => page.getByTestId("confirm-dialog");
const confirmBtn = (page: Page) => dialog(page).locator('button[data-role="confirm"]');

test("legal hold: place needs a reason, shows who/when/why, release asks first", async ({ page }) => {
  await signIn(page, "/customers/iruda");
  const card = page.getByTestId("legal-hold");
  await expect(card).toHaveAttribute("data-active", "0");
  await expect(page.getByTestId("hold-explain")).toContainText("automatic deletion of this customer's data is paused");
  await page.getByTestId("hold-place").click();
  await expect(confirmBtn(page), "a reason is required").toBeDisabled();
  await page.getByTestId("hold-reason").fill("Dispute over invoice 1042");
  await confirmBtn(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(card).toHaveAttribute("data-active", "1");
  await expect(page.getByTestId("hold-state")).toContainText("On hold");
  await expect(page.getByTestId("hold-detail")).toContainText("Dispute over invoice 1042");
  await expect(page.getByTestId("hold-detail")).toContainText("usr_haeun");
  await expect(page.getByTestId("purge-schedule")).toContainText("Paused by the legal hold");
  await expect(page.locator('[data-testid="purge-row"][data-stage="LEGAL_HOLD_SET"]')).toHaveCount(1);

  await page.waitForTimeout(700);
  await page.getByTestId("hold-release").click();
  await expect(page.getByTestId("hold-confirm-text")).toContainText("daily retention job will delete");
  await page.waitForTimeout(700);
  await confirmBtn(page).click();
  await expect(card).toHaveAttribute("data-active", "0");
  await expect(page.locator('[data-testid="purge-row"][data-stage="LEGAL_HOLD_RELEASED"]')).toHaveCount(1);
  await noHScroll(page);
});

test("export: terminated customer inside the window downloads the CSV; deadline shown; active customer has no export card", async ({ page }) => {
  await signIn(page, "/customers/iruda");
  await expect(page.getByTestId("export-deadline")).toHaveText("2026-12-06");
  await expect(page.getByTestId("export-btn")).toBeEnabled();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-btn").click()]);
  expect(dl.suggestedFilename()).toMatch(/^incidents-cus_iruda-.*\.csv$/);
  const path = await dl.path();
  const text = (await import("node:fs")).readFileSync(path!, "utf8");
  expect(text).toContain("number,id,title,severity");
  expect(text).toContain("lms-web-1");
  await page.goto("/customers/mirae");
  await appReady(page);
  await expect(page.getByTestId("export-card")).toHaveCount(0);
});

test("deletion record: stage, counts, time and who, as cards on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "/customers/iruda");
  const row = page.locator('[data-testid="purge-row"][data-stage="CONNECTIONS"]');
  await expect(row).toContainText("Connection details deleted");
  await expect(row).toContainText("37 resources");
  await expect(row).toContainText("System (daily job)");
  await expect(row.locator("td").first()).toHaveCSS("display", "block");
  await noHScroll(page);
});

test("non-admin sees the role reason instead of retention controls", async ({ page }) => {
  await signIn(page, "/customers/iruda", "operator");
  await expect(page.getByTestId("retention-role")).toContainText("need the Admin role");
  await expect(page.getByTestId("hold-place")).toHaveCount(0);
});

test("digest badge: one number, opens the list, fits on a phone", async ({ page }) => {
  await signIn(page, "/incidents");
  const badge = page.getByTestId("digest-badge");
  await expect(badge).toHaveAttribute("aria-label", "Business-hours summary: 2");
  await expect(badge).toContainText("Business-hours summary: 2");
  await badge.click();
  await expect(page.getByTestId("digest-suspended")).toContainText("Eden Mobility");
  await expect(page.getByTestId("digest-residuals")).toContainText("Iruda Edu");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("digest-panel")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("2");
  await noHScroll(page);
  expect((await badge.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("Escalate now on an incident of a suspended customer is off and says nobody will be paged", async ({ page }) => {
  // earlier specs may have resolved or acknowledged one of these: suspend all three and use the first that is still open
  const open = [
    ["mirae", "/c/mirae/core/payments-api/incident/inc-7f3a0c91b2d4-20261108181204"],
    ["hanbit", "/c/hanbit/tracking/public-api/incident/inc-a1b5e2c07d33-20261108180512"],
    ["daon", "/c/daon/platform/eks-prod/incident/inc-0d9c71f4e8a2-20261108181401"],
  ] as const;
  for (const [slug] of open) {
    await signIn(page, `/customers/${slug}`);
    if ((await page.getByTestId("customer-status").getAttribute("data-status")) !== "ACTIVE") continue;
    await page.getByTestId("cs-change").click();
    await page.getByTestId("cs-suspend").click();
    await page.getByTestId("cs-reason").fill("Invoice overdue");
    await confirmBtn(page).click();
    await expect(page.getByTestId("customer-status")).toHaveAttribute("data-status", "SUSPENDED");
  }
  let found = false;
  for (const [, url] of open) {
    await page.goto(url);
    await appReady(page);
    if (await page.getByRole("button", { name: "Escalate now" }).count()) {
      await expect(page.getByRole("button", { name: "Escalate now" }).first()).toBeDisabled();
      await expect(page.getByTestId("escalate-why")).toContainText("nobody will be paged");
      found = true;
      break;
    }
  }
  expect(found, "one of the three open incidents is still open").toBe(true);
});
