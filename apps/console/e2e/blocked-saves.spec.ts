// Template changes the server refuses (#178 item 1; D-64, D-38): WOULD_BE_UNREACHABLE (409) and RESPONDER_LIMIT_EXCEEDED (422), seen from the
// Responders card. These cannot happen on the default fixture, so this spec runs on its own server with E2E_FIXTURE=blocked-saves
// (playwright.config.ts, project "blocked-saves"). Customer: Quill Labs, see src/lib/api/mock/e2e-fixtures.ts. The last test saves, so it is last.
import { test, expect, type Page } from "@playwright/test";
import { appReady } from "./helpers/ready";

const signIn = async (page: Page, next: string) => {
  await page.goto(`/auth/dev-login?as=admin&next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
  await appReady(page);
};
const dialog = (page: Page) => page.getByTestId("confirm-dialog");
const confirmBtn = (page: Page) => dialog(page).locator('button[data-role="confirm"]');
const open = async (page: Page) => {
  await signIn(page, "/c/quill/call-order");
  await expect(page.getByTestId("co-template-name")).toHaveText("Verified desk");
  await page.getByTestId("co-template-change").click();
};

test("detaching the only verified person is blocked: nobody could be called (WOULD_BE_UNREACHABLE)", async ({ page }) => {
  await open(page);
  await page.getByTestId("co-template-select").selectOption({ label: "No template" });
  const box = page.getByTestId("co-template-blocked");
  await expect(box).toContainText("Can’t save: this would break 1 customer");
  await expect(box.locator('[data-reason="UNREACHABLE"]')).toHaveText("Quill Labs: nobody could be called after this change.");
  await expect(box).toContainText("There is no way around this.");
  await expect(confirmBtn(page)).toHaveText("Detach Verified desk");
  await expect(confirmBtn(page)).toBeDisabled();
});

test("a template of 21 people is blocked: more than 20 would be called at once (RESPONDER_LIMIT_EXCEEDED, D-38)", async ({ page }) => {
  await open(page);
  await page.getByTestId("co-template-select").selectOption({ label: "Wide bench · 21 people" });
  const box = page.getByTestId("co-template-blocked");
  await expect(box).toContainText("Can’t save: this would break 1 customer");
  await expect(box.locator('[data-reason="RESPONDER_LIMIT_EXCEEDED"]')).toHaveText("Quill Labs: a step that calls everyone in Responders would reach more than 20 people.");
  await expect(confirmBtn(page)).toBeDisabled();
});

test("a blocked change leaves the customer as it was", async ({ page }) => {
  await open(page);
  await page.getByTestId("co-template-select").selectOption({ label: "No template" });
  await expect(page.getByTestId("co-template-blocked")).toBeVisible();
  await dialog(page).locator('button[data-role="cancel"]').click();
  await expect(page.getByTestId("co-template-name")).toHaveText("Verified desk");
});

test("inactive staff are skipped: named in the preview and again after the save", async ({ page }) => {
  await open(page);
  await page.getByTestId("co-template-select").selectOption({ label: "Desk with leavers · 3 people" });
  await expect(page.getByTestId("co-template-skipped")).toHaveText("Skipped (inactive): Alder Inactive, Birch Inactive — they won't be added.");
  await expect(page.getByTestId("co-template-blocked")).toHaveCount(0);
  await confirmBtn(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("co-template-name")).toHaveText("Desk with leavers");
  await expect(page.getByTestId("toast")).toContainText("Skipped (inactive): Alder Inactive, Birch Inactive — not added.");
  await expect(page.getByTestId("co-staff").filter({ hasText: "Inactive" })).toHaveCount(0);
});
