// QA "CI·글꼴 변경 점검 — 2026-11-11": P2-N, P2-O, P3-P. Runs after y-fonts.spec.ts and before z-ack.spec.ts (file order), on
// the mock store as scope.spec.ts leaves it; every acknowledge is undone.
//   P2-N  what an action raises (the toast with Undo) never stands where the action was pressed: taps at the same
//         spot 150 ms, 400 ms, 1 s, 2 s and 3 s later change nothing. The rule is the same-spot guard's
//         (design-system list/same-spot), for the list row and for the panel, with the fonts and without them.
//   P2-O  the bottom menu never covers a row's action: the first incident's Acknowledge is in the first screen
//         down to 360×640, and any row of any list can be scrolled clear of the menu and of what sticks to the top.
//   P3-P  the panel's actions do not move sideways when the incident is acknowledged.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { reportOnFailure, watchPage } from "./helpers/diag";

test.beforeEach(({ page }) => watchPage(page));
test.afterEach(({ page }, info) => reportOnFailure(page, info));

const PAY_ID = "inc-7f3a0c91b2d4-20261108181204";
const PAY = `/c/mirae/core/payments-api/incident/${PAY_ID}`;
const FONT_FILES = "**/_next/static/media/*.woff2";
const DELAYS = [150, 400, 1000, 2000, 3000];
type Rect = { left: number; top: number; right: number; bottom: number };

async function open(page: Page, next: string, fonts: boolean) {
  if (!fonts) await page.route(FONT_FILES, (r) => r.abort());
  await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => document.querySelector(".shell")?.classList.contains("ready"));
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))));
}
/** server actions sent by the page (Acknowledge, Undo …) */
function watchPosts(page: Page) {
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.headers()["next-action"]) posts.push(r.url()); });
  return posts;
}
const rect = (l: Locator): Promise<Rect> => l.evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
const overlap = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** true = a press anywhere on the control reaches it (centre and just inside each corner) */
const reachable = (l: Locator) => l.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]];
  return pts.every(([x, y]) => { const top = document.elementFromPoint(x!, y!); return Boolean(top && (top === el || el.contains(top))); });
});
const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
const rows = (page: Page) => page.getByTestId("incident-row");

/**
 * Press, then press the same spot again `delays` ms after the first press (all in one go when there are several):
 * one request, still acknowledged, and the toast with its Undo is still up — no later press reached anything.
 */
async function pressAgain(page: Page, posts: string[], button: Locator, delays: number[], acked: () => Promise<void>) {
  if (!(await reachable(button))) {
    await button.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await settle(page);
  }
  expect(await reachable(button), "the action can be pressed").toBe(true);
  const pressed = await rect(button);
  const at = { x: Math.round((pressed.left + pressed.right) / 2), y: Math.round((pressed.top + pressed.bottom) / 2) };
  const before = posts.length;
  const t0 = Date.now();
  await page.touchscreen.tap(at.x, at.y);
  for (const d of delays) {
    await page.waitForTimeout(Math.max(0, d - (Date.now() - t0)));
    await page.touchscreen.tap(at.x, at.y);
  }
  await page.waitForTimeout(400);
  await acked();
  expect(posts.length - before, `requests after presses at 0 and ${delays.join(", ")} ms`).toBe(1);
  // the toast is there with Undo, and it does not lie over the control that was pressed
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Acknowledged in Mirae Pay › Core › Payments API");
  const undo = toast.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();
  const tb = await rect(toast);
  expect(overlap(tb, pressed), `toast ${JSON.stringify(tb)} over the pressed control ${JSON.stringify(pressed)}`).toBe(false);
  expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest(".toast")), [at.x, at.y])).toBe(false);
  const vh = page.viewportSize()!.height;
  expect(await toast.getAttribute("data-place")).toBe(pressed.bottom + 24 > vh - 200 ? "top" : "bottom");
  // inside the viewport, and its Undo is a full tap target
  expect(tb.top).toBeGreaterThanOrEqual(0);
  expect(tb.bottom).toBeLessThanOrEqual((await rect(page.locator(".bnav"))).top);
  const ub = await rect(undo);
  expect(Math.min(ub.right - ub.left, ub.bottom - ub.top)).toBeGreaterThanOrEqual(44);
  return { at, pressed };
}

