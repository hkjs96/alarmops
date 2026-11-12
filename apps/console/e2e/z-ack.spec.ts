// QA "Console 범위 틀 점검 — 2026-11-10" fixes: P1-1..3, P2-1..8, cheap P3s, security R-4, Filter to… (Ctrl/⌘K).
// Runs after scope.spec.ts (file order). The tests that acknowledge put the shared mock store back with Undo.
import { test, expect, type Page } from "@playwright/test";
import { reportOnFailure, watchPage } from "./helpers/diag";

// a failure prints what the page saw (taps, clicks, layout shifts, fonts) to the run's log
test.beforeEach(({ page }) => watchPage(page));
test.afterEach(({ page }, info) => reportOnFailure(page, info));

const PAY_ID = "inc-7f3a0c91b2d4-20261108181204";
const PAY = `/c/mirae/core/payments-api/incident/${PAY_ID}`;
/** signs in and waits until the page has stopped changing by itself (fonts in, shell mounted): geometry is compared after this */
const signIn = async (page: Page, next = "/incidents") => {
  await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))));
};
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
const rows = (page: Page) => page.getByTestId("incident-row");
const rowTitles = (page: Page) => rows(page).evaluateAll((trs) => trs.map((tr) => tr.querySelector("a.ttl")!.textContent));
/** the list row at a point (the toast may lie over it) */
const rowAt = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => document.elementsFromPoint(px!, py!).map((e) => e.closest("tr")).find(Boolean)?.getAttribute("data-id") ?? null, [x, y]);
/** geometry of every row and of its Acknowledge button, by incident */
const rowBoxes = (page: Page) => rows(page).evaluateAll((trs) => Object.fromEntries(trs.map((tr) => {
  const q = (e: Element | null) => { if (!e) return null; const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10); };
  return [tr.getAttribute("data-id")!, { row: q(tr), act: q(tr.querySelector(".c-act")), ack: q(tr.querySelector(".c-act button[aria-label^='Acknowledge']")) }];
})));
const rowsOnly = (o: Record<string, { row: number[] | null }>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.row]));
const without = <T,>(o: Record<string, T>, ...ids: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !ids.includes(k)));
const idOf = (row: ReturnType<Page["locator"]>) => row.getAttribute("data-id").then((v) => v!);
const label = (row: ReturnType<Page["locator"]>) => row.getByTestId("ack-label");
/** Undo through the row's … menu (the only Undo on the row) */
async function undoRow(page: Page, row: ReturnType<Page["locator"]>) {
  await row.getByRole("button", { name: /^More for / }).click();
  await page.getByRole("menuitem", { name: "Undo acknowledge" }).click();
  await expect(row.getByRole("button", { name: /^Acknowledge / })).toBeVisible();
}
const overflow = (page: Page) => page.evaluate(() => { const tw = document.querySelector(".tw")!; return tw.scrollWidth - tw.clientWidth; });
/**
 * The centre of a control, for a press by coordinates — and the control must be what a press there reaches. On a
 * phone the bottom menu lies over the end of the page: when the control is under it (text is a few pixels wider on
 * another machine, a line wraps, everything below is 50px lower) the page is scrolled until it is clear, as a
 * person would. Before this check the press went to the menu, which opened another screen (CI, 2026-11-11).
 */
const center = async (l: ReturnType<Page["locator"]>) => {
  const reached = () => l.evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return Boolean(top && (top === el || el.contains(top))); });
  if (!(await reached())) {
    await l.evaluate((el) => new Promise((done) => { el.scrollIntoView({ block: "center", behavior: "instant" }); requestAnimationFrame(() => requestAnimationFrame(() => done(null))); }));
  }
  expect(await reached(), "a press at the centre of the control reaches the control").toBe(true);
  const b = (await l.boundingBox())!;
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), b };
};

