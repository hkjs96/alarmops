// Persona capture for fix/principal-logs (customer SUSPENDED -> portal session ends):
// node docs/qa/shoot-portal-suspend.mjs <base> <outDir> <dbUrl>
// Portal user = usr_dev_viewer re-linked by SQL to CUSTOMER contact ct_acme_jisu (cus_acme). Staff = dev admin.
import { chromium } from "/home/claude/wt-console/node_modules/playwright/index.mjs";
import pg from "/home/claude/wt-followup/node_modules/pg/lib/index.js";
const [base, out, dbUrl] = process.argv.slice(2);
const db = new pg.Client({ connectionString: dbUrl }); await db.connect();
const setStatus = (s) => db.query(`update "Customer" set status=$1 where id='cus_acme'`, [s]);
const say = (k, v) => console.log(k + ": " + v);
const b = await chromium.launch();
const ck = async (c) => (await c.cookies()).map((x) => x.name).join(",") || "(none)";
const trace = (p) => { const hops = []; p.on("response", (r) => { if (r.request().isNavigationRequest()) hops.push(r.status() + " " + new URL(r.url()).pathname + new URL(r.url()).search); }); return hops; };
const text = async (p) => (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 260);
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
for (const [w, h, scheme] of [[1440, 900, "light"], [390, 844, "dark"]]) {
  const tag = `${w}-${scheme}`;
  await setStatus("ACTIVE");
  // 1. portal user signs in
  let c = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }); let p = await c.newPage(); let hops = trace(p);
  await p.goto(base + "/auth/dev-login?as=viewer&next=/incidents", { waitUntil: "networkidle" });
  say(`[${tag}] portal signed in url`, p.url()); say(`[${tag}] cookies`, await ck(c));
  await p.screenshot({ path: `${out}/portal-active-${tag}.png`, fullPage: true });
  // 2. suspend, reload
  await setStatus("SUSPENDED"); hops.length = 0;
  await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(1500);
  say(`[${tag}] after suspend url`, p.url()); say(`[${tag}] hops`, hops.join(" -> ")); say(`[${tag}] cookies`, await ck(c));
  say(`[${tag}] text`, await text(p)); say(`[${tag}] overflowX`, await overflow(p));
  await p.screenshot({ path: `${out}/portal-suspended-reload-${tag}.png`, fullPage: true });
  // 2b. suspended: dev sign-in attempt again
  hops.length = 0; await p.goto(base + "/auth/dev-login?as=viewer&next=/incidents", { waitUntil: "networkidle" }); await p.waitForTimeout(800);
  say(`[${tag}] suspended re-signin url`, p.url()); say(`[${tag}] hops`, hops.join(" -> ")); say(`[${tag}] text`, await text(p));
  await p.screenshot({ path: `${out}/portal-suspended-signin-${tag}.png`, fullPage: true });
  // 3. back to ACTIVE, sign in
  await setStatus("ACTIVE"); hops.length = 0;
  await p.goto(base + "/login", { waitUntil: "networkidle" });
  await p.getByRole("link", { name: /a viewer/i }).click(); await p.waitForLoadState("networkidle"); await p.waitForTimeout(800);
  say(`[${tag}] reactivated signin url`, p.url()); say(`[${tag}] hops`, hops.join(" -> ")); say(`[${tag}] cookies`, await ck(c));
  await p.screenshot({ path: `${out}/portal-reactivated-${tag}.png`, fullPage: true });
  await c.close();
  // 4. staff unaffected while customer SUSPENDED
  await setStatus("SUSPENDED");
  c = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }); p = await c.newPage(); hops = trace(p);
  await p.goto(base + "/auth/dev-login?next=/incidents", { waitUntil: "networkidle" });
  await p.reload({ waitUntil: "networkidle" }); await p.goto(base + "/c/acme-demo/call-order", { waitUntil: "networkidle" });
  say(`[${tag}] staff url`, p.url()); say(`[${tag}] staff hops`, hops.join(" -> ")); say(`[${tag}] staff text`, await text(p));
  await p.screenshot({ path: `${out}/staff-suspended-${tag}.png`, fullPage: true });
  // 5. valid session visits /auth/ended
  hops.length = 0; await p.goto(base + "/auth/ended", { waitUntil: "networkidle" });
  say(`[${tag}] ended (valid) url`, p.url()); say(`[${tag}] hops`, hops.join(" -> ")); say(`[${tag}] cookies`, await ck(c));
  await p.reload({ waitUntil: "networkidle" }); say(`[${tag}] after reload`, p.url());
  await p.screenshot({ path: `${out}/staff-auth-ended-${tag}.png`, fullPage: true });
  await c.close();
  // 5b. signed out visits /auth/ended
  c = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }); p = await c.newPage(); hops = trace(p);
  await p.goto(base + "/auth/ended", { waitUntil: "networkidle" }); say(`[${tag}] ended (signed out) hops`, hops.join(" -> "));
  await c.close();
}
await setStatus("ACTIVE"); await db.end(); await b.close();
