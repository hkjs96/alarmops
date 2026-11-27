// Responder templates (API-CONTRACT §8.3, D-64): create, edit + preview + save, attach on a customer, read-only for others, 390px.
// Customers of the mock that this spec changes: eden (attach Night backup). Templates: Infra core (add Dohyun), Weekend desk (new).
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
const rowOf = (page: Page, name: string) => page.getByTestId("tpl-row").filter({ hasText: name });

test.describe("templates, ADMIN", () => {
  test("create a template", async ({ page }) => {
    await signIn(page, "/call-order/templates");
    await expect(page.getByRole("heading", { name: "Call order" })).toBeVisible();
    await page.getByTestId("tpl-new").click();
    await page.getByTestId("tpl-create").click();
    await expect(page.getByText("Enter a name.")).toBeVisible();
    await page.getByTestId("tpl-new-name").fill("Weekend desk");
    await page.getByTestId("tpl-add-select").selectOption({ label: "Taemin Jung · Data engineer" });
    await page.getByTestId("tpl-add").click();
    await page.getByTestId("tpl-create").click();
    await expect(page.getByTestId("tpl-result")).toContainText("Created “Weekend desk” with 1 person.");
    await expect(rowOf(page, "Weekend desk")).toBeVisible();
    // the same name again is refused with what to do
    await page.getByTestId("tpl-new").click();
    await page.getByTestId("tpl-new-name").fill("Weekend desk");
    await page.getByTestId("tpl-add-select").selectOption({ label: "Eunji Kwon · Data engineer" });
    await page.getByTestId("tpl-add").click();
    await page.getByTestId("tpl-create").click();
    await expect(page.getByTestId("tpl-create-error")).toContainText("Choose a different name.");
  });

  test("edit, see what it does to each customer, confirm, save", async ({ page }) => {
    await signIn(page, "/call-order/templates");
    await rowOf(page, "Infra core").getByTestId("tpl-open").click();
    await page.getByTestId("tpl-edit").click();
    await expect(page.getByTestId("tpl-save")).toBeDisabled();
    await expect(page.getByTestId("tpl-save-why")).toHaveText("Nothing has changed yet.");
    await page.getByTestId("tpl-add-select").selectOption({ label: "Dohyun Kang · Joined Nov 3" });
    await page.getByTestId("tpl-add").click();
    await expect(page.getByTestId("tpl-affects")).toContainText("This change affects");
    await expect(page.getByTestId("tpl-fx-customer").filter({ hasText: "Ara Games" })).toContainText("Dohyun Kang joins Responders");
    await expect(page.getByTestId("tpl-fx-customer").filter({ hasText: "Mirae Pay" })).toContainText("Dohyun Kang joins Responders");
    const save = page.getByTestId("tpl-save");
    await expect(save).toBeEnabled();
    await expect(save).toHaveText(/^Save template for \d+ customers$/);
    await save.click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId("tpl-dialog-customers")).toContainText("Ara Games");
    await confirmBtn(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("tpl-result")).toContainText("Saved “Infra core” for");
    await expect(page.getByTestId("tpl-undo")).toBeVisible();
    await expect(page.getByTestId("tpl-members")).toContainText("Dohyun Kang");
  });

  test("attach a template on a customer: effects first, then confirm", async ({ page }) => {
    await signIn(page, "/c/eden/call-order");
    const card = page.getByTestId("co-template");
    await expect(card).toContainText("Template: none");
    await card.getByTestId("co-template-change").click();
    await page.getByTestId("co-template-select").selectOption({ label: "Night backup · 2 people" });
    await expect(page.getByTestId("co-template-effects")).toContainText("Sora Yoon joins Responders");
    await expect(page.getByTestId("co-template-effects")).toContainText("Jiwoo Han is already in Responders (added directly) — no change");
    await expect(confirmBtn(page)).toHaveText("Attach Night backup");
    await confirmBtn(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("co-template-name")).toHaveText("Night backup");
    await expect(page.getByTestId("co-staff").filter({ hasText: "Sora Yoon" })).toContainText("from Night backup");
    await expect(page.getByTestId("co-staff").filter({ hasText: "Jiwoo Han" })).toContainText("added directly");
  });
});

test.describe("templates, not admin", () => {
  test("an operator reads, with the reason, and cannot change the template of a customer", async ({ page }) => {
    await signIn(page, "/call-order/templates", "operator");
    await expect(page.getByTestId("tpl-new")).toHaveCount(0);
    await rowOf(page, "Data desk").getByTestId("tpl-open").click();
    await expect(page.getByTestId("tpl-why")).toContainText("Changing a template needs the Admin role. You are signed in as Operator.");
    await expect(page.getByTestId("tpl-edit")).toHaveCount(0);
    await page.goto("/c/eden/call-order");
    await expect(page.getByTestId("co-template-change")).toBeDisabled();
  });
});

test("390px: the list is cards and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page, "/call-order/templates");
  await rowOf(page, "Infra core").getByTestId("tpl-open").click();
  await noHScroll(page);
  await page.getByTestId("tpl-edit").click();
  await noHScroll(page);
  const box = await page.getByTestId("tpl-save").boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