test.describe("phone 390×740 — 하은 H3 / H4", () => {
  test.use({ viewport: { width: 390, height: 740 }, hasTouch: true });
  const badge = (page: Page) => page.locator(".bnav .cnt");

  test("H3 list: a double tap acknowledges one incident; no row moves, then or later; Undo is not under the finger; the toast fits; Undo restores", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await expect(badge(page)).toContainText("4");
    const before = await rowTitles(page);
    expect(before[0]).toBe("payments-db-1 FreeStorageSpace below 10 GB");
    expect(before[1]).toBe("api-alb 5XX rate above 2%");
    const first = rows(page).first();
    const at = await center(first.getByRole("button", { name: /^Acknowledge/ }));
    const boxes0 = await rowBoxes(page);

    // two taps on the same spot, 150 ms apart
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(150);
    await page.touchscreen.tap(at.x, at.y);

    await expect(label(first)).toHaveText("Acknowledged ✓ 03:16");
    await expect(badge(page)).toContainText("3");
    // exactly one incident changed: the other open ones still offer Acknowledge
    await expect(page.getByRole("button", { name: /^Acknowledge / })).toHaveCount(2);
    await expect(rows(page).nth(1).getByRole("button", { name: "Acknowledge api-alb 5XX rate above 2%" })).toBeVisible();
    // same order, and every other row is exactly where it was
    expect(await rowTitles(page)).toEqual(before);
    expect(await rowAt(page, at.x, at.y)).toBe(PAY_ID);
    expect(without(await rowBoxes(page), PAY_ID)).toEqual(without(boxes0, PAY_ID));
    expect((await rowBoxes(page))[PAY_ID]!.row).toEqual(boxes0[PAY_ID]!.row);
    // P2-A: what is under the finger now does nothing; Undo is behind … at the far side of the card
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("button, a, [role=menuitem]")?.textContent ?? null, [at.x, at.y]);
    expect(under).toBeNull();
    await expect(first.getByRole("button", { name: /Undo/ })).toHaveCount(0);
    const more = (await first.getByRole("button", { name: /^More for payments-db-1/ }).boundingBox())!;
    expect(more.x).toBeGreaterThan(at.b.x + at.b.width + 100);
    expect(Math.min(more.width, more.height)).toBeGreaterThanOrEqual(44);
    // the bar says what is waiting; it was there before, the same size, so it pushed nothing
    await expect(page.getByTestId("list-pending")).toHaveText("1 acknowledged in place");

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
    await page.screenshot({ path: test.info().outputPath("h3-1-acked-in-place.png") });

    // 6 s later (the old release time) nothing has moved, and a slow third tap on the same spot still does nothing
    await page.waitForTimeout(6000);
    expect(await rowTitles(page)).toEqual(before);
    expect(without(await rowBoxes(page), PAY_ID)).toEqual(without(boxes0, PAY_ID));
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(300);
    await expect(label(first)).toHaveText("Acknowledged ✓ 03:16");
    await expect(badge(page)).toContainText("3");
    await page.screenshot({ path: test.info().outputPath("h3-2-still-in-place.png") });

    // Undo (the toast is still up: 9 s). The row goes back to Acknowledge where it stands.
    await toast.getByRole("button", { name: "Undo" }).tap();
    await expect(badge(page)).toContainText("4");
    await expect(page.getByTestId("toast")).toContainText("Acknowledge undone in Mirae Pay › Core › Payments API · paging continues");
    await expect(rows(page).first().getByRole("button", { name: /^Acknowledge payments-db-1/ })).toBeVisible();
    expect(await rowTitles(page)).toEqual(before);
    expect(await rowBoxes(page)).toEqual(boxes0);
    await expect(page.getByTestId("list-pending")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("h3-3-undone.png") });
    expect(errors).toEqual([]);
  });

  for (const wait of [300, 700, 1500]) {
    test(`P1-A touch: Acknowledge row 1, then row 2's button ${wait} ms later → row 2's incident is acknowledged`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await signIn(page);
      await page.evaluate(() => window.scrollTo(0, 300));
      await page.waitForTimeout(200);
      const [r1, r2, r3] = [rows(page).nth(0), rows(page).nth(1), rows(page).nth(2)];
      const [id1, id2] = [await idOf(r1), await idOf(r2)];
      const a1 = await center(r1.getByRole("button", { name: /^Acknowledge/ }));
      const a2 = await center(r2.getByRole("button", { name: /^Acknowledge/ }));
      const boxes0 = await rowBoxes(page);
      await page.touchscreen.tap(a1.x, a1.y);
      await page.waitForTimeout(wait);
      // nothing moved while waiting: row 2's button is where the finger is going
      expect(without(await rowBoxes(page), id1)).toEqual(without(boxes0, id1));
      await page.touchscreen.tap(a2.x, a2.y);
      await expect(label(r2)).toHaveText("Acknowledged ✓ 03:16");
      await expect(label(r1)).toHaveText("Acknowledged ✓ 03:16");
      await expect(r2).toContainText("api-alb 5XX rate above 2%");
      await expect(r3.getByRole("button", { name: /^Acknowledge node-exporter/ })).toBeVisible(); // the third (Daon Retail) was not touched
      await expect(badge(page)).toContainText("2");
      expect(without(await rowBoxes(page), id1, id2)).toEqual(without(boxes0, id1, id2));
      expect(rowsOnly(await rowBoxes(page))).toEqual(rowsOnly(boxes0)); // the acknowledged rows kept their size too
      await expect(page.getByTestId("list-pending")).toHaveText("2 acknowledged in place");
      if (wait === 700) await page.screenshot({ path: test.info().outputPath("h3b-390-two-in-place.png") });
      await page.getByTestId("toast").getByRole("button", { name: "Dismiss" }).tap();
      await undoRow(page, r2);
      await undoRow(page, r1);
      await expect(badge(page)).toContainText("4");
      expect(await rowBoxes(page)).toEqual(boxes0);
    });
  }

  test("H4 panel: Acknowledge gives a toast with Undo; the primary spot only says Acknowledged ✓ for 5 s, then Resolve… which asks first; Undo is a link below; paging says it stopped", async ({ page }) => {
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
    const spot = page.getByTestId("panel-acked");
    await expect(spot).toHaveText("Acknowledged ✓ 03:16");
    await expect(spot.getByRole("button")).toHaveCount(0); // the primary spot does nothing
    await expect(page.getByRole("button", { name: /^Resolve/ })).toHaveCount(0);
    // P2-A: Undo is a link on its own line below, at the other side; nowhere near the finger (touch slop included)
    const undoLink = page.getByTestId("panel-undo");
    await expect(undoLink).toHaveText("Undo acknowledge");
    const ub = (await undoLink.boundingBox())!;
    const sb = (await spot.boundingBox())!;
    expect(ub.y).toBeGreaterThanOrEqual(sb.y + sb.height + 12); // on a phone the primary spot is the full width: the link is clearly below it
    expect(Math.hypot(Math.max(ub.x - at.x, 0, at.x - (ub.x + ub.width)), Math.max(ub.y - at.y, 0, at.y - (ub.y + ub.height)))).toBeGreaterThan(48);
    expect(ub.height).toBeGreaterThanOrEqual(44);
    // Mute and Escalate kept their places (Escalate is off, not gone), so the primary spot did not slide sideways
    await expect(page.getByRole("button", { name: "Escalate now" })).toBeDisabled();
    expect(sb.x + 20).toBeLessThan(at.x);
    expect(sb.x + sb.width - 20).toBeGreaterThan(at.x);
    expect(Math.abs(sb.y - at.b.y)).toBeLessThanOrEqual(1); // the Paged line above lost its coming calls, and its block is held at its height: the spot is where the finger is
    const eb = (await page.getByRole("button", { name: "Escalate now" }).boundingBox())!;
    expect(eb.x + eb.width + 24).toBeLessThan(at.x);
    // the slow "did it take?" taps, 1.2 s and 2.4 s later, on the same spot: still acknowledged
    for (let n = 0; n < 2; n++) {
      await page.waitForTimeout(1200);
      const now = await center(spot);
      await page.touchscreen.tap(at.x, now.y);
    }
    await page.waitForTimeout(300);
    await expect(page.getByTestId("paged-line")).toContainText("Paging stopped at 03:16");
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
    await expect(label(row)).toHaveText("Acknowledged ✓ 03:16");
    await page.screenshot({ path: test.info().outputPath("h4-3-list-row.png") });
    await undoRow(page, row);
    await expect(page.locator(".bnav .cnt")).toContainText("4");
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
    // the same height: at most half a pixel apart (a font that is there for one paint and not for the other rounds differently)
    await page.evaluate(() => document.fonts.ready);
    expect(Math.abs((await page.locator(".sline").boundingBox())!.height - hydrated)).toBeLessThanOrEqual(0.5);
  });
});

