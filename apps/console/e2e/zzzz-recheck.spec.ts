// QA "Console Call order 재점검 — 2026-11-11": P2-A (sign-out over an unsaved edit), P2-B (rows hold their place without
// scroll anchoring), P3 A–D. Runs last (zzzz-): it removes responders and saves a call order in the shared mock store,
// and puts back what it changed.
// The WebKit project (PW_WEBKIT=1, playwright.config.ts) runs this file: Safari has no scroll anchoring at all.
import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { assertNoRowShift, noScrollAnchoring } from "./helpers/no-row-shift";

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const signIn = async (page: Page, next = "/call-order", as?: "operator" | "viewer") => {
  await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}${as ? `&as=${as}` : ""}`);
  await page.waitForLoadState("networkidle");
};
const card = (page: Page) => page.getByTestId("co-responders");
const RESP = '[data-testid="co-responders"] li[data-row-key]';
const CO = '[data-testid="co-row"]';
const INC = '[data-testid="incident-row"]';
const person = (page: Page, id: string) => card(page).locator(`li[data-row-key="${id}"]`);
const dlg = (page: Page) => page.getByTestId("confirm-dialog");
const guard = (page: Page) => page.getByTestId("dirty-guard");
const toast = (page: Page) => page.getByTestId("toast");
const live = (page: Page) => card(page).getByTestId("co-resp-live");
const READ = 700;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const VIEWPORTS = [{ w: 1440, h: 900, touch: false }, { w: 390, h: 844, touch: true }];

/**
 * Where every Responders row is on the screen (exact, not rounded) and how far everything is scrolled. With scroll
 * anchoring off, "no row moved" means both are the same before and after: nothing was pushed, nothing was re-scrolled.
 */
const place = (page: Page) => page.evaluate((sel) => ({
  rows: [...document.querySelectorAll<HTMLElement>(sel)].map((e) => { const b = e.getBoundingClientRect(); return `${e.dataset.rowKey} top ${b.top.toFixed(2)} height ${b.height.toFixed(2)}`; }),
  scroll: [window.scrollX, window.scrollY, ...[...document.querySelectorAll<HTMLElement>(".panel-body, .tw")].map((e) => e.scrollTop)].join(","),
}), RESP);
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

for (const vp of VIEWPORTS) {
  test.describe(`P2-B Responders without scroll anchoring at ${vp.w}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch });

    test("remove, At risk, Unreachable, role back, Undo: 0px for every row, and nothing is scrolled to make it so", async ({ page }) => {
      await signIn(page, "/c/daon/call-order");
      await noScrollAnchoring(page);
      expect(await page.evaluate(() => getComputedStyle(document.querySelector(".co-resp")!).getPropertyValue("overflow-anchor"))).toBe("none");
      await expect(page.getByTestId("co-health")).toHaveCount(0); // Daon Retail starts out reachable
      await card(page).getByTestId("co-resp-edit").click();
      await expect(live(page)).toContainText("Reach now: OK");
      const liveBox = (await live(page).boundingBox())!;
      expect(liveBox.height).toBe(44);
      await card(page).getByRole("button", { name: "Remove Junho Park from Responders of Daon Retail" }).evaluate((el) => el.scrollIntoView({ block: "center" }));
      const start = await settled(page);
      expect(start.rows.length).toBeGreaterThanOrEqual(3);
      const same = async (what: string) => { expect(await settled(page), what).toEqual(start); };

      // 1. Junho removed: a tombstone of his row's exact height
      await card(page).getByRole("button", { name: "Remove Junho Park from Responders of Daon Retail" }).click();
      await page.waitForTimeout(READ);
      await dlg(page).getByRole("button", { name: "Remove Junho Park from Daon Retail" }).click();
      await expect(person(page, "ct_junho")).toHaveAttribute("data-gone", "1");
      await expect(live(page)).toContainText("1 removed, shown until Done");
      await same("after removing Junho Park");

      // 2. Minjae removed: Daon Retail becomes AT RISK. The QA repro: the banner pushed every row 225–269 px down.
      await card(page).getByRole("button", { name: "Remove Minjae Lee from Responders of Daon Retail" }).click();
      await page.waitForTimeout(READ);
      await dlg(page).getByRole("button", { name: "Remove Minjae Lee from Daon Retail" }).click();
      await expect(person(page, "ct_minjae")).toHaveAttribute("data-gone", "1");
      await expect(live(page)).toContainText("At risk");
      await expect(live(page)).toContainText("Daon Retail is harder to reach now");
      await expect(card(page).getByTestId("co-resp-health")).toContainText("reaches only Soyeon Choi");
      await expect(page.getByTestId("co-health")).toHaveCount(0); // the panel above the card holds still until Done
      await same("after removing Minjae Lee (At risk)");
      await shot(page, `P2B-${vp.w}-1-at-risk`);

      // 3. Soyeon to Notify only: UNREACHABLE (was 39 px)
      const role = card(page).getByLabel("Role of Soyeon Choi");
      await role.selectOption("NOTIFY_ONLY");
      await page.waitForTimeout(READ);
      await dlg(page).getByRole("button", { name: "Make Soyeon Choi Notify only for Daon Retail" }).click();
      await expect(live(page)).toContainText("Unreachable");
      await expect(live(page)).toContainText("Nobody for Daon Retail is reached now");
      await expect(card(page).getByTestId("co-resp-health")).toContainText("nobody for Daon Retail is reached");
      await same("after Soyeon Choi → Notify only (Unreachable)");
      await shot(page, `P2B-${vp.w}-2-unreachable`);
      // the line that says it has not grown, and the status that needs room is below the last row
      expect((await live(page).boundingBox())!.height).toBe(44);
      const lastRow = (await card(page).locator("li[data-row-key]").last().boundingBox())!;
      expect((await card(page).getByTestId("co-resp-status").boundingBox())!.y).toBeGreaterThanOrEqual(lastRow.y + lastRow.height - 1);
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      // 4. and back again, one step at a time
      await role.selectOption("PAGEABLE");
      await expect(toast(page)).toContainText("Soyeon Choi is now Pageable for Daon Retail");
      await expect(live(page)).toContainText("At risk");
      await same("after Soyeon Choi → Pageable");
      await page.waitForTimeout(READ);
      await person(page, "ct_junho").getByRole("button", { name: "Undo: put Junho Park back" }).click();
      await expect(person(page, "ct_junho")).not.toHaveAttribute("data-gone", "1");
      await expect(person(page, "ct_junho")).toContainText("added directly");
      await same("after Undo for Junho Park");
      await page.waitForTimeout(READ);
      await person(page, "ct_minjae").getByRole("button", { name: "Undo: put Minjae Lee back" }).click();
      await expect(person(page, "ct_minjae")).not.toHaveAttribute("data-gone", "1");
      await expect(person(page, "ct_minjae")).toContainText("added directly");
      await expect(live(page)).toContainText("Reach now: OK");
      await same("after Undo for Minjae Lee");

      // Done is the explicit refresh: the panel is up to date again
      await card(page).getByTestId("co-resp-edit").click();
      await expect(live(page)).toHaveCount(0);
      await expect(page.getByTestId("co-health")).toHaveCount(0);
    });

    test("the panel's own banner comes with Done, not in the middle of the edit", async ({ page }) => {
      await signIn(page, "/c/daon/call-order");
      await noScrollAnchoring(page);
      await card(page).getByTestId("co-resp-edit").click();
      const role = card(page).getByLabel("Role of Soyeon Choi");
      await role.evaluate((el) => el.scrollIntoView({ block: "center" }));
      for (const name of ["Junho Park", "Minjae Lee"]) {
        await card(page).getByRole("button", { name: `Remove ${name} from Responders of Daon Retail` }).click();
        await page.waitForTimeout(READ);
        await dlg(page).getByRole("button", { name: `Remove ${name} from Daon Retail` }).click();
        await expect(toast(page)).toContainText(`${name} removed`);
      }
      await expect(live(page)).toContainText("At risk");
      await expect(page.getByTestId("co-health")).toHaveCount(0);
      await expect(page.getByTestId("co-paged")).toContainText("Junho Park"); // as it was when Edit was pressed
      await card(page).getByTestId("co-resp-edit").click(); // Done
      await expect(page.getByTestId("co-health")).toContainText("At risk");
      await expect(page.getByTestId("co-paged")).not.toContainText("Junho Park");
      // put back
      await card(page).getByTestId("co-resp-edit").click();
      for (const name of ["Junho Park", "Minjae Lee"]) {
        await card(page).getByLabel("MSP staff to add").selectOption({ label: await card(page).locator("option", { hasText: name }).first().innerText() });
        await page.waitForTimeout(READ);
        await card(page).getByRole("button", { name: "Add to Daon Retail" }).first().click();
        await expect(toast(page)).toContainText(`${name} added to Responders of Daon Retail`);
      }
      await expect(live(page)).toContainText("Reach now: OK");
      await card(page).getByTestId("co-resp-edit").click();
      await expect(page.getByTestId("co-health")).toHaveCount(0);
    });
  });
}

