// QA explore: node docs/qa/explore.mjs <base> <path...>  — prints h1, nav links, main text
import { chromium } from "/home/claude/wt-console/node_modules/playwright/index.mjs";
const [base, ...paths] = process.argv.slice(2);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
for (const path of paths) {
  if(path.startsWith("/")&&!globalThis.li){globalThis.li=1;await p.goto(base+"/auth/dev-login?next=/people",{waitUntil:"networkidle"});}
  await p.goto(base + path, { waitUntil: "networkidle" });
  console.log("==", path, "->", p.url());
  console.log((await p.locator("body").innerText()).slice(0, 1500));
  console.log("LINKS", (await p.$$eval("a", as => as.map(a => a.getAttribute("href")))).filter((v,i,s)=>s.indexOf(v)===i).slice(0,40).join(" "));
}
await b.close();
