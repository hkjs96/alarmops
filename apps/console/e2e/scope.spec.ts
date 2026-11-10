import { test, expect, type Page } from "@playwright/test";

const PAY_ID = "inc-7f3a0c91b2d4-20261108181204";
const PAY = `/c/mirae/core/payments-api/incident/${PAY_ID}`;
const signIn = (page: Page, next = "/incidents") => page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.(googleapis|gstatic)\.com/.test(m.location().url)) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const settle = (page: Page) => page.waitForTimeout(260); // tree width transition is 180ms
async function noOverflow(page: Page, label: string) {
  const o = await page.evaluate(() => {
    const d = document.documentElement;
    const inner = [...document.querySelectorAll<HTMLElement>(".shell-main > .page, .panel-body, .tw, .sline, .top")]
      .filter((e) => e.offsetParent !== null).map((e) => e.scrollWidth - e.clientWidth);
    return Math.max(d.scrollWidth - d.clientWidth, ...inner);
  });
  expect(o, `horizontal overflow: ${label}`).toBeLessThanOrEqual(0);
}
const treeItem = (page: Page, name: RegExp) => page.getByRole("treeitem", { name });
const rail = (page: Page) => page.locator(".shell").getAttribute("data-rail");
const badge = (page: Page) => page.getByTestId("nav-badge");
const outside = (page: Page) => page.locator(".sline-out").getByTestId("outside-line");

test.describe("tree is docked and pushes content", () => {
  for (const width of [1920, 1440, 1280, 1024, 800]) {
    test(`${width}: tree, list and panel never intersect; nothing overflows`, async ({ page }) => {
      const errors = watchErrors(page);
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      for (const withPanel of [false, true]) {
        if (withPanel) { await page.goto(PAY); await expect(page.getByTestId("panel")).toBeVisible(); }
        for (const wantRail of [true, false]) {
          // put the tree in the wanted state through its own buttons
          if ((await rail(page)) === "1" && !wantRail) await page.getByRole("button", { name: /^Open the customer tree/ }).click();
          if ((await rail(page)) === "0" && wantRail) await page.getByRole("button", { name: "Collapse the tree to a narrow rail" }).click();
          await settle(page);
          const label = `${width} ${withPanel ? "panel" : "list"} ${wantRail ? "rail" : "tree"}`;
          const tree = await box(page, ".stree");
          expect(Math.round(tree.width), label).toBe(wantRail ? 45 : 272);
          expect(tree.x, label).toBe(0);
          const main = await box(page, ".shell-main");
          expect(main.x, `${label}: content starts where the tree ends`).toBeGreaterThanOrEqual(tree.x + tree.width - 0.5);
          expect(main.x + main.width, label).toBeLessThanOrEqual(width + 0.5);
          const listVisible = await page.locator(".shell-main > .page").isVisible();
          if (listVisible) {
            const list = await box(page, ".shell-main > .page");
            expect(list.x, label).toBeGreaterThanOrEqual(tree.x + tree.width - 0.5);
            // every visible thing inside the list stays to the right of the tree
            const leftmost = await page.evaluate(() => Math.min(...[...document.querySelectorAll<HTMLElement>(".shell-main > .page *")]
              .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0 && !e.classList.contains("sr-only")).map((e) => e.getBoundingClientRect().left)));
            expect(leftmost, label).toBeGreaterThanOrEqual(tree.x + tree.width);
            if (withPanel) {
              const panel = await box(page, ".panel");
              expect(panel.x, `${label}: panel beside the list`).toBeGreaterThanOrEqual(list.x + list.width - 0.5);
              expect(panel.width, label).toBeGreaterThanOrEqual(440);
              expect(panel.width, label).toBeLessThanOrEqual(601);
              expect(list.width - 36, `${label}: list keeps 320px`).toBeGreaterThanOrEqual(320);
            }
            // path, status/severity and Acknowledge on every row that has it
            const rows = page.getByTestId("incident-row");
            for (const r of await rows.all()) {
              await expect(r.getByTestId("row-path"), label).toBeVisible();
              await expect(r.locator(".c-sev"), label).toBeVisible();
              await expect(r.locator(".c-status"), label).toBeVisible();
            }
            expect(await page.locator(".t.inc .c-act button:visible").count(), label).toBe(3);
          } else {
            // no room for a 320px list: the panel is the view, still beside the tree
            expect(withPanel, label).toBe(true);
            const panel = await box(page, ".panel");
            expect(panel.x, label).toBeGreaterThanOrEqual(tree.x + tree.width - 0.5);
            await expect(page.getByRole("button", { name: "← Back to the list" })).toBeVisible();
          }
          await noOverflow(page, label);
        }
      }
      expect(errors).toEqual([]);
    });
  }

  test("expanding the rail moves the list by exactly the width the tree gains", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await signIn(page);
    expect(await rail(page)).toBe("1"); // nothing remembered: rail up to 1100px
    const before = (await box(page, ".shell-main > .page h1")).x;
    await page.getByRole("button", { name: /^Open the customer tree beside the list/ }).click();
    await settle(page);
    expect((await box(page, ".shell-main > .page h1")).x - before).toBe(272 - 45);
    await page.reload();
    expect(await rail(page)).toBe("0"); // remembered for the session
  });

  test("width changes over 180ms; not at all with reduced motion", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await expect(page.locator(".shell.ready")).toBeVisible();
    expect(await page.locator(".stree").evaluate((e) => getComputedStyle(e).transitionDuration)).toBe("0.18s");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.locator(".stree").evaluate((e) => getComputedStyle(e).transitionDuration)).toBe("0s");
    await page.getByRole("button", { name: "Collapse the tree to a narrow rail" }).click();
    expect(Math.round((await box(page, ".stree")).width)).toBe(45); // no settle needed
  });

  test("resizes between 200 and 360 and remembers the width", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const sep = page.getByRole("separator", { name: /Resize the tree/ });
    const b = (await sep.boundingBox())!;
    await page.mouse.move(b.x + 3, b.y + 200);
    await page.mouse.down();
    await page.mouse.move(b.x + 3 + 500, b.y + 200, { steps: 5 });
    await page.mouse.up();
    expect(Math.round((await box(page, ".stree")).width)).toBe(360);
    expect((await box(page, ".shell-main")).x).toBeGreaterThanOrEqual(360);
    await sep.focus();
    for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowLeft");
    await settle(page);
    expect(Math.round((await box(page, ".stree")).width)).toBe(200);
    await page.reload();
    await expect(page.locator(".shell.ready")).toBeVisible();
    expect(Math.round((await box(page, ".stree")).width)).toBe(200);
  });
});

