// Call order › Rotations (API-CONTRACT §8.3 `/rotations`, docs/ui/screens/oncall-rotations.md), on the default mock server.
// Runs after the other specs (the name sorts last): it changes MSP night desk (rot_night) and creates and deletes "E2E desk".
// rot_night starts as Haeun Kim, Junho Park, Jiwoo Han (1 = on shift now). The order of the tests matters: the tests that save are
// kept together and leave the order as noted. Page parts it reads (data-testid): rot-segment (the shared rotations), rot-order, rot-member
// (a person of the order, with Move … up / Move … down buttons), rot-preview-row, rot-next-shift, rot-save, rot-save-why, rot-result,
// rot-error, rot-reload, rot-why, rot-used-row (data-status, data-selected), rot-cust-row, rot-new, rot-new-name, rot-add-select, rot-add,
// rot-create, rot-create-error, rot-delete, rot-in-use, rot-affected, and [data-badge] (one member badge in a Customer rotations row).
import { test, expect, type Browser, type Page } from "@playwright/test";
import { appReady } from "./helpers/ready";

const signIn = async (page: Page, next: string, as = "admin") => {
  await page.goto(`/auth/dev-login?as=${as}&next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
  await appReady(page);
};
const PATH = "/call-order/rotations";
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
const dialog = (page: Page) => page.getByTestId("confirm-dialog");
const confirmBtn = (page: Page) => dialog(page).locator('button[data-role="confirm"]');
const members = (page: Page) => page.getByTestId("rot-member");
const order = async (page: Page) => (await members(page).allInnerTexts()).map((t) => t.split("\n")[0]!.replace(/\s*(on shift|now).*$/i, "").trim());
const edit = (page: Page) => page.getByRole("button", { name: "Edit members & order" });
/** moves the person in 2nd place one down, i.e. swaps 2 and 3 */
const swap23 = async (page: Page) => { await members(page).nth(1).getByRole("button", { name: /^Move .* down$/ }).click(); };
const terminatedRows = async (page: Page) => page.locator('[data-testid="rot-used-row"][data-status="TERMINATED"]').count();
const terminatedFree = async (page: Page) => page.locator('[data-testid="rot-used-row"]:not([data-status="TERMINATED"])').count();

test.describe("read-only for staff who are not admins", () => {
  for (const [as, who] of [["viewer", "Viewer"], ["operator", "Operator"]] as const) {
    test(`${as}: no write buttons, the reason, and the read areas`, async ({ page }) => {
      await signIn(page, PATH, as);
      for (const name of ["New shared rotation", "Edit members & order", "Delete"]) await expect(page.getByRole("button", { name })).toHaveCount(0);
      await expect(page.getByTestId("rot-why")).toContainText(`Changing a rotation needs the Admin role. You are signed in as ${who}.`);
      for (const h of ["Order", "Next shifts", "Used by", "Customer rotations"]) await expect(page.getByRole("heading", { name: h })).toBeVisible();
    });
  }
});

test.describe("a portal user", () => {
  test("Rotations and Templates are Not found; the Call order menu has neither link", async ({ page }) => {
    for (const p of ["/call-order/rotations", "/call-order/templates"]) {
      await signIn(page, p, "portal");
      await expect(page.getByText("Not found", { exact: false }).first()).toBeVisible();
      await expect(page.getByTestId("rot-order")).toHaveCount(0);
    }
    await signIn(page, "/c/mirae/call-order", "portal");
    const menu = page.getByRole("navigation");
    await expect(menu.getByRole("link", { name: "Rotations" })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: "Templates" })).toHaveCount(0);
  });
});

test.describe("reading", () => {
  test("the tree's customer narrows Customer rotations and marks Used by; with none, both customer rotations show", async ({ page }) => {
    await signIn(page, PATH);
    await expect(page.getByTestId("rot-cust-row").filter({ hasText: "Hanbit on-call" })).toBeVisible();
    await expect(page.getByTestId("rot-cust-row").filter({ hasText: "Lumen on-call" })).toBeVisible();
    await signIn(page, `${PATH}?customer=hanbit`);
    await expect(page.getByTestId("rot-cust-row")).toHaveCount(1);
    await expect(page.getByTestId("rot-cust-row")).toContainText("Hanbit on-call");
    await expect(page.getByText("Lumen on-call")).toHaveCount(0);
    await expect(page.locator('[data-testid="rot-used-row"][data-selected="true"]')).toContainText("Hanbit");
  });

  test("Cover or swap and Swap with me are off, with their reason, and send nothing", async ({ page }) => {
    const sent: string[] = [];
    page.on("request", (r) => { if (r.method() !== "GET") sent.push(`${r.method()} ${r.url()}`); });
    await signIn(page, PATH);
    for (const b of await page.getByRole("button", { name: /^(Cover or swap|Swap with me)$/ }).all()) {
      await expect(b).toBeDisabled();
      const id = await b.getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      await expect(page.locator(`#${id}`)).not.toBeEmpty();
      await b.click({ force: true });
    }
    expect(sent).toEqual([]);
  });

  test("390px: Customer rotations are cards, member badges wrap inside the card, nothing scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await signIn(page, PATH);
    await noHScroll(page);
    const cards = page.getByTestId("rot-cust-row");
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(2);
    // cards, not a table: no table rows and no header row are shown
    await expect(page.locator('tr[data-testid="rot-cust-row"], [data-testid="rot-cust-row"][role="row"]')).toHaveCount(0);
    await expect(page.getByRole("columnheader")).toHaveCount(0);
    for (const c of await cards.all()) {
      expect(await c.locator("[data-badge]").count(), "every card has member badges").toBeGreaterThan(0);
      const box = await c.boundingBox();
      expect(box!.width).toBeLessThanOrEqual(390);
      // every badge ends inside the card
      for (const b of await c.locator("[data-badge]").all()) {
        const bb = await b.boundingBox();
        expect(bb!.x + bb!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
      }
      expect(await c.evaluate((n) => n.scrollWidth - n.clientWidth)).toBeLessThanOrEqual(0);
    }
  });

  test("390px: edit, the preview and the confirmation work; Esc leaves nothing saved", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await signIn(page, PATH);
    const before = await order(page);
    await edit(page).click();
    await noHScroll(page);
    await swap23(page);
    await expect(page.getByTestId("rot-next-shift")).toBeVisible();
    await noHScroll(page);
    const save = page.getByTestId("rot-save");
    expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await save.click();
    await expect(dialog(page)).toBeVisible();
    await noHScroll(page);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await page.reload();
    await appReady(page);
    expect(await order(page)).toEqual(before);
  });

  test("dark colour scheme: text of the Rotations screen reaches 4.5:1, reading and editing", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 900 }, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    const measure = () => page.evaluate(() => {
      const parse = (c: string): [number, number, number, number] => { const m = c.match(/[\d.]+/g)!.map(Number); return [m[0]!, m[1]!, m[2]!, m[3] ?? 1]; };
      const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const bgOf = (el: Element): [number, number, number] => {
        let n: Element | null = el; let acc: [number, number, number] = [255, 255, 255];
        const stack: [number, number, number, number][] = [];
        while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) stack.push(c); if (c[3] === 1) break; n = n.parentElement; }
        for (const c of stack.reverse()) acc = [0, 1, 2].map((i) => c[i]! * c[3] + acc[i]! * (1 - c[3])) as [number, number, number];
        return acc;
      };
      let min = 21; let worst = ""; let seen = 0;
      for (const el of Array.from(document.querySelectorAll("main *, .shell-main *"))) {
        const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim());
        const cs = getComputedStyle(el);
        if (!own || cs.visibility === "hidden" || cs.display === "none" || (el as HTMLElement).offsetParent === null) continue;
        if ((el as HTMLButtonElement).disabled) continue; // disabled controls are exempt from WCAG 1.4.3
        seen++;
        const fg = parse(cs.color); const bg = bgOf(el);
        const f = [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])) as [number, number, number];
        const [a, b] = [lum(...f), lum(...bg)];
        const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (r < min) { min = r; worst = `${el.tagName}.${el.className} "${el.textContent!.trim().slice(0, 30)}"`; }
      }
      return { min, worst, seen };
    });
    await page.goto(`/auth/dev-login?next=${encodeURIComponent(PATH)}`, { waitUntil: "networkidle" });
    await appReady(page);
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
    let r = await measure();
    expect(r.seen).toBeGreaterThan(20);
    expect(r.min, `reading, worst: ${r.worst}`).toBeGreaterThanOrEqual(4.5);
    await edit(page).click();
    await swap23(page);
    await expect(page.getByTestId("rot-next-shift")).toBeVisible();
    r = await measure();
    expect(r.min, `editing with a preview, worst: ${r.worst}`).toBeGreaterThanOrEqual(4.5);
    await ctx.close();
  });
});

