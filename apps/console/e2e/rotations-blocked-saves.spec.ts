// Rotation saves the server refuses or cannot do now (API-CONTRACT §8.3: PREVIEW_STALE, 503 BUSY, DELETE), seen from Call order › Rotations.
// They cannot happen on the default fixture, so this spec runs on its own server with E2E_FIXTURE=blocked-saves (playwright.config.ts,
// project "blocked-saves"; its pattern matches this file). The variant adds three shared rotations (src/lib/api/mock/e2e-fixtures.ts):
//  - Stale desk: after its first preview a request for cover comes in, so the first save is refused PREVIEW_STALE. Its shift now is Junho Park's.
//  - Busy desk:  the first save is answered 503 BUSY twice (the console sends it again once, and the second answer reaches the screen).
//  - Spare desk: rot_e2e_spare, used by no call order, can be deleted.
import { test, expect, type Page } from "@playwright/test";
import { appReady } from "./helpers/ready";

const signIn = async (page: Page, next: string) => {
  await page.goto(`/auth/dev-login?as=admin&next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
  await appReady(page);
};
const PATH = "/call-order/rotations";
const dialog = (page: Page) => page.getByTestId("confirm-dialog");
const confirmBtn = (page: Page) => dialog(page).locator('button[data-role="confirm"]');
const members = (page: Page) => page.getByTestId("rot-member");
const order = async (page: Page) => (await members(page).allInnerTexts()).map((t) => t.split("\n")[0]!.replace(/\s*(on shift|now).*$/i, "").trim());
const open = async (page: Page, name: string) => {
  await signIn(page, PATH);
  await page.getByTestId("rot-segment").getByText(name, { exact: true }).click();
  await expect(page.getByTestId("rot-order")).toContainText(name);
};
const swap23 = async (page: Page) => {
  await page.getByRole("button", { name: "Edit members & order" }).click();
  await members(page).nth(1).getByRole("button", { name: /^Move .* down$/ }).click();
  await expect(page.getByTestId("rot-next-shift")).toBeVisible();
};

test("Stale desk: a request for cover after the preview refuses the save, the screen looks again by itself, and the next save works", async ({ page }) => {
  await open(page, "Stale desk");
  await swap23(page);
  await page.getByTestId("rot-save").click();
  await confirmBtn(page).click();
  await expect(page.getByTestId("rot-error")).toContainText(/Nothing was changed/);
  await expect(page.getByTestId("rot-error")).toContainText(/preview/i);
  // looked at again, by itself: the shift with the request for cover is kept, and Next stays with the person who has it now.
  // (judged on the next shift's own row: the row of the shift now is Kept in every preview and proves nothing)
  await expect(page.getByTestId("rot-next-shift-row")).toContainText("Kept");
  await expect(page.getByTestId("rot-next-shift")).toHaveText("Junho Park → Junho Park");
  await expect(page.getByTestId("rot-save")).toBeEnabled();
  await page.getByTestId("rot-save").click();
  await confirmBtn(page).click();
  await expect(page.getByTestId("rot-result")).toBeVisible();
  await expect(page.getByTestId("rot-error")).toHaveCount(0);
});

test("Busy desk: the first save says BUSY and saves nothing; the second save works", async ({ page }) => {
  await open(page, "Busy desk");
  const before = await order(page);
  await swap23(page);
  await page.getByTestId("rot-save").click();
  await confirmBtn(page).click();
  await expect(page.getByTestId("rot-error")).toContainText(/busy/i);
  await expect(page.getByTestId("rot-error")).toContainText(/Nothing was changed/);
  await page.reload();
  await appReady(page);
  await page.getByTestId("rot-segment").getByText("Busy desk", { exact: true }).click();
  expect(await order(page)).toEqual(before);
  await expect(page.getByTestId("rot-order")).toHaveAttribute("data-version", "1");
  await swap23(page);
  await page.getByTestId("rot-save").click();
  await confirmBtn(page).click();
  await expect(page.getByTestId("rot-result")).toBeVisible();
  await expect(page.getByTestId("rot-error")).toHaveCount(0);
  await expect(page.getByTestId("rot-order")).toHaveAttribute("data-version", "2");
});

test("Spare desk is deleted: nothing uses it", async ({ page }) => {
  await open(page, "Spare desk");
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(dialog(page)).toBeVisible();
  await confirmBtn(page).click();
  await expect(page.getByTestId("rot-segment")).not.toContainText("Spare desk");
  await page.reload();
  await appReady(page);
  await expect(page.getByTestId("rot-segment")).not.toContainText("Spare desk");
});
