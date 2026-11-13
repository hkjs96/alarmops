// D-43: customer status (suspend, resume, terminate), the offboarding checklist, and the "Not paged" marker.
// Customers of the mock that these tests own (status-mock.ts): gaon (suspend/resume), haneul (terminate), dasol (503 on
// terminate), cheong (read as non-admin), iruda (terminated, checklist), eden (suspended, has a not-paged incident).
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
const status = (page: Page) => page.getByTestId("customer-status");

test.describe("customer status, ADMIN", () => {
  test("suspend with a reason, then resume", async ({ page }) => {
    await signIn(page, "/customers/gaon");
    await expect(status(page)).toHaveAttribute("data-status", "ACTIVE");
    await page.getByTestId("cs-change").click();
    await page.getByTestId("cs-suspend").click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId("cs-explain")).toContainText("Alarms from this customer are recorded but nobody is paged (customer contacts and MSP staff). A business-hours summary is sent instead.");
    await expect(confirmBtn(page), "a reason is required").toBeDisabled();
    await page.getByTestId("cs-reason").fill("Invoice 60 days overdue");
    await expect(confirmBtn(page)).toBeEnabled();
    await confirmBtn(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(status(page)).toHaveAttribute("data-status", "SUSPENDED");
    await expect(page.getByTestId("customer-status-badge").first()).toHaveText("Suspended");
    await expect(page.getByTestId("status-changed-at")).toContainText("Status changed 2026-");
    await expect(page.getByTestId("toast")).toContainText("suspended");

    await page.getByTestId("cs-change").click();
    await expect(page.getByTestId("cs-suspend")).toHaveCount(0);
    await page.getByTestId("cs-resume").click();
    await expect(page.getByTestId("cs-explain")).toContainText("Incidents from the suspended period will not be paged");
    await page.getByTestId("cs-reason").fill("Paid");
    await page.waitForTimeout(700); // the same-spot guard: a second press at the spot just pressed (600 ms) is ignored, as it should be
    await confirmBtn(page).click();
    await expect(status(page)).toHaveAttribute("data-status", "ACTIVE");
    await expect(page.getByTestId("customer-status-badge").first()).toHaveText("Active");
  });

  test("the Customers list and the tree show the SUSPENDED and TERMINATED badges", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/customers");
    const item = (slug: string) => page.locator(`[data-testid="customer-item"][data-slug="${slug}"] [data-testid="customer-status-badge"]`);
    await expect(item("eden")).toHaveText("Suspended");
    await expect(item("iruda")).toHaveText("Terminated");
    await expect(item("mirae")).toHaveText("Active");
    // the tree: shape-free tag with the word, for the two customers that are not active (the tree may keep "Other customers" collapsed)
    const group = page.getByRole("treeitem", { name: /Other customers/ });
    if (await group.count() && (await group.first().getAttribute("aria-expanded")) === "false") await group.first().click();
    await expect(page.getByRole("treeitem", { name: /Eden Mobility/ }).getByTestId("tree-status")).toHaveText("Suspended");
    await expect(page.getByRole("treeitem", { name: /Iruda Edu/ }).getByTestId("tree-status")).toHaveText("Terminated");
    await expect(page.getByRole("treeitem", { name: /Mirae Pay/ }).getByTestId("tree-status")).toHaveCount(0);
  });

  test("terminate: a wrong name keeps the button off, the right name turns it on; the checklist appears", async ({ page }) => {
    await signIn(page, "/customers/haneul");
    await page.getByTestId("cs-change").click();
    await page.getByTestId("cs-terminate").click();
    const text = page.getByTestId("cs-explain");
    await expect(dialog(page).getByTestId("confirm-warning")).toContainText("This cannot be undone");
    for (const t of ["Paging stops now", "alarms AlarmOps manages", "remove the connection stack", "deleted 30 days after termination"]) await expect(text).toContainText(t);
    await page.getByTestId("cs-reason").fill("Contract ended");
    await expect(confirmBtn(page), "reason alone is not enough").toBeDisabled();
    await page.getByTestId("cs-confirm-name").fill("Haneul");
    await expect(page.getByTestId("cs-name-hint")).toContainText("does not match");
    await expect(confirmBtn(page)).toBeDisabled();
    await page.getByTestId("cs-confirm-name").fill("Haneul Air");
    await expect(page.getByTestId("cs-name-hint")).toContainText("matches");
    await expect(confirmBtn(page)).toBeEnabled();
    await confirmBtn(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(status(page)).toHaveAttribute("data-status", "TERMINATED");
    const off = page.getByTestId("offboarding");
    await expect(off).toBeVisible();
    await expect(off.locator("[data-testid^=ob-step-]")).toHaveCount(5);
    await expect(page.getByTestId("ob-step-PAGING_STOPPED")).toHaveAttribute("data-state", "DONE");
    await expect(page.getByTestId("ob-step-ALARMS_DELETED")).toHaveAttribute("data-state", "PENDING");
    await expect(page.getByTestId("ob-mark-ALARMS_DELETED"), "a pending, automatic step cannot be marked by hand").toHaveCount(0);
    await expect(page.getByTestId("ob-step-CUSTOMER_STACK_REMOVED")).toHaveAttribute("data-state", "MANUAL");
    await expect(page.getByTestId("cs-change"), "terminated is final").toBeDisabled();
    await expect(page.getByTestId("cs-why")).toContainText("cannot change status");
  });

  test("terminate when the command queue is not available: 503 says nothing was changed", async ({ page }) => {
    await signIn(page, "/customers/dasol");
    await page.getByTestId("cs-change").click();
    await page.getByTestId("cs-terminate").click();
    await page.getByTestId("cs-reason").fill("Contract ended");
    await page.getByTestId("cs-confirm-name").fill("Dasol Health");
    await confirmBtn(page).click();
    await expect(page.getByTestId("cs-err")).toContainText("was not terminated");
    await expect(page.getByTestId("cs-err")).not.toContainText("alarm-commands");
    await expect(page.getByTestId("cs-err")).toContainText("Nothing was changed");
    await expect(dialog(page), "the dialog stays so it can be tried again").toBeVisible();
    await dialog(page).locator('button[data-role="cancel"]').click();
    await expect(status(page)).toHaveAttribute("data-status", "ACTIVE");
    await expect(page.getByTestId("offboarding")).toHaveCount(0);
  });

  test("a status changed by someone else: 409 asks for a reload, then the change can be made", async ({ page, browser }) => {
    await signIn(page, "/customers/jeil");
    await page.getByTestId("cs-change").click();
    await page.getByTestId("cs-suspend").click();
    await page.getByTestId("cs-reason").fill("Invoice overdue");
    // another admin suspends the same customer first
    const other = await browser.newContext({ baseURL: `http://localhost:${process.env.PORT ?? 3107}` });
    const op = await other.newPage();
    await signIn(op, "/customers/jeil");
    await op.getByTestId("cs-change").click();
    await op.getByTestId("cs-suspend").click();
    await op.getByTestId("cs-reason").fill("Other admin");
    await op.locator('[data-testid="confirm-dialog"] button[data-role="confirm"]').click();
    await expect(op.getByTestId("customer-status")).toHaveAttribute("data-status", "SUSPENDED");
    await other.close();

    await confirmBtn(page).click();
    await expect(page.getByTestId("cs-err")).toContainText("Someone else changed this");
    await page.getByTestId("cs-reload").click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(status(page)).toHaveAttribute("data-status", "SUSPENDED");
  });
});

