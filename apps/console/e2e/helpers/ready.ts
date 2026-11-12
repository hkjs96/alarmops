import type { Page } from "@playwright/test";

/**
 * The page is the app's: loaded, taken over by the app (the shell has mounted and applied what it remembers) and its
 * fonts settled. `page.goto` returns at the load event, which says nothing about that — with the fonts served by the
 * console itself the load event often comes first. A test that reads state or presses by coordinates right after
 * signing in waits for this.
 */
export async function appReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const shell = document.querySelector(".shell");
    return document.readyState === "complete" && (!shell || shell.classList.contains("ready")) && document.fonts.status === "loaded";
  });
}
