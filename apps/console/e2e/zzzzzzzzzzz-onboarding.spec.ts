// Customer onboarding (#63): the wizard, the connection kit and check, the customer's people and the public verification page,
// on the mock API (src/lib/api/mock/onboarding-mock.ts documents the account-id suffixes and the demo tokens). This file runs
// last (name) because it adds customers to the shared mock store.
import { test, expect, type Page, type Browser } from "@playwright/test";
import { appReady } from "./helpers/ready";

const signIn = async (page: Page, next: string, as = "admin") => {
  await page.goto(`/auth/dev-login?as=${as}&next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("networkidle");
  await appReady(page);
};
const noHScroll = async (page: Page, where: string) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `horizontal scroll: ${where}`).toBeLessThanOrEqual(0);

async function newCustomer(page: Page, name: string, domains = "") {
  await page.goto("/customers/new");
  await appReady(page);
  await page.getByTestId("nc-name").fill(name);
  if (domains) await page.getByTestId("nc-domains").fill(domains);
  await page.getByTestId("nc-save").click();
}
async function addAccount(page: Page, id: string, caps: ("alarmWriter" | "tagWriter" | "remediator")[] = []) {
  await expect(page.getByTestId("account-form")).toBeVisible();
  await page.getByTestId("ac-id").fill(id);
  for (const c of caps) await page.getByTestId(`ac-cap-${c}`).locator("input").check();
  await page.getByTestId("ac-save").click();
  await expect(page.getByTestId("conn-panel")).toHaveAttribute("data-account", id);
}
const checkNow = async (page: Page) => {
  await page.getByTestId("check-btn").click();
  await expect(page.getByTestId("check-status")).toHaveAttribute("data-phase", /queuing|checking/);
};

test.describe.configure({ mode: "serial" });

test.describe("wizard, 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("happy path: customer, organization, account, kit, check, people, finish", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page, "/customers");
    await page.getByTestId("new-customer").click();
    await expect(page).toHaveURL(/\/customers\/new$/);
    await expect(page.locator("h1")).toHaveText("New customer");
    await expect(page.getByTestId("ob-steps").locator('[aria-current="step"]')).toHaveText(/Customer/);

    await page.getByTestId("nc-name").fill("Oak Systems");
    await page.getByTestId("nc-domains").fill("oak.example, pay.oak.example");
    await page.getByTestId("nc-save").click();
    await expect(page).toHaveURL(/\/customers\/oak-systems\/onboarding$/);
    await expect(page.locator("h1")).toHaveText("Oak Systems");
    await expect(page.getByTestId("ob-steps").locator('[aria-current="step"]')).toHaveText(/Organization/);

    // organization
    await page.getByTestId("org-project").fill("Core");
    await page.getByTestId("org-service").fill("Payments API");
    await expect(page.getByTestId("org-save")).toHaveText("Save organization for Oak Systems");
    await page.getByTestId("org-save").click();
    await expect(page.getByTestId("org-saved")).toContainText("Project “Core” and service “Payments API” saved");
    await expect(page.getByTestId("org-item")).toContainText("Payments API");
    await page.getByTestId("org-next").click();

    // account (capabilities off by default, Remediator carries the warning)
    await expect(page.getByTestId("ob-steps").locator('[aria-current="step"]')).toHaveText(/AWS account/);
    for (const c of ["alarmWriter", "tagWriter", "remediator"]) await expect(page.getByTestId(`ac-cap-${c}`).locator("input")).not.toBeChecked();
    await expect(page.getByTestId("ac-remediator-warning")).toContainText("stop EC2 and RDS instances and delete load balancers");
    await page.getByTestId("ac-alias").fill("oak-prod");
    await page.getByTestId("ac-env").selectOption("PRD");
    await page.getByTestId("ac-svc").selectOption({ label: "Core › Payments API" });
    await addAccount(page, "123456789401", ["alarmWriter"]);

    // the kit
    const ext = (await page.getByTestId("kit-ExternalId-value").textContent())!;
    expect(ext).toMatch(/^ao-[0-9a-f]{64}$/);
    for (const n of ["CentralRoleArn", "ExternalId", "CentralEventBusArn", "EnableAlarmWriter", "EnableTagWriter", "EnableRemediator"]) await expect(page.getByTestId(`kit-${n}`)).toBeVisible();
    await expect(page.getByTestId("kit-EnableAlarmWriter-value")).toHaveText("true");
    await expect(page.getByTestId("kit-EnableTagWriter-value")).toHaveText("false");
    await expect(page.getByTestId("kit-RemediatorCallerRoleArn")).toHaveCount(0);
    await expect(page.getByTestId("kit-CentralRoleArn-value")).toHaveText(/^arn:aws:iam::\d{12}:role\//);
    await expect(page.getByTestId("kit-incomplete")).toHaveCount(0);
    await expect(page.getByTestId("kit-CentralEventBusArn-value")).toHaveText(/^arn:aws:events:ap-northeast-2:\d{12}:event-bus\//);
    await page.getByTestId("kit-ExternalId-copy").click();
    await expect(page.getByTestId("kit-copy-state")).toHaveText("Copied ExternalId");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ext);
    await expect(page.getByTestId("al-account_id-value")).toHaveText("123456789401");
    await expect(page.getByTestId("al-action-value")).toHaveText("add");
    await expect(page.getByTestId("next-steps")).toContainText("bus-allowlist");
    expect(page.url(), "no value in the address").not.toContain(ext);
    expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain(ext);

    // check, with a visible "checking" state, then the per-role table
    await checkNow(page);
    await expect(page.getByTestId("check-btn")).toHaveText("Checking…");
    await expect(page.getByTestId("role-reader")).toContainText("Checking…");
    await expect(page.getByTestId("check-btn")).toHaveText("Check connection", { timeout: 20_000 });
    await expect(page.getByTestId("role-reader")).toContainText("OK");
    await expect(page.getByTestId("role-eventForwarder")).toContainText("OK · events received");
    await expect(page.getByTestId("role-alarmWriter")).toContainText("OK");
    await expect(page.getByTestId("role-tagWriter")).toContainText("Not enabled");
    await expect(page.getByTestId("role-remediator")).toContainText("Not enabled");
    await expect(page.getByTestId("check-status")).toHaveText("Connected.");
    await expect(page.getByTestId("last-checked")).toContainText("Last checked 2026-");

    // people: add, masked values, e-mail link, SMS has no sender (503) -> manual
    // words stay whole in the table at 1440
    for (const k of ["reader", "eventForwarder", "alarmWriter", "remediator"]) expect(await page.getByTestId(`role-${k}`).locator("td").first().evaluate((el) => getComputedStyle(el).whiteSpace), k).toBe("nowrap");
    await page.getByTestId("conn-next").click();
    // after a step change the focus is on the step heading, and the step is announced
    await expect(page.getByTestId("step-heading")).toBeFocused();
    await expect(page.getByTestId("step-announce")).toHaveText("Step 5 of 5: People");
    await page.getByTestId("ct-name").fill("Yuna Seo");
    await page.getByTestId("ct-email").fill("yuna.seo@oak.example");
    await page.getByTestId("ct-phone").fill("010-1234-4821");
    await page.getByTestId("ct-save").click();
    const person = page.getByTestId("contact-item").filter({ hasText: "Yuna Seo" });
    await expect(person.getByTestId("contact-email")).toHaveText("y•••@oak.example");
    await expect(person.getByTestId("contact-phone")).toHaveText("010-••••-4821");
    await expect(page.locator("body")).not.toContainText("yuna.seo@oak.example");
    await expect(page.getByTestId("ct-email")).toHaveValue("");
    await expect(page.getByTestId("needs-count")).toContainText("1");
    await person.getByTestId("send-EMAIL").click();
    await expect(person.getByTestId("ch-EMAIL")).toHaveAttribute("data-status", "LINK_SENT");
    await expect(person.getByTestId("ch-EMAIL-state")).toContainText("Link sent");
    await person.getByTestId("send-SMS").click();
    await expect(person.getByTestId("contact-msg")).toContainText("Links cannot be sent yet");
    await expect(person.getByTestId("manual-form")).toBeVisible();
    await person.getByTestId("manual-confirm").click();
    await expect(person.getByTestId("contact-msg")).toContainText("Say how you checked");
    await person.getByTestId("manual-note").fill("Confirmed by phone with Yuna");
    await person.getByTestId("manual-confirm").click();
    await expect(person.getByTestId("ch-SMS")).toHaveAttribute("data-status", "VERIFIED");
    await expect(person.getByTestId("ch-SMS")).toContainText("by hand");

    // bulk send asks first and lists the targets
    await page.getByTestId("ct-name").fill("Joon Han");
    await page.getByTestId("ct-email").fill("joon.han@oak.example");
    await page.getByTestId("ct-save").click();
    await expect(page.getByTestId("needs-count")).toContainText("2");
    await page.getByTestId("bulk-open").click();
    await expect(page.getByTestId("bulk-targets")).toContainText("Joon Han: E-mail");
    await expect(page.getByTestId("bulk-targets")).toContainText("Yuna Seo");
    await page.getByTestId("confirm-dialog").locator('button[data-role="confirm"]').click();
    await expect(page.getByTestId("bulk-result")).toContainText("link");
    await expect(page.getByTestId("contact-item").filter({ hasText: "Joon Han" }).getByTestId("ch-EMAIL")).toHaveAttribute("data-status", "LINK_SENT");

    // finish: the summary, then the customer page shows the connection
    await expect(page.getByTestId("setup-account")).toHaveAttribute("data-conn", "CONNECTED");
    await page.getByTestId("finish").click();
    await expect(page).toHaveURL(/\/customers\/oak-systems$/);
    await expect(page.getByTestId("conn-account")).toHaveAttribute("data-conn", "CONNECTED");
    await expect(page.getByTestId("conn-account")).toContainText("123 456 789 401");
  });

  test("resumable: leaving and coming back shows the same kit and result", async ({ page }) => {
    await signIn(page, "/customers/oak-systems");
    await page.getByTestId("conn-open").click();
    await expect(page).toHaveURL(/\/customers\/oak-systems\/onboarding\?step=connection$/);
    await expect(page.getByTestId("kit-ExternalId-value")).toHaveText(/^ao-[0-9a-f]{64}$/);
    await expect(page.getByTestId("role-reader")).toContainText("OK");
    await expect(page.getByTestId("last-checked")).toContainText("Last checked 2026-");
    await page.goto("/customers/oak-systems/onboarding");
    await expect(page.getByTestId("ob-steps").locator('[aria-current="step"]')).toHaveText(/Connection/);
    await page.getByTestId("ob-step-people").click();
    await expect(page.getByTestId("contact-item")).toHaveCount(2);
    await page.getByTestId("ob-step-organization").click();
    await expect(page.getByTestId("org-item")).toContainText("Core");
  });

  test("copy falls back to selecting the text when the clipboard refuses", async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true }); });
    await signIn(page, "/customers/oak-systems/onboarding?step=connection");
    await page.getByTestId("kit-ExternalId-copy").click();
    await expect(page.getByTestId("kit-copy-state")).toContainText("It is selected");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toMatch(/^ao-[0-9a-f]{64}$/);
  });

  test("a kit with missing central values says so and cannot be copied whole", async ({ page }) => {
    await signIn(page, "/customers/new");
    await newCustomer(page, "No Central Co");
    await expect(page).toHaveURL(/no-central-co\/onboarding$/);
    await page.getByTestId("org-next").click();
    await addAccount(page, "123456789421");
    await expect(page.getByTestId("kit-incomplete")).toContainText("This kit is not complete: 2 values are still missing. Fill them in before you send it.");
    await expect(page.getByTestId("kit-incomplete")).toContainText("deploy-central");
    await expect(page.getByTestId("kit-CentralRoleArn-copy")).toBeDisabled();
    await expect(page.getByTestId("kit-CentralEventBusArn-copy")).toBeDisabled();
    await expect(page.getByTestId("kit-CentralRoleArn-placeholder")).toContainText("Missing");
    await expect(page.getByTestId("kit-all-copy")).toBeDisabled();
    await expect(page.getByTestId("kit-all-why")).toContainText("2 values are missing");
    await expect(page.getByTestId("kit-ExternalId-copy")).toBeEnabled();
    await page.getByTestId("cap-remediator").locator("input").click();
    await page.getByTestId("confirm-dialog").locator('button[data-role="confirm"]').click();
    await expect(page.getByTestId("kit-incomplete")).toContainText("3 values are still missing");
  });

  test("duplicate customer links to the existing one; a free-mail login domain is refused; a bad domain is caught first", async ({ page }) => {
    await signIn(page, "/customers/new");
    await newCustomer(page, "mirae pay");
    await expect(page.getByTestId("nc-error")).toContainText("A customer with this name already exists");
    await expect(page.getByTestId("nc-existing")).toHaveAttribute("href", "/customers/cus_mirae");
    await page.getByTestId("nc-existing").click();
    await expect(page.locator("h1")).toHaveText("Mirae Pay");

    await page.goto("/customers/new");
    await newCustomer(page, "Pine Works", "gmail.com");
    await expect(page.getByTestId("nc-error")).toContainText("A public mail domain (such as gmail.com or naver.com) cannot be a login domain");
    await expect(page).toHaveURL(/\/customers\/new$/);
    await page.getByTestId("nc-domains").fill("not a domain!");
    await page.getByTestId("nc-save").click();
    await expect(page.getByTestId("nc-error")).toContainText("is not a domain");
    await page.getByTestId("nc-domains").fill("oak.example");
    await page.getByTestId("nc-save").click();
    await expect(page.getByTestId("nc-error")).toContainText("Another customer already uses one of these login domains");
  });

  test("bad account id, duplicate account, failing optional role, cooldown, no command queue", async ({ page }) => {
    await signIn(page, "/customers/new");
    await newCustomer(page, "Birch Ltd");
    await expect(page).toHaveURL(/birch-ltd\/onboarding$/);
    await page.getByTestId("org-next").click(); // skip the organization
    await page.getByTestId("ac-id").fill("12345");
    await page.getByTestId("ac-save").click();
    await expect(page.getByTestId("ac-error")).toContainText("exactly 12 digits");
    await page.getByTestId("ac-id").fill("123456789401"); // Oak's account
    await page.getByTestId("ac-save").click();
    await expect(page.getByTestId("ac-error")).toContainText("already registered");

    await addAccount(page, "123456789402", ["alarmWriter", "tagWriter"]);
    await checkNow(page);
    await expect(page.getByTestId("check-btn")).toHaveText("Check connection", { timeout: 20_000 });
    await expect(page.getByTestId("role-reader")).toContainText("OK");
    await expect(page.getByTestId("role-alarmWriter")).toContainText("Failed · access denied");
    await expect(page.getByTestId("role-alarmWriter")).toContainText("Enable AlarmWriter".replace(" ", "") + "=true");
    await expect(page.getByTestId("role-tagWriter")).toContainText("OK");
    await expect(page.getByTestId("fail-summary")).toContainText("1 role failed");
    await expect(page.getByTestId("check-status")).toContainText("Connected. 1 optional role is not working.");

    // a second check inside 30 s: 429, said as a time, no countdown
    await page.getByTestId("check-btn").click();
    await expect(page.getByTestId("check-error")).toContainText(/You can check again at \d\d:\d\d:\d\d KST/);
    await expect(page.getByTestId("check-btn")).toBeEnabled();

    // capability toggles after saving; Remediator asks first
    await page.getByTestId("cap-tagWriter").locator("input").click();
    await expect(page.getByTestId("cap-status")).toContainText("TagWriter is now off");
    await expect(page.getByTestId("kit-EnableTagWriter-value")).toHaveText("false");
    await page.getByTestId("cap-remediator").locator("input").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText("Turn on Remediator");
    await page.getByTestId("confirm-dialog").locator('button[data-role="cancel"]').click();
    await expect(page.getByTestId("cap-remediator").locator("input")).not.toBeChecked();
    await page.waitForTimeout(700);
    await page.getByTestId("cap-remediator").locator("input").click();
    await page.getByTestId("confirm-dialog").locator('button[data-role="confirm"]').click();
    await expect(page.getByTestId("kit-RemediatorCallerRoleArn")).toBeVisible();
    await expect(page.getByTestId("kit-EnableRemediator-value")).toHaveText("true");

    // the other failures: trust policy rejected (403), stack missing (404), no command queue (503)
    await page.getByTestId("ob-step-account").click();
    await addAccount(page, "123456789403");
    await checkNow(page);
    await expect(page.getByTestId("check-btn")).toHaveText("Check connection", { timeout: 20_000 });
    await expect(page.getByTestId("role-reader")).toContainText("Trust policy rejects our role");
    await expect(page.getByTestId("role-eventForwarder")).toContainText("Waiting for the first event");
    await page.getByTestId("ob-step-account").click();
    await addAccount(page, "123456789404");
    await checkNow(page);
    await expect(page.getByTestId("check-btn")).toHaveText("Check connection", { timeout: 20_000 });
    await expect(page.getByTestId("role-reader")).toContainText("Failed · role not found");
    await page.getByTestId("ob-step-account").click();
    await addAccount(page, "123456789503");
    await page.getByTestId("check-btn").click();
    await expect(page.getByTestId("check-error")).toContainText("Connection checks are not available yet");
    await expect(page.getByTestId("check-btn")).toBeEnabled();
  });
});

test.describe("public verification page", () => {
  const fresh = async (browser: Browser, viewport: { width: number; height: number }) => {
    const context = await browser.newContext({ viewport }); // no cookies: nobody is signed in
    return { context, page: await context.newPage() };
  };

  for (const [name, viewport, token] of [["1440", { width: 1440, height: 900 }, "vf_demo_email_1"], ["390", { width: 390, height: 844 }, "vf_demo_email_2"]] as const) {
    test(`pending, then confirmed, then the same link is expired (${name})`, async ({ browser }) => {
      const { context, page } = await fresh(browser, viewport);
      const res = await page.goto(`/verify/${token}`);
      expect(res?.status()).toBe(200);
      expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
      expect(res?.headers()["cache-control"]).toContain("no-store");
      expect(res?.headers()["x-robots-tag"]).toBe("noindex, nofollow"); // and the global strict-origin-when-cross-origin did not win
      await expect(page.getByTestId("verify-pending")).toContainText("e-mail address");
      await expect(page.locator("body")).not.toContainText("@"); // the channel only, never the address
      await noHScroll(page, `verify ${name}`);
      expect((await page.getByTestId("verify-confirm").boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // looking again changes nothing (a scanner opening the link does not use it up)
      await page.reload();
      await expect(page.getByTestId("verify-confirm")).toBeVisible();
      await page.getByTestId("verify-confirm").click();
      await expect(page.getByTestId("verify-done")).toContainText("Your e-mail address is confirmed");
      expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain(token);
      await page.reload();
      await expect(page.getByTestId("verify-expired")).toContainText("expired or was already used");
      await noHScroll(page, `verify expired ${name}`);
      await context.close();
    });
  }

  test("an unknown, used or malformed link is one calm state; nothing else is reachable without a session", async ({ browser }) => {
    const { context, page } = await fresh(browser, { width: 390, height: 844 });
    for (const t of ["vf_demo_used", "vf_does_not_exist", "x".repeat(300)]) {
      const r = await page.goto(`/verify/${t}`);
      // 300 characters is not a token at all: the middleware does not treat it as the public path
      if (t.length > 200) { expect(page.url()).toContain("/login"); continue; }
      expect(r?.status()).toBe(200);
      await expect(page.getByTestId("verify-expired")).toBeVisible();
    }
    await page.goto("/customers/new");
    await expect(page).toHaveURL(/\/login/);
    await context.close();
  });

  test("a link requested in the console is not guessable from the page and SMS has its own token", async ({ browser }) => {
    const { context, page } = await fresh(browser, { width: 1440, height: 900 });
    await page.goto("/verify/vf_demo_sms_1");
    await expect(page.getByTestId("verify-pending")).toContainText("phone number");
    await page.getByTestId("verify-confirm").click();
    await expect(page.getByTestId("verify-done")).toContainText("phone number is confirmed");
    await context.close();
  });
});

test.describe("phone 390", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("wizard steps have no horizontal scroll and 44px targets; the result table turns into cards", async ({ page }) => {
    await signIn(page, "/customers/new");
    await noHScroll(page, "new customer");
    await newCustomer(page, "Larch Co", "larch.example");
    await expect(page).toHaveURL(/larch-co\/onboarding$/);
    await noHScroll(page, "organization");
    await page.getByTestId("org-next").click();
    await noHScroll(page, "account");
    await addAccount(page, "123456789412", ["alarmWriter", "remediator"]);
    await noHScroll(page, "kit");
    expect((await page.getByRole("link", { name: "Back to the customer" }).boundingBox())!.height, "Back link").toBeGreaterThanOrEqual(44);
    await checkNow(page);
    await expect(page.getByTestId("check-btn")).toHaveText("Check connection", { timeout: 20_000 });
    await noHScroll(page, "check result");
    expect(await page.getByTestId("role-table").locator("thead").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("role-alarmWriter").locator("td").first()).toBeVisible();
    for (const id of ["check-btn", "kit-ExternalId-copy"]) expect((await page.getByTestId(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(44);
    await page.getByTestId("conn-next").click();
    await noHScroll(page, "people");
    await page.getByTestId("ct-name").fill("Mina Oh");
    await page.getByTestId("ct-phone").fill("010-5555-0199");
    await page.getByTestId("ct-save").click();
    await expect(page.getByTestId("contact-item")).toContainText("010-••••-0199");
    await noHScroll(page, "people list");
    for (const id of ["send-SMS", "manual-SMS", "ct-save"]) expect((await page.getByTestId(id).first().boundingBox())!.height, id).toBeGreaterThanOrEqual(44);
  });

  test("a non-admin sees the steps read-only and no New customer button", async ({ page }) => {
    await signIn(page, "/customers", "operator");
    await expect(page.getByTestId("new-customer")).toHaveCount(0);
    await page.goto("/customers/new");
    await expect(page.getByTestId("ob-role-note")).toContainText("needs the Admin role");
    await expect(page.getByTestId("nc-save")).toBeDisabled();
  });
});
