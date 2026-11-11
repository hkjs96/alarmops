// QA "Console Call order 최종 점검 — 2026-11-11": P2-C (the held top of the panel must not pass for "now"), P2-D (a
// session that is gone fails visibly, for every action), P3-F·G·H·I, security 재검토 3 권고 2·4.
// Runs last (zzzzz-). The session tests change nothing on the server — that is their point — except where a real
// action is needed first: one incident is left acknowledged (its Undo was refused because the session was gone and the
// undo token lives in that page only), and every call order or Responders list that is changed is put back.
import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { noScrollAnchoring } from "./helpers/no-row-shift";

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const signIn = async (page: Page, next = "/call-order") => {
  await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
};
const card = (page: Page) => page.getByTestId("co-responders");
const RESP = '[data-testid="co-responders"] li[data-row-key]';
const person = (page: Page, id: string) => card(page).locator(`li[data-row-key="${id}"]`);
const dlg = (page: Page) => page.getByTestId("confirm-dialog");
const guard = (page: Page) => page.getByTestId("dirty-guard");
const toast = (page: Page) => page.getByTestId("toast");
const live = (page: Page) => card(page).getByTestId("co-resp-live");
const heldNow = (page: Page) => page.getByTestId("co-held-now");
const ended = (page: Page) => page.getByTestId("session-ended");
const READ = 700;
/** all three of Daon Retail, in whatever order the list has them (a person put back comes last) */
const ALL3_PAGED = /Paged \(3\): (?=.*Junho Park)(?=.*Minjae Lee)(?=.*Soyeon Choi)/;
const ALL3_NOW = /^Now: OK — paged \(3\): (?=.*Junho Park)(?=.*Minjae Lee)(?=.*Soyeon Choi)[A-Za-z, ]+$/;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const VIEWPORTS = [{ w: 1440, h: 900, touch: false }, { w: 390, h: 844, touch: true }];
const aoKeys = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("ao-draft")));
const session = async (page: Page) => (await page.context().cookies()).find((c) => c.name === "ao_session");

/** every Responders row and the top block: where they are on the screen (exact), and how far everything is scrolled */
const place = (page: Page) => page.evaluate((sel) => {
  const top = document.querySelector<HTMLElement>('[data-testid="co-top"]')!.getBoundingClientRect();
  return {
    top: `top ${top.top.toFixed(2)} height ${top.height.toFixed(2)}`,
    rows: [...document.querySelectorAll<HTMLElement>(sel)].map((e) => { const b = e.getBoundingClientRect(); return `${e.dataset.rowKey} top ${b.top.toFixed(2)} height ${b.height.toFixed(2)}`; }),
    scroll: [window.scrollX, window.scrollY, ...[...document.querySelectorAll<HTMLElement>(".panel-body, .tw")].map((e) => e.scrollTop)].join(","),
  };
}, RESP);
async function settled(page: Page) {
  let prev = JSON.stringify(await place(page));
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const now = JSON.stringify(await place(page));
    if (now === prev) break;
    prev = now;
  }
  return place(page);
}
/**
 * The same boxes measured inside what scrolls (screen position + how far the panel and the window are scrolled). Used
 * where the test itself has to scroll between two presses (the controls of a long list are not all in one view): a
 * line that was added or taken away above a row still shows as a changed number; the test's own scrolling does not.
 */
async function layout(page: Page) {
  const p = await settled(page);
  const off = await page.evaluate(() => window.scrollY + (document.querySelector<HTMLElement>(".panel-body")?.scrollTop ?? 0));
  const shiftBy = (line: string) => line.replace(/top (-?[\d.]+)/, (_, v: string) => `top ${(Number(v) + off).toFixed(1)}`);
  return { top: shiftBy(p.top), rows: p.rows.map(shiftBy) };
}
/** P3-I: what a status line says fits in the height reserved for it — nothing is cut off */
const fits = (page: Page, testid: string) => page.getByTestId(testid).locator(".co-resp-live-t").evaluate((e) => {
  const line = e.parentElement!.getBoundingClientRect();
  const text = e.getBoundingClientRect();
  return { cut: Math.max(text.bottom - line.bottom, line.top - text.top, e.scrollHeight - e.clientHeight), wide: e.scrollWidth - e.clientWidth, ellipsis: getComputedStyle(e).textOverflow };
});
const expectFits = async (page: Page, testid: string, what: string) => {
  const f = await fits(page, testid);
  expect(f.cut, `${what}: text cut off vertically`).toBeLessThanOrEqual(0);
  expect(f.wide, `${what}: text cut off sideways`).toBeLessThanOrEqual(0);
  expect(f.ellipsis, what).not.toBe("ellipsis");
};
const toTop = (page: Page) => page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll<HTMLElement>(".panel-body").forEach((e) => { e.scrollTop = 0; }); });
const removeResponder = async (page: Page, name: string) => {
  await card(page).getByRole("button", { name: `Remove ${name} from Responders of Daon Retail` }).click();
  await page.waitForTimeout(READ);
  await dlg(page).getByRole("button", { name: `Remove ${name} from Daon Retail` }).click();
  await expect(toast(page)).toContainText(`${name} removed`);
};

