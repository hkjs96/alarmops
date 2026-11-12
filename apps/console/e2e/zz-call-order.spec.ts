import { test, expect, type Browser, type Page } from "@playwright/test";
import { appReady } from "./helpers/ready";

/**
 * Call order (D-30, D-33): list, read-first panel, edit, save rules, widening, own steps, the unsaved-edit guard on
 * every exit, drafts, 409, keyboard-only editing of three customers in a row, 390px.
 * The mock store is shared by the whole run, so this file is last (zz-) and each test edits its own customer.
 */
/** signs in and waits until the app has taken the page over (helpers/ready.ts) */
const signIn = async (page: Page, next = "/call-order") => {
  await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);
  await appReady(page);
};
const ORDERS = "/c/hanbit/fulfilment/orders-api/call-order";
const ORDERS_PATH = "Hanbit Logistics › Fulfilment › Orders API";

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
/** Every server action the page sends: where it was posted and what it carried. A save names its scope in both. */
function watchActions(page: Page) {
  const calls: { path: string; body: string }[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.headers()["next-action"]) calls.push({ path: new URL(r.url()).pathname, body: r.postData() ?? "" }); });
  return { calls, saves: () => calls.filter((c) => c.body.includes('"steps"')) };
}
async function noOverflow(page: Page, label: string) {
  const o = await page.evaluate(() => {
    const d = document.documentElement;
    const inner = [...document.querySelectorAll<HTMLElement>(".shell-main > .page, .panel-body, .tw, .sline, .top, .dguard")]
      .filter((e) => e.offsetParent !== null).map((e) => e.scrollWidth - e.clientWidth);
    return Math.max(d.scrollWidth - d.clientWidth, ...inner);
  });
  expect(o, `horizontal overflow: ${label}`).toBeLessThanOrEqual(0);
}
const rowBoxes = (page: Page) => page.$$eval('[data-testid="co-row"]', (rows) => rows.map((r) => {
  const b = r.getBoundingClientRect();
  return [(r as HTMLElement).dataset.key, Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(" ");
}));
const panel = (page: Page) => page.getByTestId("panel");
const readView = (page: Page) => page.getByTestId("co-read-view");
const editView = (page: Page) => page.getByTestId("co-edit-view");
const toast = (page: Page) => page.getByTestId("toast");
const guard = (page: Page) => page.getByTestId("dirty-guard");
const confirmDlg = (page: Page) => page.getByTestId("confirm-dialog");
const minutes = (page: Page, step: number) => page.getByLabel(`Step ${step} minutes`);
const sentence = (page: Page) => panel(page).getByTestId("co-sentence");
/** the sentence as it would be saved (without the struck-through old values of the live preview) */
const expectPlain = (page: Page, part: string) => expect(sentence(page)).toHaveAttribute("data-plain", new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
const row = (page: Page, key: string) => page.locator(`[data-testid="co-row"][data-key="${key}"]`);
const drafts = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("ao-draft:call-order:")).sort());
async function openEdit(page: Page, path: string) {
  await page.goto(path);
  await expect(readView(page)).toBeVisible();
  await page.getByTestId("co-edit").click();
  await expect(editView(page)).toBeVisible();
}
/** Undo in a toast is armed 600ms after it appears (it may have come up under a second tap). */
async function undo(page: Page) {
  await page.waitForTimeout(700);
  await toast(page).getByRole("button", { name: "Undo" }).click();
}

test.describe("list", () => {
  test("one row per customer and per level with own steps: path, ordering, who is called first, then, reach", async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await expect(page.getByRole("heading", { level: 1, name: "Call order" })).toBeVisible();
    await expect(page.getByTestId("co-row")).toHaveCount(16); // 14 customers + Mirae Pay › Data platform + Hanbit › Fulfilment › Orders API
    // problem customers first
    await expect(page.getByTestId("co-row").nth(0)).toContainText("Kumho Clinic");
    await expect(page.getByTestId("co-row").nth(0).locator(".c-reach")).toContainText("Unreachable");
    await expect(page.getByTestId("co-row").nth(0).locator(".c-first")).toContainText("nobody");
    await expect(page.getByTestId("co-row").nth(1).locator(".c-reach")).toContainText("At risk");
    // the four ordering patterns of the mockup, with real names
    const expectRow = async (key: string, style: string, first: string, then: string) => {
      await expect(row(page, key).getByTestId("co-style")).toHaveText(style);
      await expect(row(page, key).getByTestId("co-first")).toHaveText(first);
      await expect(row(page, key).locator(".c-then")).toContainText(then);
    };
    await expectRow("mirae", "Custom", "Haeun Kim", "10 min call Yuna Seo");
    await expectRow("daon", "All at once", "Junho, Minjae, Soyeon", "2 min SMS everyone (3)");
    await expectRow("hanbit", "Customer rotation", "Junho Park", "12 min call everyone (4)");
    await expectRow("ara", "Shared rotation", "Haeun Kim", "2 min SMS Haeun · MSP night desk");
    // own-steps rows: full path, customer bold, and the tag
    const own = row(page, "hanbit/fulfilment/orders-api");
    await expect(own.getByTestId("co-path")).toHaveText("Hanbit Logistics›Fulfilment›Orders API");
    await expect(own.locator(".co-path b")).toHaveText("Hanbit Logistics");
    await expect(own.locator(".c-style")).toContainText("Own steps");
    await expect(row(page, "mirae/data-platform").locator(".c-style")).toContainText("Own steps");
    await expect(row(page, "mirae").locator(".c-style")).not.toContainText("Own steps");
    // the list has nothing to type into
    await expect(page.locator(".t.co input, .t.co select, .t.co textarea")).toHaveCount(0);
    await noOverflow(page, "list 1440");
    expect(errors).toEqual([]);
  });

  test("scope filter: the customer's rows, plus a row for the exact level you filtered to", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/call-order?customer=mirae");
    await expect(page.getByTestId("co-row")).toHaveCount(2);
    await page.goto("/call-order?customer=mirae&project=core&service=checkout");
    await expect(page.getByTestId("co-row")).toHaveCount(2);
    const asked = row(page, "mirae/core/checkout");
    await expect(asked).toContainText("your filter");
    await expect(asked.locator(".c-style")).toContainText("inherits from Mirae Pay");
    await page.goto("/call-order?mine=1");
    await expect(page.getByTestId("co-row")).toHaveCount(8); // 7 of Haeun's customers + Data platform
    await page.goto("/call-order?customer=nope");
    await expect(page.getByTestId("not-found")).toBeVisible();
  });

  test("Only with problems (tree) applies to the list", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await expect(page.getByTestId("co-row")).toHaveCount(16);
    const sw = page.getByRole("switch", { name: /^Only with problems/ });
    const n = Number(await page.getByTestId("problem-count").textContent());
    await sw.click();
    await expect(page.getByTestId("co-problems-note")).toContainText(`${14 - n} customers without an open incident or a call-order problem are not listed`);
    const keys = await page.$$eval('[data-testid="co-row"]', (r) => [...new Set(r.map((x) => (x as HTMLElement).dataset.key!.split("/")[0]))]);
    expect(keys).toHaveLength(n);
    expect(keys).toEqual(expect.arrayContaining(["kumho", "lumen"]));
    await page.getByRole("button", { name: "Show all customers" }).click();
    await expect(page.getByTestId("co-row")).toHaveCount(16);
    await sw.click();
    await expect(page.getByTestId("co-problems-note")).toHaveCount(0);
  });

  test("column priority by width: Then goes first, then Reach moves beside the name, then cards with names", async ({ page }) => {
    await signIn(page);
    const visible = (sel: string) => page.locator(`[data-testid="co-row"][data-key="kumho"] ${sel}`).isVisible();
    for (const [width, then, reachCol, inlineTag] of [[1440, true, true, false], [1100, true, true, false], [900, false, true, false], [790, false, false, true]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/call-order");
      await page.waitForTimeout(260);
      expect(await visible(".c-then"), `${width} then`).toBe(then);
      expect(await visible(".c-reach"), `${width} reach column`).toBe(reachCol);
      expect(await visible(".co-hin"), `${width} reach tag beside the name`).toBe(inlineTag);
      for (const sel of [".c-path", ".c-first", ".c-style"]) expect(await visible(sel), `${width} ${sel}`).toBe(true);
      await noOverflow(page, `list ${width}`);
    }
  });
});