test.describe("filter", () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }); });

  test("default is All customers; the tree filters, the outside line appears, the badge does not move", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await expect(page.locator(".sline-desk").first()).toHaveText("All customers · 14");
    await expect(page.getByTestId("incident-row")).toHaveCount(7);
    await expect(badge(page)).toContainText("4");
    await expect(outside(page)).toHaveCount(0);
    await expect(page.getByTestId("row-path").first()).toHaveText("Mirae Pay›Core›Payments API");
    expect(await page.getByTestId("row-path").first().locator("b").innerText()).toBe("Mirae Pay");

    await treeItem(page, /^Mirae Pay/).click();
    await expect(page).toHaveURL(/\/incidents\?customer=mirae$/);
    await expect(page.getByTestId("incident-row")).toHaveCount(1);
    await expect(outside(page)).toHaveText("Outside this view: 3 open (1 from an unmapped account) · 3 acknowledged");
    await expect(badge(page)).toContainText("4");
    await expect(treeItem(page, /^Mirae Pay/)).toHaveAttribute("aria-selected", "true");

    await treeItem(page, /^Core/).click();
    await expect(page).toHaveURL(/\?customer=mirae&project=core$/);
    await treeItem(page, /^Checkout/).click();
    await expect(page).toHaveURL(/\?customer=mirae&project=core&service=checkout$/);
    await expect(page.locator(".sline-desk").first()).toHaveText("MPMirae Pay×›Core×›Checkout×");
    await expect(page.getByTestId("incident-row")).toHaveCount(0);
    await expect(page.getByText("No active incidents in Mirae Pay › Core › Checkout.")).toBeVisible();
    await expect(outside(page)).toHaveText("Outside this view: 4 open (1 from an unmapped account) · 3 acknowledged");

    // × clears one level
    await page.getByRole("button", { name: "Clear Checkout · show all of Core" }).click();
    await expect(page).toHaveURL(/\?customer=mirae&project=core$/);
    await expect(page.getByTestId("incident-row")).toHaveCount(1);
    await page.getByRole("button", { name: "Clear Mirae Pay · show all customers" }).click();
    await expect(page).toHaveURL(/\/incidents$/);
    await expect(outside(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("My customers: 3 listed, 2 open · 2 acknowledged outside; the link removes the filter and offers the way back", async ({ page }) => {
    await signIn(page);
    await treeItem(page, /^My customers/).click();
    await expect(page).toHaveURL(/\?mine=1$/);
    await expect(page.locator(".sline-desk").first()).toHaveText("My customers · 7×");
    await expect(page.getByTestId("incident-row")).toHaveCount(3);
    await expect(outside(page)).toHaveText("Outside this view: 2 open · 2 acknowledged");
    await expect(badge(page)).toContainText("4");
    await outside(page).click();
    await expect(page).toHaveURL(/\/incidents$/);
    await expect(page.getByTestId("incident-row")).toHaveCount(7);
    await page.getByRole("link", { name: "Back to My customers" }).click();
    await expect(page).toHaveURL(/\?mine=1$/);
  });

  test("open in the list + open outside = badge", async ({ page }) => {
    await signIn(page);
    for (const q of ["customer=mirae", "customer=daon&project=commerce&service=checkout", "customer=hanbit", "mine=1", "customer=ara"]) {
      await page.goto(`/incidents?${q}`);
      const inList = await page.locator('[data-testid="incident-row"]:is(.hot, .esc)').count();
      const m = /(\d+) open/.exec(await outside(page).innerText())!;
      expect(inList + Number(m[1]), q).toBe(4);
    }
  });

  test("the filter follows the user to the other screens, and the tree works there", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page, "/incidents?customer=daon&project=commerce");
    for (const name of ["Customers", "Monitoring", "Call order", "People", "Maintenance"]) {
      await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(/customer=daon&project=commerce/);
      await expect(page.getByTestId("scope-echo")).toHaveText("Daon Retail › Commerce");
      await expect(page.locator(".stree")).toBeVisible();
    }
    await treeItem(page, /^Search/).click();
    await expect(page).toHaveURL(/\/maintenance\?customer=daon&project=commerce&service=search$/);
    await expect(page.getByTestId("scope-echo")).toHaveText("Daon Retail › Commerce › Search");
    await expect(outside(page)).toHaveCount(0);
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Settings" }).click();
    await expect(page.locator(".sline")).toContainText("MSP-wide settings · all 14 customers");
    await expect(page.locator(".stree")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("typing in the tree: ancestors shown, duplicates never auto-selected", async ({ page }) => {
    await signIn(page);
    const find = page.getByRole("textbox", { name: /Filter the tree/ });
    await find.fill("checkout");
    await expect(page.locator(".stree-hint")).toHaveText("2 matches in 2 customers · nothing is selected until you choose one");
    await expect(treeItem(page, /^Daon Retail/)).toBeVisible();
    await expect(treeItem(page, /^Commerce/)).toBeVisible();
    await find.press("Enter");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/incidents$/);
    await expect(page.locator(".stree-hint")).toContainText("nothing selected");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\?customer=daon&project=commerce&service=checkout$/);
    await expect(find).toHaveValue("");
  });
});