test.describe("desktop 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const badge = (page: Page) => page.getByTestId("nav-badge");

  test("P1-1 a double click acknowledges one incident; the row stays when the pointer leaves, after 6 s, until Re-sort", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    const before = await rowTitles(page);
    const first = rows(page).first();
    const at = await center(first.getByRole("button", { name: /^Acknowledge/ }));
    const boxes0 = await rowBoxes(page);
    await page.mouse.move(at.x, at.y);
    await page.mouse.dblclick(at.x, at.y, { delay: 40 });
    await expect(label(first)).toHaveText("Acknowledged ✓ 03:16");
    await expect(first).toHaveClass(/dim/);
    await expect(badge(page)).toContainText("3");
    await expect(page.getByRole("button", { name: /^Acknowledge / })).toHaveCount(2);
    expect(await rowTitles(page)).toEqual(before);
    expect(await rowAt(page, at.x, at.y)).toBe(PAY_ID);
    // the pointer leaves the row, wanders over the others, and time passes: nothing moves
    for (const y of [40, at.y + 90, at.y + 180, 40]) { await page.mouse.move(at.x, y, { steps: 4 }); await page.waitForTimeout(150); }
    await page.waitForTimeout(6000);
    expect(await rowTitles(page)).toEqual(before);
    expect(without(await rowBoxes(page), PAY_ID)).toEqual(without(boxes0, PAY_ID));
    expect((await rowBoxes(page))[PAY_ID]!.row).toEqual(boxes0[PAY_ID]!.row);
    // the bar: the same place and size as before it had anything to say; its button is far from the Acknowledge column
    const bar = page.getByTestId("list-bar");
    await expect(page.getByTestId("list-pending")).toHaveText("1 acknowledged in place");
    await expect(page.getByTestId("inc-summary")).toHaveText("7 listed · 3 open · 4 acknowledged");
    const resort = bar.getByRole("button", { name: "Re-sort" });
    expect((await resort.boundingBox())!.x + 200).toBeLessThan(at.b.x);
    await page.screenshot({ path: test.info().outputPath("p1a-1440-in-place.png") });
    // only the user sorts
    await resort.click();
    await expect.poll(() => rowTitles(page)).toEqual([before[1], before[2], before[3], before[0], ...before.slice(4)]);
    await expect(page.getByTestId("list-pending")).toHaveCount(0);
    expect((await bar.boundingBox())!.height).toBe(36);
    // Undo: the row becomes open again where it now stands (below the open ones); again only Re-sort moves it
    const row = rows(page).filter({ hasText: "payments-db-1" });
    await undoRow(page, row);
    await expect(badge(page)).toContainText("4");
    expect((await rowTitles(page))[3]).toBe(before[0]);
    await expect(page.getByTestId("list-pending")).toHaveText("1 reopened in place");
    await page.waitForTimeout(700); // the bar's button is armed 600 ms after the bar speaks (it may come up under a second tap)
    await bar.getByRole("button", { name: "Re-sort" }).click();
    await expect.poll(() => rowTitles(page)).toEqual(before);
    expect(errors).toEqual([]);
  });

  for (const wait of [300, 700, 1500]) {
    test(`P1-A mouse: Acknowledge row 1, move to row 2's button, click ${wait} ms later → row 2's incident is acknowledged`, async ({ page }) => {
      await signIn(page);
      const [r1, r2, r3] = [rows(page).nth(0), rows(page).nth(1), rows(page).nth(2)];
      const [id1, id2] = [await idOf(r1), await idOf(r2)];
      await expect(r2).toContainText("Hanbit");
      await expect(r3).toContainText("Daon Retail");
      const a1 = await center(r1.getByRole("button", { name: /^Acknowledge/ }));
      const a2 = await center(r2.getByRole("button", { name: /^Acknowledge/ }));
      const boxes0 = await rowBoxes(page);
      await page.mouse.move(a1.x, a1.y);
      await page.mouse.click(a1.x, a1.y);
      await page.mouse.move(a2.x, a2.y, { steps: 6 }); // the pointer leaves row 1 here
      await page.waitForTimeout(wait);
      expect(without(await rowBoxes(page), id1)).toEqual(without(boxes0, id1));
      expect(await rowAt(page, a2.x, a2.y)).toBe(id2);
      await page.mouse.click(a2.x, a2.y);
      await expect(label(r2)).toHaveText("Acknowledged ✓ 03:16");
      await expect(label(r1)).toHaveText("Acknowledged ✓ 03:16");
      await expect(r2).toContainText("Hanbit"); // QA saw Daon Retail acknowledged here instead
      await expect(r3.getByRole("button", { name: /^Acknowledge node-exporter/ })).toBeVisible();
      await expect(badge(page)).toContainText("2");
      expect(without(await rowBoxes(page), id1, id2)).toEqual(without(boxes0, id1, id2));
      expect(rowsOnly(await rowBoxes(page))).toEqual(rowsOnly(boxes0)); // the acknowledged rows kept their size too
      await expect(page.getByTestId("list-pending")).toHaveText("2 acknowledged in place");
      if (wait === 700) await page.screenshot({ path: test.info().outputPath("h3b-1440-two-in-place.png") });
      await undoRow(page, r2);
      await undoRow(page, r1);
      await expect(badge(page)).toContainText("4");
      expect(await rowBoxes(page)).toEqual(boxes0);
    });
  }

  test("P2-A the slow second click (0.7 s, 1.5 s) on the same spot does not undo; Undo is behind … at the other end of the cell", async ({ page }) => {
    await signIn(page);
    const first = rows(page).first();
    const at = await center(first.getByRole("button", { name: /^Acknowledge/ }));
    await page.mouse.click(at.x, at.y);
    for (const wait of [700, 800]) {
      await page.waitForTimeout(wait);
      const under = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("button, a, [role=menuitem]")?.textContent ?? null, [at.x, at.y]);
      expect(under).toBeNull();
      await page.mouse.click(at.x, at.y);
    }
    await page.waitForTimeout(400);
    await expect(label(first)).toHaveText("Acknowledged ✓ 03:16");
    await expect(badge(page)).toContainText("3");
    await expect(page).toHaveURL(/\/incidents$/); // the action cell is not part of the row link: a click on the label opens nothing
    const more = first.getByRole("button", { name: /^More for payments-db-1/ });
    const mb = (await more.boundingBox())!;
    expect(mb.x + mb.width).toBeLessThan(at.b.x - 24); // left of where the button was
    // a double click on … opens and closes the menu; it never lands on Undo
    await page.mouse.dblclick(mb.x + mb.width / 2, mb.y + mb.height / 2, { delay: 60 });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await more.click();
    const item = (await page.getByRole("menuitem", { name: "Undo acknowledge" }).boundingBox())!;
    expect(item.y).toBeGreaterThanOrEqual(mb.y + mb.height);
    await page.screenshot({ path: test.info().outputPath("p2a-1440-menu.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await undoRow(page, first);
    await expect(badge(page)).toContainText("4");
  });

  for (const width of [1440, 1280]) {
    test(`P2-B ${width} with the panel open: Acknowledge leaves the table inside its box, no button clipped, no row moved`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page, PAY);
      await expect(page.getByTestId("panel")).toBeVisible();
      await page.waitForTimeout(300);
      expect(await overflow(page)).toBe(0);
      const boxes0 = await rowBoxes(page);
      const row = rows(page).filter({ hasText: "payments-db-1" });
      const fits = () => page.evaluate(() => {
        const tw = document.querySelector(".tw")!.getBoundingClientRect();
        return [...document.querySelectorAll(".t.inc .c-act button, .t.inc .c-act .act-l")].every((b) => { const r = b.getBoundingClientRect(); return r.left >= tw.left && r.right <= tw.right + 0.5 && (b as HTMLElement).scrollWidth <= (b as HTMLElement).clientWidth + 1; });
      });
      expect(await fits()).toBe(true);
      // from the panel
      await page.getByTestId("panel").getByRole("button", { name: "Acknowledge", exact: true }).click();
      await expect(label(row)).toContainText("Acknowledged ✓");
      await expect(page.getByTestId("panel-acked")).toHaveText("Acknowledged ✓ 03:16");
      expect(await overflow(page)).toBe(0);
      expect(await fits()).toBe(true);
      expect(without(await rowBoxes(page), PAY_ID)).toEqual(without(boxes0, PAY_ID));
      expect(await page.evaluate(() => document.querySelector(".tw")!.scrollLeft)).toBe(0);
      // and one from the list while the panel is open
      const r2 = rows(page).nth(1);
      const id2 = await idOf(r2);
      await r2.getByRole("button", { name: /^Acknowledge/ }).click();
      await expect(label(r2)).toContainText("Acknowledged ✓");
      expect(await overflow(page)).toBe(0);
      expect(await fits()).toBe(true);
      expect(without(await rowBoxes(page), PAY_ID, id2)).toEqual(without(boxes0, PAY_ID, id2));
      await expect(r2.getByRole("button", { name: /^More for / })).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: test.info().outputPath(`p2b-${width}-panel-acked.png`) });
      // Resolve… comes to the primary spot after 5 s; the Undo link is below it on the other side
      await expect(page.getByRole("button", { name: "Resolve…" })).toBeVisible({ timeout: 7000 });
      const rb = (await page.getByRole("button", { name: "Resolve…" }).boundingBox())!;
      const ub = (await page.getByTestId("panel-undo").boundingBox())!;
      expect(ub.y).toBeGreaterThanOrEqual(rb.y + rb.height);
      expect(ub.x + ub.width).toBeLessThan(rb.x);
      await page.getByTestId("panel-undo").click();
      await expect(page.getByTestId("panel").getByRole("button", { name: "Acknowledge", exact: true })).toBeVisible();
      await undoRow(page, r2);
      await expect(badge(page)).toContainText("4");
      expect(await rowBoxes(page)).toEqual(boxes0);
    });
  }

  test("P3-A keyboard: Enter on Acknowledge leaves the focus on the row's status label; in the panel on the primary spot, then on Resolve…", async ({ page }) => {
    await signIn(page);
    const first = rows(page).first();
    await first.getByRole("button", { name: /^Acknowledge/ }).focus();
    await page.keyboard.press("Enter");
    await expect(label(first)).toHaveText("Acknowledged ✓ 03:16");
    await expect(label(first)).toBeFocused();
    // Enter or Space again do nothing; Tab goes on from the row, not from the top of the page
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expect(badge(page)).toContainText("3");
    await page.keyboard.press("Shift+Tab");
    await expect(first.getByRole("button", { name: /^More for payments-db-1/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Undo acknowledge" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(first.getByRole("button", { name: /^Acknowledge payments-db-1/ })).toBeFocused();
    await expect(badge(page)).toContainText("4");

    await page.goto(PAY);
    const ack = page.getByTestId("panel").getByRole("button", { name: "Acknowledge", exact: true });
    await ack.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("panel-acked")).toBeFocused();
    await expect(page.getByRole("button", { name: "Resolve…" })).toBeFocused({ timeout: 7000 });
    await page.getByTestId("panel-undo").click();
    await expect(ack).toBeVisible();
    await expect(badge(page)).toContainText("4");
  });

  test("a tab change sorts the list; opening and closing a panel does not", async ({ page }) => {
    await signIn(page);
    const before = await rowTitles(page);
    const first = rows(page).first();
    await first.getByRole("button", { name: /^Acknowledge/ }).click();
    await expect(label(first)).toHaveText("Acknowledged ✓ 03:16");
    // open another incident's panel and close it: the list still stands as it was
    await rows(page).nth(2).locator("a.ttl").click();
    await expect(page.getByTestId("panel")).toBeVisible();
    expect(await rowTitles(page)).toEqual(before);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("panel")).toHaveCount(0);
    expect(await rowTitles(page)).toEqual(before);
    await expect(page.getByTestId("list-pending")).toHaveText("1 acknowledged in place");
    // the Acknowledged tab and back: sorted
    await page.getByRole("group", { name: "Status" }).getByRole("link", { name: /^Acknowledged/ }).click();
    await expect(page).toHaveURL(/status=ACKNOWLEDGED/);
    await expect(rows(page)).toHaveCount(4);
    // Undo here: the row leaves this tab's list, but stays where it is and says so
    const row = rows(page).filter({ hasText: "payments-db-1" });
    const titles = await rowTitles(page);
    await row.getByRole("button", { name: /^More for / }).click();
    await page.getByRole("menuitem", { name: "Undo acknowledge" }).click();
    await expect(row.getByRole("status")).toHaveText("Reopened · paging");
    expect(await rowTitles(page)).toEqual(titles);
    await expect(page.getByTestId("list-pending")).toHaveText("1 no longer in this list");
    await page.getByRole("group", { name: "Status" }).getByRole("link", { name: /^Active/ }).click();
    await expect(page).toHaveURL(/\/incidents$/);
    await expect.poll(() => rowTitles(page)).toEqual(before);
    await expect(badge(page)).toContainText("4");
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
    // fonts are the console's own files: no other origin is allowed for anything
    expect(csp.split("; "), path).toContain("font-src 'self'");
    expect(csp.split("; "), path).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp, path).not.toMatch(/https?:/);
    expect(csp, path).not.toContain("unsafe-eval");
    expect(h["permissions-policy"], path).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    expect(h["strict-transport-security"], path).toBe("max-age=31536000; includeSubDomains"); // this is a production build
  }
});

