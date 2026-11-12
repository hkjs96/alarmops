// Persona capture for fix/principal-logs (93ab48f): /login?ended=1 notice, /auth/ended?from=layout with live session.
// node docs/qa/shoot-ended-notice.mjs <base> <outDir>   (mock mode, MOCK_API=1)
import { chromium } from "/home/claude/wt-console/node_modules/playwright/index.mjs";
const [base, out] = process.argv.slice(2);
const say = (k, v) => console.log(k + ": " + v);
const b = await chromium.launch();
const ck = async (c) => (await c.cookies()).map((x) => x.name).join(",") || "(none)";
const trace = (p) => { const hops = []; p.on("response", (r) => { if (r.request().isNavigationRequest()) hops.push(r.status() + " " + new URL(r.url()).pathname + new URL(r.url()).search); }); return hops; };
const text = async (p) => (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300);
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const controls = (p) => p.evaluate(() => [...document.querySelectorAll("a,button,input")].filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
  return `${(e.innerText || e.value || e.tagName).trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)} fg=${s.color} bg=${s.backgroundColor}`; }).join(" | "));
const bodyColors = (p) => p.evaluate(() => { const s = getComputedStyle(document.body); return `fg=${s.color} bg=${s.backgroundColor}`; });
for (const [w, h, scheme] of [[1440, 900, "light"], [390, 844, "dark"]]) {
  const tag = `${w}-${scheme}`;
  let c = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }); let p = await c.newPage(); let hops = trace(p);
  // 1a. /login?ended=1 (signed out)
  await p.goto(base + "/login?ended=1", { waitUntil: "networkidle" });
  say(`[${tag}] login ended url`, p.url()); say(`[${tag}] text`, await text(p)); say(`[${tag}] overflowX`, await overflow(p));
  say(`[${tag}] body`, await bodyColors(p)); say(`[${tag}] controls`, await controls(p));
  await p.screenshot({ path: `${out}/login-ended-${tag}.png`, fullPage: true });
  // 1b. plain /login
  await p.goto(base + "/login", { waitUntil: "networkidle" });
  say(`[${tag}] plain login text`, await text(p));
  await p.screenshot({ path: `${out}/login-plain-${tag}.png`, fullPage: true });
  // 2. live session -> /auth/ended?from=layout
  await p.goto(base + "/auth/dev-login?next=/incidents", { waitUntil: "networkidle" });
  say(`[${tag}] signed in url`, p.url()); say(`[${tag}] cookies`, await ck(c));
  hops.length = 0;
  await p.goto(base + "/auth/ended?from=layout", { waitUntil: "networkidle" }); await p.waitForTimeout(500);
  say(`[${tag}] ended-layout url`, p.url()); say(`[${tag}] hops`, hops.join(" -> ")); say(`[${tag}] text`, await text(p));
  say(`[${tag}] overflowX`, await overflow(p)); say(`[${tag}] body`, await bodyColors(p)); say(`[${tag}] controls`, await controls(p));
  await p.screenshot({ path: `${out}/ended-layout-${tag}.png`, fullPage: true });
  // 2a. Try again link
  const tryLink = p.getByRole("link", { name: /try again/i });
  say(`[${tag}] try again href`, await tryLink.getAttribute("href").catch(() => "(missing)"));
  hops.length = 0; await tryLink.click().catch((e) => say("try click err", e.message)); await p.waitForLoadState("networkidle"); await p.waitForTimeout(500);
  say(`[${tag}] after try again url`, p.url()); say(`[${tag}] hops`, hops.join(" -> ")); say(`[${tag}] cookies`, await ck(c));
  await p.screenshot({ path: `${out}/ended-layout-tryagain-${tag}.png`, fullPage: true });
  // 2b. Sign out button
  await p.goto(base + "/auth/ended?from=layout", { waitUntil: "networkidle" });
  hops.length = 0; await p.getByRole("button", { name: /sign out/i }).click(); await p.waitForLoadState("networkidle"); await p.waitForTimeout(800);
  say(`[${tag}] after sign out url`, p.url()); say(`[${tag}] hops`, hops.join(" -> ")); say(`[${tag}] cookies`, await ck(c)); say(`[${tag}] text`, await text(p));
  await p.screenshot({ path: `${out}/ended-layout-signout-${tag}.png`, fullPage: true });
  hops.length = 0; await p.goto(base + "/incidents", { waitUntil: "networkidle" });
  say(`[${tag}] after sign out /incidents`, p.url());
  await c.close();
}
await b.close();
