// Signing in and out of the web app, as an owner would. These are the only tests besides
// global-setup.ts that use the sign-in form, so they run on the desktop project only.
import { STATE, USERS, WEB, demoPassword } from "../helpers/env.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { open, settle, signIn, signInThroughForm, words } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

test.describe("sign-in and sign-out", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "Sign-in form tests run once, on the desktop (sign-ins are rate limited)."));

  test("the sign-in page is plain and offers sign-up", async ({ page }) => {
    const text = await open(page, `${WEB}/sign-in`);
    expect(text).toContain("Sign in");
    expect(text).toContain("Create an account");
    await expectCleanScreen(page);
  });

  test("a signed-out visitor who opens a restaurant screen is sent to sign-in", async ({ page }) => {
    for (const path of ["/", "/staff", "/menu", "/mini-apps", "/settings"]) {
      await page.goto(`${WEB}${path}`);
      await settle(page);
      expect(new URL(page.url()).pathname, `${path} without signing in`).toMatch(/^\/sign-in/);
    }
  });

  test("a wrong password shows a plain message and does not sign in", async ({ page, consoleWatch }) => {
    // The sign-in service answers a wrong password with a 400, which the browser logs as a failed request.
    consoleWatch.allow(/Failed to load resource: the server responded with a status of 400/);
    // A made-up password: never the real one, and a seeded email so the message is the real path.
    await signInThroughForm(page, WEB, USERS.sliceYardStaff, `wrong-${Date.now()}`);
    await expect(page.getByText("That email and password do not match. Please try again.")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/sign-in");
    await expectCleanScreen(page);
  });

  test("an owner signs in, sees their restaurant, signs out, and the door is shut behind them", async ({ page }) => {
    await signIn(page, WEB, USERS.sliceYardOwner, demoPassword());
    expect(new URL(page.url()).pathname).toBe("/");
    const home = await words(page);
    expect(home).toContain("Hello");
    expect(home).toContain("Slice Yard");
    await expectCleanScreen(page);

    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.waitForURL((url) => url.pathname.startsWith("/sign-in"));
    await page.goto(`${WEB}/staff`);
    await settle(page);
    expect(new URL(page.url()).pathname).toMatch(/^\/sign-in/);
    expect(await words(page)).not.toContain("Gianna Holloway");
  });
});

test.describe("a saved session", () => {
  test.use({ storageState: STATE.marigoldOwner });

  test("opening sign-in while signed in does not show anyone else's restaurant", async ({ page }) => {
    const text = await open(page, `${WEB}/`);
    expect(text).toContain("Marigold Kitchen");
    expect(text).not.toContain("Slice Yard");
  });
});
