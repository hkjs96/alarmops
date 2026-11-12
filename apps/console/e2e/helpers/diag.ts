import type { Page, TestInfo } from "@playwright/test";

/**
 * What the page saw, printed to the run's log when a test fails. The hosted runner's report artifact cannot always be
 * opened, and "the tap did nothing" says nothing by itself: this records every touch, pointer and click with what was
 * under it, every layout shift, every font that arrived, and the zoom — enough to tell a missed tap from a swallowed one.
 * Installed before the page's own scripts (`watchPage` in a beforeEach), read back in an afterEach (`reportOnFailure`).
 */
export async function watchPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __diag?: unknown[] };
    if (w.__diag) return;
    const log: unknown[] = (w.__diag = []);
    const t = () => Math.round(performance.now());
    const name = (e: Element | null) => (e && e.tagName ? `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : ""}${e.getAttribute("aria-label") ? `[${e.getAttribute("aria-label")!.slice(0, 40)}]` : ""}` : e ? "text" : "none");
    const hydrated = (e: Element | null) => Boolean(e && Object.keys(e).some((k) => k.startsWith("__reactProps")));
    for (const type of ["touchstart", "touchend", "touchcancel", "pointerdown", "pointerup", "pointercancel", "click", "dblclick"]) {
      window.addEventListener(type, (ev) => {
        const p = (ev as TouchEvent).changedTouches?.[0] ?? (ev as MouseEvent);
        const target = ev.target as Element | null;
        const control = target?.closest?.("button, a") ?? null;
        log.push([t(), type, Math.round(p.clientX), Math.round(p.clientY), name(target), control ? `in ${name(control)} hydrated=${hydrated(control)}` : "", `detail=${(ev as MouseEvent).detail ?? ""}`, `scale=${window.visualViewport?.scale}`, `scrollY=${Math.round(window.scrollY)}`]);
        if (type === "click") queueMicrotask(() => log.push([t(), "click-after", `defaultPrevented=${ev.defaultPrevented}`]));
      }, true);
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as { value: number; startTime: number; sources?: { node: Element | null; previousRect: DOMRect; currentRect: DOMRect }[] }[]) {
          log.push([Math.round(e.startTime), "layout-shift", e.value.toFixed(5), ...(e.sources ?? []).slice(0, 3).map((s) => `${name(s.node)} y ${s.previousRect.y}→${s.currentRect.y} h ${s.previousRect.height}→${s.currentRect.height}`)]);
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch { /* not in this browser */ }
    const fonts = () => document.fonts.addEventListener("loadingdone", (e) => log.push([t(), "fonts", ...(e as FontFaceSetLoadEvent).fontfaces.map((f) => `${f.family} ${f.weight} ${f.unicodeRange.slice(0, 24)}`)]));
    if (document.fonts) fonts();
    document.addEventListener("DOMContentLoaded", () => log.push([t(), "DOMContentLoaded"]));
    window.addEventListener("load", () => log.push([t(), "load"]));
    window.addEventListener("error", (e) => log.push([t(), "error", String(e.message).slice(0, 200)]));
  });
}

export async function reportOnFailure(page: Page, info: TestInfo): Promise<void> {
  if (info.status === info.expectedStatus && process.env.PW_DIAG !== "1") return; // PW_DIAG=1: print for passing tests too
  const lines: string[] = [`--- diagnostics: ${info.title.slice(0, 80)} (${info.status}) ---`];
  try {
    const d = await page.evaluate(() => ({
      now: Math.round(performance.now()),
      url: location.pathname + location.search,
      log: (window as unknown as { __diag?: unknown[] }).__diag ?? [],
      fonts: [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`),
      scale: window.visualViewport?.scale,
      firstRow: (document.querySelector("tr[data-id]") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").slice(0, 300) ?? null,
      alerts: [...document.querySelectorAll("[role=alert], [role=status], [data-testid=toast]")].map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 200)).filter(Boolean),
      buttons: [...document.querySelectorAll("button")].filter((b) => /^Acknowledge/.test(b.getAttribute("aria-label") ?? b.textContent ?? "") && b.getClientRects().length > 0).slice(0, 3).map((b) => { const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return `${b.textContent} @ ${r.x},${r.y} ${r.width}×${r.height} disabled=${b.disabled} top=${top === b || b.contains(top) ? "itself" : top?.tagName + "." + top?.className}`; }),
    }));
    lines.push(`now=${d.now} url=${d.url} scale=${d.scale}`, `fonts: ${d.fonts.join(" | ")}`, `first row: ${d.firstRow}`, `alerts: ${JSON.stringify(d.alerts)}`, `acknowledge buttons: ${JSON.stringify(d.buttons)}`);
    for (const e of d.log as unknown[][]) lines.push("  " + e.join(" "));
  } catch (e) {
    lines.push(`page could not be read: ${String(e).slice(0, 200)}`);
  }
  console.log(lines.join("\n"));
}