const SIZES = [{ width: 360, height: 740 }, { width: 375, height: 667 }, { width: 390, height: 664 }, { width: 390, height: 740 }, { width: 412, height: 800 }];
for (const vp of SIZES) {
  for (const fonts of [true, false]) {
    test.describe(`P2-N ${vp.width}×${vp.height}, fonts ${fonts ? "loaded" : "blocked"}`, () => {
      test.use({ viewport: vp, hasTouch: true });

      test("panel: Acknowledge, then the same spot at 150 ms, 400 ms, 1 s, 2 s, 3 s → one request, still acknowledged; then Undo from the toast", async ({ page }) => {
        const posts = watchPosts(page);
        await open(page, PAY, fonts);
        const ack = page.getByRole("button", { name: "Acknowledge", exact: true });
        await pressAgain(page, posts, ack, DELAYS, async () => {
          await expect(page.getByTestId("panel-acked")).toHaveText("Acknowledged ✓ 03:16");
          await expect(page.getByTestId("paged-line")).toContainText("Paging stopped at 03:16");
        });
        await expect(page.locator(".bnav .cnt")).toContainText("3");
        // the Undo that was kept away from the finger works when it is meant
        await page.getByTestId("toast").getByRole("button", { name: "Undo" }).tap();
        await expect(page.getByTestId("toast")).toContainText("Acknowledge undone");
        await expect(ack).toBeVisible();
        await expect(page.locator(".bnav .cnt")).toContainText("4");
        expect(posts.length).toBe(2);
      });

      test("list: Acknowledge on the first row, then the same spot at 150 ms, 400 ms, 1 s, 2 s, 3 s → one request, that row acknowledged and no other", async ({ page }) => {
        const posts = watchPosts(page);
        await open(page, "/incidents", fonts);
        const first = rows(page).first();
        expect(await first.getAttribute("data-id")).toBe(PAY_ID);
        await pressAgain(page, posts, first.getByRole("button", { name: /^Acknowledge / }), DELAYS, async () => {
          await expect(first.getByTestId("ack-label")).toHaveText("Acknowledged ✓ 03:16");
        });
        await expect(page.getByRole("button", { name: /^Acknowledge / })).toHaveCount(2);
        await expect(page.locator(".bnav .cnt")).toContainText("3");
        await page.getByTestId("toast").getByRole("button", { name: "Undo" }).tap();
        await expect(first.getByRole("button", { name: /^Acknowledge / })).toBeVisible();
        await expect(page.getByRole("button", { name: /^Acknowledge / })).toHaveCount(3);
        await expect(page.locator(".bnav .cnt")).toContainText("4");
      });
    });
  }
}

test.describe("P2-N one late press at a time, 360×740 (the size it was found at)", () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });
  for (const d of DELAYS) {
    test(`panel: a single second press ${d} ms after Acknowledge changes nothing`, async ({ page }) => {
      const posts = watchPosts(page);
      await open(page, PAY, true);
      await pressAgain(page, posts, page.getByRole("button", { name: "Acknowledge", exact: true }), [d], async () => {
        await expect(page.getByTestId("panel-acked")).toHaveText("Acknowledged ✓ 03:16");
      });
      await page.getByTestId("panel-undo").tap();
      await expect(page.getByRole("button", { name: "Acknowledge", exact: true })).toBeVisible();
      await expect(page.locator(".bnav .cnt")).toContainText("4");
    });
  }
});