for (const as of ["operator", "viewer"]) {
  test(`${as}: Change status is off, with the reason`, async ({ page }) => {
    await signIn(page, "/customers/cheong", as);
    await expect(page.getByTestId("cs-change")).toBeDisabled();
    await expect(page.getByTestId("cs-why")).toContainText("needs the Admin role");
    await expect(page.getByTestId("cs-why")).toContainText(as === "operator" ? "Operator" : "Viewer");
    await expect(page.getByTestId("customer-status-badge").first()).toHaveText("Active");
  });
}

test("a portal user sees the badge but none of the staff controls", async ({ page }) => {
  await signIn(page, "/customers/mirae", "portal");
  await expect(page.getByTestId("customer-status-badge").first()).toBeVisible();
  await expect(page.getByTestId("cs-change")).toHaveCount(0);
  await expect(page.getByText("needs the Admin role")).toHaveCount(0);
  await expect(page.getByText("not shown to your role")).toHaveCount(0);
});

test("Esc closes the dialog and the focus goes back to Change status", async ({ page }) => {
  await signIn(page, "/customers/ara");
  await page.getByTestId("cs-change").click();
  await page.getByTestId("cs-suspend").click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("cs-change")).toBeFocused();
});

test("a non-admin still sees the badge and no checklist of a terminated customer", async ({ page }) => {
  await signIn(page, "/customers/iruda", "operator");
  await expect(page.getByTestId("customer-status-badge").first()).toHaveText("Terminated");
  await expect(page.getByTestId("cs-change")).toBeDisabled();
  await expect(page.getByTestId("offboarding")).toHaveCount(0);
});

