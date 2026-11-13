import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The console's rule for every list (QA P1-A, twice): after an action that changes or removes a row, no row moves under
 * the pointer. A removed row stays where it was (a tombstone); a changed row changes in place; nothing slides up into
 * the spot that was just pressed. `assertNoRowShift` presses a control and checks exactly that — right after, and
 * again 0.7 s and 1.6 s later (the old bug bit after a pause too).
 *
 * Every control with `data-list-action="<name>"` must be exercised by one call with that name: the unit test
 * "each list action is covered by assertNoRowShift" (src/lib/contract.test.ts) fails otherwise.
 */
export type RowBox = { key: string; x: number; y: number; h: number };
export interface NoRowShift {
  /** the list action, as in `data-list-action` */
  name: string;
  /** selector of the rows; each row carries `data-row-key` */
  rows: string;
  /** the control that is pressed */
  at: Locator;
  /** how it is pressed: a mouse click at its centre (default), a touch tap, Enter on it, or choosing an option of a <select> */
  how?: "click" | "tap" | "enter" | { select: string };
  /** what follows the press before the list is looked at again (confirm a dialog, pick a menu item, wait for a toast) */
  then?: () => Promise<void>;
  /** compare with this instead of the rows as they are when called (a list that was measured before its panel opened) */
  baseline?: RowBox[];
  /** rows that start below the pressed point may move down — never up — because a row was added above them */
  mayGrowBelow?: boolean;
  /** the pressed control sits below the list it adds to (Responders, P3-K): rows may move down — never up — by the row that was added */
  mayMoveDown?: boolean;
  /** rows of the baseline that the action is expected to take away for good (an explicit refresh): none by default */
  settleMs?: number[];
}

const readBoxes = (page: Page, rows: string): Promise<RowBox[]> => page.$$eval(rows, (els) => els.filter((e) => (e as HTMLElement).offsetParent !== null || e.getClientRects().length > 0).map((e) => {
  const b = e.getBoundingClientRect();
  return { key: (e as HTMLElement).dataset.rowKey ?? "", x: Math.round(b.x + window.scrollX), y: Math.round(b.y + window.scrollY), h: Math.round(b.height) };
}));

/**
 * The rows as they stand once the page has stopped moving by itself (the shell animates its columns for 180 ms when a
 * panel opens or closes; fonts arrive): two readings 120 ms apart that agree.
 */
export async function rowBoxes(page: Page, rows: string): Promise<RowBox[]> {
  let prev = await readBoxes(page, rows);
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(120);
    const now = await readBoxes(page, rows);
    if (JSON.stringify(now) === JSON.stringify(prev)) return now;
    prev = now;
  }
  return prev;
}

/** what is under a point: the row it belongs to and the list action it would trigger */
const under = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => {
  const el = document.elementFromPoint(px!, py!);
  const act = el?.closest<HTMLElement>("[data-list-action]") ?? null;
  return { row: el?.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey ?? null, action: act && !(act as HTMLButtonElement).disabled ? act.dataset.listAction ?? null : null };
}, [x, y]);

/**
 * Rows must hold their place by how the page is built, not because the browser re-scrolls for us: Chromium's scroll
 * anchoring hides a banner that grows above a list, Safari has none (QA 재점검 P2-B). Every measurement here is taken
 * with anchoring switched off.
 */
export async function noScrollAnchoring(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.getElementById("e2e-no-anchor")) return;
    const st = document.createElement("style");
    st.id = "e2e-no-anchor";
    st.textContent = "*, *::before, *::after { overflow-anchor: none !important; }";
    document.head.appendChild(st);
  });
}

export async function assertNoRowShift(page: Page, o: NoRowShift): Promise<RowBox[]> {
  await noScrollAnchoring(page);
  const before = o.baseline ?? await rowBoxes(page, o.rows);
  expect(before.length, `${o.name}: the list has rows`).toBeGreaterThan(0);
  expect(before.every((r) => r.key), `${o.name}: every row has data-row-key`).toBe(true);
  // into the middle of the view: nothing that sticks to an edge (the phone's bottom menu, the panel's footer) is over it
  await o.at.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const scroll0 = await page.evaluate(() => [window.scrollX, window.scrollY, ...[...document.querySelectorAll<HTMLElement>(".panel-body, .tw")].map((e) => e.scrollTop)].join(","));
  const start = o.baseline ? before : await rowBoxes(page, o.rows);
  const b = (await o.at.boundingBox())!;
  const p = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  const pressed = await under(page, p.x, p.y);

  if (o.how === "tap") await page.touchscreen.tap(p.x, p.y);
  else if (o.how === "enter") { await o.at.focus(); await page.keyboard.press("Enter"); }
  else if (typeof o.how === "object") await o.at.selectOption(o.how.select);
  else await page.mouse.click(p.x, p.y);
  await o.then?.();

  let last: RowBox[] = [];
  let waited = 0;
  for (const ms of o.settleMs ?? [0, 700, 1600]) {
    await page.waitForTimeout(ms - waited);
    waited = ms;
    const scroll = await page.evaluate(() => [window.scrollX, window.scrollY, ...[...document.querySelectorAll<HTMLElement>(".panel-body, .tw")].map((e) => e.scrollTop)].join(","));
    const now = await rowBoxes(page, o.rows);
    last = now;
    const pos = new Map(now.map((r) => [r.key, r]));
    // 1. nobody left: a removed row is still there (as a tombstone)
    expect(start.filter((r) => !pos.has(r.key)).map((r) => r.key), `${o.name} +${ms}ms: rows that disappeared`).toEqual([]);
    // 2. the order of the rows that were there is the same
    const keys = new Set(start.map((r) => r.key));
    expect(now.filter((r) => keys.has(r.key)).map((r) => r.key), `${o.name} +${ms}ms: order`).toEqual(start.map((r) => r.key));
    // 3. nothing moved (compared only while nothing was scrolled: a page that scrolls is not a row that shifts)
    if (o.baseline || scroll === scroll0) {
      const moved = start.map((r) => ({ key: r.key, dx: pos.get(r.key)!.x - r.x, dy: pos.get(r.key)!.y - r.y, from: r.y }))
        .filter((m) => Math.abs(m.dx) > 1 || (o.mayMoveDown || (o.mayGrowBelow && m.from >= p.y) ? m.dy < -1 : Math.abs(m.dy) > 1));
      expect(moved, `${o.name} +${ms}ms: rows that moved`).toEqual([]);
    }
    // 4. the pressed spot: no action of another row has come under it
    const u = await under(page, p.x, p.y);
    if (u.action && u.row !== pressed.row) expect(`${u.action} of row ${u.row}`, `${o.name} +${ms}ms: an action of another row is under the pressed spot`).toBe("nothing");
  }
  return last;
}

/**
 * The second half of the rule: pressing the same spot again within 600 ms does nothing, whatever is there by then.
 * `count` reads the number that must not change (rows not gone, requests sent, …).
 */
export async function assertSecondPressIgnored(page: Page, name: string, at: Locator, count: () => Promise<number>, how: "click" | "tap" = "click"): Promise<void> {
  await at.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const b = (await at.boundingBox())!;
  const p = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  if (how === "tap") { await page.touchscreen.tap(p.x, p.y); await page.touchscreen.tap(p.x, p.y); }
  else await page.mouse.dblclick(p.x, p.y);
  await page.waitForTimeout(900);
  expect(await count(), `${name}: a double press counted once`).toBeLessThanOrEqual(1);
}