test.describe("P2-N the rule, not the size", () => {
  test("a tall phone: the pressed control is far from the bottom, the toast keeps its usual place and still does not cover it", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 915 }, hasTouch: true });
    const page = await context.newPage();
    const posts = watchPosts(page);
    await open(page, "/incidents", true);
    const first = rows(page).first();
    const { pressed } = await pressAgain(page, posts, first.getByRole("button", { name: /^Acknowledge / }), [1000], async () => {
      await expect(first.getByTestId("ack-label")).toHaveText("Acknowledged ✓ 03:16");
    });
    expect(pressed.bottom + 24).toBeLessThanOrEqual(915 - 200);
    expect(await page.getByTestId("toast").getAttribute("data-place")).toBe("bottom");
    await page.getByTestId("toast").getByRole("button", { name: "Undo" }).tap();
    await expect(first.getByRole("button", { name: /^Acknowledge / })).toBeVisible();
    await context.close();
  });

  test("a viewport too short to keep them apart: the toast's Undo is deaf where the action was pressed, and works beside it", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 740, height: 300 }, hasTouch: true }); // a phone on its side
    const page = await context.newPage();
    const posts = watchPosts(page);
    await open(page, PAY, true);
    const ack = page.getByRole("button", { name: "Acknowledge", exact: true });
    await ack.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }));
    await settle(page);
    const pressed = await rect(ack);
    const at = { x: Math.round((pressed.left + pressed.right) / 2), y: Math.round((pressed.top + pressed.bottom) / 2) };
    await page.touchscreen.tap(at.x, at.y);
    const toast = page.getByTestId("toast");
    const undo = toast.getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    // whatever the toast covers here, every press inside the pressed control's box (slop included) is dropped
    const box = (await toast.getAttribute("data-follows-press"))!.split(",").map(Number);
    expect(box).toEqual([Math.round(pressed.left - 24), Math.round(pressed.top - 24), Math.round(pressed.right + 24), Math.round(pressed.bottom + 24)]);
    for (const d of [1000, 2000, 3000]) {
      await page.waitForTimeout(d > 0 ? 1000 : 0);
      await page.touchscreen.tap(at.x, at.y);
    }
    await page.waitForTimeout(300);
    expect(posts.length).toBe(1);
    await expect(page.getByTestId("paged-line")).toContainText("Paging stopped at 03:16");
    // put it back with the panel's own Undo
    await page.getByTestId("panel-undo").tap();
    await expect(ack).toBeVisible();
    await context.close();
  });

  test("desktop: a row near the bottom edge sends the toast to the top; a row higher up leaves it at the bottom", async ({ browser, baseURL }) => {
    for (const height of [470, 900]) {
      const context = await browser.newContext({ baseURL, viewport: { width: 1440, height } });
      const page = await context.newPage();
      await open(page, "/incidents", true);
      const first = rows(page).first();
      const ack = first.getByRole("button", { name: /^Acknowledge / });
      const pressed = await rect(ack);
      await ack.click();
      const toast = page.getByTestId("toast");
      await expect(toast).toContainText("Acknowledged in Mirae Pay");
      const want = pressed.bottom + 24 > height - 200 ? "top" : "bottom";
      expect(want).toBe(height === 470 ? "top" : "bottom");
      expect(await toast.getAttribute("data-place")).toBe(want);
      expect(overlap(await rect(toast), pressed)).toBe(false);
      await page.waitForTimeout(700);
      await toast.getByRole("button", { name: "Undo" }).click();
      await expect(ack).toBeVisible();
      await context.close();
    }
  });
});