test("S-3 dev sign-in only ever redirects to a path on this origin", async ({ request, baseURL }) => {
  for (const next of ["/%09/evil.example", "/%0A/evil.example", "/%0D/evil.example", "//evil.example", "/%5Cevil.example", "/\\evil.example", "/%2F%2Fevil.example", "/%252F%252Fevil.example", "https://evil.example", "/incidents//evil.example"]) {
    const r = await request.get(`/auth/dev-login?next=${next}`, { maxRedirects: 0 });
    expect(r.status(), next).toBe(307);
    expect(r.headers()["location"], next).toBe(`${baseURL}/incidents`);
  }
  const ok = await request.get(`/auth/dev-login?next=${encodeURIComponent(`${PAY}?customer=mirae`)}`, { maxRedirects: 0 });
  expect(ok.headers()["location"]).toBe(`${baseURL}${PAY}?customer=mirae`);
});

test("S-3 the login page does not pass a hostile next on to the dev sign-in link", async ({ page }) => {
  await page.goto("/login?next=/%09/evil.example");
  await expect(page.getByRole("link", { name: /sign in as Haeun Kim/ })).toHaveAttribute("href", "/auth/dev-login");
  await page.goto(`/login?next=${encodeURIComponent("/people?customer=bora")}`);
  await expect(page.getByRole("link", { name: /sign in as Haeun Kim/ })).toHaveAttribute("href", "/auth/dev-login?next=%2Fpeople%3Fcustomer%3Dbora");
});

