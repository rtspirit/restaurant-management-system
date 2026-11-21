// The maintainer console: the maintainer sees the change feed and the review queue. An owner
// who signs in there sees "This account is not a maintainer." and nothing else.
import { CONSOLE, STATE } from "../helpers/env.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { open, settle, words } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

test.describe("maintainer", () => {
  test.use({ storageState: STATE.maintainer });

  test("the change feed shows changes for both seeded restaurants", async ({ page }) => {
    await page.goto(`${CONSOLE}/`);
    await expect(page.getByRole("heading", { name: "Change feed" })).toBeVisible();
    await expect(page.getByText("Loading...")).toHaveCount(0);
    const text = await words(page);
    expect(text).toContain("Marigold Kitchen");
    expect(text).toContain("Slice Yard");
    expect(text).toMatch(/T[0-3] (cosmetic|minor|major|platform)/);
    await expectCleanScreen(page, "maintainer");
  });

  test("the tier filter narrows the feed", async ({ page }) => {
    await page.goto(`${CONSOLE}/`);
    await expect(page.getByRole("heading", { name: "Change feed" })).toBeVisible();
    await expect(page.getByText("Loading...")).toHaveCount(0);
    await page.getByLabel("Tier").selectOption({ label: "T1 minor" });
    await page.getByRole("button", { name: "Apply filters" }).click();
    const feed = page.getByRole("list", { name: "Changes, newest first" });
    // Either rows that are all T1, or the plain "nothing matches" line.
    await expect
      .poll(async () => {
        if (await page.getByText("Loading...").count()) return "loading";
        if (await page.getByText("No changes match these filters.").count()) return "T1 minor"; // nothing else showing
        const tags = await feed.getByText(/^T[0-3] (cosmetic|minor|major|platform)$/).allInnerTexts();
        return [...new Set(tags)].join(", ");
      })
      .toBe("T1 minor");
    await expectCleanScreen(page, "maintainer");
  });

  test("the review queue renders", async ({ page }) => {
    await page.goto(`${CONSOLE}/queue`);
    await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
    await expect(page.getByText("Loading...")).toHaveCount(0);
    expect(await words(page)).toContain("Changes held until a maintainer approves them");
    await expectCleanScreen(page, "maintainer");
  });
});

test.describe("an owner in the console", () => {
  test.use({ storageState: STATE.ownerInConsole });

  test("is told plainly they are not a maintainer, and sees no change at all", async ({ page, consoleWatch }) => {
    // The console's own requests are refused with 403: the browser logs each one.
    consoleWatch.allow(/status of 403/);
    const statuses: number[] = [];
    page.on("response", (res) => {
      if (new URL(res.url()).pathname.startsWith("/admin/")) statuses.push(res.status());
    });
    for (const path of ["/", "/queue"]) {
      await page.goto(`${CONSOLE}${path}`);
      await settle(page);
      await expect(page.getByText("This account is not a maintainer.").first()).toBeVisible();
      const text = await words(page);
      expect(text).not.toContain("Slice Yard");
      expect(text).not.toContain("Standard records");
      await expect(page.getByRole("list", { name: /Changes|Waiting for a maintainer/ })).toHaveCount(0);
      // The filter form (with its tier names) stays on screen for an owner; only the rows are checked here.
      await expectCleanScreen(page, "maintainer");
    }
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses.every((s) => s === 403), `console requests answered ${statuses.join(", ")}`).toBe(true);
  });
});

test.describe("signed out", () => {
  test("the console sends a signed-out visitor to sign-in", async ({ page }) => {
    const text = await open(page, `${CONSOLE}/`);
    expect(new URL(page.url()).pathname).toMatch(/^\/sign-in/);
    expect(text).toContain("Sign in");
  });
});