const FIRST_SCREEN = [{ width: 360, height: 640 }, { width: 375, height: 667 }, { width: 390, height: 664 }, { width: 390, height: 740 }];
for (const vp of FIRST_SCREEN) {
  for (const fonts of [true, false]) {
    test.describe(`P2-O ${vp.width}×${vp.height}, fonts ${fonts ? "loaded" : "blocked"}`, () => {
      test.use({ viewport: vp, hasTouch: true });

      test("the first incident's Acknowledge is above the bottom menu on the first screen; the filters are one line", async ({ page }) => {
        await open(page, "/incidents", fonts);
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        const ack = rows(page).first().getByRole("button", { name: /^Acknowledge / });
        const menu = await rect(page.locator(".bnav"));
        const b = await rect(ack);
        expect(b.bottom, `Acknowledge ends at ${b.bottom}, the menu starts at ${menu.top}`).toBeLessThanOrEqual(menu.top);
        expect(await reachable(ack)).toBe(true);
        // status chips, Sev and Assignee: one line, scrolling sideways inside itself; the page does not scroll sideways
        const filters = page.locator(".inc-filters");
        const fb = await rect(filters);
        expect(fb.bottom - fb.top).toBeLessThanOrEqual(52);
        const tops = await filters.locator(".chip, .sel").evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).map((e) => Math.round(e.getBoundingClientRect().top)));
        expect(tops.length).toBe(5);
        expect(new Set(tops).size).toBe(1);
        const heights = await filters.locator(".chip, .sel").evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).map((e) => Math.round(e.getBoundingClientRect().height)));
        expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        // the last control of the line can be brought into view and used
        const assignee = page.getByLabel("Assignee");
        await assignee.scrollIntoViewIfNeeded();
        await expect(assignee).toBeInViewport({ ratio: 1 });
        // the unmapped-account notice is short, and all of it is the way to Map account
        const banner = page.locator(".inc-unmapped .banner").first();
        const nb = await rect(banner);
        expect(nb.bottom - nb.top).toBeGreaterThanOrEqual(44);
        expect(nb.bottom - nb.top).toBeLessThanOrEqual(92);
        expect(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("a")?.textContent ?? null, [nb.left + 40, nb.top + 10])).toBe("Map account →");
      });

      test("every incident's actions can be scrolled clear of the bottom menu and of what sticks to the top, however they are scrolled into view", async ({ page }) => {
        await open(page, "/incidents", fonts);
        const controls = page.locator("tr[data-id] .c-act button");
        const n = await controls.count();
        expect(n).toBeGreaterThanOrEqual(3);
        for (let i = 0; i < n; i++) {
          for (const block of ["start", "center", "end", "nearest"] as const) {
            await controls.nth(i).evaluate((el, b) => el.scrollIntoView({ block: b, behavior: "instant" }), block);
            await settle(page);
            expect(await reachable(controls.nth(i)), `row action ${i} after scrollIntoView(${block})`).toBe(true);
          }
        }
        // from the top, as a person does: Playwright's own scroll-if-needed, then a tap, reaches the last row's control
        await page.evaluate(() => window.scrollTo(0, 0));
        await controls.nth(n - 1).scrollIntoViewIfNeeded();
        expect(await reachable(controls.nth(n - 1))).toBe(true);
      });
    });
  }
}

