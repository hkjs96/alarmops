import { test, expect, type Page } from "@playwright/test";

/**
 * The real stack: console + packages/api (in the same app) + packages/store-sql + Postgres, seeded by db/prisma/seed.ts.
 * Checks every step against the API itself (same origin, same session cookie), not only against the screen.
 */
test.skip(!process.env.LIVE_DATABASE_URL, "LIVE_DATABASE_URL is not set: the live project needs a local Postgres (see apps/console/README.md › Live e2e). Skipped.");

const READ = 700; // a dialog's buttons ignore presses for 600 ms at the spot that opened it
const api = async (page: Page, path: string) => {
  const r = await page.request.get(`/api/v1${path}`);
  expect(r.status(), `GET ${path}`).toBe(200);
  return r.json();
};
async function signIn(page: Page, next: string) {
  await page.goto(`/auth/dev-login?next=${encodeURIComponent(next)}`);
  await page.waitForFunction(() => document.readyState === "complete" && (!document.querySelector(".shell") || document.querySelector(".shell")!.classList.contains("ready")));
}
const nextActions = (page: Page) => {
  const bodies: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.headers()["next-action"]) bodies.push(r.postData() ?? ""); });
  return bodies;
};

test.describe.configure({ mode: "serial" });

test("the API is mounted at /api/v1 and needs the session", async ({ page }) => {
  const anon = await page.request.get("/api/v1/me");
  expect(anon.status()).toBe(401);
  expect((await anon.json()).error.code).toBe("UNAUTHENTICATED");
  const tick = await page.request.post("/api/internal/tick", { data: {} });
  expect(tick.status()).toBe(401); // wrong / missing secret: refused, no session involved
  await signIn(page, "/incidents");
  expect(await api(page, "/me")).toMatchObject({ id: "usr_dev_admin", name: "Demo Admin", role: "ADMIN", kind: "INTERNAL" });
  const ok = await page.request.post("/api/internal/tick", { headers: { authorization: "Bearer live-e2e-only-tick-secret-0123456789abcdef" }, data: {} });
  expect(ok.status()).toBe(200);
});

test("list incidents, then acknowledge exactly one", async ({ page }) => {
  const actions = nextActions(page);
  await signIn(page, "/incidents");
  const rows = page.getByTestId("incident-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "public-api 5xx rate high" })).toHaveCount(1);
  const before = await api(page, "/incidents?status=active");
  expect(before.counts.open).toBe(3);
  await rows.filter({ hasText: "public-api 5xx rate high" }).getByRole("button", { name: /^Acknowledge public-api 5xx rate high/ }).click();
  await expect.poll(async () => (await api(page, "/incidents?status=ACKNOWLEDGED")).items.length).toBe(1);
  const acked = await api(page, "/incidents?status=ACKNOWLEDGED");
  expect(acked.items[0]).toMatchObject({ title: "public-api 5xx rate high", status: "ACKNOWLEDGED", acknowledgedBy: { name: "Demo Admin" } });
  expect((await api(page, "/incidents?status=active")).counts.open).toBe(2);
  expect(actions.filter((b) => b.includes(acked.items[0].id)).length).toBe(1);
});

test("Call order: edit step 2 and save — stored with the next version", async ({ page }) => {
  await signIn(page, "/c/acme-demo/call-order");
  const before = await api(page, "/customers/cus_acme/paging");
  expect(before.steps.map((s: { atMin: number }) => s.atMin)).toEqual([0, 2, 7]);
  await expect(page.getByTestId("co-read-view")).toBeVisible();
  await page.getByTestId("co-edit").click();
  await expect(page.getByTestId("co-edit-view")).toBeVisible();
  await page.getByLabel("Step 2 minutes").fill("3");
  await expect(page.getByTestId("co-unsaved")).toHaveText("Unsaved");
  await page.getByTestId("co-save").click();
  const dlg = page.getByTestId("confirm-dialog");
  if (await dlg.isVisible().catch(() => false)) { await page.waitForTimeout(READ); await dlg.getByRole("button", { name: /^Save for / }).click(); }
  await expect(page.getByTestId("toast")).toContainText("Saved for Acme Demo");
  const after = await api(page, "/customers/cus_acme/paging");
  expect(after.steps.map((s: { atMin: number }) => s.atMin)).toEqual([0, 3, 7]);
  expect(after.version).toBe(before.version + 1);
});

test("Responders: remove a person after the confirmation", async ({ page }) => {
  await signIn(page, "/c/acme-demo/call-order");
  const v0 = (await api(page, "/customers/cus_acme/responders")).version;
  const card = page.getByTestId("co-responders");
  await expect(card.getByTestId("co-cust-person").filter({ hasText: "Minho Lee" })).toHaveCount(1);
  await card.getByTestId("co-resp-edit").click();
  await card.getByRole("button", { name: "Remove Minho Lee from Acme Demo" }).click();
  const dlg = page.getByTestId("confirm-dialog");
  await expect(dlg).toBeVisible();
  await page.waitForTimeout(READ);
  await dlg.getByRole("button", { name: "Remove Minho Lee from Acme Demo" }).click();
  await expect(page.getByTestId("toast")).toContainText("Minho Lee removed");
  const after = await api(page, "/customers/cus_acme/responders");
  expect(after.version).toBe(v0 + 1);
  expect(after.people.map((p: { contactId: string }) => p.contactId)).not.toContain("ct_acme_minho");
  expect(JSON.stringify(after)).not.toContain("minho@acme.example");
});
