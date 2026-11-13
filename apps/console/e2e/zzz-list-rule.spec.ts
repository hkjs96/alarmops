// QA "Console Call order 점검 — 2026-11-11": P1-A as a rule for every list, P2-A, P2-B, P3 C–K, security 권고 1–6.
// Runs last (zzz-): it removes responders and resolves an incident in the shared mock store, and puts back what it can.
import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { assertNoRowShift, assertSecondPressIgnored, rowBoxes } from "./helpers/no-row-shift";

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const signIn = async (page: Page, next = "/call-order", as?: "operator" | "viewer") => {
  await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}${as ? `&as=${as}` : ""}`);
  await page.waitForLoadState("networkidle");
};
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
/** server actions posted by the page whose arguments mention `needle` */
function watchActions(page: Page) {
  const bodies: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.headers()["next-action"]) bodies.push(r.postData() ?? ""); });
  return { with: (needle: string) => bodies.filter((b) => b.includes(needle)).length };
}
const card = (page: Page) => page.getByTestId("co-responders");
const RESP = '[data-testid="co-responders"] li[data-row-key]';
const CO = '[data-testid="co-row"]';
const INC = '[data-testid="incident-row"]';
const person = (page: Page, id: string) => card(page).locator(`li[data-row-key="${id}"]`);
const dlg = (page: Page) => page.getByTestId("confirm-dialog");
const toast = (page: Page) => page.getByTestId("toast");
// while Responders are edited the reach is said inside the card (below the rows); the panel's own banner waits for Done
const health = (page: Page) => card(page).getByTestId("co-resp-health");
/** a dialog's buttons do nothing for 600 ms at the spot that opened it; a person takes longer than that to read it */
const READ = 700;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const vp of [{ w: 1440, h: 900, touch: false }, { w: 390, h: 844, touch: true }]) {
  test.describe(`P1-A Responders at ${vp.w}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch });
    const how = vp.touch ? "tap" as const : "click" as const;

    test("the QA repro: Remove pressed twice at the same spot removes nobody; removing asks, names the person and the customer, keeps every row in place, and each person has their own Undo", async ({ page }) => {
      const errors = watchErrors(page);
      const actions = watchActions(page);
      await signIn(page, "/c/daon/call-order");
      await card(page).getByTestId("co-resp-edit").click();
      await expect(card(page).getByTestId("co-resp-rule")).toContainText("Rows keep their place");
      const removeJunho = card(page).getByRole("button", { name: "Remove Junho Park from Responders of Daon Retail" });
      const removeMinjae = card(page).getByRole("button", { name: "Remove Minjae Lee from Responders of Daon Retail" });
      await removeJunho.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await shot(page, `P1A-${vp.w}-0-before`);

      // 1. the repro — press Remove, then the same spot again: a confirmation, and nobody is removed
      await assertSecondPressIgnored(page, "responder.remove", removeJunho, async () => actions.with('"ct_junho"') + actions.with('"ct_minjae"'), how);
      expect(actions.with('"ct_junho"') + actions.with('"ct_minjae"')).toBe(0);
      await expect(dlg(page).getByRole("heading")).toHaveText("Remove Junho Park from Responders of Daon Retail?");
      await expect(dlg(page)).toContainText(/Junho Park will no longer be called or notified for Daon Retail\. Responders belong to the whole customer: this applies to all \d+ services of Daon Retail, at every level\./);
      await expect(dlg(page)).toContainText("“Everyone in Responders” goes from 3 to 2.");
      await expect(dlg(page).getByRole("button", { name: "Keep Junho Park" })).toBeFocused(); // the safe choice
      await expect(dlg(page).getByTestId("confirm-warning")).toHaveCount(0); // Minjae and Soyeon are still there
      await shot(page, `P1A-${vp.w}-1-confirm`);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.keyboard.press("Enter"); // Enter keeps
      await expect(dlg(page)).toHaveCount(0);
      await expect(card(page).locator("li[data-gone]")).toHaveCount(0);
      expect(actions.with('"ct_junho"')).toBe(0);

      // 2. remove Junho: his row stays where it was, as "Removed · Undo"; Minjae's Remove has not moved under the pointer
      const spot = (await removeJunho.boundingBox())!;
      const minjaeWas = (await removeMinjae.boundingBox())!;
      await assertNoRowShift(page, {
        name: "responder.remove", rows: RESP, at: removeJunho, how,
        then: async () => { await page.waitForTimeout(READ); await dlg(page).getByRole("button", { name: "Remove Junho Park from Daon Retail" }).click(); await expect(toast(page)).toContainText("Junho Park removed from Responders of Daon Retail"); },
      });
      await expect(person(page, "ct_junho")).toHaveAttribute("data-gone", "1");
      await expect(person(page, "ct_junho").getByTestId("tombstone")).toContainText("Junho Park · Removed");
      expect(await removeMinjae.boundingBox()).toEqual(minjaeWas);
      await shot(page, `P1A-${vp.w}-2-after-first`);
      // the old bug: the same spot again, also after 1.5 s, removed Minjae. Now there is nothing to press there.
      await page.waitForTimeout(1500);
      const at = { x: Math.round(spot.x + spot.width / 2), y: Math.round(spot.y + spot.height / 2) };
      if (vp.touch) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(400);
      await expect(dlg(page)).toHaveCount(0);
      await expect(person(page, "ct_minjae")).not.toHaveAttribute("data-gone", "1");
      expect(actions.with('"ct_minjae"')).toBe(0);
      await shot(page, `P1A-${vp.w}-3-after-second-press`);

      // 3. Minjae: the confirmation says what it costs — only Soyeon is left and her phone is not verified
      await assertNoRowShift(page, {
        name: "responder.remove", rows: RESP, at: removeMinjae, how,
        then: async () => {
          await expect(dlg(page).getByTestId("confirm-at-risk")).toContainText("After this, Daon Retail is harder to reach");
          await expect(dlg(page).getByTestId("confirm-at-risk")).toContainText("reaches only Soyeon Choi, who has no verified");
          await shot(page, `P1A-${vp.w}-4-confirm-at-risk`);
          await page.waitForTimeout(READ);
          await dlg(page).getByRole("button", { name: "Remove Minjae Lee from Daon Retail" }).click();
          await expect(toast(page)).toContainText("Minjae Lee removed");
        },
      });
      await expect(health(page)).toContainText("At risk");
      await expect(card(page).locator("li[data-gone]")).toHaveCount(2);

      // 4. taking the last pageable person off the call list would leave nobody: said first, in red, with the safe choice focused
      const role = card(page).getByLabel("Role of Soyeon Choi");
      await assertNoRowShift(page, {
        name: "responder.role", rows: RESP, at: role, how: { select: "NOTIFY_ONLY" },
        then: async () => {
          await expect(dlg(page).getByRole("heading")).toHaveText("Make Soyeon Choi Notify only for Daon Retail?");
          await expect(dlg(page).getByTestId("confirm-warning")).toContainText("Unreachable");
          await expect(dlg(page).getByTestId("confirm-warning")).toContainText("After this, nobody for Daon Retail is reached if something breaks.");
          await expect(dlg(page).getByRole("button", { name: "Keep Soyeon Choi Pageable" })).toBeFocused();
          await shot(page, `P1A-${vp.w}-5-confirm-unreachable`);
          expect(await overflow(page)).toBeLessThanOrEqual(0);
          await page.keyboard.press("Enter"); // keeps her Pageable
          await expect(dlg(page)).toHaveCount(0);
        },
      });
      await expect(role).toHaveValue("PAGEABLE");
      await expect(health(page)).not.toContainText("Unreachable");
      // … and going through with it is possible, and says so afterwards
      await role.selectOption("NOTIFY_ONLY");
      await dlg(page).getByRole("button", { name: "Make Soyeon Choi Notify only for Daon Retail" }).click();
      await expect(toast(page)).toContainText("Soyeon Choi is now Notify only for Daon Retail");
      await expect(health(page)).toContainText("Unreachable");
      await expect(health(page)).toContainText("nobody for Daon Retail is reached");
      await shot(page, `P1A-${vp.w}-6-unreachable`);
      await role.selectOption("PAGEABLE");
      await expect(toast(page)).toContainText("Soyeon Choi is now Pageable for Daon Retail");

      // 5. Undo is per person: the FIRST one removed comes back, in his own place, while the second stays removed
      await page.waitForTimeout(READ);
      await assertNoRowShift(page, {
        name: "responder.undo-remove", rows: RESP, at: person(page, "ct_junho").getByRole("button", { name: "Undo: put Junho Park back" }), how,
        then: async () => { await expect(toast(page)).toContainText("Junho Park is back in Responders of Daon Retail"); await expect(person(page, "ct_junho")).not.toHaveAttribute("data-gone", "1"); },
      });
      await expect(person(page, "ct_junho")).toContainText("added directly");
      await expect(person(page, "ct_minjae")).toHaveAttribute("data-gone", "1");
      await expect(card(page).locator("li[data-row-key]").first()).toHaveAttribute("data-row-key", "ct_junho"); // not appended: where he was
      await shot(page, `P1A-${vp.w}-7-undo-first`);
      await page.waitForTimeout(READ);
      await person(page, "ct_minjae").getByRole("button", { name: "Undo: put Minjae Lee back" }).click();
      await expect(person(page, "ct_minjae")).not.toHaveAttribute("data-gone", "1");
      await expect(health(page)).toHaveCount(0);
      await expect(card(page).locator("li[data-gone]")).toHaveCount(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      // tap targets on the phone
      if (vp.touch) for (const b of await card(page).locator("button:visible, select:visible").all()) expect((await b.boundingBox())!.height, await b.textContent() ?? "").toBeGreaterThanOrEqual(44);
      await card(page).getByTestId("co-resp-edit").click(); // Done
      await expect(card(page).locator("select, input")).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}

test.describe("Responders: add, the explicit refresh, a step's person, two people at once", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an added person goes after the last row and nothing above moves; Done is the refresh that takes tombstones away; someone a step names cannot be removed", async ({ page }) => {
    await signIn(page, "/c/daon/call-order");
    await card(page).getByTestId("co-resp-edit").click();
    await expect(page.getByTestId("co-footnote")).toHaveText("Editing Responders of Daon Retail: each change applies at once. The steps themselves are not changed here."); // QA P3-F
    await expect(page.getByTestId("co-edit")).toBeDisabled();
    await card(page).getByLabel("MSP staff to add").selectOption({ label: "Jiwoo Han · Cloud engineer" });
    await assertNoRowShift(page, {
      name: "responder.add", rows: RESP, at: card(page).getByRole("button", { name: "Add to Daon Retail" }).first(), mayGrowBelow: true, mayMoveDown: true,
      then: async () => { await expect(toast(page)).toContainText("Jiwoo Han added to Responders of Daon Retail"); await expect(person(page, "ct_jiwoo")).toBeVisible(); },
    });
    await expect(card(page).getByTestId("co-staff").last()).toContainText("Jiwoo Han");
    await card(page).getByRole("button", { name: "Remove Jiwoo Han from Responders of Daon Retail" }).click();
    await page.waitForTimeout(READ);
    await dlg(page).getByRole("button", { name: "Remove Jiwoo Han from Daon Retail" }).click();
    await expect(person(page, "ct_jiwoo").getByTestId("tombstone")).toContainText("Jiwoo Han · Removed");
    // a customer person: the typed contact comes back masked only
    const form = card(page).getByTestId("co-add-person");
    await form.getByLabel("Name").fill("Ari Go");
    await form.getByLabel("Phone").fill("010-2222-3344");
    await form.getByLabel("Role").selectOption("PAGEABLE");
    await assertNoRowShift(page, {
      name: "responder.add-person", rows: RESP, at: form.getByRole("button", { name: "Add to Daon Retail" }), mayGrowBelow: true, mayMoveDown: true,
      then: async () => { await expect(toast(page)).toContainText("Ari Go added to Daon Retail as Pageable"); },
    });
    const ari = card(page).getByTestId("co-cust-person").filter({ hasText: "Ari Go" });
    await expect(ari.getByTestId("co-masked")).toHaveText("010-••••-3344");
    await expect(form.getByLabel("Phone")).toHaveValue("");
    expect(await page.content()).not.toContain("2222");
    // what the server action refuses is said in words (security 권고 5)
    await form.getByLabel("Name").fill("Bo Ra");
    await form.getByLabel("Phone").fill("12-34");
    await form.getByRole("button", { name: "Add to Daon Retail" }).click();
    await expect(card(page).getByTestId("co-resp-err")).toContainText("That phone number does not look right.");
    await ari.getByRole("button", { name: "Remove Ari Go from Daon Retail" }).click();
    await page.waitForTimeout(READ);
    await dlg(page).getByRole("button", { name: "Remove Ari Go from Daon Retail" }).click();
    await expect(ari.getByTestId("tombstone")).toContainText("Ari Go · Removed");
    await expect(card(page).locator("li[data-gone]")).toHaveCount(2);
    await card(page).getByTestId("co-resp-edit").click(); // Done: the explicit refresh
    await expect(card(page).locator("li[data-gone]")).toHaveCount(0);
    await expect(card(page).getByTestId("co-staff")).toHaveCount(2);
    await expect(ari).toHaveCount(0);
    await expect(page.getByTestId("co-edit")).toBeEnabled();

    await page.goto("/c/mirae/call-order");
    await card(page).getByTestId("co-resp-edit").click();
    await card(page).getByRole("button", { name: "Remove Yuna Seo from Mirae Pay" }).click();
    await page.waitForTimeout(READ);
    await dlg(page).getByRole("button", { name: "Remove Yuna Seo from Mirae Pay" }).click();
    await expect(card(page).getByTestId("co-resp-err")).toContainText("Yuna Seo is named in a step. Change the step first.");
    await expect(person(page, "ct_yuna")).not.toHaveAttribute("data-gone", "1");
    await expect(card(page).getByTestId("co-staff").first()).toContainText("set by the template");
  });

  test("If-Match on Responders: a change made on a list someone else changed meanwhile is refused — Changed, reload — and nothing is removed", async ({ page, browser }) => {
    await signIn(page, "/c/eden/call-order");
    await card(page).getByTestId("co-resp-edit").click();
    const other = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await signIn(other, "/c/eden/call-order");
    await card(other).getByTestId("co-resp-edit").click();
    await card(other).getByLabel("MSP staff to add").selectOption({ label: "Taemin Jung · Data engineer" });
    await card(other).getByRole("button", { name: "Add to Eden Mobility" }).first().click();
    await expect(toast(other)).toContainText("Taemin Jung added");
    // this tab still shows the list as it was
    await card(page).getByRole("button", { name: "Remove Junho Park from Responders of Eden Mobility" }).click();
    await page.waitForTimeout(READ);
    await dlg(page).getByRole("button", { name: "Remove Junho Park from Eden Mobility" }).click();
    await expect(card(page).getByTestId("co-resp-conflict")).toContainText("Changed — reload. Someone else changed the Responders of Eden Mobility while you were editing. Your last change was not applied.");
    await expect(person(page, "ct_junho")).not.toHaveAttribute("data-gone", "1");
    await expect(card(page).getByRole("button", { name: /^Remove / }).first()).toBeDisabled(); // nothing more on a stale list
    await card(page).getByTestId("co-resp-reload").click();
    await expect(card(page).getByTestId("co-resp-conflict")).toHaveCount(0);
    await expect(person(page, "ct_taemin")).toBeVisible();
    await expect(person(page, "ct_junho")).toContainText("Junho Park");
    // put it back
    await card(page).getByRole("button", { name: "Remove Taemin Jung from Responders of Eden Mobility" }).click();
    await page.waitForTimeout(READ);
    await dlg(page).getByRole("button", { name: "Remove Taemin Jung from Eden Mobility" }).click();
    await expect(person(page, "ct_taemin")).toHaveAttribute("data-gone", "1");
    await other.context().close();
  });
});