for (const vp of VIEWPORTS) {
  test.describe(`P2-C the held top of the panel while Responders are edited, at ${vp.w}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch });

    test("from the press on Edit it is a box of the same height, dimmed, labelled, with the live reach on one fixed line; 0px for it and for every row", async ({ page }) => {
      await signIn(page, "/c/daon/call-order");
      await noScrollAnchoring(page);
      await expect(page.getByTestId("co-paged")).toContainText(ALL3_PAGED);
      await expect(page.getByTestId("co-held-label")).toHaveCount(0);
      const edit = card(page).getByTestId("co-resp-edit");
      await edit.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const before = await settled(page);

      // Edit: the one moment the block changes — and it changes without moving anything
      await edit.click();
      await expect(page.getByTestId("co-held-label")).toHaveText("Before your changes — updates when you press Done");
      await expect(heldNow(page)).toHaveText(ALL3_NOW);
      const held = await settled(page);
      expect(held.top, "the top block kept its place and its height when Edit was pressed").toBe(before.top);
      expect(held.scroll).toBe(before.scroll);
      const old = page.getByTestId("co-top-old");
      expect(await old.evaluate((e) => [(e as HTMLElement).inert, getComputedStyle(e).opacity, e.getAttribute("aria-hidden")])).toEqual([true, "0.5", "true"]);
      await expect(page.getByTestId("co-top")).toHaveAttribute("data-held", "1");
      const lineH = (await heldNow(page).boundingBox())!.height;
      expect(lineH).toBe(vp.w <= 760 ? 70 : 52);

      const role = card(page).getByLabel("Role of Soyeon Choi");
      await role.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const start = await layout(page);
      const same = async (what: string) => { expect(await layout(page), what).toEqual(start); };

      await removeResponder(page, "Junho Park");
      await expect(heldNow(page)).toHaveText("Now: OK — paged (2): Minjae Lee, Soyeon Choi");
      await same("after removing Junho Park");
      await removeResponder(page, "Minjae Lee");
      await expect(heldNow(page)).toHaveText("Now: AT RISK — paged (1): Soyeon Choi");
      await expect(heldNow(page)).toHaveClass(/\bar\b/);
      await same("after removing Minjae Lee (At risk)");
      await role.selectOption("NOTIFY_ONLY");
      await page.waitForTimeout(READ);
      await dlg(page).getByRole("button", { name: "Make Soyeon Choi Notify only for Daon Retail" }).click();
      await expect(heldNow(page)).toHaveText("Now: UNREACHABLE — nobody is paged");
      await expect(heldNow(page)).toHaveClass(/\bunr\b/);
      await same("after Soyeon Choi → Notify only (Unreachable)");
      expect((await heldNow(page).boundingBox())!.height, "the live line did not grow").toBe(lineH);
      // P3-I: neither status line is cut off, in the longest thing it says
      await expect(live(page)).toContainText("Nobody for Daon Retail is reached now · details below · 2 removed, shown until Done");
      await expectFits(page, "co-held-now", "held live line (Unreachable)");
      await expectFits(page, "co-resp-live", "Responders status line (Unreachable + 2 removed)");
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      // the QA repro: scroll back up to see who is paged now. The answer on top is the live one; the old one is marked.
      await toTop(page);
      await page.waitForTimeout(200);
      const label = (await page.getByTestId("co-held-label").boundingBox())!;
      const now = (await heldNow(page).boundingBox())!;
      expect(label.y, "the label is in the first viewport of the panel").toBeGreaterThanOrEqual(0);
      expect(now.y + now.height, "the live status is in the first viewport of the panel").toBeLessThanOrEqual(vp.h);
      expect(now.y).toBeGreaterThan(label.y);
      const paged = page.getByTestId("co-paged");
      await expect(paged).toContainText(ALL3_PAGED); // still there — under the label, dimmed and inert
      expect(await paged.evaluate((e) => Boolean(e.closest("[inert]")) && Boolean(e.closest('[data-testid="co-top"][data-held="1"]')))).toBe(true);
      expect((await paged.boundingBox())!.y, "the old answer is below the live one").toBeGreaterThan(now.y + now.height - 1);
      await expect(page.getByTestId("co-health")).toHaveCount(0); // the old health banner is not repeated: the live line stands there
      await shot(page, `P2C-${vp.w}-held-top-unreachable`);

      // back, one step at a time, then Done: the block is live again
      await role.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await role.selectOption("PAGEABLE");
      await expect(heldNow(page)).toHaveText("Now: AT RISK — paged (1): Soyeon Choi");
      for (const [id, name] of [["ct_junho", "Junho Park"], ["ct_minjae", "Minjae Lee"]] as const) {
        await page.waitForTimeout(READ);
        await person(page, id).getByRole("button", { name: `Undo: put ${name} back` }).click();
        await expect(person(page, id)).not.toHaveAttribute("data-gone", "1");
      }
      await expect(heldNow(page)).toHaveText(ALL3_NOW);
      await card(page).getByTestId("co-resp-edit").click(); // Done
      await expect(page.getByTestId("co-held-label")).toHaveCount(0);
      await expect(page.getByTestId("co-top")).not.toHaveAttribute("data-held", "1");
      expect(await page.getByTestId("co-top-old").evaluate((e) => [(e as HTMLElement).inert, getComputedStyle(e).opacity])).toEqual([false, "1"]);
      await expect(page.getByTestId("co-paged")).toContainText(ALL3_PAGED);
    });

    test("leaving without Done leaves nothing stale: the list and the panel opened again say what was applied", async ({ page }) => {
      await signIn(page, "/c/daon/call-order");
      await card(page).getByTestId("co-resp-edit").click();
      await removeResponder(page, "Junho Park");
      await removeResponder(page, "Minjae Lee");
      await expect(heldNow(page)).toHaveText("Now: AT RISK — paged (1): Soyeon Choi");
      // out without Done: the Close button at 1440, "Back to the list" on the phone, then Esc for the second round
      if (vp.w > 760) await page.getByRole("button", { name: "Close panel" }).click();
      else await page.getByRole("button", { name: "← Back to the list" }).click();
      await expect(page).toHaveURL(/\/call-order$/);
      const row = page.locator('[data-testid="co-row"][data-row-key="daon"]');
      await expect(row).toContainText(/at risk/i);
      await expect(row).toContainText("Soyeon");
      await expect(row).not.toContainText("Junho");
      // opened again: live, not held, and it says the same
      await page.goto("/c/daon/call-order");
      await expect(page.getByTestId("co-held-label")).toHaveCount(0);
      await expect(page.getByTestId("co-paged")).toContainText("Paged (1): Soyeon Choi");
      await expect(page.getByTestId("co-health")).toContainText("At risk");
      await expect(card(page).locator("li[data-gone]")).toHaveCount(0);

      // put back; this time leave with Esc in the middle of the edit
      await card(page).getByTestId("co-resp-edit").click();
      for (const id of ["ct_junho", "ct_minjae"]) {
        await card(page).getByLabel("MSP staff to add").selectOption(id);
        await page.waitForTimeout(READ);
        await card(page).getByRole("button", { name: "Add to Daon Retail" }).first().click();
        await expect(person(page, id)).toBeVisible();
      }
      await expect(heldNow(page)).toHaveText(ALL3_NOW);
      await expect(page.getByTestId("co-paged")).toContainText("Paged (1): Soyeon Choi"); // held: as it was when Edit was pressed
      await card(page).getByTestId("co-resp-edit").focus();
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/call-order$/);
      await expect(row).not.toContainText(/at risk/i);
      await expect(row).toContainText("Junho");
      await page.goto("/c/daon/call-order");
      await expect(page.getByTestId("co-paged")).toContainText(ALL3_PAGED);
      await expect(page.getByTestId("co-health")).toHaveCount(0);
    });

    test("P3-H Reload after Changed — reload moves no row, and what is under the pointer is not a control", async ({ page, browser }) => {
      await signIn(page, "/c/daon/call-order");
      await noScrollAnchoring(page);
      await card(page).getByTestId("co-resp-edit").click();
      const remove = card(page).getByRole("button", { name: "Remove Junho Park from Responders of Daon Retail" });
      await remove.click();
      await expect(dlg(page)).toBeVisible();
      // another tab removes the same person while this one has the question open
      const other = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      await signIn(other, "/c/daon/call-order");
      await card(other).getByTestId("co-resp-edit").click();
      await card(other).getByRole("button", { name: "Remove Junho Park from Responders of Daon Retail" }).click();
      await other.waitForTimeout(READ);
      await dlg(other).getByRole("button", { name: "Remove Junho Park from Daon Retail" }).click();
      await expect(person(other, "ct_junho")).toHaveAttribute("data-gone", "1");

      await page.waitForTimeout(READ);
      await dlg(page).getByRole("button", { name: "Remove Junho Park from Daon Retail" }).click();
      await expect(card(page).getByTestId("co-resp-conflict")).toContainText("Changed — reload.");
      await expectFits(page, "co-resp-live", "Responders status line (Changed — reload, with the Reload button)");
      // the QA repro: the Reload below the list, with the panel scrolled to its end
      const reload = card(page).getByTestId("co-resp-reload");
      await reload.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(READ); // the question's button was pressed near here a moment ago (same-spot rule)
      const start = await settled(page);
      const b = (await reload.boundingBox())!;
      const at = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
      if (vp.touch) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
      await expect(person(page, "ct_junho").getByTestId("tombstone")).toContainText("No longer in Responders");
      await expect(card(page).getByTestId("co-resp-conflict")).toHaveCount(0);
      await expect(card(page).getByTestId("co-resp-reloaded")).toContainText("Reloaded. These are the Responders of Daon Retail as they are now.");
      for (const ms of [0, 700, 1600]) {
        await page.waitForTimeout(ms === 0 ? 0 : 700);
        expect(await settled(page), `rows after Reload +${ms}ms`).toEqual(start);
        const under = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x!, y!); return e?.closest("button, a[href], select, input")?.outerHTML.slice(0, 80) ?? null; }, [at.x, at.y]);
        expect(under, `a control is under the pressed spot +${ms}ms`).toBeNull();
      }
      await expect(live(page)).not.toContainText("Changed — reload");
      await shot(page, `P3H-${vp.w}-after-reload`);
      // Done lets go of the reserved room
      await card(page).getByTestId("co-resp-edit").click();
      await expect(card(page).getByTestId("co-resp-reloaded")).toHaveCount(0);
      await expect(person(page, "ct_junho")).toHaveCount(0);
      // put back, from the tab that removed him
      await other.waitForTimeout(READ);
      await person(other, "ct_junho").getByRole("button", { name: "Undo: put Junho Park back" }).click();
      await expect(person(other, "ct_junho")).not.toHaveAttribute("data-gone", "1");
      await other.context().close();
      // the same from the Reload in the status line: the line keeps its height, nothing below it moves
      await page.reload();
      await expect(page.getByTestId("co-paged")).toContainText(ALL3_PAGED);
    });
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* P2-D: the session is gone                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** the cookie goes, as it does when the user signs out in another tab or the 8 hours are over */
const loseSession = async (page: Page) => { await page.context().clearCookies({ name: "ao_session" }); expect(await session(page)).toBeUndefined(); };
/** the state every action must end in: said, with Sign in back to this address — not "…ing" for ever */
async function expectSessionEnded(page: Page) {
  await expect(ended(page)).toBeVisible();
  await expect(ended(page)).toHaveAttribute("data-reason", "expired");
  await expect(ended(page).getByRole("heading")).toHaveText("Your session ended — sign in again. Nothing was changed.");
  const here = new URL(page.url());
  await expect(ended(page).getByTestId("session-sign-in")).toHaveText("Sign in");
  await expect(ended(page).getByTestId("session-sign-in")).toHaveAttribute("href", `/login?next=${encodeURIComponent(here.pathname + here.search)}`);
  await expect(ended(page).getByTestId("session-sign-in")).toBeFocused();
  // it cannot be put aside: Esc and a press beside it leave it up
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await expect(ended(page)).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  // nothing on the page still says that something is on its way
  await expect(page.getByText(/^(Saving|Removing|Acknowledging|Adding)…$/)).toHaveCount(0);
}
/** Sign in → the login page → back at the address the tab was on */
async function signInAgain(page: Page) {
  const here = new URL(page.url());
  await ended(page).getByTestId("session-sign-in").click();
  await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(here.pathname + here.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await page.getByRole("link", { name: /sign in as Haeun Kim/ }).click();
  await expect(page).toHaveURL(here.pathname + here.search);
  await page.waitForLoadState("networkidle");
  await expect(ended(page)).toHaveCount(0);
}

for (const vp of VIEWPORTS) {
  test.describe(`P2-D the session is gone: Call order at ${vp.w}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch });

    test("Save: said at once, the button stops saying Saving…, the draft is kept, Sign in comes back to the edit; nothing was saved", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await signIn(page, "/c/iruda/call-order");
      await page.getByTestId("co-edit").click();
      const min = page.getByLabel("Step 2 minutes");
      const was = await min.inputValue();
      const typed = String(Number(was) + 3);
      await min.fill(typed);
      await expect(page.getByTestId("co-unsaved")).toContainText("Unsaved");
      expect(await aoKeys(page)).toHaveLength(1);
      await loseSession(page);
      await page.getByTestId("co-save").click();
      await expectSessionEnded(page);
      await expect(page.getByTestId("co-save")).toContainText("Save for Iruda Edu");
      await expect(page.getByTestId("co-save")).not.toContainText("Saving");
      await expect(page.getByTestId("co-issues")).toContainText("Could not save: Your session ended — sign in again. Nothing was changed.");
      await expect(toast(page)).toHaveCount(0); // no "Saved", and no "Not signed out" either
      await expect(min).toHaveValue(typed);
      expect(await aoKeys(page), "the draft is kept").toHaveLength(1);
      await shot(page, `P2D-${vp.w}-save-session-ended`);
      expect(errors, "no unhandled error on the page").toEqual([]);

      await signInAgain(page);
      await expect(page.getByTestId("co-draft-here")).toContainText("Draft for Iruda Edu");
      await page.getByTestId("co-draft-here").getByRole("button", { name: "Resume" }).click();
      await expect(min).toHaveValue(typed); // what was typed
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await dlg(page).getByRole("button", { name: "Discard changes" }).click();
      await page.getByTestId("co-edit").click();
      await expect(min).toHaveValue(was); // and the server still has what it had
    });

    test("Responders — Remove, role, Add: each fails visibly and changes nothing", async ({ page }) => {
      const open = async () => { await signIn(page, "/c/daon/call-order"); await card(page).getByTestId("co-resp-edit").click(); };
      // Remove
      await open();
      await card(page).getByRole("button", { name: "Remove Junho Park from Responders of Daon Retail" }).click();
      await page.waitForTimeout(READ);
      await loseSession(page);
      await dlg(page).getByRole("button", { name: "Remove Junho Park from Daon Retail" }).click();
      await expectSessionEnded(page);
      await expect(person(page, "ct_junho")).not.toHaveAttribute("data-gone", "1");
      await expect(person(page, "ct_junho").getByRole("button")).toHaveText("Remove…");
      await expect(card(page).getByTestId("co-resp-err")).toHaveText("Your session ended — sign in again. Nothing was changed.");
      await expect(live(page)).toContainText("Not applied.");
      await signInAgain(page);
      await expect(person(page, "ct_junho")).toContainText("Junho Park");

      // role (Taehee Oh is Notify only: making someone Pageable is not asked about, it is sent at once)
      await open();
      const role = card(page).getByLabel("Role of Taehee Oh");
      await loseSession(page);
      await role.selectOption("PAGEABLE");
      await expectSessionEnded(page);
      await expect(role).toBeEnabled();
      await expect(role).toHaveValue("NOTIFY_ONLY");
      await expect(card(page).getByTestId("co-resp-err")).toHaveText("Your session ended — sign in again. Nothing was changed.");
      await signInAgain(page);
      await expect(person(page, "ct_taehee").getByTestId("co-role")).toHaveText("Notify only");

      // Add
      await open();
      const staffCount = await card(page).getByTestId("co-staff").count();
      const pick = card(page).getByLabel("MSP staff to add");
      await pick.selectOption({ index: 1 });
      await loseSession(page);
      await card(page).getByRole("button", { name: "Add to Daon Retail" }).first().click();
      await expectSessionEnded(page);
      await expect(card(page).getByRole("button", { name: "Add to Daon Retail" }).first()).toBeEnabled();
      await signInAgain(page);
      await expect(card(page).getByTestId("co-staff")).toHaveCount(staffCount);
    });
  });
}