test("D-26 Customers is in the menu and lives in the shell; P3-B the tree's problem count is explained; the panel path wraps after ›", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "/incidents?customer=daon");
  const main = page.getByRole("navigation", { name: "Main", exact: true });
  await expect(main.getByRole("link")).toHaveText([/^Incidents/, "Monitoring", "Call order", "People", "Maintenance", "Customers", "Settings"]);
  await main.getByRole("link", { name: "Customers", exact: true }).click();
  await expect(page).toHaveURL(/\/customers\?customer=daon$/);
  await expect(page.locator("#main h1")).toHaveText("Customers");
  await expect(main.getByRole("link", { name: "Customers", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tree")).toBeVisible();
  await expect(page.getByTestId("scope-echo")).toHaveText("Daon Retail");
  const sw = page.getByRole("switch", { name: "Only with problems, 5 customers with problems" });
  await expect(sw).toBeVisible();
  await expect(page.getByTestId("problem-count")).toHaveAttribute("title", "5 customers with problems");
  // phone: six items fit the bottom menu, each at least 44px, nothing cut
  await page.setViewportSize({ width: 390, height: 740 });
  const bnav = page.locator(".bnav");
  await expect(bnav.getByRole("link")).toHaveText([/^Incidents/, "Monitor", "Call order", "People", "Maint.", "Customers"]);
  expect(await bnav.evaluate((e) => e.scrollWidth - e.clientWidth)).toBe(0);
  for (const a of await bnav.getByRole("link").all()) { const b = (await a.boundingBox())!; expect(b.width).toBeGreaterThanOrEqual(44); expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(390); }
  // panel title at 1024: a second line never starts with ›
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/incidents");
  await rows(page).filter({ hasText: "api-alb" }).locator("a.ttl").click();
  await expect(page.getByTestId("panel-path")).toHaveText("Hanbit Logistics›Tracking›Public API");
  const starts = await page.getByTestId("panel-path").evaluate((h) => {
    const segs = [...h.children] as HTMLElement[];
    return segs.map((s, n) => ({ t: s.textContent, first: n === 0 || s.offsetTop > segs[n - 1]!.offsetTop }));
  });
  for (const s of starts) expect(s.t!.startsWith("›")).toBe(false);
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