test.describe("panel", () => {
  test("below 1408 opening a panel collapses the tree; the user can open it again; closing restores", async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, "/incidents?customer=mirae");
    expect(await rail(page)).toBe("0");
    const before = (await box(page, ".shell-main > .page h1")).x;
    await page.getByRole("link", { name: "payments-db-1 FreeStorageSpace below 10 GB" }).click();
    await expect(page).toHaveURL(new RegExp(`${PAY}\\?customer=mirae$`));
    await expect(page.getByTestId("panel-path")).toHaveText("Mirae Pay›Core›Payments API");
    await expect(page.getByTestId("panel-path")).toBeFocused();
    await settle(page);
    expect(await rail(page)).toBe("1");
    expect(before - (await box(page, ".shell-main > .page h1")).x).toBe(272 - 45);
    // the list is still filtered and still there
    await expect(page.getByTestId("incident-row")).toHaveCount(1);
    await expect(page.getByTestId("incident-row")).toHaveAttribute("aria-current", "true");
    await expect(outside(page)).toContainText("3 open");

    await page.getByRole("button", { name: /^Open the customer tree beside the panel/ }).click();
    await settle(page);
    expect(await rail(page)).toBe("0");
    const tree = await box(page, ".stree");
    const list = await box(page, ".shell-main > .page");
    const panel = await box(page, ".panel");
    expect(list.x).toBeGreaterThanOrEqual(tree.width);
    expect(panel.x).toBeGreaterThanOrEqual(list.x + list.width - 0.5);
    await noOverflow(page, "1280 panel + tree");

    await page.getByRole("button", { name: "Collapse the tree to a narrow rail" }).click();
    expect(await rail(page)).toBe("1");
    await page.getByRole("button", { name: "Close panel" }).click();
    await expect(page).toHaveURL(/\/incidents\?customer=mirae$/);
    await settle(page);
    expect(await rail(page)).toBe("0"); // the automatic collapse was not remembered
    expect((await box(page, ".shell-main > .page h1")).x).toBe(before);
    await expect(page.getByRole("link", { name: "payments-db-1 FreeStorageSpace below 10 GB" })).toBeFocused();
    expect(errors).toEqual([]);
  });

  for (const width of [1408, 1440, 1920]) {
    test(`${width}: opening and closing a panel does not move the list (0px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      const x0 = (await box(page, ".shell-main > .page h1")).x;
      const row0 = (await box(page, '[data-testid="incident-row"]')).x;
      await page.getByRole("link", { name: "api-alb 5XX rate above 2%" }).click();
      await expect(page.getByTestId("panel-path")).toHaveText("Hanbit Logistics›Tracking›Public API");
      await settle(page);
      expect(await rail(page)).toBe("0");
      expect((await box(page, ".shell-main > .page h1")).x - x0).toBe(0);
      expect((await box(page, '[data-testid="incident-row"]')).x - row0).toBe(0);
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/incidents$/);
      await settle(page);
      expect((await box(page, ".shell-main > .page h1")).x - x0).toBe(0);
    });
  }

  test("1407: one pixel below the line the tree does collapse", async ({ page }) => {
    await page.setViewportSize({ width: 1407, height: 900 });
    await signIn(page, PAY);
    await expect(page.getByTestId("panel")).toBeVisible();
    expect(await rail(page)).toBe("1");
  });

  test("deep link: reload, back and forward restore panel and filter; Copy link leaves the filter out", async ({ page, context }) => {
    const errors = watchErrors(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 1440, height: 900 });
    const deep = `${PAY}?customer=mirae&project=core`;
    await signIn(page, deep);
    const check = async () => {
      await expect(page).toHaveURL(new RegExp(`${PAY}\\?customer=mirae&project=core$`));
      await expect(page.getByTestId("panel-path")).toHaveText("Mirae Pay›Core›Payments API");
      await expect(page.locator(".sline-desk").first()).toHaveText("MPMirae Pay×›Core×›All services");
      await expect(page.getByTestId("incident-row")).toHaveCount(1);
      await expect(treeItem(page, /^Core/)).toHaveAttribute("aria-selected", "true");
    };
    await check();
    await page.reload();
    await check();
    await page.getByRole("button", { name: "Copy link" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`^http://localhost:\\d+${PAY}$`));

    await page.getByRole("button", { name: "Close panel" }).click();
    await expect(page).toHaveURL(/\/incidents\?customer=mirae&project=core$/);
    await expect(page.getByTestId("panel")).toHaveCount(0);
    await page.goBack();
    await check();
    await page.goBack(); // sign-in redirect entry or the page before it: either way forward returns here
    await page.goForward();
    await check();
    await page.goForward();
    await expect(page).toHaveURL(/\/incidents\?customer=mirae&project=core$/);
    await expect(page.getByTestId("panel")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a panel is independent of the filter, and a filter change closes it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // Hanbit incident open while the list is filtered to Daon: both hold after a reload
    const hanbit = "/c/hanbit/tracking/public-api/incident/inc-a1b5e2c07d33-20261108180512";
    await signIn(page, `${hanbit}?customer=daon`);
    await expect(page.getByTestId("panel-path")).toHaveText("Hanbit Logistics›Tracking›Public API");
    await expect(page.locator(".panel-note")).toHaveText("This incident is outside your list filter.");
    await expect(page.getByTestId("incident-row")).toHaveCount(2);
    // choosing the filter that is already set leaves the panel alone
    await treeItem(page, /^Daon Retail/).click();
    await expect(page.getByTestId("panel")).toBeVisible();
    await treeItem(page, /^Mirae Pay/).click();
    await expect(page).toHaveURL(/\/incidents\?customer=mirae$/);
    await expect(page.getByTestId("panel")).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText("Panel closed · the list now shows Mirae Pay");
  });

  test("unmapped account opens at /c/-/ with no customer in the band", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.getByRole("link", { name: "3 alarms from unmapped account" }).click();
    await expect(page).toHaveURL(/\/c\/-\/incident\/inc-55e0a7b19c4f-20261108175002$/);
    await expect(page.getByTestId("panel-path")).toHaveText("Unmapped account");
  });

  test("Not found: one body for unknown, malformed and wrong-scope addresses", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const urls = [
      "/incidents?customer=nope", "/incidents?customer=mirae&project=nope", "/incidents?customer=mirae&project=core&service=nope",
      "/incidents?customer=Mirae%20Pay", "/monitoring/alarms?customer=nope", "/people?customer=daon&project=core",
      "/c/nope/incident/x", `/c/daon/incident/${PAY_ID}`, `/c/mirae/core/incident/${PAY_ID}`, `/c/mirae/core/checkout/incident/${PAY_ID}`,
      `/c/-/incident/${PAY_ID}`, "/c/mirae/core/payments-api/incident/does-not-exist", "/c/mirae", "/c/mirae/core/payments-api/paging",
      `${PAY}?customer=nope`, "/incidents/does-not-exist", "/nowhere",
    ];
    const bodies = new Set<string>();
    for (const u of urls) {
      await page.goto(u);
      await expect(page.getByTestId("not-found"), u).toBeVisible();
      await expect(page.getByTestId("panel"), u).toHaveCount(0);
      await expect(page.getByTestId("incident-row"), u).toHaveCount(0);
      bodies.add((await page.locator("#main").innerHTML()).replace(/<!--.*?-->/g, "")); // React boundary markers are not content
      expect(page.url().endsWith(u), `address stays as typed: ${u}`).toBe(true);
      await expect(page.locator(".sline-desk").first(), u).toHaveText("All customers · 14");
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).not.toMatch(/Mirae|Daon|nope/);
  });
});