test.describe("panel: read first", () => {
  test("opens read-only: sentence with real names and minutes, paged / notified, steps, where it comes from — nothing to type into until Edit", async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/call-order?customer=mirae");
    await row(page, "mirae").getByTestId("co-path").click();
    await expect(page).toHaveURL(/\/c\/mirae\/call-order\?customer=mirae$/);
    await expect(panel(page).locator(".panel-band .ov")).toHaveText("Call order · customer level");
    await expect(page.getByTestId("panel-path")).toHaveText("Mirae Pay");
    await expect(sentence(page)).toHaveText("Slack + call on shift in MSP night desk (Haeun now) now → Call Yuna Seo (Mirae Pay) at 10 min → Call everyone in Responders (5) at 15 min → repeat once.");
    await expect(page.getByTestId("co-paged")).toContainText("Paged (5): Haeun Kim, Yuna Seo, Junho Park, Minjae Lee, Taemin Jung · Also notified (4): Seojun Bae, Hana Noh, Hyejin Lim, Dami Ko.");
    await expect(page.getByTestId("co-steps").locator("li")).toHaveText([/^1\s*0 min.*MSP night desk.*Slack · call$/, /^2\s*10 min.*Yuna Seo \(Mirae Pay\).*Call$/, /^3\s*15 min.*everyone in Responders \(5\).*Call$/, /then.*repeat once/]);
    await expect(page.getByTestId("co-from")).toContainText("Comes from");
    await expect(page.getByTestId("co-from")).toContainText("Mirae Pay · customer steps · Custom, started from Urgent (edited) · used by 4 services (Data platform keeps own steps) · edited by Minjae Lee, Nov 7.");
    // read first: no input of any kind, no Save, no widening, no remove
    await expect(panel(page).locator("input, select, textarea")).toHaveCount(0);
    await expect(page.getByTestId("co-save")).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: /instead…|Remove own steps/ })).toHaveCount(0);
    await expect(page.getByTestId("co-edit")).toHaveText(/^Edit call order for Mirae Pay/);
    await expect(panel(page)).toContainText("Read only. An edit here reaches 4 services.");
    // typing an "e" into a text field is a letter, not Edit
    await page.getByPlaceholder("Find by name…").fill("e");
    await expect(readView(page)).toBeVisible();
    await page.getByPlaceholder("Find by name…").fill("");
    // E opens the editor; Cancel with nothing changed goes straight back
    await page.getByTestId("panel-path").focus();
    await page.keyboard.press("e");
    await expect(editView(page)).toBeVisible();
    await expect(panel(page).locator(".panel-band .ov")).toHaveText("Call order · editing at customer level");
    await expect(minutes(page, 2)).toBeFocused();
    await expect(page.getByTestId("co-save")).toHaveText(/^Save for Mirae Pay/);
    await panel(page).getByRole("button", { name: "Cancel" }).click();
    await expect(readView(page)).toBeVisible();
    await expect(confirmDlg(page)).toHaveCount(0);
    expect(await drafts(page)).toEqual([]);
    // Copy link is the panel's own address, without the reader's filter
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await panel(page).getByRole("button", { name: "Copy link" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/c\/mirae\/call-order$/);
    // Esc closes and the focus is back on the row
    await page.getByTestId("panel-path").focus();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/call-order\?customer=mirae$/);
    await expect(row(page, "mirae").getByTestId("co-path")).toBeFocused();
    expect(errors).toEqual([]);
  });

  test("own steps and inherited steps say where they come from; a link always opens the read view", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, ORDERS);
    await expect(page.getByTestId("panel-path")).toHaveText("Hanbit Logistics›Fulfilment›Orders API");
    await expect(panel(page).locator(".panel-band .ov")).toHaveText("Call order · service level");
    await expect(sentence(page)).toHaveText("Call Hyunwoo Ahn (Hanbit Logistics) now → Call on shift in Hanbit on-call (Junho now) at 5 min → repeat once.");
    await expect(page.getByTestId("co-from")).toContainText(`${ORDERS_PATH} · own steps`);
    await expect(page.getByTestId("co-from")).toContainText("used by 1 service · edited by Junho Park, Oct 29.");
    await expect(page.getByTestId("co-edit")).toHaveText(new RegExp(`^Edit call order for ${ORDERS_PATH}`));

    await page.goto("/c/mirae/core/checkout/call-order");
    await expect(readView(page)).toBeVisible();
    await expect(page.getByTestId("co-from")).toContainText("Inherited from");
    await expect(page.getByTestId("co-from")).toContainText("Mirae Pay. Checkout has no steps of its own and follows it.");
    await expect(page.getByTestId("co-edit")).toHaveText(/^Create own steps for Mirae Pay › Core › Checkout…/);
    await expect(page.getByTestId("co-paged")).toContainText("Also notified (4)");
    await page.getByRole("link", { name: "Open the call order of Mirae Pay →" }).click();
    await expect(page).toHaveURL(/\/c\/mirae\/call-order$/);
    await expect(page.getByTestId("co-from")).toContainText("Comes from");
    // the "where steps come from" tree: read-only navigation between levels
    await page.locator(".co-tree").getByRole("link", { name: /^Data platform/ }).click();
    await expect(page).toHaveURL(/\/c\/mirae\/data-platform\/call-order$/);
    await expect(sentence(page)).toHaveText("Slack on shift in Data desk (Taemin now) now → Slack everyone in Responders (5) at 15 min → no repeat.");
    // wrong addresses are the one Not found
    for (const bad of ["/c/mirae/nope/call-order", "/c/nope/call-order", "/c/mirae/core/checkout/extra/call-order"]) {
      await page.goto(bad);
      await expect(page.getByTestId("not-found")).toBeVisible();
    }
  });

  test("paging health problems are explained in the panel (D-32)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/c/kumho/call-order");
    await expect(page.getByTestId("co-health")).toContainText("Unreachable");
    await expect(page.getByTestId("co-health")).toContainText("If something breaks now, nobody for Kumho Clinic is reached.");
    await expect(page.getByTestId("co-health")).toContainText("Nobody in Responders can be called or texted.");
    await expect(page.getByTestId("co-paged")).toContainText("Paged (0)");
    await page.goto("/c/lumen/call-order");
    const h = page.getByTestId("co-health");
    await expect(h).toContainText("At risk");
    // step 1 is a post in Lumen's Slack channel, which is connected: steps 2 and 3 (SMS, call) and the rotation gap are the problems
    await expect(h.locator("li")).toHaveCount(3);
    await expect(h).not.toContainText("no verified Slack"); // QA P3-H: the banner and the Responders card name the same channels
    await expect(page.getByTestId("co-cust-person").filter({ hasText: "Kyungmin Oh" })).toContainText("SMS · not verified");
    await expect(h).toContainText("Step 2 (SMS at 2 min) reaches only Kyungmin Oh, who has no verified SMS.");
    await expect(h).toContainText("Lumen on-call has nobody on shift from Sat Nov 14 09:00");
    await page.goto("/c/daon/call-order");
    await expect(readView(page)).toBeVisible();
    await expect(page.getByTestId("co-health")).toHaveCount(0);
  });

  test("the incident panel's Paged line links to the call order of the incident's own scope", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/c/mirae/core/payments-api/incident/inc-7f3a0c91b2d4-20261108181204");
    const link = page.getByTestId("paged-line").getByTestId("paged-call-order");
    await expect(link).toHaveAccessibleName("Open the call order of Mirae Pay › Core › Payments API");
    await link.click();
    await expect(page).toHaveURL(/\/c\/mirae\/core\/payments-api\/call-order$/);
    await expect(page.getByTestId("panel-path")).toHaveText("Mirae Pay›Core›Payments API");
    await expect(page.getByTestId("co-from")).toContainText("Inherited from");
    await expect(page.getByRole("link", { name: "Call order", exact: true }).first()).toHaveAttribute("aria-current", "page");
  });
});