test.describe("offboarding checklist (iruda)", () => {
  test("residual events are called out; MANUAL steps are marked done by an admin, ALARMS_DELETED needs a note", async ({ page }) => {
    await signIn(page, "/customers/iruda");
    await expect(page.getByTestId("customer-status-badge").first()).toHaveText("Terminated");
    await expect(page.getByTestId("ob-cleanup")).toContainText("Cleanup needed");
    await expect(page.getByTestId("ob-cleanup")).toContainText("Events still arriving from this customer: 4, last at 2026-11-09 02:40:00 KST");
    await expect(page.getByTestId("ob-progress")).toHaveText("2 of 5 done");
    await expect(page.getByTestId("ob-detail")).toContainText("This account has no AlarmWriter role");
    await expect(page.getByTestId("ob-detail")).toContainText("CAPABILITY_DISABLED");
    await expect(page.getByTestId("ob-retention")).toContainText("deleted on 2026-12-06");

    // a step without a note requirement
    await page.getByTestId("ob-mark-CUSTOMER_STACK_REMOVED").click();
    await expect(confirmBtn(page)).toBeEnabled();
    await confirmBtn(page).click();
    await expect(page.getByTestId("ob-step-CUSTOMER_STACK_REMOVED")).toHaveAttribute("data-state", "DONE");
    await expect(page.getByTestId("ob-progress")).toHaveText("3 of 5 done");

    // ALARMS_DELETED: the note is enforced in the dialog
    await page.getByTestId("ob-mark-ALARMS_DELETED").click();
    await expect(confirmBtn(page)).toBeDisabled();
    await page.getByTestId("ob-note").fill("   ");
    await expect(confirmBtn(page), "spaces are not a note").toBeDisabled();
    await page.getByTestId("ob-note").fill("Checked the CloudWatch console of 481220935017: no AlarmOps alarms left.");
    await expect(confirmBtn(page)).toBeEnabled();
    await confirmBtn(page).click();
    await expect(page.getByTestId("ob-step-ALARMS_DELETED")).toHaveAttribute("data-state", "DONE");
    await expect(page.getByTestId("ob-step-ALARMS_DELETED")).toContainText("no AlarmOps alarms left");
    await expect(page.getByTestId("ob-progress")).toHaveText("4 of 5 done");
    await expect(page.getByTestId("ob-mark-ALARMS_DELETED")).toHaveCount(0);
  });

  test("at 390 px the checklist and the status page have no horizontal scroll and 44 px controls", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "/customers/iruda");
    await noHScroll(page);
    const btn = page.getByTestId("ob-mark-BUS_ALLOWLIST_REMOVED");
    expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await btn.click();
    await noHScroll(page);
    const box = (await dialog(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await dialog(page).locator('button[data-role="cancel"]').click();
    await signIn(page, "/customers");
    await noHScroll(page);
  });
});

test.describe("Not paged marker", () => {
  test("the incident list and the incident panel say nobody was paged", async ({ page }) => {
    await signIn(page, "/incidents?customer=eden&status=RESOLVED");
    const row = page.getByTestId("incident-row").filter({ hasText: "fleet-telemetry-1" });
    await expect(row.getByTestId("not-paged")).toHaveText("Not paged (customer suspended)");
    await row.getByRole("link", { name: /fleet-telemetry-1/ }).click();
    const panel = page.getByTestId("panel");
    await expect(panel.getByTestId("not-paged")).toContainText("Not paged (customer suspended)");
    await expect(panel.getByTestId("not-paged")).toContainText("nobody is paged");
    // an ordinary incident has none
    await signIn(page, "/incidents");
    await expect(page.getByTestId("not-paged")).toHaveCount(0);
  });
});

test("390 px: after the 503 the error is in view, not under the buttons, and has the focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await signIn(page, "/customers/dasol");
  await page.getByTestId("cs-change").click();
  await page.getByTestId("cs-terminate").click();
  await page.getByTestId("cs-reason").fill("Contract ended");
  await page.getByTestId("cs-confirm-name").fill("Dasol Health");
  await page.waitForTimeout(700);
  await confirmBtn(page).click();
  const err = page.getByTestId("cs-err");
  await expect(err).toBeVisible();
  await expect(err).toBeFocused();
  const e = (await err.boundingBox())!;
  const buttons = (await dialog(page).locator(".dguard-acts").boundingBox())!;
  expect(e.y).toBeGreaterThanOrEqual(0);
  expect(e.y + e.height, "the whole message is inside the window").toBeLessThanOrEqual(600);
  expect(e.y + e.height, "and above the dialog's buttons").toBeLessThanOrEqual(buttons.y + 1);
});
