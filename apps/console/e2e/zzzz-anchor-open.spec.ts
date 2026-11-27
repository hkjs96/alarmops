// #184: the row you were looking at stays where it is when a Call order panel opens, closes or saves (decision 11/27
// "보던 행 고정"). Opening goes to another route, which used to send the list back to the top (1440: `.page` is a new
// element at scrollTop 0; 390: the window is sent to the top). Every check measures the row's top in the VIEWPORT.
import { test, expect, type Page } from "@playwright/test";
import { assertAnchorRowHeld, noScrollAnchoring } from "./helpers/no-row-shift";

const CO = '[data-testid="co-row"]';
const toast = (page: Page) => page.getByTestId("toast");
const signIn = async (page: Page, next = "/call-order") => {
  await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
};
const top = (page: Page, key: string) => page.evaluate(([sel, k]) => {
  const el = [...document.querySelectorAll<HTMLElement>(sel!)].find((e) => e.dataset.rowKey === k && e.getClientRects().length > 0);
  return el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null;
}, [CO, key] as const);
const keys = (page: Page) => page.$$eval(CO, (els) => els.map((e) => (e as HTMLElement).dataset.rowKey ?? ""));
/** scroll the list (the column on desktop, the window on a phone) so that the row `key` sits `at` px from the top of the view */
const scrollRowTo = (page: Page, key: string, at: number) => page.evaluate(([sel, k, y]) => {
  const el = [...document.querySelectorAll<HTMLElement>(sel as string)].find((e) => e.dataset.rowKey === k)!;
  const d = el.getBoundingClientRect().top - (y as number);
  let p: HTMLElement | null = el.parentElement;
  while (p && p !== document.body && !((p.scrollHeight > p.clientHeight) && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
  if (p && p !== document.body) p.scrollTop += d; else window.scrollBy(0, d);
}, [CO, key, at] as const);
const ORDERS = "hanbit/fulfilment/orders-api";
async function scrolledList(page: Page, want = ORDERS) {
  await noScrollAnchoring(page);
  const all = await keys(page);
  expect(all.length, "the list has enough rows to scroll").toBeGreaterThan(6);
  expect(all, "the row with own steps is listed").toContain(want);
  const key = want;
  await scrollRowTo(page, key, 300);
  await page.waitForTimeout(150);
  const t = await top(page, key);
  expect(Math.abs(t! - 300), "the list is scrolled").toBeLessThanOrEqual(2);
  return key;
}

test.describe("#184 1440: opening and closing a panel holds the row", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("open, then close: the clicked row stays at the same place in the view (+0, +700, +1600 ms)", async ({ page }) => {
    await signIn(page);
    const key = await scrolledList(page);
    const link = page.locator(`${CO}[data-key="${key}"] a[data-key]`);
    await assertAnchorRowHeld(page, { name: "callorder.open.anchor", rows: CO, preferKey: key, at: link, then: async () => { await expect(page.locator(".co-panel")).toHaveCount(1); } });
    // closing without having scrolled the list: the same row is still where it was
    const t0 = await top(page, key);
    await page.getByRole("button", { name: /^Close/ }).first().click();
    await expect(page.locator(".co-panel")).toHaveCount(0);
    for (const ms of [0, 700, 1600]) {
      await page.waitForTimeout(ms === 0 ? 0 : ms === 700 ? 700 : 900);
      expect(Math.abs((await top(page, key))! - t0!), `close +${ms}ms: ${key}`).toBeLessThanOrEqual(2);
    }
  });
});

test.describe("#184 390: after the panel replaced the list, save and close bring the row back", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("open, edit, save: the row is at its old place in the view (+0, +700, +1600 ms) and the focus is on a visible link", async ({ page }) => {
    await signIn(page);
    const key = await scrolledList(page);
    const before = (await top(page, key))!;
    await page.locator(`${CO}[data-key="${key}"] a[data-key]`).tap();
    await expect(page.locator(".co-panel")).toHaveCount(1);
    await page.getByTestId("co-edit").click();
    const min = page.getByLabel("Step 2 minutes");
    await min.fill(String(Number(await min.inputValue()) + 1));
    await page.getByTestId("co-save").click();
    await expect(toast(page)).toContainText("Saved for");
    await expect(page.locator(".co-panel")).toHaveCount(0);
    let waited = 0;
    for (const ms of [0, 700, 1600]) {
      await page.waitForTimeout(ms - waited); waited = ms;
      const t = await top(page, key);
      expect(t, `+${ms}ms: ${key} is in the list`).not.toBeNull();
      expect(Math.abs(t! - before), `+${ms}ms: ${key} was ${before}px from the top of the view, now ${t}px`).toBeLessThanOrEqual(2);
    }
    const f = await page.evaluate(() => { const a = document.activeElement as HTMLElement; const r = a.getBoundingClientRect(); return { link: a.matches("a[data-key]"), inView: r.bottom > 0 && r.top < innerHeight }; });
    expect(f).toEqual({ link: true, inView: true });
    // put the call order back as it was
    await page.waitForTimeout(700);
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page)).toContainText("Undone");
  });
});