test.describe("the same rule on the other lists", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Call order list: a save, new own steps and removed own steps never move a row", async ({ page }) => {
    await signIn(page, "/call-order");
    const base = await rowBoxes(page, CO);
    // a customer-level save (confirmed): the row says something else, in the same place
    await page.goto("/c/cheong/call-order");
    await page.getByTestId("co-edit").click();
    await page.getByLabel("Step 2 minutes").fill("3");
    await assertNoRowShift(page, {
      name: "callorder.save", rows: CO, at: page.getByTestId("co-save"), baseline: base,
      then: async () => { await page.waitForTimeout(READ); await dlg(page).getByRole("button", { name: "Save for Cheong Media" }).click(); await expect(page).toHaveURL(/\/call-order$/); await expect(toast(page)).toContainText("Saved for Cheong Media"); },
    });
    // own steps for one service: the new level waits in the bar, no row is pushed down
    await page.goto("/c/bora/main/web/call-order");
    await page.getByTestId("co-edit").click();
    await assertNoRowShift(page, {
      name: "callorder.create-own", rows: CO, at: page.getByTestId("co-save"), baseline: base,
      then: async () => { await expect(page).toHaveURL(/\/call-order$/); await expect(toast(page)).toContainText("Own steps created for Bora Foods › Main › Web"); },
    });
    await expect(page.getByTestId("co-list-pending")).toHaveText("1 new level with own steps");
    await page.waitForTimeout(READ);
    await page.getByTestId("co-list-bar").getByRole("button", { name: "Show" }).click(); // the explicit refresh
    await expect(page.locator(`${CO}[data-key="bora/main/web"]`)).toContainText("Own steps");
    const withNew = await rowBoxes(page, CO);
    // removing them: the row stays, marked, until the list is refreshed
    await page.locator(`${CO}[data-key="bora/main/web"]`).getByTestId("co-path").click();
    await page.getByTestId("co-edit").click();
    await assertNoRowShift(page, {
      name: "callorder.remove-own", rows: CO, at: page.getByRole("button", { name: "Remove own steps of Bora Foods › Main › Web…" }), baseline: withNew,
      then: async () => { await page.waitForTimeout(READ); await dlg(page).getByRole("button", { name: "Remove own steps of Bora Foods › Main › Web" }).click(); await expect(page).toHaveURL(/\/call-order$/); },
    });
    await expect(page.locator(`${CO}[data-key="bora/main/web"]`)).toHaveAttribute("data-gone", "1");
    await expect(page.locator(`${CO}[data-key="bora/main/web"]`).getByTestId("co-row-gone")).toHaveText("Own steps removed");
    await page.waitForTimeout(READ);
    await page.getByTestId("co-list-bar").getByRole("button", { name: "Refresh list" }).click();
    await expect(page.locator(`${CO}[data-key="bora/main/web"]`)).toHaveCount(0);
    expect((await rowBoxes(page, CO)).map((r) => r.key)).toEqual(base.map((r) => r.key));
  });

  test("Incidents: Acknowledge, Undo, Escalate, Resolve and Reload — from the row and from the panel — never move a row", async ({ page, browser }) => {
    const DAON = "inc-0d9c71f4e8a2-20261108181401", HANBIT = "inc-a1b5e2c07d33-20261108180512", PAY = "inc-7f3a0c91b2d4-20261108181204";
    const r = (id: string) => page.locator(`${INC}[data-id="${id}"]`);
    await signIn(page, "/incidents");
    await page.evaluate(() => document.fonts.ready);
    await assertNoRowShift(page, {
      name: "incident.ack", rows: INC, at: r(DAON).getByRole("button", { name: /^Acknowledge / }),
      then: async () => { await expect(r(DAON).getByTestId("ack-label")).toContainText("Acknowledged"); },
    });
    await page.waitForTimeout(READ);
    await assertNoRowShift(page, {
      name: "incident.undo-ack", rows: INC, at: r(DAON).getByRole("button", { name: /^More for / }),
      then: async () => { await page.getByRole("menuitem", { name: "Undo acknowledge" }).click(); await expect(r(DAON).getByRole("button", { name: /^Acknowledge / })).toBeVisible(); },
    });
    // someone else changes an incident: Acknowledge on this (stale) list is refused, and Reload moves nothing either
    const other = await (await browser.newContext()).newPage();
    await signIn(other, "/incidents");
    await other.locator(`${INC}[data-id="${HANBIT}"]`).getByRole("button", { name: /^Acknowledge / }).click();
    await expect(other.getByTestId("toast")).toContainText("Acknowledged");
    await other.waitForTimeout(READ);
    await other.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
    await expect(other.getByTestId("toast")).toContainText("Acknowledge undone");
    await other.context().close();
    await r(HANBIT).getByRole("button", { name: /^Acknowledge / }).click();
    await expect(r(HANBIT)).toContainText("Not acknowledged");
    await page.waitForTimeout(READ);
    await assertNoRowShift(page, {
      name: "incident.reload", rows: INC, at: r(HANBIT).getByRole("button", { name: /^Reload the list/ }),
      then: async () => { await expect(r(HANBIT).getByRole("button", { name: /^Acknowledge / })).toBeVisible(); },
    });

    // from the panel, with the list beside it
    await page.goto(`/c/mirae/core/payments-api/incident/${PAY}`);
    await page.evaluate(() => document.fonts.ready);
    const p = page.getByTestId("panel");
    await assertNoRowShift(page, { name: "incident.panel-escalate", rows: INC, at: p.getByRole("button", { name: "Escalate now" }), then: async () => { await page.waitForLoadState("networkidle"); } });
    await page.waitForTimeout(READ);
    await assertNoRowShift(page, { name: "incident.panel-ack", rows: INC, at: p.getByRole("button", { name: "Acknowledge", exact: true }), then: async () => { await expect(page.getByTestId("panel-acked")).toBeVisible(); } });
    await assertNoRowShift(page, { name: "incident.panel-undo-ack", rows: INC, at: page.getByTestId("panel-undo"), then: async () => { await expect(p.getByRole("button", { name: "Acknowledge", exact: true })).toBeVisible(); } });
    await page.waitForTimeout(READ);
    await p.getByRole("button", { name: "Acknowledge", exact: true }).click();
    await expect(p.getByRole("button", { name: "Resolve…" })).toBeVisible({ timeout: 8000 });
    await p.getByRole("button", { name: "Resolve…" }).click();
    await assertNoRowShift(page, {
      name: "incident.panel-resolve", rows: INC, at: p.getByRole("button", { name: "Resolve incident" }),
      then: async () => { await expect(r(PAY)).toContainText("Resolved"); },
    });
    await expect(r(PAY)).toHaveAttribute("data-gone", "1"); // left the active list: still in its place, saying so
  });
});

