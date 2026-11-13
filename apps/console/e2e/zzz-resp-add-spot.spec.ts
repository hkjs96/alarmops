// QA 권고 A and B: the Responders Add controls are below the lists. A jump link next to Done leads there; and without scroll
// anchoring (Safari) an add must not carry the Add button away from the pointer — two adds in a row hit it both times.
// Uses /c/bora (no later spec reads its Responders).
import { test, expect, type Page } from "@playwright/test";
import { noScrollAnchoring } from "./helpers/no-row-shift";

const signIn = async (page: Page, next: string) => {
  await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
};

for (const vp of [{ w: 1440, h: 900, touch: false }, { w: 390, h: 844, touch: true }]) {
  test.describe(`Responders Add controls at ${vp.w}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch });
    test("a jump link next to Done reaches the Add controls; after an add the Add button stays at the same place in the viewport (no scroll anchoring)", async ({ page }) => {
      await signIn(page, "/c/bora/call-order");
      await noScrollAnchoring(page);
      const card = page.getByTestId("co-responders");
      await card.getByTestId("co-resp-edit").click();
      const jump = card.getByTestId("co-resp-jump");
      await expect(jump).toBeVisible();
      expect((await jump.boundingBox())!.height).toBeGreaterThanOrEqual(vp.touch ? 44 : 24);
      await jump.click();
      await expect(card.getByLabel("MSP staff to add")).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

      const form = card.getByTestId("co-add-person");
      const add = form.getByRole("button", { name: /^Add to / });
      await add.evaluate((el) => el.scrollIntoView({ block: "center" }));
      for (const n of [1, 2]) {
        await form.getByLabel("Name").fill(`Scroll Test ${vp.w}-${n}`);
        await form.getByLabel("Email").fill(`scroll${vp.w}${n}@bora.example`);
        const y0 = (await add.boundingBox())!.y;
        const rows0 = await card.locator("li[data-row-key]").count();
        await add.click();
        await expect(card.locator("li[data-row-key]")).toHaveCount(rows0 + 1);
        await page.waitForTimeout(700);
        const y1 = (await add.boundingBox())!.y;
        expect(Math.abs(y1 - y0), `add #${n}: the Add button moved ${y1 - y0}px in the viewport`).toBeLessThanOrEqual(4);
      }
    });
  });
}
