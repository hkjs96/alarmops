// P3-K: pressing "Edit responders" must not move the Responders rows (they used to drop by ~239 px at 1440 and ~281 px at 390).
// Also: the nonce CSP (hardening 2c) lets the app render and hydrate — no CSP violation, the theme script ran.
import { test, expect, type Page } from "@playwright/test";
import { noScrollAnchoring, rowBoxes } from "./helpers/no-row-shift";

const signIn = async (page: Page, next: string) => {
  await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
};
const RESP = '[data-testid="co-responders"] li[data-row-key]';
const TOLERANCE_PX = 2;

for (const vp of [{ w: 1440, h: 900, touch: false }, { w: 390, h: 844, touch: true }]) {
  test.describe(`P3-K Responders Edit at ${vp.w}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.touch });

    test("Edit keeps every Responders row where it was (document y)", async ({ page }) => {
      await signIn(page, "/c/daon/call-order");
      await noScrollAnchoring(page); // Safari has none: the layout itself must hold the rows
      const edit = page.getByTestId("co-resp-edit");
      await edit.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const before = await rowBoxes(page, RESP);
      expect(before.length).toBeGreaterThanOrEqual(3);
      const scrollY = await page.evaluate(() => window.scrollY);

      const b = (await edit.boundingBox())!;
      const at = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
      if (vp.touch) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
      await expect(page.getByTestId("co-responders")).toHaveAttribute("data-editing", "1");

      for (const wait of [0, 700]) {
        await page.waitForTimeout(wait);
        const after = await rowBoxes(page, RESP);
        expect(after.map((r) => r.key)).toEqual(before.map((r) => r.key));
        expect(await page.evaluate(() => window.scrollY), "the page did not scroll either").toBe(scrollY);
        for (const [i, r] of before.entries()) {
          expect(Math.abs(after[i]!.y - r.y), `row ${r.key} moved ${after[i]!.y - r.y}px after Edit (+${wait} ms)`).toBeLessThanOrEqual(TOLERANCE_PX);
        }
      }
      // what Edit brought in is there, below the last row
      const editor = page.getByTestId("co-resp-ed");
      await expect(editor).toBeVisible();
      const last = await rowBoxes(page, RESP);
      expect((await editor.boundingBox())!.y + scrollY).toBeGreaterThan(last[last.length - 1]!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  });
}

test("the nonce CSP: pages render and hydrate with no CSP violation, and the inline scripts carry the request's nonce", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  const res = await page.goto("/auth/dev-login?next=%2Fincidents");
  await page.waitForLoadState("networkidle");
  expect(res!.url()).toContain("/incidents");
  const csp = (await res!.allHeaders())["content-security-policy"] ?? "";
  const script = csp.split("; ").find((d) => d.startsWith("script-src"))!;
  expect(script).toMatch(/'nonce-[^']+'/);
  expect(script).toContain("'strict-dynamic'");
  expect(script).not.toContain("'unsafe-inline'");
  // the pre-paint theme script ran (it sets data-theme or a class on <html>) and every <script> has a nonce
  expect(await page.evaluate(() => [...document.scripts].filter((s) => !s.src).every((s) => s.nonce !== "" || s.getAttribute("nonce") !== null))).toBe(true);
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeAttached();
  expect(problems).toEqual([]);
  // (the /auth/session rate limit is covered by unit tests: a burst here would use up the shared address bucket of later specs)
});
