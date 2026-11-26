import { expect, test, type Page } from "@playwright/test";

/**
 * Text contrast of the Monitoring screens, measured on the page (getComputedStyle → WCAG 2.x ratio), light and dark.
 * Every visible text element must reach 4.5:1 against the first opaque background behind it (qa-ux #139).
 */
async function measure(page: Page): Promise<{ min: number; worst: string }[]> {
  return page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] => { const m = c.match(/[\d.]+/g)!.map(Number); return [m[0]!, m[1]!, m[2]!, m[3] ?? 1]; };
    const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const bgOf = (el: Element): [number, number, number] => {
      let n: Element | null = el;
      let acc: [number, number, number] = [255, 255, 255];
      const stack: [number, number, number, number][] = [];
      while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) stack.push(c); if (c[3] === 1) break; n = n.parentElement; }
      for (const c of stack.reverse()) acc = [0, 1, 2].map((i) => c[i]! * c[3] + acc[i]! * (1 - c[3])) as [number, number, number];
      return acc;
    };
    let min = 21; let worst = "";
    for (const el of Array.from(document.querySelectorAll("main *, .shell-main *"))) {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim());
      const cs = getComputedStyle(el);
      if (!own || cs.visibility === "hidden" || cs.display === "none" || (el as HTMLElement).offsetParent === null) continue;
      if ((el as HTMLButtonElement).disabled) continue; // disabled controls are exempt from WCAG 1.4.3
      const fg = parse(cs.color); const bg = bgOf(el);
      const f = [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])) as [number, number, number];
      const [a, b] = [lum(...f), lum(...bg)];
      const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (r < min) { min = r; worst = `${el.tagName}.${el.className} "${el.textContent!.trim().slice(0, 30)}"`; }
    }
    return [{ min, worst }];
  });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`monitoring text contrast, ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1440, height: 900 } });
    for (const tab of ["alarms", "resources", "needs-review"]) {
      test(`/monitoring/${tab} is at least 4.5:1`, async ({ page }) => {
        await page.goto(`/auth/dev-login?next=${encodeURIComponent(`/monitoring/${tab}`)}`, { waitUntil: "networkidle" });
        const [r] = await measure(page);
        expect(r!.min, `worst: ${r!.worst}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  });
}