test.describe("P2-A · P2-B · P3", () => {
  test("P2-A the incident panel and Call order name Mirae Pay's steps with the same words", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/c/hanbit/tracking/public-api/incident/inc-a1b5e2c07d33-20261108180512");
    // Mirae Pay's open incident may have been resolved by the test above; its frozen call order is still shown
    await page.goto("/c/mirae/core/payments-api/incident/inc-7f3a0c91b2d4-20261108181204");
    const inPanel = (await page.getByTestId("plan-label").first().textContent())!;
    expect(inPanel).toBe("Custom, started from Urgent (edited)");
    await page.goto("/c/mirae/call-order");
    await expect(page.getByTestId("co-plan-label")).toHaveText(inPanel);
    await page.getByTestId("co-edit").click();
    await expect(page.getByRole("button", { name: "Urgent (edited)" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Standard", exact: true })).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Escape");
  });

  test("P2-B limits are on the screen and the editor stops at them; P3-D what is not a whole number is refused, and said", async ({ page }) => {
    const errors = watchErrors(page);
    const actions = watchActions(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page, "/c/gaon/call-order");
    await page.getByTestId("co-edit").click();
    await expect(page.getByTestId("co-limits")).toContainText("Limits: Up to 12 steps · minutes 0–1,440, each later than the one before · repeat 0–5 · at most 60 notifications per incident in one pass and 120 in an hour · “everyone” reaches at most 20 people.");
    await expect(page.getByTestId("co-step-count")).toHaveText("4 of 12 steps");
    await expect(page.getByTestId("co-sends")).toContainText(/These steps send up to \d+ of 60 notifications per incident in one pass and \d+ of 120 in an hour/);
    const add = page.getByTestId("co-add-step");
    for (let i = 0; i < 8; i++) await add.click();
    await expect(page.getByTestId("co-step-rows").locator("li")).toHaveCount(12);
    await expect(add).toBeDisabled();
    await expect(page.getByTestId("co-step-count")).toHaveText("12 of 12 steps — that is the limit. Remove a step to add another.");
    await add.click({ force: true });
    await expect(page.getByTestId("co-step-rows").locator("li")).toHaveCount(12);
    await page.getByRole("button", { name: "Remove step 12" }).click();
    await expect(add).toBeEnabled();
    await expect(page.getByTestId("co-step-count")).toHaveText("11 of 12 steps");
    // too many notifications is an error with the numbers in it, before anything is sent
    const way = (step: number, name: string) => page.locator(`[data-step="${step}"]`).getByRole("button", { name, exact: true });
    for (let s = 3; s < 11; s++) for (const c of ["Slack DM", "SMS", "Email"]) await way(s, c).click();
    await expect(page.getByTestId("co-issues").locator(".co-err")).toContainText(/This call order would send \d+ notifications per incident in one pass of the steps \(limit 60\)\. Use fewer steps, channels or repeats, or call fewer people per step\./);
    await page.keyboard.press("Control+Enter");
    await expect(dlg(page)).toHaveCount(0);
    expect(actions.with('"steps"')).toBe(0);

    // P3-D
    const m2 = page.getByLabel("Step 2 minutes");
    const was = await m2.inputValue();
    for (const typed of ["-5", "2.5", "1e1", "abc", "12 minutes<script>"]) {
      await m2.fill(typed);
      await expect(m2, typed).toHaveValue(was);
      await expect(page.locator('[data-step="1"]').getByTestId("co-refused"), typed).toHaveText(`Step 2: “${typed}” was not entered — minutes are a whole number from 0 to 1440, digits only. It stays at ${was} min.`);
    }
    await m2.fill("3");
    await expect(m2).toHaveValue("3");
    await expect(page.locator('[data-step="1"]').getByTestId("co-refused")).toHaveCount(0);
    const rep = page.getByLabel("Repeat count");
    await rep.fill("99");
    await expect(rep).toHaveValue("1");
    await expect(page.getByTestId("co-refused")).toHaveText("“99” was not entered — repeat is a whole number from 0 to 5. It stays at 1.");
    await rep.fill("7");
    await expect(page.getByTestId("co-issues")).toContainText("Repeat must be a whole number from 0 to 5.");
    await page.getByTestId("panel").getByRole("button", { name: "Cancel" }).click();
    await dlg(page).getByRole("button", { name: "Discard changes" }).click();
    expect(actions.with('"steps"')).toBe(0);
    expect(errors).toEqual([]);
  });

  test("P3-E J/K move between Call order rows; P3-K Not found goes back to the list of its own screen; P3-J the step's select shows its whole label", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "/call-order");
    await expect(page.locator(".co-keys")).toHaveText(/J\s*K move · Enter open · E edit/);
    const keys = await page.$$eval(`${CO} a[data-key]`, (a) => a.map((x) => (x as HTMLElement).dataset.key));
    const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key ?? null);
    await page.keyboard.press("j");
    expect(await focused()).toBe(keys[0]);
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    expect(await focused()).toBe(keys[2]);
    await page.keyboard.press("k");
    expect(await focused()).toBe(keys[1]);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("co-read-view")).toHaveAttribute("data-scope", keys[1]!);
    await page.keyboard.press("j"); // inside the panel J is not a list key
    await expect(page.getByTestId("co-read-view")).toHaveAttribute("data-scope", keys[1]!);

    for (const [url, label, href] of [["/c/nope/call-order", "Back to Call order", "/call-order"], ["/c/mirae/nope/call-order", "Back to Call order", "/call-order"], ["/c/nope/incident/x", "Back to Incidents", "/incidents"]] as const) {
      await page.goto(url);
      await expect(page.getByTestId("not-found-back"), url).toHaveText(label);
      await expect(page.getByTestId("not-found-back"), url).toHaveAttribute("href", href);
    }

    await page.goto("/c/mirae/call-order");
    await page.getByTestId("co-edit").click();
    const fits = await page.getByLabel("Step 1 calls").evaluate((sel: HTMLSelectElement) => {
      const c = document.createElement("canvas").getContext("2d")!;
      const cs = getComputedStyle(sel);
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const text = sel.selectedOptions[0]!.textContent ?? "";
      return { text, need: c.measureText(text).width, have: sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20 };
    });
    expect(fits.text).toBe("On shift in MSP night desk (Haeun now)");
    expect(fits.need, JSON.stringify(fits)).toBeLessThanOrEqual(fits.have);
    await page.keyboard.press("Escape");
  });
});