test.describe("delete", () => {
  test("a rotation that call orders use cannot be deleted: the customers and steps are listed, the rotation stays", async ({ page }) => {
    await signIn(page, PATH);
    const before = await order(page);
    await page.getByRole("button", { name: "Delete" }).click();
    if (await dialog(page).count()) await confirmBtn(page).click();
    const inUse = page.getByTestId("rot-in-use");
    await expect(inUse).toBeVisible();
    await expect(inUse).toContainText("Mirae Pay");
    await expect(inUse).toContainText(/step 1/i);
    await page.reload();
    await appReady(page);
    await expect(page.getByTestId("rot-segment")).toContainText("MSP night desk");
    expect(await order(page)).toEqual(before);
  });
});

test.describe("saving a change that reaches many customers", () => {
  test("setup: rot_night has a TERMINATED customer in Used by, so N below cannot be the whole usage", async ({ page }) => {
    await signIn(page, PATH);
    if ((await terminatedRows(page)) === 0) {
      // the default mock has no terminated customer on rot_night; terminate Ara Games (nothing else in the suite owns it)
      await signIn(page, "/customers/ara");
      await page.getByTestId("cs-change").click();
      await page.getByTestId("cs-terminate").click();
      await page.getByTestId("cs-reason").fill("Contract ended");
      await page.getByTestId("cs-confirm-name").fill("Ara Games");
      await confirmBtn(page).click();
      await expect(page.getByTestId("customer-status")).toHaveAttribute("data-status", "TERMINATED");
      await signIn(page, PATH);
    }
    expect(await terminatedRows(page)).toBeGreaterThan(0);
  });

  test("swap 2 and 3: the customers and Next before → after first, one confirmation, then the result and the new order", async ({ page }) => {
    await signIn(page, PATH);
    expect(await order(page)).toEqual(["Haeun Kim", "Junho Park", "Jiwoo Han"]);
    await edit(page).click();
    await expect(page.getByTestId("rot-save")).toBeDisabled();
    await expect(page.getByTestId("rot-save-why")).toHaveText("Nothing has changed yet.");
    await swap23(page);
    await expect(page.getByTestId("rot-next-shift")).toHaveText("Junho Park → Jiwoo Han");
    await expect(page.getByTestId("rot-preview-row").first()).toContainText("Kept");
    const n = await terminatedFree(page);
    expect(n).toBeGreaterThan(0);
    const total = await page.getByTestId("rot-used-row").count();
    expect(n, "a TERMINATED customer is in Used by but not in N").toBeLessThan(total);
    await expect(page.getByTestId("rot-affected")).toContainText("Mirae Pay");
    const save = page.getByTestId("rot-save");
    await expect(save).toBeEnabled();
    await expect(save).toHaveText(`Save rotation for ${n} customers`);
    await expect(save).not.toHaveText(`Save rotation for ${total} customers`);
    await save.click();
    await expect(dialog(page)).toHaveCount(1);
    await confirmBtn(page).click();
    await expect(page.getByTestId("rot-result")).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => order(page)).toEqual(["Haeun Kim", "Jiwoo Han", "Junho Park"]);
    await expect(page.getByTestId("rot-error")).toHaveCount(0);
  });

  test("the next change on the same page, with no Reload: preview and save succeed, no VERSION_CONFLICT", async ({ page }) => {
    await signIn(page, PATH);
    expect(await order(page)).toEqual(["Haeun Kim", "Jiwoo Han", "Junho Park"]);
    await edit(page).click();
    await swap23(page);
    await page.getByTestId("rot-save").click();
    await confirmBtn(page).click();
    await expect(page.getByTestId("rot-result")).toBeVisible();
    await expect.poll(() => order(page)).toEqual(["Haeun Kim", "Junho Park", "Jiwoo Han"]);
    // and once more without leaving the page
    await edit(page).click();
    await swap23(page);
    await expect(page.getByTestId("rot-save")).toBeEnabled();
    await expect(page.getByText(/Someone else changed this/)).toHaveCount(0);
    await page.getByTestId("rot-save").click();
    await confirmBtn(page).click();
    await expect(page.getByTestId("rot-result")).toBeVisible();
    await expect(page.getByText(/Someone else changed this/)).toHaveCount(0);
    await expect.poll(() => order(page)).toEqual(["Haeun Kim", "Jiwoo Han", "Junho Park"]);
    // back to the first order for the tests that follow: Haeun, Junho, Jiwoo
    await edit(page).click();
    await swap23(page);
    await page.getByTestId("rot-save").click();
    await confirmBtn(page).click();
    await expect.poll(() => order(page)).toEqual(["Haeun Kim", "Junho Park", "Jiwoo Han"]);
  });

  test("two pages: A starts editing, B saves, A changes again and tries to save: it is refused with Reload, and Reload shows B's order", async ({ browser }) => {
    const open = async (b: Browser) => { const p = await (await b.newContext({ baseURL: test.info().project.use.baseURL })).newPage(); await signIn(p, PATH); return p; };
    const a = await open(browser);
    const b = await open(browser);
    await edit(a).click();
    await swap23(a);
    await expect(a.getByTestId("rot-next-shift")).toBeVisible();
    // B saves first
    await edit(b).click();
    await swap23(b);
    await b.getByTestId("rot-save").click();
    await confirmBtn(b).click();
    await expect(b.getByTestId("rot-result")).toBeVisible();
    // A changes again after that and looks at it again
    await a.getByTestId("rot-member").nth(1).getByRole("button", { name: /^Move .* down$/ }).click();
    await expect(a.getByTestId("rot-error")).toContainText(/Someone else changed this/);
    await expect(a.getByTestId("rot-save")).toBeDisabled();
    await expect(a.getByTestId("rot-reload")).toBeVisible();
    await a.getByTestId("rot-reload").click();
    await appReady(a);
    await expect.poll(() => order(a)).toEqual(["Haeun Kim", "Jiwoo Han", "Junho Park"]);
    await expect(a.getByTestId("rot-error")).toHaveCount(0);
    await a.context().close(); await b.context().close();
  });

  test("keyboard only: Edit, the move buttons, Save and the confirmation; Esc on the confirmation saves nothing", async ({ page }) => {
    await signIn(page, PATH);
    const before = await order(page);
    expect(before).toEqual(["Haeun Kim", "Jiwoo Han", "Junho Park"]);
    await edit(page).focus();
    await page.keyboard.press("Enter");
    // move the person in 3rd place up: the buttons are reached and pressed with the keyboard
    const up = members(page).nth(2).getByRole("button", { name: /^Move .* up$/ });
    await up.focus();
    await expect(up).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("rot-next-shift")).toBeVisible();
    const save = page.getByTestId("rot-save");
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    // focus is inside the dialog
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="confirm-dialog"]'))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await page.reload();
    await appReady(page);
    expect(await order(page)).toEqual(before);
    // again, and this time confirmed with the keyboard
    await edit(page).focus();
    await page.keyboard.press("Enter");
    await members(page).nth(2).getByRole("button", { name: /^Move .* up$/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("rot-save")).toBeEnabled();
    await page.getByTestId("rot-save").focus();
    await page.keyboard.press("Enter");
    await confirmBtn(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("rot-result")).toBeVisible();
    await expect.poll(() => order(page)).toEqual(["Haeun Kim", "Junho Park", "Jiwoo Han"]);
  });
});

test.describe("a new shared rotation", () => {
  test("E2E desk: created and shown; the same name again is refused; deleted and gone", async ({ page }) => {
    await signIn(page, PATH);
    const create = async () => {
      await page.getByRole("button", { name: "New shared rotation" }).click();
      await page.getByTestId("rot-new-name").fill("E2E desk");
      await page.getByTestId("rot-add-select").selectOption({ index: 1 });
      await page.getByTestId("rot-add").click();
      await page.getByTestId("rot-create").click();
    };
    await create();
    await expect(page.getByTestId("rot-segment")).toContainText("E2E desk");
    await create();
    await expect(page.getByTestId("rot-create-error")).toContainText("Choose a different name.");
    // leave the form, open E2E desk and delete it
    await page.keyboard.press("Escape");
    await page.getByTestId("rot-segment").getByText("E2E desk", { exact: true }).click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(dialog(page)).toBeVisible();
    await confirmBtn(page).click();
    await expect(page.getByTestId("rot-segment")).not.toContainText("E2E desk");
  });
});