test.describe("column priority", () => {
  const cols = async (page: Page) => ({
    paged: await page.locator(".t.inc thead .c-paged").isVisible(),
    age: await page.locator(".t.inc tbody .c-age").first().isVisible(),
    head: await page.locator(".t.inc thead").isVisible(),
    ack: await page.locator(".t.inc .c-act button:visible").count(),
  });
  test("Paged drops first, then Age, then cards; Acknowledge always stays", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    expect(await cols(page)).toEqual({ paged: true, age: true, head: true, ack: 3 }); // list 1120
    await page.setViewportSize({ width: 1280, height: 900 }); // list 960
    expect(await cols(page)).toEqual({ paged: false, age: true, head: true, ack: 3 });
    await page.setViewportSize({ width: 1101, height: 900 }); // list 781
    expect(await cols(page)).toEqual({ paged: false, age: false, head: true, ack: 3 });
    // remember "expanded", so the tree stays open below 1101px
    await page.getByRole("button", { name: "Collapse the tree to a narrow rail" }).click();
    await page.getByRole("button", { name: /^Open the customer tree/ }).click();
    await page.setViewportSize({ width: 1000, height: 900 }); // list 680 → cards
    await settle(page);
    expect(await cols(page)).toEqual({ paged: false, age: true, head: false, ack: 3 });
    await noOverflow(page, "cards");
    // beside a panel at 1440 with the tree open: the panel gives way to keep the table (list 690)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAY);
    await settle(page);
    expect(await cols(page)).toEqual({ paged: false, age: false, head: true, ack: 3 });
    expect(Math.round((await box(page, ".panel")).width)).toBe(442);
    await noOverflow(page, "1440 tree + table + panel");
  });
});