test.describe("P2-O the same rule on the other screens, 360×640", () => {
  test.use({ viewport: { width: 360, height: 640 }, hasTouch: true });

  test("Call order: every row's link can be scrolled clear of the menu and the filter line", async ({ page }) => {
    await open(page, "/call-order", true);
    const links = page.locator(".t.co tbody tr a.co-path");
    const n = await links.count();
    expect(n).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < n; i++) {
      for (const block of ["start", "center", "end", "nearest"] as const) {
        await links.nth(i).evaluate((el, b) => el.scrollIntoView({ block: b, behavior: "instant" }), block);
        await settle(page);
        expect(await reachable(links.nth(i)), `call order row ${i} after scrollIntoView(${block})`).toBe(true);
      }
    }
  });

  for (const path of ["/incidents", "/incidents?status=RESOLVED", PAY, "/call-order", "/call-order/c/daon", "/customers", "/people", "/monitoring", "/maintenance", "/settings"]) {
    test(`${path}: at the end of the page the content ends above the bottom menu`, async ({ page }) => {
      await open(page, path, true);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await settle(page);
      const m = await page.evaluate(() => {
        const main = document.querySelector("main")!;
        const menu = document.querySelector(".bnav")!.getBoundingClientRect();
        const cs = getComputedStyle(main);
        // the lowest thing drawn inside main
        let lowest = 0;
        for (const el of main.querySelectorAll<HTMLElement>("*")) {
          if (el.getClientRects().length === 0 || getComputedStyle(el).position === "fixed" || el.closest(".toast")) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) lowest = Math.max(lowest, r.bottom);
        }
        return { lowest, menuTop: menu.top, menuH: menu.height, pad: parseFloat(cs.paddingBottom), spb: getComputedStyle(document.documentElement).scrollPaddingBottom, ox: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      expect(m.pad).toBeGreaterThanOrEqual(m.menuH); // bottom padding = the menu's height (the safe-area inset is in both)
      expect(m.lowest).toBeLessThanOrEqual(m.menuTop + 1); // a line box may reach a fraction of a pixel past its block
      expect(parseFloat(m.spb)).toBeGreaterThanOrEqual(m.menuH);
      expect(m.ox).toBeLessThanOrEqual(0);
    });
  }
});

for (const vp of [{ width: 390, height: 740 }, { width: 360, height: 740 }, { width: 1440, height: 900 }]) {
  test.describe(`P3-P ${vp.width}×${vp.height}`, () => {
    test.use({ viewport: vp, hasTouch: vp.width < 600 });
    test("panel: nothing in the action row moves sideways (or up or down) when the incident is acknowledged and when Resolve… comes", async ({ page }) => {
      await open(page, PAY, true);
      const wrap = page.locator(".hero-actions-wrap > .hero-actions");
      const xs = () => wrap.evaluate((w) => { const q = (e: Element) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }; return [q(w), ...[...w.children].map(q)]; });
      const title = () => page.locator("#inc-title").evaluate((e) => e.getBoundingClientRect().x);
      // on a phone the three actions are fixed columns: nothing changes at all. Beside the list (desktop) the row may
      // wrap, so there only the left edge of the row and of Mute and Escalate, which never wrap, is held to 0
      const phone = vp.width < 600;
      const dims = phone ? [0, 1, 2, 3] : [0];
      const before = await xs();
      const t0 = await title();
      expect(before.length).toBe(4);
      const ack = page.getByRole("button", { name: "Acknowledge", exact: true });
      if (vp.width < 600) await ack.tap(); else await ack.click();
      await expect(page.getByTestId("panel-acked")).toBeVisible();
      await expect(page.getByTestId("paged-line")).toContainText("Paging stopped");
      await settle(page);
      const after = await xs();
      const n = phone ? before.length : 3;
      for (let i = 0; i < n; i++) for (const k of dims) expect(Math.abs(after[i]![k]! - before[i]![k]!), `box ${i} [x,y,w,h][${k}]: ${before[i]} → ${after[i]}`).toBeLessThanOrEqual(0.01);
      expect(Math.abs((await title()) - t0)).toBeLessThanOrEqual(0.01);
      await expect(page.getByRole("button", { name: "Resolve…" })).toBeVisible({ timeout: 8000 });
      const later = await xs();
      for (let i = 0; i < n; i++) for (const k of dims) expect(Math.abs(later[i]![k]! - before[i]![k]!), `box ${i} [x,y,w,h][${k}] with Resolve…: ${before[i]} → ${later[i]}`).toBeLessThanOrEqual(0.01);
      await page.getByTestId("panel-undo").click();
      await expect(ack).toBeVisible();
      await settle(page);
      const back = await xs();
      for (let i = 0; i < n; i++) expect(Math.abs(back[i]![0]! - before[i]![0]!)).toBeLessThanOrEqual(0.01);
    });
  });
}
