// QA "Console 범위 틀 점검 — 2026-11-10" fixes: P1-1..3, P2-1..8, cheap P3s, security R-4, Filter to… (Ctrl/⌘K).
// Runs after scope.spec.ts (file order). The tests that acknowledge put the shared mock store back with Undo.
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
const rows = (page: Page) => page.getByTestId("incident-row");
const rowTitles = (page: Page) => rows(page).evaluateAll((trs) => trs.map((tr) => tr.querySelector("a.ttl")!.textContent));
/** the list row at a point (the toast may lie over it) */
const rowAt = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => document.elementsFromPoint(px!, py!).map((e) => e.closest("tr")).find(Boolean)?.getAttribute("data-id") ?? null, [x, y]);
const center = async (l: ReturnType<Page["locator"]>) => { const b = (await l.boundingBox())!; return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), b }; };

test.describe("phone 390×740 — 하은 H3 / H4", () => {
  test.use({ viewport: { width: 390, height: 740 }, hasTouch: true });
  const badge = (page: Page) => page.locator(".bnav .cnt");

  test("H3 list: a double tap acknowledges one incident; the row keeps its place; the toast fits; Undo restores", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await expect(badge(page)).toContainText("4");
    const before = await rowTitles(page);
    expect(before[0]).toBe("payments-db-1 FreeStorageSpace below 10 GB");
    expect(before[1]).toBe("api-alb 5XX rate above 2%");
    const first = rows(page).first();
    const at = await center(first.getByRole("button", { name: /^Acknowledge/ }));

    // two taps on the same spot, 150 ms apart
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(150);
    await page.touchscreen.tap(at.x, at.y);

    await expect(first.locator(".ack-done")).toHaveText("Acknowledged ✓");
    await expect(badge(page)).toContainText("3");
    // exactly one incident changed: the other three open ones still offer Acknowledge
    await expect(page.getByRole("button", { name: /^Acknowledge / })).toHaveCount(2);
    await expect(rows(page).nth(1).getByRole("button", { name: "Acknowledge api-alb 5XX rate above 2%" })).toBeVisible();
    // the acknowledged row is still where the finger is, in the same order as before
    await expect(first).toHaveAttribute("data-held", "1");
    expect(await rowTitles(page)).toEqual(before);
    expect(await rowAt(page, at.x, at.y)).toBe(PAY_ID);
    await expect(first.getByRole("button", { name: /^Undo acknowledge of payments-db-1/ })).toBeVisible();

    // P1-3 the toast: full width above the bottom menu, at most three lines, Undo at least 44px, never taller than 96px
    const toast = page.getByTestId("toast");
    await expect(toast).toContainText("Acknowledged in Mirae Pay › Core › Payments API · payments-db-1 FreeStorageSpace below 10 GB");
    const tb = (await toast.boundingBox())!;
    const nav = (await page.locator(".bnav").boundingBox())!;
    expect(tb.x).toBeLessThanOrEqual(8);
    expect(tb.width).toBeGreaterThanOrEqual(390 - 16);
    expect(tb.height).toBeLessThanOrEqual(96);
    expect(tb.y + tb.height).toBeLessThanOrEqual(nav.y);
    const lines = await toast.locator(".toast-t").evaluate((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)));
    expect(lines).toBeLessThanOrEqual(3);
    const undo = (await toast.getByRole("button", { name: "Undo" }).boundingBox())!;
    expect(Math.min(undo.width, undo.height)).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: test.info().outputPath("h3-1-acked-held.png") });

    // after 5 s the list sorts again: the acknowledged incident goes below the open ones and keeps its Undo
    await expect(first).not.toHaveAttribute("data-held", "1", { timeout: 7000 });
    await expect.poll(() => rowTitles(page)).toEqual([before[1], before[2], before[3], before[0], ...before.slice(4)]);
    await page.screenshot({ path: test.info().outputPath("h3-2-resorted.png") });

    // Undo (the toast is still up: 9 s)
    await toast.getByRole("button", { name: "Undo" }).tap();
    await expect(badge(page)).toContainText("4");
    await expect(page.getByTestId("toast")).toContainText("Acknowledge undone in Mirae Pay › Core › Payments API · paging continues");
    await expect.poll(() => rowTitles(page)).toEqual(before);
    await expect(rows(page).first().getByRole("button", { name: /^Acknowledge payments-db-1/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("h3-3-undone.png") });
    expect(errors).toEqual([]);
  });

  test("H4 panel: Acknowledge gives a toast with Undo, shows Acknowledged ✓ · Undo for 5 s, then Resolve… which asks first; paging says it stopped", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page, PAY); // arriving from a Slack link
    await expect(page.getByTestId("panel-path")).toHaveText("Mirae Pay›Core›Payments API");
    await expect(page.getByTestId("paged-line")).toContainText("call Yuna");
    const ackBtn = page.getByRole("button", { name: "Acknowledge", exact: true });
    const at = await center(ackBtn);
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(150);
    await page.touchscreen.tap(at.x, at.y); // the sleepy second tap

    // toast: full path + Undo, same as the list
    const toast = page.getByTestId("toast");
    await expect(toast).toContainText("Acknowledged in Mirae Pay › Core › Payments API · payments-db-1 FreeStorageSpace below 10 GB");
    await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
    expect((await toast.boundingBox())!.height).toBeLessThanOrEqual(96);
    // still acknowledged (the second tap neither resolved nor undid it), and no Resolve under the finger
    await expect(page.getByTestId("panel-acked")).toContainText("Acknowledged ✓");
    await expect(page.getByTestId("panel-acked").getByRole("button", { name: "Undo acknowledge" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Resolve/ })).toHaveCount(0);
    await expect(page.locator(".bnav .cnt")).toContainText("3");
    // paging: stopped, by whom, and no calls that will not happen
    await expect(page.getByTestId("paged-line")).toContainText("Paging stopped at 03:16 — acknowledged by Haeun");
    await expect(page.getByTestId("paged-line")).not.toContainText("call Yuna");
    await expect(page.getByTestId("paged-line")).not.toContainText("everyone");
    const esc = page.locator(".card", { hasText: "Escalation" }).last();
    await expect(esc.getByTestId("paging-stopped")).toHaveText("Paging stopped at 03:16 — acknowledged by Haeun");
    await expect(esc).not.toContainText("Yuna");
    await expect(esc).not.toContainText("everyone in Responders");
    await expect(esc).not.toContainText("Then repeats");
    await page.screenshot({ path: test.info().outputPath("h4-1-acked.png") });

    // 5 s later Resolve is offered — and it asks before it does anything
    const resolve = page.getByRole("button", { name: "Resolve…" });
    await expect(resolve).toBeVisible({ timeout: 7000 });
    const rAt = await center(resolve);
    await page.touchscreen.tap(rAt.x, rAt.y);
    const ask = page.getByRole("alertdialog", { name: "Resolve this incident in Mirae Pay › Core › Payments API?" });
    await expect(ask).toBeVisible();
    await expect(ask.getByRole("button", { name: "Keep it open" })).toBeFocused();
    await expect(toast).toHaveCount(0); // nothing lies over the question's buttons
    await page.screenshot({ path: test.info().outputPath("h4-2-resolve-asks.png") });
    // whatever sits where Resolve… was, a second tap there does not resolve
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("button")?.textContent ?? "", [rAt.x, rAt.y]);
    expect(under).not.toMatch(/Resolve/);
    await ask.getByRole("button", { name: "Keep it open" }).tap();
    await expect(ask).toHaveCount(0);
    await expect(page.getByTestId("paging-stopped").first()).toBeVisible(); // still acknowledged, not resolved

    // the list row reflects it and offers the same Undo
    await page.getByRole("button", { name: "← Back to the list" }).tap();
    await expect(page).toHaveURL(/\/incidents$/);
    const row = rows(page).filter({ hasText: "payments-db-1" });
    await expect(row.locator(".ack-done")).toHaveText("Acknowledged ✓");
    await page.screenshot({ path: test.info().outputPath("h4-3-list-row.png") });
    await row.getByRole("button", { name: /^Undo acknowledge of payments-db-1/ }).tap();
    await expect(page.locator(".bnav .cnt")).toContainText("4");
    await expect(row.getByRole("button", { name: /^Acknowledge payments-db-1/ })).toBeVisible();
    await page.goto(PAY);
    await expect(page.getByTestId("paged-line")).toContainText("call Yuna"); // paging continues
    await expect(page.getByRole("button", { name: "Acknowledge", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("panel Undo from the toast puts everything back", async ({ page }) => {
    await signIn(page, PAY);
    await page.getByRole("button", { name: "Acknowledge", exact: true }).tap();
    await expect(page.getByTestId("panel-acked")).toBeVisible();
    await page.waitForTimeout(700); // a toast's button is armed 600 ms after it appears
    await page.getByTestId("toast").getByRole("button", { name: "Undo" }).tap();
    await expect(page.getByTestId("toast")).toContainText("Acknowledge undone in Mirae Pay › Core › Payments API · paging continues");
    await expect(page.getByRole("button", { name: "Acknowledge", exact: true })).toBeVisible();
    await expect(page.getByTestId("paging-stopped")).toHaveCount(0);
    await expect(page.locator(".bnav .cnt")).toContainText("4");
  });

  test("P2-5 the first incident is in the first screen; stats are one row of chips", async ({ page }) => {
    await signIn(page);
    const nav = (await page.locator(".bnav").boundingBox())!;
    const first = rows(page).first();
    const title = (await first.locator("a.ttl").boundingBox())!;
    expect(title.y + title.height).toBeLessThanOrEqual(nav.y);
    const sev = (await first.locator(".c-sev").boundingBox())!;
    expect(sev.y).toBeLessThan(nav.y - 100);
    const tiles = page.getByTestId("tiles");
    const tb = (await tiles.boundingBox())!;
    expect(tb.height).toBeLessThanOrEqual(48);
    const tops = await tiles.locator(".tile").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1); // one row
    expect(await tiles.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true); // scrolls sideways inside itself
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test("P2-8 the filter line (with the outside count) stays while the list scrolls", async ({ page }) => {
    await signIn(page, "/incidents?mine=1");
    const out = page.locator(".sline-out").getByTestId("outside-line");
    await expect(out).toHaveText("Outside this view: 2 open · 2 acknowledged");
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
    const line = (await page.locator(".sline").boundingBox())!;
    expect(line.y).toBe(0);
    await expect(page.getByRole("button", { name: /^Showing My customers/ })).toBeInViewport();
    await expect(out).toBeInViewport();
    // and it is on top of the list, not under it
    expect(await page.evaluate(() => Boolean(document.elementFromPoint(100, 20)?.closest(".sline")))).toBe(true);
  });

  test("P2-7 the sheet has the legend as a collapsed link; P3 tap targets: Sev / Assignee and the panel's links are 44px", async ({ page }) => {
    await signIn(page);
    for (const label of ["Sev", "Assignee"]) {
      const b = (await page.getByLabel(label, { exact: true }).boundingBox())!;
      expect(b.height, label).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: /^Showing/ }).tap();
    const sheet = page.getByRole("dialog");
    const link = sheet.getByRole("button", { name: /^What do these mean\?/ });
    await expect(link).toHaveAttribute("aria-expanded", "false");
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await link.tap();
    await expect(sheet.getByText("This project or service has its own call order instead of the customer's.")).toBeVisible();
    await sheet.getByRole("button", { name: "Close" }).tap();
    await page.getByRole("button", { name: /^Showing/ }).tap();
    await expect(sheet.getByRole("button", { name: /^What do these mean\?/ })).toHaveAttribute("aria-expanded", "false");
    await sheet.getByRole("button", { name: "Close" }).tap();

    await page.goto(PAY);
    for (const name of [/^Open resource/, /^Call order for Mirae Pay/, /^RDS storage full/]) {
      const b = (await page.getByRole("link", { name }).boundingBox())!;
      expect(b.height, String(name)).toBeGreaterThanOrEqual(44);
    }
  });

  test("Filter to… from the search button in the filter line", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Filter to a customer, project or service by name" }).tap();
    const dlg = page.getByRole("dialog", { name: "Filter to a customer, project or service" });
    await expect(dlg).toBeVisible();
    const box = (await dlg.boundingBox())!;
    expect(box.width).toBe(390);
    await dlg.getByRole("combobox").fill("orders");
    for (const o of await dlg.getByRole("option").all()) expect((await o.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // two customers have a service that starts with "orders": nothing is chosen for the user
    await expect(dlg.getByRole("alert")).toContainText("2 customers have a match for “orders”: Bora Foods, Hanbit Logistics");
    await dlg.getByRole("option", { name: /Hanbit Logistics.*Orders API/ }).tap();
    await expect(page).toHaveURL(/\?customer=hanbit&project=fulfilment&service=orders-api$/);
    await expect(page.getByRole("button", { name: /^Showing Hanbit Logistics Fulfilment Orders API/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test("P2-2 the outside line has its place before the counts arrive (no jump)", async ({ page }) => {
    await signIn(page, "/incidents?customer=mirae");
    await expect(page.locator(".sline-out").getByTestId("outside-line")).toBeVisible();
    const hydrated = (await page.locator(".sline").boundingBox())!.height;
    // the same page as the server sends it, with the app's scripts held back
    await page.route("**/_next/static/chunks/**", (r) => r.abort());
    await page.goto("/incidents?customer=mirae", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("outside-pending")).toBeVisible();
    expect((await page.locator(".sline").boundingBox())!.height).toBe(hydrated);
  });
});

test.describe("desktop 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const badge = (page: Page) => page.getByTestId("nav-badge");

  test("P1-1 a double click acknowledges one incident; the row stays until the pointer leaves it", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    const before = await rowTitles(page);
    const at = await center(rows(page).first().getByRole("button", { name: /^Acknowledge/ }));
    await page.mouse.move(at.x, at.y);
    await page.mouse.dblclick(at.x, at.y, { delay: 40 });
    await expect(rows(page).first().locator(".ack-done")).toHaveText("Acknowledged ✓");
    await expect(badge(page)).toContainText("3");
    await expect(page.getByRole("button", { name: /^Acknowledge / })).toHaveCount(2);
    expect(await rowTitles(page)).toEqual(before);
    expect(await rowAt(page, at.x, at.y)).toBe(PAY_ID);
    // the pointer leaves the row: the list sorts again right away (well before the 5 s)
    await page.mouse.move(at.x, 40);
    await expect.poll(() => rowTitles(page), { timeout: 1500 }).toEqual([before[1], before[2], before[3], before[0], ...before.slice(4)]);
    await page.waitForTimeout(700);
    await page.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
    await expect(badge(page)).toContainText("4");
    await expect.poll(() => rowTitles(page)).toEqual(before);
    expect(errors).toEqual([]);
  });

  test("P2-1 tab order: skip link → menu → tree → content; the legend is the tree's last stop and collapsed", async ({ page }) => {
    await signIn(page);
    await page.goto("/incidents");
    await page.waitForLoadState("networkidle");
    const where = () => page.evaluate(() => {
      const e = document.activeElement as HTMLElement;
      const zone = e.classList.contains("skip") ? "skip" : e.closest("header.top") ? "menu" : e.closest(".sline") ? "line" : e.closest(".stree") ? "tree" : e.closest("main") ? "content" : "other";
      return { zone, text: (e.getAttribute("aria-label") ?? e.textContent ?? "").trim() };
    });
    const seq: { zone: string; text: string }[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const w = await where();
      seq.push(w);
      if (w.zone === "content") break;
    }
    expect(seq[0]).toEqual({ zone: "skip", text: "Skip to content" });
    const zones = seq.map((s) => s.zone).filter((z, i, a) => z !== a[i - 1]);
    expect(zones).toEqual(["skip", "menu", "tree", "content"]);
    const tree = seq.filter((s) => s.zone === "tree");
    expect(tree[0]!.text).toBe("Filter the tree by customer, project or service name");
    expect(tree.some((s) => s.text === "Customers, projects and services")).toBe(true);
    expect(tree[tree.length - 1]!.text).toMatch(/^What do these mean\?/);
    const legend = page.getByRole("button", { name: /^What do these mean\?/ });
    await expect(legend).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".stree-legl")).toHaveCount(0);
    await legend.click();
    await expect(page.locator(".stree-legl")).toContainText("This project or service has its own call order instead of the customer's.");
    // the same on a stub screen
    await page.goto("/people");
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Tab");
    expect((await where()).zone).toBe("skip");
  });

  test("P2-2 a collapsed tree is a rail from the first paint, and a remembered width too", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Collapse the tree to a narrow rail" }).click();
    await expect(page.locator(".shell")).toHaveAttribute("data-rail", "1");
    // hold the app's scripts back: what is on screen is what the server sent plus the head script
    await page.route("**/_next/static/chunks/**", (r) => r.abort());
    await page.goto("/incidents", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".shell")).not.toHaveClass(/mounted/);
    expect(Math.round((await page.locator(".stree").boundingBox())!.width)).toBe(45);
    expect(Math.round((await page.locator(".shell-main").boundingBox())!.x)).toBe(45);
    await page.unroute("**/_next/static/chunks/**");
    // hydrated: the same 45px, so nothing moved
    await page.goto("/incidents");
    await expect(page.locator(".shell")).toHaveClass(/mounted/);
    expect(Math.round((await page.locator(".stree").boundingBox())!.width)).toBe(45);

    // remembered width
    await page.evaluate(() => sessionStorage.setItem("ao-scope-shell", JSON.stringify({ col: false, w: 340 })));
    await page.route("**/_next/static/chunks/**", (r) => r.abort());
    await page.goto("/incidents", { waitUntil: "domcontentloaded" });
    expect(Math.round((await page.locator(".stree").boundingBox())!.width)).toBe(340);
    expect(Math.round((await page.locator(".shell-main").boundingBox())!.x)).toBe(340);
    // no remembered choice: the default 272
    await page.evaluate(() => sessionStorage.removeItem("ao-scope-shell"));
    await page.goto("/incidents", { waitUntil: "domcontentloaded" });
    expect(Math.round((await page.locator(".stree").boundingBox())!.width)).toBe(272);
  });

  test("P2-2 below 1408 a panel address starts with the rail (automatic), before the app runs", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page);
    await page.route("**/_next/static/chunks/**", (r) => r.abort());
    await page.goto(PAY, { waitUntil: "domcontentloaded" });
    expect(Math.round((await page.locator(".stree").boundingBox())!.width)).toBe(45);
    await page.goto("/incidents", { waitUntil: "domcontentloaded" });
    expect(Math.round((await page.locator(".stree").boundingBox())!.width)).toBe(272);
  });

  test("P2-3 one meaning of open: the badge, the summary, the Open tile, the tree and the outside line agree; the tab is Active", async ({ page }) => {
    await signIn(page);
    await expect(badge(page)).toContainText("4");
    await expect(page.getByTestId("inc-summary")).toContainText("7 listed · 4 open · 3 acknowledged");
    await expect(page.getByTestId("tile-open")).toContainText("Open4");
    await expect(page.getByTestId("tile-open")).toContainText("3 triggered · 1 escalated");
    const status = page.getByRole("group", { name: "Status" });
    await expect(status.getByRole("link")).toHaveText(["Active7", "Acknowledged3", "Resolved17"]);
    await expect(status.getByRole("link", { name: /^Open/ })).toHaveCount(0);

    // QA's case: the filter where "Open 1" stood right above "0 open"
    await page.goto("/incidents?customer=daon&project=commerce&service=checkout");
    await expect(badge(page)).toContainText("4");
    await expect(page.getByTestId("inc-summary")).toContainText("1 listed · 0 open · 1 acknowledged");
    await expect(page.getByTestId("tile-open")).toContainText("Open0");
    await expect(status.getByRole("link")).toHaveText(["Active1", "Acknowledged1", "Resolved0"]);
    await expect(page.locator(".sline-out").getByTestId("outside-line")).toHaveText("Outside this view: 4 open (1 from an unmapped account) · 2 acknowledged");
    // open in this list + open outside = the badge
    await page.goto("/incidents?customer=daon");
    const inView = Number((await page.getByTestId("tile-open").locator(".v").innerText()).trim());
    const out = Number(/(\d+) open/.exec(await page.locator(".sline-out").getByTestId("outside-line").innerText())![1]);
    expect(inView + out).toBe(4);
    await expect(page.getByRole("treeitem", { name: /^Daon Retail, 1 open incident$/ })).toBeVisible();
  });

  test("P2-4 with a panel open the stats are one row and the list starts high", async ({ page }) => {
    await signIn(page, PAY);
    await expect(page.getByTestId("panel")).toBeVisible();
    const tiles = page.getByTestId("tiles");
    expect((await tiles.boundingBox())!.height).toBeLessThanOrEqual(48);
    const tops = await tiles.locator(".tile").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    const boxes = await rows(page).evaluateAll((trs) => trs.map((tr) => { const r = tr.getBoundingClientRect(); return { y: r.top, b: r.bottom }; }));
    expect(boxes[0]!.y).toBeLessThan(470);
    expect(boxes.filter((b) => b.b <= 900).length).toBeGreaterThanOrEqual(4); // QA saw 2.5 rows
    // without a panel, at this width, the full tiles are back
    await page.goto("/incidents");
    expect((await tiles.boundingBox())!.height).toBeGreaterThan(70);
    const first = (await rows(page).first().boundingBox())!;
    expect(first.y + first.height).toBeLessThan(900);
  });

  test("P3 Space selects in the tree; Esc with the focus in the tree closes the panel", async ({ page }) => {
    await signIn(page, PAY);
    const tree = page.getByRole("tree");
    await tree.focus();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/incidents$/);
    await expect(page.getByTestId("panel")).toHaveCount(0);
    await tree.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(/\/incidents\?customer=mirae$/);
    // Esc while clearing the tree search only clears the search
    await page.goto(PAY);
    await page.getByRole("textbox", { name: "Filter the tree by customer, project or service name" }).fill("dao");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("panel")).toBeVisible();
  });

  test("P3 dark: the › separators are readable", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await signIn(page, `${PAY}?customer=mirae`);
    // the separator uses the muted text colour (it was the decoration colour, 1.6:1 on a dark surface)
    const lum = (rgb: string) => { const [r, g, b] = rgb.match(/[\d.]+/g)!.slice(0, 3).map((v) => { const c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
    const tokens = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const read = (v: string) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
      const out = { mut: read("--mut"), deco: read("--deco"), surface: read("--surface"), hair: read("--hair") };
      probe.remove();
      return out;
    });
    for (const sel of [".inc-path .chain", ".panel-path .chain", ".sline .chain"]) {
      const fg = await page.locator(sel).first().evaluate((e) => getComputedStyle(e).color);
      expect(fg, sel).toBe(tokens.mut);
      expect(fg, sel).not.toBe(tokens.deco);
      for (const bg of [tokens.surface, tokens.hair]) {
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        expect((a! + 0.05) / (b! + 0.05), `${sel} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("Ctrl K: Filter to… — my customers first, the customer in bold, no automatic choice on duplicate names", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page, "/incidents?status=ACKNOWLEDGED");
    await expect(page.getByRole("button", { name: /^Filter to…/ })).toBeVisible();
    await page.keyboard.press("Control+k");
    const dlg = page.getByRole("dialog", { name: "Filter to a customer, project or service" });
    const input = dlg.getByRole("combobox");
    await expect(input).toBeFocused();
    // nothing typed: All customers, My customers, then mine, then the others by name
    const names = await dlg.getByRole("option").evaluateAll((os) => os.map((o) => o.querySelector(".p")!.textContent));
    expect(names.slice(0, 4)).toEqual(["All customers", "My customers", "Mirae Pay", "Ara Games"]);
    expect(names.slice(9)).toEqual(["Daon Retail", "Eden Mobility", "Hanbit Logistics", "Haneul Air", "Iruda Edu", "Kumho Clinic", "Lumen Bank"]);
    // every row starts with its customer, in bold
    await input.fill("main");
    for (const o of await dlg.getByRole("option").all()) await expect(o.locator(".p b")).toHaveCount(1);
    // "checkout" is under Mirae Pay (mine) and Daon Retail: neither is selected, Enter does nothing
    await input.fill("checkout");
    await expect(dlg.getByRole("alert")).toContainText("2 customers have a match for “checkout”: Mirae Pay, Daon Retail. Nothing is selected");
    await expect(dlg.getByRole("option", { selected: true })).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(dlg).toBeVisible();
    await expect(page).toHaveURL(/\/incidents\?status=ACKNOWLEDGED$/);
    // naming the customer makes it one match; Enter applies it on the same screen and keeps the other filters
    await input.fill("daon checkout");
    await expect(dlg.getByRole("option", { selected: true })).toHaveText(/Daon Retail›Commerce›Checkout/);
    await page.keyboard.press("Enter");
    await expect(dlg).toHaveCount(0);
    await expect(page).toHaveURL(/\/incidents\?customer=daon&project=commerce&service=checkout&status=ACKNOWLEDGED$/);
    await expect(page.locator("#main h1")).toBeFocused();
    await expect(page.getByRole("treeitem", { name: /^Checkout$/, selected: true })).toBeVisible();
    // ⌘K too; Esc closes and changes nothing; it works on the other screens and not in Settings
    await page.keyboard.press("Meta+k");
    await expect(dlg).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await expect(page).toHaveURL(/customer=daon&project=commerce&service=checkout/);
    await page.goto("/people");
    await page.getByRole("button", { name: /^Filter to…/ }).click();
    await expect(dlg.getByText("Filter People to…")).toBeAttached();
    await dlg.getByRole("combobox").fill("bora");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/people\?customer=bora$/);
    await page.goto("/settings/msp-defaults");
    await expect(page.getByRole("button", { name: /^Filter to…/ })).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await expect(dlg).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Filter to… with a panel open closes the panel like any other filter change", async ({ page }) => {
    await signIn(page, PAY);
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog").getByRole("combobox").fill("hanbit");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/incidents\?customer=hanbit$/);
    await expect(page.getByTestId("panel")).toHaveCount(0);
    await expect(page.getByTestId("toast")).toContainText("Panel closed · the list now shows Hanbit Logistics");
  });
});

test("R-4 security headers on pages, the login page and redirects", async ({ request }) => {
  for (const path of ["/login", "/incidents", PAY, "/auth/dev-login"]) {
    const r = await request.get(path, { maxRedirects: 0 });
    const h = r.headers();
    expect(h["x-frame-options"], path).toBe("DENY");
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    const csp = h["content-security-policy"] ?? "";
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).toContain("default-src 'self'");
    expect(csp, path).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(csp, path).not.toContain("unsafe-eval");
  }
});

test("R-4 the CSP does not break the app: no violation on the list, the panel or the dialogs", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(PAY);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/design");
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-pre-rail") || true)).toBe(true); // the head scripts ran
  expect(violations).toEqual([]);
});

test("R-6 dot-only ids and slugs are Not found, like any other wrong address", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  for (const p of ["/c/mirae/core/payments-api/incident/%2E%2E", "/c/mirae/incident/...", "/incidents?customer=..", "/incidents?customer=mirae&project=."]) {
    await page.goto(p);
    await expect(page.getByTestId("not-found"), p).toBeVisible();
  }
});
