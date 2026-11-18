// Settings › Users (#74, D-55): list, filters, add staff / portal user, change role, disable / enable, move a portal user,
// clear the Google link, your own row, the last admin — at 1440 and 390 (cards, no horizontal scroll, 44 px targets).
// Mock people: Haeun (you, ADMIN), Junho (second admin), Minjae, Sora, Dana (disabled), portal users Yuna (Mirae Pay, linked to a contact),
// Jiho (Daon Retail), Mina (Hanbit, pending). The mock store is shared by the run, so each test makes its own people.
import { test, expect, type Page } from "@playwright/test";
import { appReady } from "./helpers/ready";

const signIn = async (page: Page, next: string, as = "admin") => {
  await page.goto(`/auth/dev-login?as=${as}&next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
  await appReady(page);
};
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
const row = (page: Page, name: string) => page.getByTestId("us-row").filter({ has: page.getByTestId("us-name").filter({ hasText: new RegExp(`^${name}$`) }) });
const dialog = (page: Page) => page.getByTestId("confirm-dialog");
const target44 = async (loc: ReturnType<Page["locator"]>) => expect((await loc.boundingBox())!.height).toBeGreaterThanOrEqual(44);

async function addStaff(page: Page, name: string, email: string, role: "ADMIN" | "OPERATOR" | "VIEWER") {
  await page.getByTestId("us-add").click();
  await page.getByTestId("us-name-in").fill(name);
  await page.getByTestId("us-email-in").fill(email);
  await page.getByTestId(`us-newrole-${role}`).check();
  await page.getByTestId("us-submit").click();
}

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test.describe(`Settings › Users at ${w}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test("the list: masked e-mail, kind, role, status with a shape and text, last sign-in, Google; cards on a phone; no sideways scroll", async ({ page }) => {
      await signIn(page, "/settings/users");
      await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeVisible();
      expect(await page.getByTestId("us-row").count()).toBeGreaterThanOrEqual(8);
      const yuna = row(page, "Yuna Seo");
      await expect(yuna).toContainText("y•••@mirae.example");
      await expect(yuna).toContainText("Portal · Mirae Pay");
      await expect(yuna).toContainText("Viewer (read-only)");
      await expect(yuna.getByTestId("us-status")).toHaveText("✓Active");
      await expect(row(page, "Dana Choi").getByTestId("us-status")).toHaveText("⊘Disabled");
      await expect(row(page, "Mina Oh").getByTestId("us-status")).toHaveText("◔Pending");
      await expect(row(page, "Sora Yoon")).toContainText("Never");
      await expect(row(page, "Sora Yoon").getByTestId("us-google")).toContainText("No");
      await expect(row(page, "Sora Yoon").getByTestId("us-google")).toContainText("No — links at first sign-in");
      expect(await page.locator('[data-testid^="us-act-"][title]').count()).toBe(0); // no reason lives in a tooltip only
      const split = await page.locator("td.us-mail").evaluateAll((tds) => tds.filter((td) => { for (const n of Array.from(td.childNodes)) { if (n.nodeType !== 3) continue; const r = document.createRange(); r.selectNodeContents(n); if (new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top))).size > 1) return true; } return false; }).length);
      expect(split, "an address broken inside a word").toBe(0); // it breaks after the @ or not at all
      await expect(page.getByTestId("us-legend")).toContainText("Pending was added but not activated yet");
      const mina = row(page, "Mina Oh");
      await expect(mina.getByTestId("us-act-enable")).toHaveText("Activate…");
      await mina.getByTestId("us-act-enable").click();
      await expect(dialog(page)).toContainText("They will be able to sign in");
      await expect(dialog(page)).not.toContainText("again");
      for (const b of await dialog(page).getByRole("button").all()) await target44(b);
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await expect(row(page, "Haeun Kim").getByTestId("us-google")).toContainText("Yes");
      await expect(row(page, "Haeun Kim")).toContainText("You");
      expect(await page.locator("body").innerText()).not.toMatch(/\b[a-z0-9.]{2,}@msp\.example/); // only the masked address is ever shown
      // the table is cards on a phone: rows are blocks and the header is out of sight
      const display = await page.getByTestId("us-row").first().evaluate((el) => getComputedStyle(el).display);
      expect(display).toBe(w <= 760 ? "block" : "table-row");
      await target44(row(page, "Sora Yoon").getByTestId("us-act-role"));
      await target44(page.getByTestId("us-add"));
      await noHScroll(page);
    });

    test("filters: type, status, role, customer, search; clear; empty state", async ({ page }) => {
      await signIn(page, "/settings/users");
      await page.getByTestId("us-f-kind").selectOption("CUSTOMER");
      await page.getByTestId("us-apply").click();
      await expect(page).toHaveURL(/kind=CUSTOMER/);
      await expect(page.getByTestId("us-row").first()).toBeVisible();
      for (const k of await page.getByTestId("us-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))) expect(k).toBe("CUSTOMER");
      await page.getByTestId("us-f-customer").selectOption({ label: "Daon Retail" });
      await page.getByTestId("us-apply").click();
      await expect(page.getByTestId("us-row")).toHaveCount(1);
      await expect(page.getByTestId("us-count")).toContainText("1 user match the filters");
      await page.getByTestId("us-clear").click();
      await expect(page).toHaveURL(/\/settings\/users$/);
      await page.getByTestId("us-f-status").selectOption("DISABLED");
      await page.getByTestId("us-apply").click();
      await expect(page.getByTestId("us-row")).toHaveCount(1);
      await expect(row(page, "Dana Choi")).toBeVisible();
      await page.getByTestId("us-clear").click();
      await expect(page).toHaveURL(/\/settings\/users$/);
      // Apply filters moves the focus to the results line
      await page.getByTestId("us-f-status").selectOption("ACTIVE");
      await page.getByTestId("us-apply").click();
      await expect(page.getByTestId("us-count")).toBeFocused();
      await page.getByTestId("us-clear").click();
      await expect(page).toHaveURL(/\/settings\/users$/);
      // the text search is client-side: nothing typed goes into the address
      await page.getByTestId("us-f-q").fill("zzz-nobody");
      await expect(page.getByText("No users match")).toBeVisible();
      expect(page.url()).not.toContain("zzz");
      await page.getByTestId("us-f-q").fill("sora");
      await expect(page.getByTestId("us-row")).toHaveCount(1);
      await page.getByTestId("us-f-q").fill("zzz-nobody");
      await expect(page.getByRole("link", { name: "Clear filters" })).toBeVisible();
      await noHScroll(page);
    });

    test("add staff: warns outside the allowed domains, blocks what the API would refuse, says what happens next, refuses a duplicate", async ({ page }) => {
      await signIn(page, "/settings/users");
      await page.getByTestId("us-add").click();
      await expect(page.getByTestId("us-name-in")).toBeFocused();
      await expect(page.getByTestId("us-next")).toContainText("Their address must be in the allowed domains (msp.example)");
      await expect(page.getByTestId("us-submit")).toBeDisabled();
      await page.getByTestId("us-name-in").fill(`E2E Staff ${w}`);
      await page.getByTestId("us-email-in").fill("not-an-address");
      await page.getByTestId("us-email-in").blur();
      await expect(page.getByTestId("us-add-form")).toContainText("does not look like an e-mail address");
      await expect(page.getByTestId("us-submit")).toBeDisabled();
      await page.getByTestId("us-email-in").fill(`e2e.staff.${w}@gmail.com`);
      await expect(page.getByTestId("us-fence-warn")).toContainText("outside the allowed domains");
      await page.getByTestId("us-email-in").fill(`e2e.staff.${w}@msp.example`);
      await expect(page.getByTestId("us-fence-warn")).toHaveCount(0);
      await expect(page.getByTestId("us-submit")).toBeDisabled(); // a role is still to choose
      await page.getByTestId("us-newrole-OPERATOR").check();
      await target44(page.getByTestId("us-submit"));
      await noHScroll(page);
      await page.getByTestId("us-submit").click();
      const result = page.getByTestId("us-result");
      await expect(result).toContainText(`E2E Staff ${w} was added as Operator. They can sign in with this Google account.`);
      await expect(result).toContainText('Sign in with Google');
      await expect(result).toBeFocused();
      await expect(page.getByTestId("us-add-form")).toHaveCount(0);
      const mine = row(page, `E2E Staff ${w}`);
      await expect(mine).toContainText("e•••@msp.example");
      await expect(mine).toContainText("Staff");
      await expect(mine).toContainText("Operator");
      await expect(mine.getByTestId("us-status")).toHaveText("✓Active");
      await expect(mine).toContainText("Never");
      // the same address again (any case): a clear message, the form stays
      await addStaff(page, "Someone Else", `E2E.Staff.${w}@MSP.example`, "VIEWER");
      const err = page.getByTestId("us-add-error");
      await expect(err).toContainText("already exists");
      await expect(err).toBeFocused();
      await expect(page.getByTestId("us-add-form")).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByTestId("us-add")).toBeFocused();
    });

    test("add staff outside the allowed domains: says plainly that they cannot sign in yet", async ({ page }) => {
      await signIn(page, "/settings/users");
      await addStaff(page, `E2E Outside ${w}`, `e2e.outside.${w}@gmail.com`, "VIEWER");
      await expect(page.getByTestId("us-result")).toContainText("they cannot sign in yet");
      await expect(page.getByTestId("us-result")).toContainText("sign-in exception list");
      await expect(page.getByTestId("us-result")).toContainText("whoever manages the console");
    });

    test("add a portal user: exactly one customer, always read-only; move them; a linked contact cannot move", async ({ page }) => {
      await signIn(page, "/settings/users");
      await page.getByTestId("us-add").click();
      await page.getByTestId("us-kind-portal").check();
      await expect(page.getByTestId("us-newrole-ADMIN")).toHaveCount(0);
      await expect(page.getByTestId("us-next")).toContainText("read-only");
      await page.getByTestId("us-name-in").fill(`E2E Portal ${w}`);
      await page.getByTestId("us-email-in").fill(`e2e.portal.${w}@client.example.com`);
      await expect(page.getByTestId("us-submit")).toBeDisabled();
      await page.getByTestId("us-customer-in").selectOption("cus_daon");
      await expect(page.getByTestId("us-fence-warn")).toHaveCount(0); // the staff fence does not apply to portal users
      await page.getByTestId("us-submit").click();
      await expect(page.getByTestId("us-result")).toContainText(`E2E Portal ${w} was added as a read-only portal user of Daon Retail.`);
      const mine = row(page, `E2E Portal ${w}`);
      await expect(mine).toContainText("Portal · Daon Retail");
      await expect(mine).toContainText("Viewer (read-only)");
      await expect(mine.getByTestId("us-act-role")).toHaveCount(0); // a role is not something a portal user has
      await mine.getByTestId("us-act-move").click();
      await expect(dialog(page)).toContainText("see only the new customer, read-only");
      await expect(page.getByTestId("us-move-select").locator("option", { hasText: "Daon Retail" })).toHaveCount(0);
      await page.getByTestId("us-move-select").selectOption("cus_hanbit");
      await page.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(page).getByRole("button", { name: "Move to Hanbit Logistics" }).click();
      await expect(page.getByTestId("us-result")).toContainText("now belongs to Hanbit Logistics");
      await expect(row(page, `E2E Portal ${w}`)).toContainText("Portal · Hanbit Logistics");
      // Yuna is linked to a contact of Mirae Pay: the API refuses and the dialog says why, nothing changes
      await row(page, "Yuna Seo").getByTestId("us-act-move").click();
      await page.getByTestId("us-move-select").selectOption("cus_daon");
      await page.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(page).getByRole("button", { name: "Move to Daon Retail" }).click();
      await expect(page.getByTestId("us-dialog-error")).toContainText("linked to a contact");
      await expect(page.getByTestId("us-dialog-error")).toContainText("Nothing was changed");
      await page.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await expect(row(page, "Yuna Seo")).toContainText("Portal · Mirae Pay");
    });

    test("change role: a confirm step in the page, focus returns on Cancel, result announced", async ({ page }) => {
      await signIn(page, "/settings/users");
      await addStaff(page, `E2E Role ${w}`, `e2e.role.${w}@msp.example`, "VIEWER");
      await expect(page.getByTestId("us-result")).toContainText("added as Viewer");
      const mine = row(page, `E2E Role ${w}`);
      const trigger = mine.getByTestId("us-act-role");
      await trigger.click();
      await expect(dialog(page)).toContainText(`Change the role of E2E Role ${w}`);
      await expect(dialog(page).getByRole("button", { name: /^Change role to Viewer$/ })).toBeDisabled(); // same role
      for (const b of await dialog(page).getByRole("button").all()) await target44(b);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page.getByTestId("us-role-ADMIN").check();
      await noHScroll(page);
      await page.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(page).getByRole("button", { name: "Change role to Admin" }).click();
      await expect(page.getByTestId("us-result")).toContainText(`E2E Role ${w} is now Admin`);
      await expect(page.getByTestId("us-result")).toBeFocused();
      await expect(mine.getByTestId("us-role")).toHaveText("Admin");
      // and back, so the other tests start with two admins
      await mine.getByTestId("us-act-role").click();
      await page.getByTestId("us-role-OPERATOR").check();
      await page.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(page).getByRole("button", { name: "Change role to Operator" }).click();
      await expect(mine.getByTestId("us-role")).toHaveText("Operator");
    });

    test("disable and enable: says what it does, status changes with a shape and text", async ({ page }) => {
      await signIn(page, "/settings/users");
      await addStaff(page, `E2E Off ${w}`, `e2e.off.${w}@msp.example`, "OPERATOR");
      const mine = row(page, `E2E Off ${w}`);
      await expect(mine).toBeVisible();
      await mine.getByTestId("us-act-disable").click();
      await expect(dialog(page)).toContainText("signed out on their next action");
      await expect(dialog(page)).toContainText("Users are never deleted");
      await page.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(page).getByRole("button", { name: `Disable E2E Off ${w}` }).click();
      await expect(page.getByTestId("us-result")).toContainText(`E2E Off ${w} is disabled`);
      await expect(mine.getByTestId("us-status")).toHaveText("⊘Disabled");
      await expect(mine.getByTestId("us-act-disable")).toHaveCount(0);
      await mine.getByTestId("us-act-enable").click();
      await page.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(page).getByRole("button", { name: `Enable E2E Off ${w}` }).click();
      await expect(mine.getByTestId("us-status")).toHaveText("✓Active");
      await expect(page.getByTestId("us-result")).toContainText("can sign in with their Google account again");
      await noHScroll(page);
    });

    test("clear the Google link: the dialog says what it does; only a linked user can be cleared", async ({ page }) => {
      await signIn(page, "/settings/users");
      const linked = page.getByTestId("us-row").filter({ has: page.getByTestId("us-google").filter({ hasText: "Yes" }) }).filter({ hasNotText: "You" }).first();
      const name = (await linked.getByTestId("us-name").innerText()).trim();
      await linked.getByTestId("us-act-google").click();
      await expect(dialog(page)).toContainText("only that account can sign in");
      await expect(dialog(page)).toContainText("does not end their current session");
      await page.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(page).getByRole("button", { name: "Clear Google link" }).click();
      await expect(page.getByTestId("us-result")).toContainText(`Google link cleared for ${name}`);
      await expect(row(page, name).getByTestId("us-google")).toContainText("No");
      await expect(row(page, name).getByTestId("us-act-google")).toBeDisabled();
      // never offered for someone who has none
      await expect(row(page, "Sora Yoon").getByTestId("us-act-google")).toBeDisabled();
    });

    test("your own row and the last admin: off before the click, with the reason", async ({ page }) => {
      await signIn(page, "/settings/users");
      const me = row(page, "Haeun Kim");
      await expect(me.getByTestId("us-act-role")).toBeDisabled();
      await expect(me.getByTestId("us-act-disable")).toBeDisabled();
      await expect(me.getByTestId("us-act-google")).toBeDisabled();
      await expect(me.getByTestId("us-note")).toContainText("You can't change your own role or status, or clear your own Google link. Ask another admin.");
      await expect(row(page, "Junho Park").getByTestId("us-act-role")).toBeEnabled(); // with two admins the other one is free to change
      await noHScroll(page);
    });

    test("the last admin refusal: a page that is out of date is refused by the API and the dialog says why; a reload shows the control off", async ({ page, browser }) => {
      await signIn(page, "/settings/users");
      await expect(row(page, "Junho Park").getByTestId("us-role")).toHaveText("Admin");
      // Junho, in another window, makes Haeun an Operator: Junho is now the only admin
      const other = await browser.newContext({ viewport: { width: w, height: h } });
      const b = await other.newPage();
      await signIn(b, "/settings/users", "admin2");
      await row(b, "Haeun Kim").getByTestId("us-act-role").click();
      await b.getByTestId("us-role-OPERATOR").check();
      await b.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(b).getByRole("button", { name: "Change role to Operator" }).click();
      await expect(row(b, "Haeun Kim").getByTestId("us-role")).toHaveText("Operator");
      // this window still shows two admins: demoting Junho looks fine and is refused
      await row(page, "Junho Park").getByTestId("us-act-role").click();
      await page.getByTestId("us-role-VIEWER").check();
      await page.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(page).getByRole("button", { name: "Change role to Viewer" }).click();
      const e = page.getByTestId("us-dialog-error");
      await expect(e).toContainText("Nothing was changed");
      await expect(e).toContainText("last active admin");
      await expect(e).toContainText("Make another user an admin first");
      await expect(e).toBeFocused();
      await page.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await page.reload();
      await appReady(page);
      const junho = row(page, "Junho Park");
      await expect(junho.getByTestId("us-role")).toHaveText("Admin");
      await expect(junho.getByTestId("us-act-role")).toBeDisabled();
      await expect(junho.getByTestId("us-act-disable")).toBeDisabled();
      await expect(junho.getByTestId("us-note")).toContainText("last active admin with access to all customers");
      // restore: Junho makes Haeun an Admin again
      await row(b, "Haeun Kim").getByTestId("us-act-role").click();
      await b.getByTestId("us-role-ADMIN").check();
      await b.waitForTimeout(700); // a button is armed 600 ms after the last press at the same spot
      await dialog(b).getByRole("button", { name: "Change role to Admin" }).click();
      await expect(row(b, "Haeun Kim").getByTestId("us-role")).toHaveText("Admin");
      await other.close();
    });
  });
}

test.describe("who sees the page", () => {
  for (const as of ["operator", "viewer"]) {
    test(`${as}: told in one sentence that the page is for admins; no list, no write control`, async ({ page }) => {
      await signIn(page, "/settings/users", as);
      await expect(page.getByTestId("users-unavailable")).toContainText("Only admins with access to all customers can manage users.");
      await expect(page.getByTestId("us-table")).toHaveCount(0);
      await expect(page.getByTestId("us-add")).toHaveCount(0);
    });
  }
  for (const as of ["portal"]) {
    test(`${as}: the same "not found" page as any address they may not see; no list, no write control`, async ({ page }) => {
      await signIn(page, "/settings/users", as);
      await expect(page.getByTestId("not-found")).toBeVisible();
      await expect(page.getByTestId("us-table")).toHaveCount(0);
      await expect(page.getByTestId("us-add")).toHaveCount(0);
    });
  }
});
