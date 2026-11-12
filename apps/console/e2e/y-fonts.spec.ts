// A web font that arrives late must not move a row or a button (src/app/fonts.ts: self-hosted, font-display: optional).
// The font files are held back here until the page has been measured, then let go: nothing may move by more than
// half a pixel, the browser must report no layout shift at all, and a press at the spot measured before the fonts
// came acknowledges exactly the incident that was there. Runs before z-ack.spec.ts (file order), on the mock store as
// scope.spec.ts leaves it; the test that acknowledges undoes it.
import { test, expect, type Page } from "@playwright/test";
import { reportOnFailure, watchPage } from "./helpers/diag";

const PAY_ID = "inc-7f3a0c91b2d4-20261108181204";
const PAY = `/c/mirae/core/payments-api/incident/${PAY_ID}`;
const FONT_FILES = "**/_next/static/media/*.woff2";
type Box = [number, number, number, number];

test.beforeEach(({ page }) => watchPage(page));
test.afterEach(({ page }, info) => reportOnFailure(page, info));

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
/** every font file waits until `release()`; `asked` counts the files the page has asked for */
async function holdFonts(page: Page) {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const state = { asked: 0, served: 0, release: () => open() };
  await page.route(FONT_FILES, async (route) => {
    state.asked++;
    await gate;
    await route.continue();
    state.served++;
  });
  return state;
}
/** list rows, their action cells and buttons, the bars above the list and the panel's actions: [x, y, width, height] by name */
const boxes = (page: Page) => page.evaluate(() => {
  const out: Record<string, number[]> = {};
  const put = (key: string, e: Element | null) => { if (!e || e.getClientRects().length === 0) return; const r = e.getBoundingClientRect(); out[key] = [r.x + window.scrollX, r.y + window.scrollY, r.width, r.height]; };
  for (const tr of document.querySelectorAll<HTMLElement>("tr[data-id]")) {
    const id = tr.dataset.id!;
    put(`row ${id}`, tr);
    put(`title ${id}`, tr.querySelector("a.ttl"));
    put(`action cell ${id}`, tr.querySelector(".c-act"));
    tr.querySelectorAll(".c-act button").forEach((b, n) => put(`action ${n} ${id}`, b));
  }
  put("scope line", document.querySelector(".sline"));
  put("list bar", document.querySelector(".list-bar"));
  put("tiles", document.querySelector(".tiles"));
  put("bottom menu", document.querySelector(".bnav"));
  document.querySelectorAll(".hero-actions-wrap button, .hero-actions-wrap a").forEach((b, n) => put(`panel action ${n} ${b.textContent}`, b));
  put("panel path", document.querySelector("[data-testid=panel-path]"));
  return out;
}) as Promise<Record<string, Box>>;
const shifts = (page: Page) => page.evaluate(() => ((window as unknown as { __diag?: unknown[][] }).__diag ?? []).filter((e) => e[1] === "layout-shift").map((e) => e.join(" ")));
const fontsPending = (page: Page) => page.evaluate(() => [...document.fonts].filter((f) => f.status === "loading").length);
const settled = (page: Page) => page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))));
/** the text is drawn in the web font (true) or in a fallback (false): a probe in the font alone is as wide as the same text in the fallback only when the font is not used */
const drawnIn = (page: Page, family: string) => page.evaluate((ff) => {
  const width = (font: string) => { const s = document.createElement("span"); s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:16px ${font}`; s.textContent = "Acknowledge payments-db-1 0123456789"; document.body.append(s); const w = s.getBoundingClientRect().width; s.remove(); return w; };
  return Math.abs(width(`${ff}, serif`) - width("serif")) > 1;
}, family);
function expectSame(before: Record<string, Box>, after: Record<string, Box>, when: string) {
  expect(Object.keys(after), when).toEqual(Object.keys(before));
  for (const [key, b] of Object.entries(before)) {
    const a = after[key]!;
    const moved = Math.max(...b.map((v, n) => Math.abs(v - a[n]!)));
    expect(moved, `${key} ${when}: ${b.join(",")} → ${a.join(",")}`).toBeLessThanOrEqual(0.5);
  }
}
async function openHeld(page: Page, next: string) {
  const fonts = await holdFonts(page);
  // "commit": the page's load waits for the font files, and they are held
  await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`, { waitUntil: "commit" });
  await page.waitForURL((u) => u.pathname === next.split("?")[0], { waitUntil: "commit" });
  return fonts;
}
const hydrated = (page: Page, selector: string) => page.waitForFunction((sel) => { const e = document.querySelector(sel); return Boolean(e && Object.keys(e).some((k) => k.startsWith("__reactProps"))); }, selector);

for (const vp of [{ width: 390, height: 740 }, { width: 1440, height: 900 }]) {
  test.describe(`fonts that arrive late, at ${vp.width}`, () => {
    test.use({ viewport: vp, hasTouch: vp.width < 600 });

    test("the list: no row and no button moves when the fonts come; the spot measured before them still acknowledges that incident, and only it", async ({ page }) => {
      const errors = watchErrors(page);
      const fonts = await openHeld(page, "/incidents");
      const first = page.getByTestId("incident-row").first();
      const ack = first.getByRole("button", { name: /^Acknowledge payments-db-1/ });
      await expect(ack).toBeVisible();
      await hydrated(page, "tr[data-id] .c-act button");
      // the page is up and usable while the fonts are still on their way
      expect(fonts.asked).toBeGreaterThanOrEqual(3); // the Latin text face and both weights of the monospace are preloaded
      expect(fonts.served).toBe(0);
      expect(await fontsPending(page)).toBeGreaterThan(0);
      const before = await boxes(page);
      expect(Object.keys(before).filter((k) => k.startsWith("row ")).length).toBeGreaterThanOrEqual(4);
      const b = (await ack.boundingBox())!;
      const at = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };

      fonts.release();
      await expect.poll(() => fonts.served).toBe(fonts.asked);
      await settled(page);
      expectSame(before, await boxes(page), "right after the fonts came");
      await page.waitForTimeout(700);
      await settled(page);
      expectSame(before, await boxes(page), "0.7 s after the fonts came");
      expect(await fontsPending(page)).toBe(0);
      expect(await shifts(page), "layout shifts reported by the browser").toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`fonts-arrived-${vp.width}.png`) });

      // a press where the button was before the fonts came
      if (vp.width < 600) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
      await expect(first.getByTestId("ack-label")).toHaveText("Acknowledged ✓ 03:16");
      // exactly one incident: the other open ones still offer Acknowledge
      await expect(page.getByRole("button", { name: /^Acknowledge / })).toHaveCount(2);
      expect(await first.getAttribute("data-id")).toBe(PAY_ID);
      // put the shared mock store back
      await first.getByRole("button", { name: /^More for / }).click();
      await page.getByRole("menuitem", { name: "Undo acknowledge" }).click();
      await expect(first.getByRole("button", { name: /^Acknowledge / })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Acknowledge / })).toHaveCount(3);
      expect(errors).toEqual([]);
    });

    test("the incident panel: its actions and the list beside it stay where they are when the fonts come", async ({ page }) => {
      const errors = watchErrors(page);
      const fonts = await openHeld(page, PAY);
      const ack = page.getByRole("button", { name: "Acknowledge", exact: true });
      await expect(ack).toBeVisible();
      await expect(page.getByTestId("panel-path")).toBeVisible();
      await hydrated(page, ".hero-actions-wrap button");
      expect(fonts.served).toBe(0);
      const before = await boxes(page);
      expect(Object.keys(before).some((k) => k.startsWith("panel action "))).toBe(true);

      fonts.release();
      await expect.poll(() => fonts.served).toBe(fonts.asked);
      await settled(page);
      expectSame(before, await boxes(page), "right after the fonts came");
      await page.waitForTimeout(700);
      await settled(page);
      expectSame(before, await boxes(page), "0.7 s after the fonts came");
      expect(await shifts(page), "layout shifts reported by the browser").toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}

test.describe("fonts in time", () => {
  test("the console's own files are the only thing fetched, and the text is drawn in them", async ({ page }) => {
    const errors = watchErrors(page);
    const elsewhere: string[] = [];
    const fontFiles = new Set<string>();
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.protocol.startsWith("http") && u.origin !== new URL(page.url() === "about:blank" ? test.info().project.use.baseURL! : page.url()).origin) elsewhere.push(r.url());
      if (r.resourceType() === "font") fontFiles.add(u.pathname);
    });
    await page.goto("/auth/dev-login?next=%2Fincidents");
    await page.waitForLoadState("networkidle");
    await settled(page);
    // no font swapped in after the first paint here either
    expect(await shifts(page), "layout shifts reported by the browser").toEqual([]);
    // a second view has the files in the cache: from then on, at the latest, the web fonts are what is drawn
    await page.reload();
    await page.waitForLoadState("networkidle");
    await settled(page);
    expect(await drawnIn(page, "var(--font-sans-latin)"), "Pretendard").toBe(true);
    expect(await drawnIn(page, "var(--font-mono)"), "Space Mono").toBe(true);
    expect([...fontFiles].every((p) => p.startsWith("/_next/static/media/")), [...fontFiles].join(" ")).toBe(true);
    expect(fontFiles.size).toBeGreaterThanOrEqual(3);
    // the 2 MB file with Hangul is not fetched for a page without Hangul
    const sizes = await page.evaluate(() => (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((e) => e.name.endsWith(".woff2")).map((e) => e.decodedBodySize));
    expect(Math.max(0, ...sizes)).toBeLessThan(400_000);
    expect(elsewhere).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe("the app's scripts arrive after the framework's", () => {
  // Found while looking for the lost taps: with the route's own chunks a moment late, React often failed to take over
  // the page as sent (error #418) and rendered it again from nothing — 12 loads of 30 this way before the fix (the
  // note in layout.tsx), about 1 in 15 without any delay.
  test("the page is taken over as it was sent: no hydration error in 10 loads of the list and the panel", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const failed: string[] = [];
    for (let n = 0; n < 10; n++) {
      const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 740 }, hasTouch: true });
      const page = await context.newPage();
      const errors = watchErrors(page);
      // the route's own chunks (layout, page) 0.3 s after everything else
      await page.route(/_next\/static\/chunks\/app\/.*\.js/, async (route) => {
        await new Promise((r) => setTimeout(r, 300));
        await route.continue().catch(() => undefined);
      });
      const next = n % 2 ? PAY : "/incidents";
      await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);
      await hydrated(page, n % 2 ? ".hero-actions-wrap button" : "tr[data-id] .c-act button");
      await page.waitForTimeout(300);
      if (errors.length) failed.push(`load ${n + 1} ${next}: ${errors.join(" | ").slice(0, 200)}`);
      await context.close();
    }
    expect(failed).toEqual([]);
  });
});