test.describe("P2-D the session is gone: the other actions (1440)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const rows = (page: Page) => page.getByTestId("incident-row");
  const openRow = (page: Page) => rows(page).filter({ has: page.getByRole("button", { name: /^Acknowledge / }) }).first();

  test("Acknowledge in the list: the row stops saying Acknowledging…, nothing is acknowledged", async ({ page }) => {
    await signIn(page, "/incidents");
    const row = openRow(page);
    const id = (await row.getAttribute("data-id"))!;
    await loseSession(page);
    await row.getByRole("button", { name: /^Acknowledge / }).click();
    await expectSessionEnded(page);
    const same = page.locator(`tr[data-id="${id}"]`);
    await expect(same.getByRole("button", { name: /^Acknowledge / })).toBeVisible();
    await expect(page.getByText("Your session ended — sign in again. Nothing was changed.").first()).toBeVisible();
    await expect(page).toHaveURL(/\/incidents$/); // not thrown to /login without a word
    await shot(page, "P2D-1440-ack-session-ended");
    await signInAgain(page);
    await expect(page.locator(`tr[data-id="${id}"]`).getByRole("button", { name: /^Acknowledge / })).toBeVisible();
  });

  test("the incident panel — Acknowledge, Escalate, then Undo and Resolve on an acknowledged incident", async ({ page }) => {
    await signIn(page, "/incidents");
    await openRow(page).locator("a.ttl").click();
    await expect(page).toHaveURL(/\/incident\//);
    const panelUrl = new URL(page.url()).pathname;
    const ack = page.getByRole("button", { name: "Acknowledge", exact: true });
    const escalate = page.getByRole("button", { name: "Escalate now" });

    // Acknowledge
    await expect(ack).toBeEnabled();
    await loseSession(page);
    await ack.click();
    await expectSessionEnded(page);
    await expect(ack).toBeEnabled(); // pending is over
    await expect(page.getByTestId("panel-acked")).toHaveCount(0);
    await expect(page.locator(".hero-actions-wrap")).toContainText("Your session ended — sign in again. Nothing was changed.");
    await signInAgain(page);
    await expect(page).toHaveURL(panelUrl);

    // Escalate (where this incident can be escalated)
    if (await escalate.isEnabled()) {
      await loseSession(page);
      await escalate.click();
      await expectSessionEnded(page);
      await expect(escalate).toBeEnabled();
      await signInAgain(page);
    }

    // a real Acknowledge, then the session goes: Undo is refused, said, and still offered — the incident stays acknowledged
    await ack.click();
    await expect(page.getByTestId("panel-acked")).toBeVisible();
    const undo = page.getByTestId("panel-undo");
    await expect(undo).toBeVisible();
    await page.waitForTimeout(READ);
    await loseSession(page);
    await undo.click();
    await expectSessionEnded(page);
    await expect(undo).toBeEnabled();
    await expect(page.locator(".hero-actions-wrap")).toContainText("Your session ended — sign in again. Nothing was changed.");
    await signInAgain(page);

    // Resolve… on the acknowledged incident
    const resolve = page.getByRole("button", { name: "Resolve…" });
    await expect(resolve).toBeVisible();
    await resolve.click();
    await page.waitForTimeout(READ);
    await loseSession(page);
    await page.getByRole("button", { name: "Resolve incident" }).click();
    await expectSessionEnded(page);
    await signInAgain(page);
    await expect(page.getByRole("button", { name: "Resolve…" })).toBeVisible(); // not resolved
  });

  test("Undo in a toast (Incidents list and Call order) with the session gone", async ({ page }) => {
    // Incidents: Acknowledge for real, then Undo from the toast without a session
    await signIn(page, "/incidents");
    const row = openRow(page);
    const id = (await row.getAttribute("data-id"))!;
    const cookie = (await session(page))!;
    await row.getByRole("button", { name: /^Acknowledge / }).click();
    await expect(toast(page)).toContainText("Acknowledged in");
    await page.waitForTimeout(READ);
    await page.context().clearCookies({ name: "ao_session" });
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(ended(page)).toBeVisible();
    await expect(page.locator(`tr[data-id="${id}"]`).getByTestId("ack-label")).toContainText("Acknowledged");
    await expect(page.getByText("Your session ended — sign in again. Nothing was changed.").first()).toBeVisible();
    // nothing was undone: a fresh visit still has it acknowledged (and has no undo token — which is why it stays so)
    await page.context().addCookies([cookie]);
    await page.reload();
    await expect(page.locator(`tr[data-id="${id}"]`)).toHaveCount(1);
    await expect(page.locator(`tr[data-id="${id}"]`).getByRole("button", { name: /^Acknowledge / })).toHaveCount(0);

    // Call order: a save that offers Undo, then Undo without a session
    await signIn(page, "/c/iruda/call-order");
    await page.getByTestId("co-edit").click();
    const min = page.getByLabel("Step 2 minutes");
    const was = await min.inputValue();
    const next = String(Number(was) + 1);
    await min.fill(next);
    await page.getByTestId("co-save").click();
    await expect(toast(page)).toContainText("Saved for Iruda Edu");
    await page.waitForTimeout(READ);
    await loseSession(page);
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(ended(page)).toBeVisible();
    await expect(toast(page)).toContainText("Could not undo — Your session ended — sign in again. Nothing was changed.");
    // put back
    await signIn(page, "/c/iruda/call-order");
    await page.getByTestId("co-edit").click();
    await expect(min).toHaveValue(next);
    await min.fill(was);
    await page.getByTestId("co-save").click();
    await expect(toast(page)).toContainText("Saved for Iruda Edu");
  });

  test("Sign out with the session already gone ends on the login page; over an unsaved edit both choices end somewhere said", async ({ page }) => {
    await signIn(page, "/incidents");
    await loseSession(page);
    await page.getByTestId("account").click();
    await page.getByTestId("sign-out").click();
    await expect(page).toHaveURL(/\/login\?signedOut=1$/);

    // Save and sign out without a session: not saved, not "signed out", said — and the draft is kept
    await signIn(page, "/c/iruda/call-order");
    await page.getByTestId("co-edit").click();
    const min = page.getByLabel("Step 2 minutes");
    const was = await min.inputValue();
    await min.fill(String(Number(was) + 4));
    await loseSession(page);
    await page.getByTestId("account").click();
    await page.getByTestId("sign-out").click();
    await guard(page).getByRole("button", { name: "Save for Iruda Edu and sign out" }).click();
    await expectSessionEnded(page);
    await expect(page.getByTestId("co-save")).not.toContainText("Saving");
    expect(await aoKeys(page)).toHaveLength(1);
    await signInAgain(page);
    await page.getByTestId("co-draft-here").getByRole("button", { name: "Discard" }).click();
    await page.getByTestId("co-edit").click();
    await expect(min).toHaveValue(was);

    // Sign out without saving, without a session: the login page
    await min.fill(String(Number(was) + 4));
    await loseSession(page);
    await page.getByTestId("account").click();
    await page.getByTestId("sign-out").click();
    await guard(page).getByRole("button", { name: "Sign out without saving" }).click();
    await expect(page).toHaveURL(/\/login\?signedOut=1$/);
  });
});