test.describe("edit and save", () => {
  test("one service: one Ctrl+Enter applies it — toast with the full path and Undo, no confirmation, nothing moves", async ({ page }) => {
    const errors = watchErrors(page);
    const actions = watchActions(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const before = await rowBoxes(page);
    await row(page, "hanbit/fulfilment/orders-api").getByTestId("co-path").click();
    await expect(readView(page)).toBeVisible();
    await page.getByTestId("co-edit").click();
    await expect(page.getByTestId("co-level")).toContainText(`${ORDERS_PATH}own steps · pages for 1 service`);
    await expect(page.getByTestId("co-unsaved")).toHaveText("");
    await minutes(page, 2).fill("4");
    // live preview: the new value, and the old one struck through
    await expect(sentence(page).locator("b.co-new")).toHaveText("4 min");
    await expect(sentence(page).locator("s.co-old")).toHaveText("was 5 min");
    await expect(page.getByTestId("co-unsaved")).toHaveText("Unsaved");
    await expect(page.getByTestId("co-save")).toHaveText(new RegExp(`^Save for ${ORDERS_PATH}`));
    await page.keyboard.press("Control+Enter");
    await expect(toast(page)).toContainText(`Saved for ${ORDERS_PATH} · step 2 5 → 4 min · 1 service`);
    await expect(confirmDlg(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/call-order$/);
    await expect(panel(page)).toHaveCount(0);
    // exactly one save, sent for exactly this scope
    expect(actions.saves()).toHaveLength(1);
    expect(actions.saves()[0]!.path).toBe(ORDERS);
    expect(actions.saves()[0]!.body).toContain('{"customer":"hanbit","project":"fulfilment","service":"orders-api"}');
    // no row or box moved, and the focus is on the row that was edited
    await expect.poll(() => rowBoxes(page)).toEqual(before); // once the panel has closed: the address changes a moment before the columns do
    await expect(row(page, "hanbit/fulfilment/orders-api").getByTestId("co-path")).toBeFocused();
    await expect(row(page, "hanbit/fulfilment/orders-api").locator(".c-then")).toContainText("4 min call Junho");
    await expect(row(page, "hanbit").locator(".c-then")).toContainText("2 min SMS Junho"); // the customer's own steps are untouched
    expect(await drafts(page)).toEqual([]);
    // Undo puts the previous value back
    await undo(page);
    await expect(toast(page)).toContainText(`Undone · ${ORDERS_PATH} is back to how it was`);
    await expect(row(page, "hanbit/fulfilment/orders-api").locator(".c-then")).toContainText("5 min call Junho");
    await expect.poll(() => rowBoxes(page)).toEqual(before); // once the panel has closed: the address changes a moment before the columns do
    expect(errors).toEqual([]);
  });

  test("more than one service: confirmation with before → after and the services it reaches; no Undo", async ({ page }) => {
    const actions = watchActions(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const before = await rowBoxes(page);
    await openEdit(page, "/c/ara/call-order");
    await minutes(page, 2).fill("3");
    await page.keyboard.press("Control+Enter");
    const dlg = confirmDlg(page);
    await expect(dlg.getByRole("heading")).toHaveText("Save for Ara Games?");
    await expect(dlg.getByTestId("co-changes")).toHaveText("step 2 2 → 3 min");
    await expect(dlg.getByTestId("co-sentence").locator("s")).toHaveText("was 2 min");
    await expect(dlg).toContainText("This changes who is paged for 3 services:");
    await expect(dlg.getByTestId("co-affected").locator("li")).toHaveText(["Ara Games › Live ops › Game API", "Ara Games › Live ops › Matchmaking", "Ara Games › Web › Store"]);
    await expect(dlg).toContainText("Nothing else is changed.");
    expect(actions.saves()).toHaveLength(0); // nothing is sent before the confirmation
    // the safe choice has the focus (QA P3-C): Enter — once too often, or held down from Ctrl+Enter — saves nothing
    await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dlg).toHaveCount(0);
    expect(actions.saves()).toHaveLength(0);
    await expect(editView(page)).toBeVisible();
    await page.keyboard.press("Control+Enter");
    await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
    // Tab stays inside the dialog
    await page.keyboard.press("Tab");
    await expect(dlg.getByRole("button", { name: "Save for Ara Games" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dlg.getByRole("button", { name: "Save for Ara Games" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toast(page)).toContainText("Saved for Ara Games · step 2 2 → 3 min · 3 services");
    await expect(toast(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
    expect(actions.saves().map((s) => s.path)).toEqual(["/c/ara/call-order"]);
    await expect(page).toHaveURL(/\/call-order$/);
    await expect.poll(() => rowBoxes(page)).toEqual(before); // once the panel has closed: the address changes a moment before the columns do
    await expect(row(page, "ara").locator(".c-then")).toContainText("3 min SMS Haeun");
  });

  test("validation: minutes must increase; nobody reachable blocks; an unverified-only step warns", async ({ page }) => {
    const actions = watchActions(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openEdit(page, "/c/eden/call-order");
    await minutes(page, 2).fill("9");
    await expect(page.getByTestId("co-issues")).toContainText("Step 3 (7 min) would not come after step 2 (9 min). Fix the minutes to save.");
    await page.keyboard.press("Control+Enter");
    await expect(confirmDlg(page)).toHaveCount(0);
    await expect(minutes(page, 3)).toBeFocused();
    await expect(minutes(page, 3)).toHaveAttribute("aria-invalid", "true");
    await minutes(page, 2).fill("");
    await expect(page.getByTestId("co-issues")).toContainText("Step 2: minutes must be a whole number");
    await minutes(page, 2).fill("2");
    await expect(page.getByTestId("co-issues")).toHaveText("");
    // no channel on a step
    const way = (step: number, name: string) => page.locator(`[data-step="${step}"]`).getByRole("button", { name, exact: true });
    await expect(page.locator('[data-step="0"] .co-chs button')).toHaveText(["Slack", "Slack DM", "SMS", "Call", "Email"]); // every way to send the API has
    await way(0, "Slack").click();
    await expect(page.getByTestId("co-issues")).toContainText("Step 1: choose at least one way to send it — Slack, Slack DM, SMS, Call or Email.");
    await way(0, "Slack").click();
    expect(actions.saves()).toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/call-order$/); // nothing changed in the end: no guard

    // Daon: Soyeon Choi (customer, Pageable) has no verified phone
    await openEdit(page, "/c/daon/call-order");
    await page.getByLabel("Step 1 calls").selectOption({ label: "Soyeon Choi (customer)" });
    await expect(page.locator(".co-ed")).toContainText("Ordering switched from All at once to Custom");
    // a post in Daon's Slack channel reaches her; a call does not (her phone is not verified)
    await expect(page.getByTestId("co-issues").locator(".co-warn")).toHaveCount(0);
    await way(0, "Call").click();
    await way(0, "Slack").click();
    await expect(page.getByTestId("co-issues").locator(".co-warn")).toHaveText("Warning: Step 1 reaches only contacts that are not verified for call: Soyeon Choi.");
    await page.getByRole("button", { name: "Remove step 3" }).click();
    await page.getByRole("button", { name: "Remove step 2" }).click();
    await expect(page.getByTestId("co-issues").locator(".co-err")).toHaveText("Nobody would be reached: no step has a person with a verified Slack, SMS, phone or email for the way it calls.");
    await page.keyboard.press("Control+Enter");
    await expect(confirmDlg(page)).toHaveCount(0);
    expect(actions.saves()).toHaveLength(0);
    await panel(page).getByRole("button", { name: "Cancel" }).click();
    await confirmDlg(page).getByRole("button", { name: "Discard changes" }).click();
    await expect(readView(page)).toBeVisible();
    expect(await drafts(page)).toEqual([]);
  });

  test("ordering style, starting plan, add / remove / reorder and repeat rebuild the sentence", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openEdit(page, "/c/bora/call-order");
    await expect(page.getByRole("radio", { name: /^Shared rotation/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /^Customer rotation/ })).toBeDisabled(); // Bora has no rotation of its own
    await expect(page.getByLabel("Repeat count")).toHaveValue("1"); // D-20: once by default
    await page.getByRole("button", { name: "Urgent" }).click();
    await expectPlain(page, "Call on shift in MSP night desk (Haeun now) now → Call everyone in Responders (3) at 5 min");
    await expect(page.locator("[data-step]")).toHaveCount(2);
    await page.getByRole("button", { name: "Put my steps back" }).click();
    await expect(page.locator("[data-step]")).toHaveCount(4);
    await page.getByRole("radio", { name: /^All at once/ }).check();
    await expect(page.locator("[data-step]")).toHaveCount(3);
    await expectPlain(page, "Slack everyone in Responders (3) now");
    await page.getByRole("radio", { name: /^Shared rotation/ }).check();
    await page.getByLabel("Rotation", { exact: true }).selectOption({ label: "Data desk (Taemin now)" });
    await expectPlain(page, "Slack on shift in Data desk (Taemin now) now");
    await page.getByTestId("co-add-step").click();
    await expect(page.locator("[data-step]")).toHaveCount(5);
    await expect(minutes(page, 5)).toHaveValue("17");
    await expect(page.getByRole("radio", { name: /^Custom Your own/ })).toBeChecked();
    await page.getByLabel("Step 5 calls").selectOption({ label: "Minjae Lee" });
    await page.locator('[data-step="4"]').getByRole("button", { name: "SMS" }).click();
    await expectPlain(page, "→ SMS + call Minjae Lee at 17 min →");
    await page.getByRole("button", { name: "Move step 5 up" }).click();
    await expectPlain(page, "SMS + call Minjae Lee at 12 min");
    await page.getByLabel("Repeat count").fill("2");
    await expectPlain(page, "repeat twice");
    await expect(sentence(page).locator("s").last()).toHaveText("was repeat once");
    await page.getByLabel("Repeat count").fill("9");
    await expect(page.getByTestId("co-issues")).toContainText("Repeat must be a whole number from 0 to 5.");
    await panel(page).getByRole("button", { name: "Cancel" }).click();
    await expect(confirmDlg(page).getByRole("button", { name: "Keep editing" })).toBeFocused();
    await confirmDlg(page).getByRole("button", { name: "Discard changes" }).click();
    await expectPlain(page, "Slack on shift in MSP night desk (Haeun now) now"); // nothing was saved
  });

  test("widening is an explicit, explained step; a widened save is always confirmed", async ({ page }) => {
    const actions = watchActions(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openEdit(page, ORDERS);
    await expect(page.getByRole("button", { name: "Edit project Fulfilment instead…" })).toBeVisible();
    await page.getByRole("button", { name: "Edit the whole customer instead…" }).click();
    const dlg = confirmDlg(page);
    await expect(dlg.getByRole("heading")).toHaveText("Edit the whole customer Hanbit Logistics instead?");
    await expect(dlg).toContainText(`You opened ${ORDERS_PATH} (1 service). This step switches the panel to Hanbit Logistics.`);
    await expect(dlg.getByTestId("co-widen-list").locator("li")).toHaveText(["Hanbit Logistics › Tracking › Public API", "Hanbit Logistics › Ops › Batch"]);
    await expect(dlg).toContainText(`Not reached: Fulfilment › Orders API (own steps). ${ORDERS_PATH} has its own steps, so it would not change.`);
    // the default is to stay
    await expect(dlg.getByRole("button", { name: `Stay on ${ORDERS_PATH}` })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dlg).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${ORDERS}$`));
    await expect(editView(page)).toBeVisible();
    // in the editor, a wider level in the "where steps come from" tree is the same step, never a plain click
    await page.locator(".co-tree").getByRole("link", { name: /^Hanbit Logistics/ }).click();
    await expect(dlg.getByRole("heading")).toHaveText("Edit the whole customer Hanbit Logistics instead?");
    await dlg.getByRole("button", { name: "Edit Hanbit Logistics · 2 services" }).click();
    await expect(page).toHaveURL(/\/c\/hanbit\/call-order$/);
    await expect(panel(page).locator(".panel-band .ov")).toHaveText("Call order · editing at customer level");
    await expect(page.getByTestId("panel-path")).toHaveText("Hanbit Logistics");
    await expect(page.getByTestId("co-level")).toContainText("Widened from the row you opened.");
    await expect(page.getByTestId("co-save")).toHaveText(/^Save for Hanbit Logistics/);
    await minutes(page, 2).fill("3");
    await page.keyboard.press("Control+Enter");
    await expect(dlg).toContainText(`Wider than the row you opened. You opened ${ORDERS_PATH}; this saves Hanbit Logistics.`);
    await expect(dlg.getByTestId("co-affected").locator("li")).toHaveCount(2);
    await expect(dlg).toContainText("Not changed: Fulfilment › Orders API (own steps).");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    expect(actions.saves()).toHaveLength(0);
    // going back to the row that was opened is one click (and the unsaved wider edit is asked about)
    await page.getByRole("button", { name: "← Back to Orders API" }).click();
    await guard(page).getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(new RegExp(`${ORDERS}$`));
    await expect(readView(page)).toBeVisible();
    await expect(sentence(page)).toContainText("at 5 min");
    expect(await drafts(page)).toEqual([]);
  });

  test("inherited → create own steps: nothing changes until saved; one service applies directly; Undo removes them again", async ({ page }) => {
    const actions = watchActions(page);
    const PORTAL = "Mirae Pay › Merchant › Merchant portal";
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/c/mirae/merchant/merchant-portal/call-order?customer=mirae");
    await expect(page.getByTestId("co-row")).toHaveCount(2);
    await expect(page.getByTestId("co-from")).toContainText("Inherited from");
    await page.getByTestId("co-edit").click();
    await expect(page.getByTestId("co-creating")).toContainText(`Creating own steps for ${PORTAL}`);
    await expect(page.getByTestId("co-creating")).toContainText("Started from the steps of Mirae Pay. Nothing changes until you save.");
    await expect(page.getByTestId("co-save")).toHaveText(new RegExp(`^Save own steps for ${PORTAL}`));
    await expect(page.getByTestId("co-row")).toHaveCount(2); // nothing created yet
    await minutes(page, 2).fill("9");
    await page.keyboard.press("Control+Enter");
    await expect(toast(page)).toContainText(`Own steps created for ${PORTAL} · step 2 10 → 9 min · 1 service`);
    expect(actions.saves()).toHaveLength(1);
    expect(actions.saves()[0]!.path).toBe("/c/mirae/merchant/merchant-portal/call-order");
    expect(actions.saves()[0]!.body).toMatch(/,0\]$/); // If-Match 0: this creates
    // the new level waits above the list instead of pushing rows down; Show puts it in
    await expect(page.getByTestId("co-row")).toHaveCount(2);
    await expect(page.getByTestId("co-list-pending")).toHaveText("1 new level with own steps");
    await page.waitForTimeout(700);
    await page.getByTestId("co-list-bar").getByRole("button", { name: "Show" }).click();
    // a new row, the tree's OWN STEPS mark, and Mirae Pay itself unchanged
    await expect(page.getByTestId("co-row")).toHaveCount(3);
    await expect(row(page, "mirae/merchant/merchant-portal").locator(".c-style")).toContainText("Own steps");
    await expect(row(page, "mirae").locator(".c-then")).toContainText("10 min call Yuna Seo");
    await page.getByRole("treeitem", { name: /^Merchant/ }).locator(".tg").first().click();
    await expect(page.getByRole("treeitem", { name: /^Merchant portal/ })).toContainText("Own steps");
    // Undo arrives by toast only while it is on screen: create once more and undo from the toast
    await row(page, "mirae/merchant/merchant-portal").getByTestId("co-path").click();
    await page.getByTestId("co-edit").click();
    await page.getByRole("button", { name: `Remove own steps of ${PORTAL}…` }).click();
    await confirmDlg(page).getByRole("button", { name: `Remove own steps of ${PORTAL}` }).click();
    await expect(toast(page)).toContainText(`Own steps removed for ${PORTAL}`);
    // the row stays where it was and says what happened, until the list is refreshed
    await expect(page.getByTestId("co-row")).toHaveCount(3);
    await expect(row(page, "mirae/merchant/merchant-portal")).toHaveAttribute("data-gone", "1");
    await expect(row(page, "mirae/merchant/merchant-portal").getByTestId("co-row-gone")).toHaveText("Own steps removed");
    await expect(page.getByTestId("co-list-pending")).toHaveText("1 no longer has own steps");
    await page.waitForTimeout(700);
    await page.getByTestId("co-list-bar").getByRole("button", { name: "Refresh list" }).click();
    await expect(page.getByTestId("co-row")).toHaveCount(2);
    await expect(page.getByRole("treeitem", { name: /^Merchant portal/ })).not.toContainText("Own steps");
  });

  test("remove own steps: only in the editor, confirmed, and the level inherits again", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/c/dasol/main/web/call-order?customer=dasol");
    await page.getByTestId("co-edit").click();
    await page.keyboard.press("Control+Enter");
    await expect(toast(page)).toContainText("Own steps created for Dasol Health › Main › Web · same steps · 1 service");
    await page.waitForTimeout(700);
    await page.getByTestId("co-list-bar").getByRole("button", { name: "Show" }).click();
    await row(page, "dasol/main/web").getByTestId("co-path").click();
    await expect(panel(page).getByRole("button", { name: /Remove own steps/ })).toHaveCount(0);
    await page.getByTestId("co-edit").click();
    await page.getByRole("button", { name: "Remove own steps of Dasol Health › Main › Web…" }).click();
    await expect(confirmDlg(page)).toContainText("Dasol Health › Main › Web would follow Dasol Health again");
    await expect(confirmDlg(page).getByRole("button", { name: "Keep them" })).toBeFocused();
    await confirmDlg(page).getByRole("button", { name: "Remove own steps of Dasol Health › Main › Web" }).click();
    await expect(toast(page)).toContainText("Own steps removed for Dasol Health › Main › Web · it follows Dasol Health again");
    await expect(row(page, "dasol/main/web")).toHaveAttribute("data-gone", "1");
    await page.waitForTimeout(700);
    await page.getByTestId("co-list-bar").getByRole("button", { name: "Refresh list" }).click();
    await expect(page.getByTestId("co-row")).toHaveCount(1);
  });
});

test.describe("unsaved edits", () => {
  test("every way out asks first: menu, tree, Ctrl+K, Esc, Close, another row, browser back", async ({ page }) => {
    const errors = watchErrors(page);
    const actions = watchActions(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await row(page, "cheong").getByTestId("co-path").click();
    await expect(readView(page)).toBeVisible();
    await page.getByTestId("co-edit").click();
    await minutes(page, 2).fill("4");
    const g = guard(page);
    const stays = async (label: string, keep = "Keep draft and continue") => {
      await expect(g.getByRole("heading"), label).toHaveText("Unsaved changes for Cheong Media");
      await expect(g.getByRole("button"), label).toHaveText(["Save for Cheong Media", keep, "Discard changes", "Cancel"]);
      await g.getByRole("button", { name: "Cancel" }).click();
      await expect(g, label).toHaveCount(0);
      await expect(page, label).toHaveURL(/\/c\/cheong\/call-order$/);
      await expect(minutes(page, 2), label).toHaveValue("4");
    };
    // 1 menu
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "People" }).click();
    await stays("menu");
    // 2 tree
    await page.getByRole("treeitem", { name: /^Ara Games/ }).locator(".x").click();
    await stays("tree");
    // 3 Ctrl+K → pick
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder("Customer, project or service…").fill("daon");
    await page.keyboard.press("Enter");
    await stays("Ctrl+K");
    // 4 Esc
    await minutes(page, 2).focus();
    await page.keyboard.press("Escape");
    await stays("Esc");
    // 5 Close button
    await panel(page).getByRole("button", { name: "Close panel" }).click();
    await stays("Close");
    // 6 another row
    await row(page, "mirae").getByTestId("co-path").click();
    await stays("row link");
    await row(page, "daon").locator(".c-first").click();
    await stays("row click");
    // 7 browser back
    await page.goBack();
    await stays("back", "Keep draft and go back");
    // Esc inside the dialog only closes the dialog
    await page.keyboard.press("Escape");
    await expect(g).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(g).toHaveCount(0);
    await expect(editView(page)).toBeVisible();
    expect(actions.saves()).toHaveLength(0);

    // Keep draft: leaves, saves nothing, and the draft waits under its own scope only
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "People" }).click();
    await g.getByRole("button", { name: "Keep draft and continue" }).click();
    await expect(page).toHaveURL(/\/people$/);
    expect(await drafts(page)).toEqual(["ao-draft:call-order:usr_haeun/cheong"]);
    expect(actions.saves()).toHaveLength(0);
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Call order" }).click();
    await expect(page.getByTestId("co-draft")).toContainText("Draft for Cheong Media");
    await expect(row(page, "cheong").locator(".c-then")).toContainText("2 min SMS everyone"); // not saved
    // another customer's panel does not get this draft
    await page.goto("/c/jeil/call-order");
    await expect(page.getByTestId("co-draft-here")).toHaveCount(0);
    await page.getByTestId("co-edit").click();
    await expect(minutes(page, 2)).toHaveValue("2");
    await panel(page).getByRole("button", { name: "Cancel" }).click();
    // Resume → back in the editor with the value
    await page.getByTestId("co-draft").getByRole("button", { name: "Resume" }).click();
    await expect(page).toHaveURL(/\/c\/cheong\/call-order$/);
    await expect(editView(page)).toBeVisible();
    await expect(minutes(page, 2)).toHaveValue("4");
    // back button → Keep draft and go back really goes back
    await page.goBack();
    await expect(g.getByRole("button", { name: "Keep draft and go back" })).toBeVisible();
    await g.getByRole("button", { name: "Keep draft and go back" }).click();
    await expect(page).toHaveURL(/\/c\/jeil\/call-order$/);
    expect(await drafts(page)).toEqual(["ao-draft:call-order:usr_haeun/cheong"]);
    // Save from the dialog: saves (confirmed, two services), then goes where the user was going
    await page.goto("/c/cheong/call-order");
    await page.getByTestId("co-draft-here").getByRole("button", { name: "Resume" }).click();
    await page.getByRole("treeitem", { name: /^Ara Games/ }).locator(".x").click();
    await g.getByRole("button", { name: "Save for Cheong Media" }).click();
    await expect(confirmDlg(page).getByTestId("co-affected").locator("li")).toHaveCount(2);
    await confirmDlg(page).getByRole("button", { name: "Save for Cheong Media" }).click();
    await expect(page).toHaveURL(/\/call-order\?customer=ara$/);
    await expect(toast(page)).toContainText("Saved for Cheong Media · step 2 2 → 4 min · 2 services");
    expect(actions.saves().map((s) => s.path)).toEqual(["/c/cheong/call-order"]);
    expect(await drafts(page)).toEqual([]);
    // Discard: leaves and drops the draft
    await openEdit(page, "/c/cheong/call-order");
    await expect(minutes(page, 2)).toHaveValue("4");
    await minutes(page, 2).fill("6");
    await panel(page).getByRole("button", { name: "Close panel" }).click();
    await g.getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(/\/call-order$/);
    expect(await drafts(page)).toEqual([]);
    expect(actions.saves()).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("a draft survives a reload: Draft for … · Resume, in the panel and in the list", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openEdit(page, "/c/gaon/call-order");
    await minutes(page, 2).fill("6");
    await expect(page.getByTestId("co-unsaved")).toHaveText("Unsaved");
    await page.reload();
    // a link (and a reload) always opens the read view; the draft is offered, not applied
    await expect(readView(page)).toBeVisible();
    await expect(sentence(page)).toContainText("at 2 min");
    await expect(page.getByTestId("co-draft-here")).toContainText("Draft for Gaon Energy");
    await page.goto("/call-order");
    await expect(page.getByTestId("co-draft")).toContainText("Draft for Gaon Energy");
    await page.getByTestId("co-draft").getByRole("button", { name: "Resume" }).click();
    await expect(editView(page)).toBeVisible();
    await expect(minutes(page, 2)).toHaveValue("6");
    await expect(sentence(page).locator("b.co-new")).toHaveText("6 min");
    await expect(sentence(page).locator("s.co-old")).toHaveText("was 2 min");
    await expect(page.getByTestId("co-unsaved")).toHaveText("Unsaved");
    // the draft holds ids and minutes, nothing that identifies a contact's address
    const raw = await page.evaluate(() => sessionStorage.getItem("ao-draft:call-order:usr_haeun/gaon"));
    expect(raw).not.toMatch(/@|010-/);
    await panel(page).getByRole("button", { name: "Cancel" }).click();
    await confirmDlg(page).getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByTestId("co-draft-here")).toHaveCount(0);
    expect(await drafts(page)).toEqual([]);
  });

  test("409: someone else saved first — changed, reload; the draft is kept and nothing is overwritten", async ({ page, browser }) => {
    const actions = watchActions(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openEdit(page, "/c/jeil/call-order");
    await minutes(page, 2).fill("4");
    // meanwhile, in another session
    await saveElsewhere(browser, "/c/jeil/call-order", "6", "Save for Jeil Insure");
    await page.keyboard.press("Control+Enter");
    await confirmDlg(page).getByRole("button", { name: "Save for Jeil Insure" }).click();
    const c = page.getByTestId("co-conflict");
    await expect(c).toContainText("Changed — reload.");
    await expect(c).toContainText("Nothing was saved, and your draft is kept as you typed it.");
    await expect(page).toHaveURL(/\/c\/jeil\/call-order$/);
    await expect(minutes(page, 2)).toHaveValue("4");
    expect(await drafts(page)).toEqual(["ao-draft:call-order:usr_haeun/jeil"]);
    await expect(page.getByTestId("co-save")).toBeDisabled();
    await page.getByTestId("co-reload").click();
    await expect(c).toContainText("Now saved");
    await expect(c.locator(".co-cmp").nth(0)).toContainText("at 6 min");
    await expect(c.locator(".co-cmp").nth(1)).toContainText("at 4 min");
    await expect(minutes(page, 2)).toHaveValue("4");
    await expect(page.getByTestId("co-save")).toBeDisabled();
    await page.keyboard.press("Control+Enter"); // still blocked
    await expect(confirmDlg(page)).toHaveCount(0);
    await page.getByTestId("co-rebase").click();
    await expect(c).toHaveCount(0);
    await expect(sentence(page).locator("s.co-old")).toHaveText("was 6 min"); // compared with what is saved now
    await page.getByTestId("co-save").click();
    await expect(confirmDlg(page).getByTestId("co-changes")).toHaveText("step 2 6 → 4 min");
    // the same button at the same spot as the confirmation a moment ago: the 600 ms same-spot guard holds a press that comes sooner than a person can read
    await page.waitForTimeout(700);
    await confirmDlg(page).getByRole("button", { name: "Save for Jeil Insure" }).click();
    await expect(toast(page)).toContainText("Saved for Jeil Insure · step 2 6 → 4 min · 2 services");
    expect(actions.saves()).toHaveLength(2); // the refused one and the one that went through
    expect(await drafts(page)).toEqual([]);
  });
});

async function saveElsewhere(browser: Browser, path: string, value: string, confirmName?: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const other = await ctx.newPage();
  await signIn(other, path);
  await other.getByTestId("co-edit").click();
  await minutes(other, 2).fill(value);
  await other.keyboard.press("Control+Enter");
  if (confirmName) await confirmDlg(other).getByRole("button", { name: confirmName }).click();
  await expect(toast(other)).toContainText("Saved for");
  await ctx.close();
}

test("keyboard only: three customers in a row, each save lands on its own customer", async ({ page }) => {
  const errors = watchErrors(page);
  const actions = watchActions(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const steps: [query: string, slug: string, name: string, from: string, to: string][] = [
    ["mirae", "mirae", "Mirae Pay", "10", "8"], ["daon", "daon", "Daon Retail", "2", "5"], ["hanbit", "hanbit", "Hanbit Logistics", "2", "4"],
  ];
  for (const [query, slug, name, from, to] of steps) {
    await page.keyboard.press("Control+k");
    await expect(page.getByPlaceholder("Customer, project or service…")).toBeFocused();
    await page.keyboard.type(query);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/call-order\\?customer=${slug}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    // Tab to the customer's row
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate((k) => (document.activeElement as HTMLElement | null)?.dataset.key === k, slug)) break;
    }
    await expect(row(page, slug).getByTestId("co-path")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(readView(page)).toBeVisible();
    await expect(page.getByTestId("panel-path")).toHaveText(name);
    await page.keyboard.press("e");
    await expect(minutes(page, 2)).toBeFocused();
    await expect(minutes(page, 2)).toHaveValue(from);
    if (slug === "hanbit") {
      // 9 would come after step 3 (7 min): the save is blocked, nothing is sent
      await page.keyboard.type("9");
      await page.keyboard.press("Control+Enter");
      await expect(page.getByTestId("co-issues")).toContainText("Step 3 (7 min) would not come after step 2 (9 min)");
      await expect(confirmDlg(page)).toHaveCount(0);
      // the focus went to the minute that is out of order (step 3): back to step 2
      await expect(minutes(page, 3)).toBeFocused();
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Shift+Tab");
        if (await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Step 2 minutes")) break;
      }
      await expect(minutes(page, 2)).toBeFocused();
      await page.keyboard.press("Control+a");
    }
    await page.keyboard.type(to);
    await expect(sentence(page).locator("b.co-new")).toHaveText(`${to} min`);
    await page.keyboard.press("Control+Enter");
    await expect(confirmDlg(page).getByRole("heading")).toHaveText(`Save for ${name}?`);
    await expect(confirmDlg(page).getByTestId("co-changes")).toHaveText(`step 2 ${from} → ${to} min`);
    // the focus is on Cancel; Shift+Tab goes to "Save for <customer>"
    await page.keyboard.press("Shift+Tab");
    await expect(confirmDlg(page).getByRole("button", { name: `Save for ${name}` })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toast(page)).toContainText(`Saved for ${name} · step 2 ${from} → ${to} min`);
    await expect(page).toHaveURL(new RegExp(`/call-order\\?customer=${slug}$`));
    await expect(row(page, slug).getByTestId("co-path")).toBeFocused(); // focus back on the edited row
  }
  // three saves, each posted from its own panel address and carrying its own customer — never another one
  const saves = actions.saves();
  expect(saves.map((s) => s.path)).toEqual(["/c/mirae/call-order", "/c/daon/call-order", "/c/hanbit/call-order"]);
  steps.forEach(([, slug], i) => {
    expect(saves[i]!.body).toContain(`{"customer":"${slug}"}`);
    for (const [, otherSlug] of steps) if (otherSlug !== slug) expect(saves[i]!.body).not.toContain(`"${otherSlug}"`);
  });
  // and the stored values did not mix
  await page.goto("/call-order");
  await expect(row(page, "mirae").locator(".c-then")).toContainText("8 min call Yuna Seo");
  await expect(row(page, "daon").locator(".c-then")).toContainText("5 min SMS everyone (3)");
  await expect(row(page, "hanbit").locator(".c-then")).toContainText("4 min SMS Junho");
  await expect(row(page, "hanbit").locator(".c-then")).toContainText("7 min call Junho");
  await expect(row(page, "hanbit/fulfilment/orders-api").locator(".c-then")).toContainText("5 min call Junho"); // own steps untouched
  await expect(row(page, "mirae/data-platform").locator(".c-then")).toContainText("15 min Slack everyone (5)");
  expect(errors).toEqual([]);
});

test.describe("responders in the panel", () => {
  test("read: staff and customer people with roles; contacts are masked and there is no reveal yet", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/c/mirae/call-order");
    const card = page.getByTestId("co-responders");
    await expect(card.getByTestId("co-staff")).toHaveCount(4);
    await expect(card.getByTestId("co-staff").first()).toContainText("Haeun Kim");
    await expect(card.getByTestId("co-staff").first()).toContainText("from Infra core");
    await expect(card.getByTestId("co-staff").last()).toContainText("added directly");
    const yuna = card.getByTestId("co-cust-person").filter({ hasText: "Yuna Seo" });
    await expect(yuna.getByTestId("co-role")).toHaveText("Pageable");
    await expect(yuna).toContainText("step 2");
    await expect(yuna).toContainText("SMS · not verified");
    await expect(yuna.getByTestId("co-masked")).toHaveText(/^y•••@mirae\.example · 010-••••-\d{4}$/);
    await expect(card.getByTestId("co-cust-person").filter({ hasText: "Seojun Bae" }).getByTestId("co-role")).toHaveText("Notify only");
    for (const t of await card.getByTestId("co-masked").allTextContents()) expect(t).toMatch(/•••|no contact on file/);
    await expect(card.getByTestId("co-mask-note")).toContainText("Contact details are masked.");
    await expect(card.getByRole("button", { name: /reveal/i })).toHaveCount(0);
    await expect(card.locator("input, select")).toHaveCount(0);
    expect(await page.content()).not.toMatch(/010-\d{4}-\d{4}/);
  });

  // editing Responders (add, role, Remove… with confirmation, tombstones, per-person Undo, 409): e2e/zzz-list-rule.spec.ts
});

test.describe("390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  async function taps(page: Page, label: string) {
    const small = await page.evaluate(() => {
      const out: string[] = [];
      const els = document.querySelectorAll<HTMLElement>(".shell-main a, .shell-main button, .shell-main select, .shell-main input, .dguard button, .toast button");
      for (const e of els) {
        if (e.offsetParent === null || e.closest(".sr-only")) continue;
        const target = e instanceof HTMLInputElement && e.type === "radio" ? (e.closest("label") ?? e) : e;
        const b = target.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.height < 44) out.push(`${e.tagName} "${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 40)}" ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
      return out;
    });
    expect(small, `tap targets under 44px: ${label}`).toEqual([]);
  }

  test("cards show who gets called by name; read → edit → save with touch; no overflow; taps ≥ 44px", async ({ page }) => {
    const errors = watchErrors(page);
    const actions = watchActions(page);
    await signIn(page);
    // cards: the names answer "who gets called" without opening anything
    const daon = row(page, "daon");
    await expect(daon.getByTestId("co-first")).toBeVisible();
    await expect(daon.getByTestId("co-first")).toHaveText("Junho, Minjae, Soyeon");
    await expect(daon).toContainText("everyone in Responders (3), all at once");
    await expect(page.locator(".t.co thead")).toBeHidden();
    const [pathBox, firstBox] = [await daon.getByTestId("co-path").boundingBox(), await daon.getByTestId("co-first").boundingBox()];
    expect(firstBox!.y).toBeGreaterThan(pathBox!.y); // path, then the names, before anything else
    expect(firstBox!.y).toBeLessThan((await daon.locator(".c-style").boundingBox())!.y);
    await expect(row(page, "kumho").locator(".co-hin")).toBeVisible(); // Reach as a tag beside the name
    await noOverflow(page, "390 list");
    await taps(page, "list");

    // read view, full screen; the one action is fixed at the bottom
    await row(page, "haneul").getByTestId("co-path").tap();
    await expect(readView(page)).toBeVisible();
    await expect(page.locator(".shell-main > .page")).toBeHidden();
    await expect(panel(page).locator("input, select, textarea")).toHaveCount(0);
    const edit = page.getByTestId("co-edit");
    await expect(edit).toBeInViewport();
    const eb = (await edit.boundingBox())!;
    expect(eb.height).toBeGreaterThanOrEqual(44);
    expect(eb.y + eb.height).toBeLessThanOrEqual(844 - 56 + 1); // above the bottom menu
    await page.mouse.wheel(0, 600);
    await expect(edit).toBeInViewport(); // still there after scrolling
    await noOverflow(page, "390 read");
    await taps(page, "read");

    await edit.tap();
    await expect(editView(page)).toBeVisible();
    await noOverflow(page, "390 edit");
    await taps(page, "edit");
    await minutes(page, 2).fill("3");
    await expect(page.getByTestId("co-save")).toBeInViewport();
    expect((await page.getByTestId("co-save").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // guard at 390
    await panel(page).getByRole("button", { name: "Close panel" }).tap();
    await expect(guard(page)).toBeVisible();
    await noOverflow(page, "390 guard");
    await taps(page, "guard");
    await guard(page).getByRole("button", { name: "Cancel" }).tap();
    // save → confirmation (two services) → toast
    await page.getByTestId("co-save").tap();
    await expect(confirmDlg(page).getByRole("heading")).toHaveText("Save for Haneul Air?");
    await noOverflow(page, "390 confirm");
    for (const b of await confirmDlg(page).getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await confirmDlg(page).getByRole("button", { name: "Save for Haneul Air" }).tap();
    await expect(toast(page)).toContainText("Saved for Haneul Air · step 2 2 → 3 min · 2 services");
    expect(actions.saves().map((s) => s.path)).toEqual(["/c/haneul/call-order"]);
    await expect(page).toHaveURL(/\/call-order$/);
    await noOverflow(page, "390 after save");

    // one service at 390: direct, with Undo
    await page.goto(ORDERS);
    await page.getByTestId("co-edit").tap();
    await noOverflow(page, "390 edit, service level (long path in every button)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await taps(page, "edit, service level");
    await minutes(page, 2).fill("6");
    await page.getByTestId("co-save").tap();
    await expect(toast(page)).toContainText(`Saved for ${ORDERS_PATH} · step 2 5 → 6 min · 1 service`);
    await taps(page, "toast");
    await noOverflow(page, "390 toast");
    await page.waitForTimeout(700);
    await toast(page).getByRole("button", { name: "Undo" }).tap();
    await expect(toast(page)).toContainText("Undone");
    // responders editor at 390
    await page.goto("/c/daon/call-order");
    await page.getByTestId("co-resp-edit").tap();
    await noOverflow(page, "390 responders edit");
    await taps(page, "responders edit");
    expect(errors).toEqual([]);
  });
});

test.describe("layout", () => {
  for (const width of [1440, 1280, 1024, 800]) {
    test(`${width}: list and panel side by side or panel alone, nothing overflows, in read and edit`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page, "/c/mirae/call-order");
      await expect(readView(page)).toBeVisible();
      await page.waitForTimeout(260);
      await noOverflow(page, `${width} read`);
      const p = (await panel(page).boundingBox())!;
      expect(p.x + p.width).toBeLessThanOrEqual(width + 0.5);
      if (await page.locator(".shell-main > .page").isVisible()) {
        const list = (await page.locator(".shell-main > .page").boundingBox())!;
        expect(p.x).toBeGreaterThanOrEqual(list.x + list.width - 0.5);
        await expect(row(page, "mirae").getByTestId("co-path")).toBeVisible();
        await expect(row(page, "mirae").getByTestId("co-first")).toBeVisible();
      }
      await page.getByTestId("co-edit").click();
      await noOverflow(page, `${width} edit`);
      await expect(page.getByTestId("co-save")).toBeInViewport();
      const save = (await page.getByTestId("co-save").boundingBox())!;
      expect(save.x + save.width).toBeLessThanOrEqual(width + 0.5);
    });
  }
});