test.describe("P2-B the same on the other lists, and P3", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Incidents and the Call order list hold their rows without scroll anchoring", async ({ page }) => {
    await signIn(page, "/incidents");
    await page.evaluate(() => document.fonts.ready);
    const row = page.locator(INC).filter({ has: page.getByRole("button", { name: /^Acknowledge / }) }).first();
    const id = await row.getAttribute("data-id");
    const r = page.locator(`${INC}[data-id="${id}"]`);
    await assertNoRowShift(page, { name: "incident.ack", rows: INC, at: r.getByRole("button", { name: /^Acknowledge / }), then: async () => { await expect(r.getByTestId("ack-label")).toContainText("Acknowledged"); } });
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("[data-testid=incident-row]")!).getPropertyValue("overflow-anchor"))).toBe("none");
    await page.waitForTimeout(READ);
    await assertNoRowShift(page, {
      name: "incident.undo-ack", rows: INC, at: r.getByRole("button", { name: /^More for / }),
      then: async () => { await page.getByRole("menuitem", { name: "Undo acknowledge" }).click(); await expect(r.getByRole("button", { name: /^Acknowledge / })).toBeVisible(); },
    });

    // Call order: a one-service save, then its Undo — the list beside the panel does not move
    await page.goto("/c/hanbit/fulfilment/orders-api/call-order");
    await page.evaluate(() => document.fonts.ready);
    await page.getByTestId("co-edit").click();
    const min = page.getByLabel("Step 2 minutes");
    const was = await min.inputValue();
    await min.fill(String(Number(was) + 1));
    await assertNoRowShift(page, {
      name: "callorder.save", rows: CO, at: page.getByTestId("co-save"),
      then: async () => { await expect(toast(page)).toContainText("Saved for Hanbit Logistics › Fulfilment › Orders API"); },
    });
    await page.waitForTimeout(READ);
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page)).toContainText("Undone");
  });

  test("P3-B after a keyboard remove and a keyboard Undo the focus is on that person's row; P3-D Ctrl K does not open over the question", async ({ page }) => {
    await signIn(page, "/c/daon/call-order");
    await card(page).getByTestId("co-resp-edit").click();
    const remove = card(page).getByRole("button", { name: "Remove Junho Park from Responders of Daon Retail" });
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect(dlg(page).getByRole("button", { name: "Keep Junho Park" })).toBeFocused();
    // P3-D: the question is answered first
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);
    await expect(page.locator(".ssearch")).toHaveCount(0);
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page).getByRole("button", { name: "Keep Junho Park" })).toBeFocused();
    await page.keyboard.press("Meta+k");
    await expect(page.locator(".ssearch")).toHaveCount(0);
    // confirm with the keyboard
    await page.keyboard.press("Shift+Tab");
    await expect(dlg(page).getByRole("button", { name: "Remove Junho Park from Daon Retail" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(person(page, "ct_junho")).toHaveAttribute("data-gone", "1");
    await expect(person(page, "ct_junho")).toBeFocused();
    // Undo is the next stop, and after it the focus is still on his row
    await page.waitForTimeout(READ);
    await page.keyboard.press("Tab");
    await expect(person(page, "ct_junho").getByRole("button", { name: "Undo: put Junho Park back" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(person(page, "ct_junho")).not.toHaveAttribute("data-gone", "1");
    await expect(person(page, "ct_junho")).toContainText("added directly");
    await expect(person(page, "ct_junho")).toBeFocused();
    // with no question on the screen Ctrl K works as before
    await page.keyboard.press("Control+k");
    await expect(page.locator(".ssearch")).toBeVisible();
    await page.keyboard.press("Escape");
    await card(page).getByTestId("co-resp-edit").click();
  });

  test("P3-C removing someone another tab already removed says Changed — reload, and no row moves for it", async ({ page, browser }) => {
    await signIn(page, "/c/daon/call-order");
    await noScrollAnchoring(page);
    await card(page).getByTestId("co-resp-edit").click();
    const remove = card(page).getByRole("button", { name: "Remove Junho Park from Responders of Daon Retail" });
    await remove.evaluate((el) => el.scrollIntoView({ block: "center" }));
    // this tab has the question open …
    await remove.click();
    await expect(dlg(page)).toBeVisible();
    // … while another tab removes the same person
    const other = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await signIn(other, "/c/daon/call-order");
    await card(other).getByTestId("co-resp-edit").click();
    await card(other).getByRole("button", { name: "Remove Junho Park from Responders of Daon Retail" }).click();
    await other.waitForTimeout(READ);
    await dlg(other).getByRole("button", { name: "Remove Junho Park from Daon Retail" }).click();
    await expect(person(other, "ct_junho")).toHaveAttribute("data-gone", "1");

    const start = await settled(page);
    await page.waitForTimeout(READ);
    await dlg(page).getByRole("button", { name: "Remove Junho Park from Daon Retail" }).click();
    await expect(card(page).getByTestId("co-resp-conflict")).toContainText("Changed — reload. Someone else changed the Responders of Daon Retail while you were editing. Your last change was not applied.");
    await expect(live(page)).toContainText("Changed — reload.");
    await expect(card(page).getByTestId("co-resp-err")).toHaveCount(0); // not a bare "Not found"
    await expect(card(page).getByRole("button", { name: "Remove Minjae Lee from Responders of Daon Retail" })).toBeDisabled();
    expect(await settled(page), "the Changed — reload notice moved a row").toEqual(start);
    await card(page).getByTestId("co-resp-reload-top").click();
    await expect(person(page, "ct_junho").getByTestId("tombstone")).toContainText("No longer in Responders");
    await expect(card(page).getByTestId("co-resp-conflict")).toHaveCount(0);
    await card(page).getByTestId("co-resp-edit").click();
    // put back, from the tab that removed him
    await other.waitForTimeout(READ);
    await person(other, "ct_junho").getByRole("button", { name: "Undo: put Junho Park back" }).click();
    await expect(person(other, "ct_junho")).not.toHaveAttribute("data-gone", "1");
    await other.context().close();
  });
});

test.describe("P3-A a viewer on a phone is told why Acknowledge is off", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("in words on the page, not in a tooltip", async ({ page }) => {
    await signIn(page, "/incidents", "viewer");
    const why = page.getByTestId("list-role-why");
    await expect(why).toBeVisible();
    await expect(why).toHaveText("Read only. Acknowledging needs the Operator role. You are signed in as Viewer.");
    await expect(why).toBeInViewport();
    expect(Number.parseFloat(await why.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(13);
    await expect(page.getByRole("button", { name: /^Acknowledge / }).first()).toBeDisabled();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await shot(page, "P3A-390-viewer-incidents");
    // an operator has no such line
    await signIn(page, "/incidents", "operator");
    await expect(page.getByTestId("list-role-why")).toHaveCount(0);
  });
});

for (const vp of VIEWPORTS) {
  test.describe(`P2-A sign out over an unsaved edit at ${vp.w}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch });
    const session = async (page: Page) => (await page.context().cookies()).find((c) => c.name === "ao_session");
    const keys = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("ao-")));
    const edit = async (page: Page, minutes: string) => {
      await signIn(page, "/c/iruda/call-order");
      await page.getByTestId("co-edit").click();
      const was = await page.getByLabel("Step 2 minutes").inputValue();
      await page.getByLabel("Step 2 minutes").fill(minutes);
      await expect(page.getByTestId("co-unsaved")).toContainText("Unsaved");
      return was;
    };
    const askSignOut = async (page: Page) => {
      await page.getByTestId("account").click();
      await page.getByTestId("sign-out").click();
      await expect(guard(page)).toContainText("Unsaved changes for Iruda Edu");
      // a draft cannot be kept across sign-out, so it is not offered
      await expect(guard(page).getByRole("button")).toHaveText(["Save for Iruda Edu and sign out", "Sign out without saving", "Cancel"]);
      await expect(guard(page)).toContainText("Signing out removes the drafts kept in this tab");
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    };
    const signedOut = async (page: Page) => {
      await expect(page).toHaveURL(/\/login\?signedOut=1$/);
      expect(await session(page), "session cookie").toBeUndefined();
      expect(await keys(page)).toEqual([]);
      await page.goto("/call-order");
      await expect(page).toHaveURL(/\/login\?next=%2Fcall-order$/);
    };
    const savedMinutes = async (page: Page) => {
      await signIn(page, "/c/iruda/call-order");
      await expect(page.getByTestId("co-draft-here")).toHaveCount(0);
      return (await page.getByTestId("co-steps").locator("li").nth(1).locator(".mono").first().innerText()).replace(" min", "");
    };

    test("Sign out without saving: signed out, nothing saved, no draft left", async ({ page }) => {
      const was = await edit(page, "9");
      await askSignOut(page);
      await shot(page, `P2A-${vp.w}-guard`);
      await guard(page).getByRole("button", { name: "Sign out without saving" }).click();
      await signedOut(page);
      expect(await savedMinutes(page)).toBe(was);
    });

    test("Save and sign out: saved, then signed out", async ({ page }) => {
      const was = await edit(page, "9");
      await askSignOut(page);
      await guard(page).getByRole("button", { name: "Save for Iruda Edu and sign out" }).click();
      // a save that reaches more than one service is confirmed first, as always
      await page.waitForTimeout(READ);
      if (await dlg(page).count()) await dlg(page).getByRole("button", { name: "Save for Iruda Edu" }).click();
      await signedOut(page);
      expect(await savedMinutes(page)).toBe("9");
      // put back
      await page.getByTestId("co-edit").click();
      await page.getByLabel("Step 2 minutes").fill(was);
      await page.getByTestId("co-save").click();
      await page.waitForTimeout(READ);
      if (await dlg(page).count()) await dlg(page).getByRole("button", { name: "Save for Iruda Edu" }).click();
      await expect(toast(page)).toContainText("Saved for Iruda Edu");
    });

    test("Save and sign out with a value that cannot be saved: not saved, so not signed out — and said", async ({ page }) => {
      const was = await edit(page, "0"); // step 2 would not come after step 1
      await askSignOut(page);
      await guard(page).getByRole("button", { name: "Save for Iruda Edu and sign out" }).click();
      await expect(toast(page)).toContainText("Not signed out: Iruda Edu was not saved.");
      await expect(page.getByTestId("co-edit-view")).toBeVisible();
      await expect(page.getByTestId("co-issues")).not.toBeEmpty();
      expect(await session(page), "still signed in").toBeDefined();
      expect((await keys(page)).some((k) => k.startsWith("ao-draft:"))).toBe(true); // what was typed is still there
      await expect(page).toHaveURL(/\/c\/iruda\/call-order/);
      // Cancel on the question keeps everything as well
      await askSignOut(page);
      await guard(page).getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByTestId("co-edit-view")).toBeVisible();
      expect(await session(page)).toBeDefined();
      await askSignOut(page);
      await guard(page).getByRole("button", { name: "Sign out without saving" }).click();
      await signedOut(page);
      expect(await savedMinutes(page)).toBe(was);
    });
  });
}

test.describe("P2-A a save that is confirmed first (more than one service)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("Save and sign out → the confirmation cancelled: still signed in; confirmed: saved and signed out", async ({ page }) => {
    const session = async () => (await page.context().cookies()).find((c) => c.name === "ao_session");
    await signIn(page, "/c/cheong/call-order");
    await page.getByTestId("co-edit").click();
    const min = page.getByLabel("Step 2 minutes");
    const was = await min.inputValue();
    const next = String(Number(was) + 2);
    await min.fill(next);
    const ask = async () => {
      await page.getByTestId("account").click();
      await page.getByTestId("sign-out").click();
      await guard(page).getByRole("button", { name: "Save for Cheong Media and sign out" }).click();
      await expect(dlg(page).getByRole("heading")).toHaveText("Save for Cheong Media?");
      await page.waitForTimeout(READ);
    };
    await ask();
    await dlg(page).getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("co-edit-view")).toBeVisible();
    await expect(page).toHaveURL(/\/c\/cheong\/call-order/);
    expect(await session(), "still signed in").toBeDefined();
    await ask();
    await dlg(page).getByRole("button", { name: "Save for Cheong Media" }).click();
    await expect(page).toHaveURL(/\/login\?signedOut=1$/);
    expect(await session()).toBeUndefined();
    // saved; put back
    await signIn(page, "/c/cheong/call-order");
    await page.getByTestId("co-edit").click();
    await expect(min).toHaveValue(next);
    await min.fill(was);
    await page.getByTestId("co-save").click();
    await page.waitForTimeout(READ);
    await dlg(page).getByRole("button", { name: "Save for Cheong Media" }).click();
    await expect(toast(page)).toContainText("Saved for Cheong Media");
  });
});
