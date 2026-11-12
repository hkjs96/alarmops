// Persona capture for feat/console-live-api: node docs/qa/shoot-live-api.mjs <base> <outDir> <step>
import { chromium } from "/home/claude/wt-console/node_modules/playwright/index.mjs";
const [base, out, step] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = async (w=1440,h=900,scheme="light") => { const c = await b.newContext({ viewport:{width:w,height:h}, colorScheme: scheme }); return c; };
const login = async (p, next) => p.goto(base + "/auth/dev-login?next=" + encodeURIComponent(next), { waitUntil: "networkidle" });
const card = (p) => p.getByTestId("co-responders");
const say = (k, v) => console.log(k + ": " + v);
const URL0 = "/c/acme-demo/call-order";
if (step === "conflict") {
  for (const [w,h,scheme] of [[1440,900,"light"],[390,844,"dark"]]) {
    const c = await ctx(w,h,scheme); const A = await c.newPage(); await login(A, URL0); const B = await c.newPage(); await B.goto(base+URL0,{waitUntil:"networkidle"});
    // B starts editing first (stale), A edits and saves
    await card(B).getByRole("button", { name: /edit/i }).first().click(); await B.waitForTimeout(500);
    await B.screenshot({ path: `${out}/resp-edit-${w}-${scheme}.png`, fullPage: true });
    say("B edit text", (await card(B).innerText()).replace(/\s+/g," ").slice(0,600));
    await card(A).getByRole("button", { name: /edit/i }).first().click();
    const rm = card(A).getByRole("button", { name: /remove/i }).first(); say("A remove label", await rm.getAttribute("aria-label") ?? await rm.innerText()); await rm.click();
    await A.waitForTimeout(600); const dlg = async (P) => { const d = P.getByRole("dialog").or(P.getByRole("alertdialog")); if (await d.first().isVisible().catch(()=>false)) { say("dialog", (await d.first().innerText()).replace(/\s+/g," ").slice(0,300)); await d.first().getByRole("button").filter({ hasNotText: /cancel|keep|back/i }).last().click(); await P.waitForTimeout(1500);} };
    await dlg(A); await A.screenshot({ path: `${out}/resp-A-afterremove-${w}.png`, fullPage: true });
    say("A after", (await card(A).innerText()).replace(/\s+/g," ").slice(0,300));
    await card(B).getByRole("button", { name: /remove/i }).last().click(); await B.waitForTimeout(600); await dlg(B);
    await B.waitForTimeout(1500);
    await B.screenshot({ path: `${out}/resp-conflict-${w}-${scheme}.png`, fullPage: true });
    const main = (await B.locator("main").innerText()).replace(/\s+/g," ");
    say("B Now lines", (main.match(/.{0,80}(Now:|Changed|reload).{0,120}/gi)||[]).join(" ||| "));
    say("B overflowX", await B.evaluate(()=>document.documentElement.scrollWidth > innerWidth));
    await c.close();
    // restore DB state between widths
  }
}
if (step === "session") {
  const c = await ctx(390,844,"light"); const p = await c.newPage(); await login(p, "/incidents");
  const href = await p.locator("a[href*='/incident/']").first().getAttribute("href"); say("incident href", href);
  await p.goto(base + href, { waitUntil: "networkidle" }); await c.clearCookies();
  const ack = p.getByRole("button", { name: /acknowledge/i }).first(); if (await ack.isVisible().catch(()=>false)) { await ack.click(); await p.waitForTimeout(1500); }
  await p.screenshot({ path: `${out}/session-ended-390.png`, fullPage: true });
  const t = (await p.locator("body").innerText()).replace(/\s+/g," "); say("session text", (t.match(/.{0,120}(session|sign(ed)? in|paging).{0,160}/gi)||[]).slice(0,4).join(" ||| ")); say("url", p.url());
  await c.close();
}
if (step === "login") {
  const c = await ctx(390,844,"dark"); const p = await c.newPage();
  await p.goto(base + "/incidents?customer=x#y", { waitUntil: "networkidle" }); say("signed-out", p.url());
  await p.screenshot({ path: `${out}/login-signedout-390-dark.png`, fullPage: true });
  await login(p, "/incidents"); await p.goto(base + "/login", { waitUntil: "networkidle" }); say("login when signed in", p.url());
  await p.screenshot({ path: `${out}/login-already-390-dark.png` });
  await c.close();
}
await b.close();