test.describe("security: roles, drafts per user, sign-out", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an operator reads the call order and is told why they cannot change it; a viewer cannot acknowledge", async ({ page }) => {
    const actions = watchActions(page);
    await signIn(page, "/c/daon/call-order", "operator");
    await page.getByTestId("account").click();
    await expect(page.getByTestId("account-role")).toHaveText("Operator");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("co-read-view")).toBeVisible();
    await expect(page.getByTestId("co-edit")).toBeDisabled();
    await expect(page.getByTestId("co-footnote")).toHaveText("Read only. Changing the call order needs the Admin role. You are signed in as Operator.");
    await expect(card(page).getByTestId("co-resp-edit")).toBeDisabled();
    await expect(card(page).getByTestId("co-resp-why")).toHaveText("Changing Responders needs the Admin role. You are signed in as Operator.");
    await page.keyboard.press("e");
    await expect(page.getByTestId("co-edit-view")).toHaveCount(0);
    await expect(page.locator(".co-panel input, .co-panel select")).toHaveCount(0);
    expect(actions.with('"steps"')).toBe(0);
    // an operator does acknowledge
    await page.goto("/incidents");
    await expect(page.locator(INC).first().getByRole("button", { name: /^Acknowledge / })).toBeEnabled();

    await signIn(page, "/incidents", "viewer");
    const ack = page.locator(INC).first().getByRole("button", { name: /^Acknowledge / });
    await expect(ack).toBeDisabled();
    await expect(ack).toHaveAttribute("title", "Acknowledging needs the Operator role. You are signed in as Viewer.");
    await page.locator(INC).first().locator("a.ttl").click();
    await expect(page.getByTestId("hero-role")).toHaveText("Acknowledging, escalating and resolving needs the Operator role. You are signed in as Viewer.");
    await expect(page.getByTestId("panel").getByRole("button", { name: "Acknowledge", exact: true })).toBeDisabled();
  });

  test("drafts belong to the user who typed them: another user in the same tab finds none, and sign-out removes them with the session", async ({ page, context, request, baseURL }) => {
    const keys = () => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("ao-")).sort());
    const makeDraft = async () => {
      await page.goto("/c/iruda/call-order");
      await page.getByTestId("co-edit").click();
      await page.getByLabel("Step 2 minutes").fill("6");
      await page.keyboard.press("Escape");
      await page.getByTestId("dirty-guard").getByRole("button", { name: /^Keep draft/ }).click();
      await expect(page.getByTestId("co-draft")).toContainText("Draft for Iruda Edu");
    };
    await signIn(page, "/call-order");
    await makeDraft();
    expect(await keys()).toContain("ao-draft:call-order:usr_haeun/iruda");
    // the same tab, another person
    await signIn(page, "/call-order", "operator");
    await expect(page.getByTestId("co-table")).toBeVisible();
    await expect(page.getByTestId("co-draft")).toHaveCount(0);
    expect((await keys()).filter((k) => k.startsWith("ao-draft"))).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem("ao-user"))).toBe("usr_minjae");
    await page.goto("/c/iruda/call-order");
    await expect(page.getByTestId("co-draft-here")).toHaveCount(0);

    // sign-out
    await signIn(page, "/call-order");
    await makeDraft();
    await page.getByTestId("account").click();
    await page.getByTestId("sign-out").click();
    await expect(page).toHaveURL(/\/login\?signedOut=1$/);
    expect(await keys()).toEqual([]);
    expect((await context.cookies()).find((c) => c.name === "ao_session")).toBeUndefined();
    await page.goto("/call-order");
    await expect(page).toHaveURL(/\/login\?next=%2Fcall-order$/);
    await signIn(page, "/call-order");
    await expect(page.getByTestId("co-draft")).toHaveCount(0);
    // the route: POST only, and not from another site
    expect((await request.get("/auth/sign-out", { maxRedirects: 0 })).status()).toBe(405);
    expect((await request.post("/auth/sign-out", { maxRedirects: 0, headers: { origin: "https://evil.example" } })).status()).toBe(403);
    const ok = await request.post("/auth/sign-out", { maxRedirects: 0, headers: { origin: baseURL! } });
    expect([ok.status(), ok.headers()["location"]]).toEqual([303, "/login?signedOut=1"]);
    expect(ok.headers()["set-cookie"]).toMatch(/^ao_session=;.*Max-Age=0/i);
  });

  test("signing out over an unsaved edit asks first", async ({ page }) => {
    await signIn(page, "/c/iruda/call-order");
    await page.getByTestId("co-edit").click();
    await page.getByLabel("Step 2 minutes").fill("7");
    await page.getByTestId("account").click();
    await page.getByTestId("sign-out").click();
    await expect(page.getByTestId("dirty-guard")).toContainText("Unsaved changes for Iruda Edu");
    await page.getByTestId("dirty-guard").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("co-edit-view")).toBeVisible();
    await page.getByTestId("panel").getByRole("button", { name: "Cancel" }).click();
    await dlg(page).getByRole("button", { name: "Discard changes" }).click();
  });
});