test.describe("phone 390", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("sheet: Daon Retail › Commerce › Checkout in 4 taps without typing", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await expect(page.locator(".stree")).toBeHidden();
    let taps = 0;
    const tap = async (l: ReturnType<Page["locator"]>) => { await l.tap(); taps++; };
    await tap(page.getByRole("button", { name: /^Showing All customers/ }));
    const sheet = page.getByRole("dialog");
    await expect(sheet).toHaveAccessibleName("Choose a customer");
    for (const r of await sheet.locator(".ssheet-row").all()) expect((await r.boundingBox())!.height).toBeGreaterThanOrEqual(52);
    await tap(sheet.getByTestId("sheet-customer").filter({ hasText: "Daon Retail" }));
    await expect(sheet).toHaveAccessibleName("Choose a project of Daon Retail");
    await expect(page).toHaveURL(/\/incidents$/); // nothing applied yet
    await tap(sheet.getByTestId("sheet-project").filter({ hasText: "Commerce" }));
    await tap(sheet.getByTestId("sheet-service").filter({ hasText: "Checkout" }));
    expect(taps).toBe(4);
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(/\?customer=daon&project=commerce&service=checkout$/);
    await expect(page.getByRole("button", { name: /^Showing Daon Retail Commerce Checkout/ })).toBeVisible();
    await expect(page.getByTestId("incident-row")).toHaveCount(1);
    await expect(page.locator(".sline-out").getByTestId("outside-line")).toHaveText("Outside this view: 4 open (1 from an unmapped account) · 2 acknowledged");
    await expect(page.locator(".bnav .cnt")).toContainText("4");

    // opens on the step that holds the choice; "Use X only" applies exactly that; Back and Close change nothing
    await page.getByRole("button", { name: /^Showing/ }).tap();
    await expect(sheet).toHaveAccessibleName("Choose a service of Commerce");
    await sheet.getByRole("button", { name: "← Back" }).tap();
    await expect(sheet).toHaveAccessibleName("Choose a project of Daon Retail");
    await sheet.getByRole("button", { name: "Close" }).tap();
    await expect(page).toHaveURL(/service=checkout$/);
    await page.getByRole("button", { name: /^Showing/ }).tap();
    await sheet.getByRole("button", { name: "Use Daon Retail › Commerce only" }).tap();
    await expect(page).toHaveURL(/\?customer=daon&project=commerce$/);
    await page.getByRole("button", { name: "Clear the filter, show all customers" }).tap();
    await expect(page).toHaveURL(/\/incidents$/);
    expect(errors).toEqual([]);
  });

  test("the incident is the whole view, with the full path and a way back", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page, "/incidents?customer=mirae");
    await page.getByRole("link", { name: "payments-db-1 FreeStorageSpace below 10 GB" }).tap();
    await expect(page).toHaveURL(new RegExp(`${PAY}\\?customer=mirae$`));
    await expect(page.getByTestId("panel-path")).toHaveText("Mirae Pay›Core›Payments API");
    await expect(page.locator(".shell-main > .page")).toBeHidden();
    const panel = await box(page, ".panel");
    expect(panel.x).toBe(0);
    expect(panel.width).toBe(390);
    await noOverflow(page, "390 panel");
    await page.reload();
    await expect(page.getByTestId("panel-path")).toHaveText("Mirae Pay›Core›Payments API");
    await page.getByRole("button", { name: "← Back to the list" }).tap();
    await expect(page).toHaveURL(/\/incidents\?customer=mirae$/);
    await expect(page.getByTestId("incident-row")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("no horizontal overflow and every tap target is at least 44px", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    const pages = [
      "/incidents", "/incidents?customer=mirae&project=core", "/incidents?mine=1", "/incidents?customer=mirae&project=core&service=checkout",
      PAY, `${PAY}?customer=mirae`, "/c/-/incident/inc-55e0a7b19c4f-20261108175002",
      "/monitoring/alarms?customer=daon", "/call-order", "/people?customer=hanbit&project=fulfilment&service=orders-api", "/maintenance", "/settings/msp-defaults", "/incidents?customer=nope",
    ];
    const targets = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, [role=button], [role=tab]")]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return e.offsetParent !== null && r.width > 0 && cs.visibility !== "hidden" && !e.classList.contains("skip") && !(e as HTMLButtonElement).disabled
          && !e.closest("p, .note, .t2, .kv, .xs, .card-h, .org"); // links inside running text
      })
      .map((e) => { const r = (e.closest(".sel") ?? e).getBoundingClientRect(); return { t: (e.getAttribute("aria-label") ?? e.textContent ?? e.tagName).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((x) => x.w < 44 || x.h < 44));
    for (const p of pages) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      await noOverflow(page, p);
      expect(await targets(), `tap targets under 44px on ${p}`).toEqual([]);
    }
    // the sheet, every step
    await page.goto("/incidents");
    await page.getByRole("button", { name: /^Showing/ }).tap();
    expect(await targets(), "sheet step 1").toEqual([]);
    await page.getByTestId("sheet-customer").filter({ hasText: "Mirae Pay" }).tap();
    expect(await targets(), "sheet step 2").toEqual([]);
    await page.getByTestId("sheet-project").filter({ hasText: "Core" }).tap();
    expect(await targets(), "sheet step 3").toEqual([]);
    await noOverflow(page, "sheet");
    expect(errors).toEqual([]);
  });
});