for (const vp of VIEWPORTS) {
  test.describe(`security 권고 4 · P2-D: sign-out in another tab, at ${vp.w}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch });

    test("the other tab is told at once: its drafts go, it says so, Sign in comes back to its address; a press there changes nothing", async ({ page, context }) => {
      // tab 1: an unsaved edit
      await signIn(page, "/c/iruda/call-order");
      await page.getByTestId("co-edit").click();
      const min = page.getByLabel("Step 2 minutes");
      const was = await min.inputValue();
      await min.fill(String(Number(was) + 5));
      await expect(page.getByTestId("co-unsaved")).toContainText("Unsaved");
      expect(await aoKeys(page)).toHaveLength(1);
      // tab 2 of the same browser: Sign out
      const two = await context.newPage();
      await two.goto("/incidents");
      await two.getByTestId("account").click();
      await two.getByTestId("sign-out").click();
      await expect(two).toHaveURL(/\/login\?signedOut=1$/);

      // tab 1, without having been touched
      await expect(ended(page)).toBeVisible();
      await expect(ended(page)).toHaveAttribute("data-reason", "signed-out");
      await expect(ended(page).getByRole("heading")).toHaveText("You signed out in another tab — sign in again.");
      await expect(ended(page)).toContainText("The drafts kept in this tab were removed");
      expect(await aoKeys(page), "this tab's drafts are removed too").toEqual([]);
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("ao-")))).toEqual([]);
      await expect(ended(page).getByTestId("session-sign-in")).toHaveAttribute("href", "/login?next=%2Fc%2Firuda%2Fcall-order");
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const b = (await ended(page).getByTestId("session-sign-in").boundingBox())!;
      if (vp.touch) expect(b.height).toBeGreaterThanOrEqual(44);
      await shot(page, `SEC4-${vp.w}-signed-out-elsewhere`);
      // Ctrl+Enter (Save) behind the question does nothing: no request, no "Saving…"
      const posts: string[] = [];
      page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
      await page.keyboard.press("Control+Enter");
      await page.waitForTimeout(400);
      expect(posts).toEqual([]);
      await expect(page.getByTestId("co-save")).not.toContainText("Saving");
      // nothing typed afterwards is written back as a draft
      expect(await aoKeys(page)).toEqual([]);

      await ended(page).getByTestId("session-sign-in").click();
      await expect(page).toHaveURL(/\/login\?next=%2Fc%2Firuda%2Fcall-order$/);
      await page.getByRole("link", { name: /sign in as Haeun Kim/ }).click();
      await expect(page).toHaveURL(/\/c\/iruda\/call-order$/);
      await expect(page.getByTestId("co-draft-here")).toHaveCount(0);
      await page.getByTestId("co-edit").click();
      await expect(min).toHaveValue(was);
      await two.close();
    });
  });
}

test.describe("P3-G Save and sign out while a save is on its way", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("it is not ignored: it waits for that save, says so, and signs out when it is saved", async ({ page }) => {
    await signIn(page, "/c/iruda/call-order");
    await page.getByTestId("co-edit").click();
    const min = page.getByLabel("Step 2 minutes");
    const was = await min.inputValue();
    const next = String(Number(was) + 2);
    await min.fill(next);
    // the save takes 3 s to reach the server
    let saves = 0;
    await page.route("**/c/iruda/call-order*", async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) { saves++; await new Promise((r) => setTimeout(r, 3000)); }
      await route.continue();
    });
    await page.getByTestId("co-save").click();
    await expect(page.getByTestId("co-save")).toContainText("Saving…");
    await page.getByTestId("account").click();
    await page.getByTestId("sign-out").click();
    // the guard says what each choice means while a save is on its way
    await expect(guard(page)).toContainText("A save for Iruda Edu is being sent right now.");
    await expect(guard(page)).toContainText("the save that is already on its way may still be applied");
    await guard(page).getByRole("button", { name: "Save for Iruda Edu and sign out" }).click();
    await expect(toast(page)).toHaveText(/^Saving for Iruda Edu… You are signed out as soon as it is saved\. If it is not saved, you stay signed in\./);
    await expect(page).toHaveURL(/\/login\?signedOut=1$/, { timeout: 10_000 });
    expect(saves, "one save was sent, not two").toBe(1);
    expect(await session(page)).toBeUndefined();
    await page.unroute("**/c/iruda/call-order*");
    // saved; put back
    await signIn(page, "/c/iruda/call-order");
    await page.getByTestId("co-edit").click();
    await expect(min).toHaveValue(next);
    await min.fill(was);
    await page.getByTestId("co-save").click();
    await expect(toast(page)).toContainText("Saved for Iruda Edu");
  });

  test("when that save is refused, the user stays signed in and is told", async ({ page, browser }) => {
    await signIn(page, "/c/iruda/call-order");
    await page.getByTestId("co-edit").click();
    const min = page.getByLabel("Step 2 minutes");
    const was = await min.inputValue();
    await min.fill(String(Number(was) + 2));
    // someone else saves first: the delayed save will be a 409
    const other = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await signIn(other, "/c/iruda/call-order");
    await other.getByTestId("co-edit").click();
    await other.getByLabel("Step 2 minutes").fill(String(Number(was) + 1));
    await other.getByTestId("co-save").click();
    await expect(toast(other)).toContainText("Saved for Iruda Edu");

    await page.route("**/c/iruda/call-order*", async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.getByTestId("co-save").click();
    await expect(page.getByTestId("co-save")).toContainText("Saving…");
    await page.getByTestId("account").click();
    await page.getByTestId("sign-out").click();
    await guard(page).getByRole("button", { name: "Save for Iruda Edu and sign out" }).click();
    await expect(toast(page)).toContainText("You are signed out as soon as it is saved");
    await expect(toast(page)).toHaveText(/^Not signed out: Iruda Edu was not saved\./, { timeout: 10_000 });
    await expect(page.getByTestId("co-conflict")).toContainText("Changed — reload.");
    expect(await session(page), "still signed in").toBeDefined();
    await page.unroute("**/c/iruda/call-order*");
    // put back from the other tab
    await other.goto("/c/iruda/call-order");
    await other.getByTestId("co-edit").click();
    await other.getByLabel("Step 2 minutes").fill(was);
    await other.getByTestId("co-save").click();
    await expect(toast(other)).toContainText("Saved for Iruda Edu");
    await other.context().close();
  });
});

test("security 권고 2: the sign-out origin check compares scheme, host and port", async ({ request, baseURL }) => {
  const u = new URL(baseURL!);
  const post = (origin: string) => request.post("/auth/sign-out", { headers: { Origin: origin }, maxRedirects: 0 });
  expect((await post(u.origin)).status()).toBe(303);
  expect((await post(`https://${u.host}`)).status(), "https origin to a console served over http").toBe(403);
  expect((await post(`http://${u.hostname}:${Number(u.port) + 1}`)).status()).toBe(403);
  expect((await post("https://evil.example")).status()).toBe(403);
  // the probe the page uses says only yes or no
  const probe = await request.get("/auth/session");
  expect([204, 401]).toContain(probe.status());
  expect(await probe.text()).toBe("");
});
