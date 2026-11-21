// Beat 1 (docs/runbook.md 3.1, 3.2 and section 5 row 1):
// "A new owner signs up and answers five questions. RMS already knows their menu, staff and locations."
// Sign up live, answer "Table service", land in a Marigold Kitchen of their own: 40 menu items,
// 24 staff, Downtown and Riverside. Then the first screen of beat 2: Mini-apps, Build.
//
// Signs up ONE new owner per run (desktop only: sign-ups count against the sign-in limit) with a
// fictional address e2e-<random>@rms.test and a random password that is thrown away, and removes
// the user and their restaurant afterwards, whatever happened.
import { randomBytes } from "node:crypto";
import { adminDb, closeAll } from "@rms/db";
import { removeSuiteSignUps, suiteUsers } from "../helpers/cleanup.js";
import { CONSOLE, SIGNUP_DOMAIN, SIGNUP_PREFIX, STATE, WEB } from "../helpers/env.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { open, settle, words } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

const email = `${SIGNUP_PREFIX}${randomBytes(5).toString("hex")}@${SIGNUP_DOMAIN}`;

test.describe("beat 1: a new owner signs up and finds their restaurant ready", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "One sign-up per run, on the desktop (sign-ups are rate limited)."));
  test.afterAll(async ({}, info) => {
    if (info.project.name !== "desktop") return;
    try {
      await removeSuiteSignUps([email]);
    } finally {
      await closeAll();
    }
  });

  test("sign up, answer the five questions, land on Home with menu, staff and locations already there", async ({ page, consoleWatch }) => {
    test.setTimeout(150_000);
    const password = randomBytes(18).toString("base64url");

    await open(page, `${WEB}/sign-up`);
    await expectCleanScreen(page);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.locator("#confirm").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/onboarding"), { timeout: 30_000 });

    const next = () => page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("heading", { name: "What is your restaurant called?" })).toBeVisible();
    await expectCleanScreen(page);
    await page.locator("#restaurantName").fill("Larkspur Table (e2e)");
    await next();
    await expect(page.getByRole("heading", { name: "How do guests order?" })).toBeVisible();
    await page.getByLabel("Table service: guests order from a server").check();
    await next();
    await expect(page.getByRole("heading", { name: "What kind of food do you serve?" })).toBeVisible();
    await page.locator("#cuisine").fill("Modern American");
    await next();
    await expect(page.getByRole("heading", { name: "How many locations do you have?" })).toBeVisible();
    await page.locator("#locationCount").fill("2");
    await next();
    await expect(page.getByRole("heading", { name: "Which of these do you use today?" })).toBeVisible();
    await page.getByLabel("Square").check();
    await expectCleanScreen(page);
    // The API answers 503 when the shared database already holds 25 restaurants (other agents'
    // tests make them too): the page then says it could not set up the restaurant. Fail fast with
    // what the page said rather than waiting out the clock.
    consoleWatch.allow(/status of 503/);
    const answered = page.waitForResponse((res) => new URL(res.url()).pathname === "/auth/onboarding" && res.request().method() === "POST", { timeout: 90_000 });
    await page.getByRole("button", { name: "Finish" }).click();
    const res = await answered;
    // The API's error code and plain message (never a token): says why, when it refuses.
    const why = res.ok() ? "" : await res.json().then((b: { error?: { code?: string; message?: string } }) => `${b.error?.code}: ${b.error?.message}`).catch(() => "");
    expect(res.status(), `Onboarding was refused (${res.status()} ${why}). at_capacity means the shared database already holds 25 restaurants.`).toBeLessThan(300);
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    await settle(page);

    // Home: "Hello", the restaurant's name, "No mini-apps yet", Build a mini-app, Look in the Marketplace.
    const home = await words(page);
    expect(home).toContain("Hello");
    expect(home).toContain("Marigold Kitchen");
    expect(home).not.toContain("Slice Yard");
    expect(home).toContain("No mini-apps yet");
    await expect(page.getByRole("link", { name: "Build a mini-app" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Look in the Marketplace" })).toBeVisible();
    await expectCleanScreen(page);

    const menu = await open(page, `${WEB}/menu`);
    expect(menu).toContain("40 items in 6 groups");
    expect(menu).toContain("Hanger Steak Frites");
    await expectCleanScreen(page);

    const staff = await open(page, `${WEB}/staff`);
    expect(staff).toContain("24 people at 2 locations");
    expect(staff).toContain("Hourly rate");
    await expectCleanScreen(page);

    const places = await open(page, `${WEB}/locations`);
    expect(places).toContain("Downtown");
    expect(places).toContain("Riverside");
    expect(places).not.toContain("Mill Street");
    await expectCleanScreen(page);

    // Beat 2's first screen: Build a mini-app, from Home.
    await page.goto(`${WEB}/`);
    await page.getByRole("link", { name: "Build a mini-app" }).click();
    await page.waitForURL((url) => url.pathname === "/mini-apps");
    await expect(page.getByText("What do you want to build?")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Say what you need" })).toBeVisible();
    await expectCleanScreen(page);
  });

  test("the new restaurant shows in the maintainer's change feed", async ({ browser }) => {
    // Run-book 3.13: "Each new sign-up adds one more row."
    const [user] = (await suiteUsers()).filter((u) => u.email === email);
    expect(user, "the sign-up made a user").toBeTruthy();
    const [org] = await adminDb()<{ id: string }[]>`select org_id as id from platform.members where user_id = ${user!.id}`;
    expect(org, "the sign-up made a restaurant").toBeTruthy();
    const tail = org!.id.replace(/-/g, "").slice(-6);

    const context = await browser.newContext({ storageState: STATE.maintainer });
    const page = await context.newPage();
    await page.goto(`${CONSOLE}/`);
    const feed = page.getByRole("list", { name: "Changes, newest first" });
    const row = feed.getByRole("listitem").filter({ hasText: `(${tail})` });
    await expect(row.first()).toBeVisible();
    await expect(row.first()).toContainText("Marigold Kitchen");
    await context.close();
  });
});
