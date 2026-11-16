// Portal (CUSTOMER kind) users see every page read-only (D-36, personas: Soyeon): a "Read-only view" marker and not one
// control that changes something — no edit, add, remove, status, escalate, acknowledge or save — at 1440 and 390.
import { test, expect, type Page } from "@playwright/test";
import { appReady } from "./helpers/ready";

const signIn = async (page: Page, next: string, as = "portal") => {
  await page.goto(`/auth/dev-login?as=${as}&next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
  await appReady(page);
};
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

/** words that start the name of a control that changes something */
const WRITE = /^(edit|add|remove|change|escalate|ack|acknowledge|resolve|save|rotate|terminate|suspend|resume|delete|undo|mark|place|release|create|new|invite|disable|enable|export|reopen|snooze|mute|unmute|apply to|bulk)\b/i;

async function expectReadOnly(page: Page, path: string) {
  await signIn(page, path);
  await expect(page.getByTestId("read-only-badge")).toBeVisible();
  await expect(page.getByTestId("read-only-badge")).toContainText(/Read-only/);
  const bad: string[] = [];
  for (const el of await page.locator("button, [role=button], [role=menuitem], input[type=checkbox], input[type=submit], textarea").all()) {
    if (!(await el.isVisible())) continue;
    const name = ((await el.getAttribute("aria-label")) ?? (await el.innerText().catch(() => "")) ?? "").trim();
    const type = await el.evaluate((n) => (n as HTMLInputElement).type ?? "");
    if (type === "checkbox" || type === "textarea" || WRITE.test(name)) bad.push(`${path}: ${type || "control"} "${name}"`);
  }
  expect(bad, "write controls in the portal view").toEqual([]);
  await noHScroll(page);
}

// What a portal user may open. (The staff-only paths — call order, People of other customers, Settings — are 404 for them in the real API;
// the mock may still render them, which is why they are swept too: whatever renders must not offer a write.)
const PAGES = ["/incidents", "/customers", "/customers/mirae", "/monitoring/alarms", "/maintenance", "/call-order", "/c/mirae/call-order", "/people", "/settings/msp-defaults"];

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test.describe(`portal read-only at ${w}`, () => {
    test.use({ viewport: { width: w, height: h } });
    for (const path of PAGES) test(`${path}`, async ({ page }) => { await expectReadOnly(page, path); });

    test("an incident, its detail and the Responders list offer no action", async ({ page }) => {
      const href = "/incidents/inc-7f3a0c91b2d4-20261108181204";
      await expectReadOnly(page, href);
      await expect(page.getByRole("button", { name: /^(Acknowledge|Ack|Escalate|Resolve)/ })).toHaveCount(0);
    });
  });
}

test("staff do not get the marker", async ({ page }) => {
  await signIn(page, "/incidents", "admin");
  await expect(page.getByTestId("read-only-badge")).toHaveCount(0);
});

test("the portal user's reveal is for their own customer's people only (the API decides; the console sends no mode)", async ({ page }) => {
  await signIn(page, "/c/mirae/call-order");
  // if the mock renders the Responders card for a portal user, a Show button exists only for the customer's own people
  const staffShow = page.getByTestId("co-staff").getByRole("button", { name: /^Show (number|email)/ });
  await expect(staffShow).toHaveCount(0);
});

test("deletion record print view: printed-at (KST) and a signature block appear on paper only", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "/customers/iruda", "admin");
  await expect(page.getByTestId("purge-log")).toBeVisible();
  await expect(page.getByTestId("purge-printed-at")).toBeHidden();
  await expect(page.getByTestId("purge-sign")).toBeHidden();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("purge-printed-at")).toHaveText(/^Printed at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} KST$/);
  await expect(page.getByTestId("purge-sign")).toContainText("Checked by");
  await expect(page.getByTestId("purge-sign")).toContainText("Date");
});