test("unsaved-changes dialog: Save / Keep draft / Discard / Cancel, focus trapped, Esc cancels", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "/design");
  const opener = page.getByRole("button", { name: "Open the unsaved-changes dialog" });
  await opener.click();
  const dlg = page.getByRole("alertdialog", { name: "Unsaved changes for Mirae Pay › Core" });
  await expect(dlg.getByRole("button")).toHaveText(["Save for Mirae Pay › Core", "Keep draft and change the filter", "Discard changes", "Cancel"]);
  await expect(dlg.getByRole("button", { name: "Save for Mirae Pay › Core" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.getByTestId("guard-choice")).toHaveText("Cancel");
  await expect(opener).toBeFocused();
  await opener.click();
  await dlg.getByRole("button", { name: "Keep draft and change the filter" }).click();
  await expect(page.getByTestId("guard-choice")).toHaveText("Keep draft");
});

// last: this one changes the shared mock store (and puts it back)
test.describe("acknowledge from the row", () => {
  test("acknowledges, the badge and the tree follow, Undo restores", async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/incidents?customer=daon");
    await expect(badge(page)).toContainText("4");
    const row = page.getByTestId("incident-row").filter({ hasText: "KubeNodeNotReady" });
    await row.getByRole("button", { name: /^Acknowledge/ }).click();
    await expect(page.locator(".toast")).toContainText("Acknowledged in Daon Retail › Platform › EKS prod");
    await expect(badge(page)).toContainText("3");
    await expect(row.getByTestId("ack-label")).toHaveText("Acknowledged ✓ 03:16");
    await expect(row.getByRole("button", { name: /^More for / })).toBeVisible(); // Undo is behind … and in the toast, not where Acknowledge was
    await expect(page.getByRole("treeitem", { name: /^Daon Retail$/ })).toBeVisible(); // no open count left on the row
    await page.waitForTimeout(700); // a toast's button is armed 600 ms after it appears (it may come up under a second tap)
    await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
    await expect(badge(page)).toContainText("4");
    await expect(row.getByRole("button", { name: /^Acknowledge/ })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /^Daon Retail, 1 open incident$/ })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
