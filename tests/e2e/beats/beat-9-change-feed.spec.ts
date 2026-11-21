// Beat 9 (docs/runbook.md 3.13 and section 5 row 9): "Everything that just happened, for us."
// Console, Change feed. Filter by tier. Built today: the feed and its filters. The rows from beats
// 2 to 8 arrive with Waves 2 and 3.
import { CONSOLE, STATE } from "../helpers/env.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { words } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

test.use({ storageState: STATE.maintainer });

const TIERS = ["T0 cosmetic", "T1 minor", "T2 major", "T3 platform"];
const STATUSES = ["Applied", "Waiting for owner", "Waiting for us", "Approved", "Rejected"];

test("the feed shows each seeded restaurant's Standard records change, newest first", async ({ page }) => {
  await page.goto(`${CONSOLE}/`);
  const feed = page.getByRole("list", { name: "Changes, newest first" });
  for (const name of ["Marigold Kitchen", "Slice Yard"]) {
    const row = feed.getByRole("listitem").filter({ hasText: name }).filter({ hasText: '"Standard records"' });
    await expect(row.first()).toBeVisible();
    await expect(row.first()).toContainText("T1 minor");
    await expect(row.first()).toContainText("Applied");
  }
  // Newest first: each row's time is no later than the one above it.
  const times = await feed.locator("time").evaluateAll((els) => els.map((e) => Date.parse(e.getAttribute("datetime") ?? "")));
  for (let i = 1; i < times.length; i++) expect(times[i]!).toBeLessThanOrEqual(times[i - 1]!);
  await expectCleanScreen(page, "maintainer");
});

test("every tier and every status can be filtered on, and each answer is plain", async ({ page }) => {
  await page.goto(`${CONSOLE}/`);
  await expect(page.getByRole("list", { name: "Changes, newest first" })).toBeVisible();
  expect(await page.getByLabel("Tier").locator("option").allInnerTexts()).toEqual(["All tiers", ...TIERS]);
  expect(await page.getByLabel("Status").locator("option").allInnerTexts()).toEqual(["Any status", ...STATUSES]);
  for (const tier of TIERS) {
    await page.getByLabel("Tier").selectOption({ label: tier });
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect
      .poll(async () => {
        if (await page.getByText("Loading...").count()) return "loading";
        if (await page.getByText("No changes match these filters.").count()) return tier;
        const tags = await page.getByRole("list", { name: "Changes, newest first" }).getByText(/^T[0-3] (cosmetic|minor|major|platform)$/).allInnerTexts();
        return [...new Set(tags)].join(", ");
      }, `filter ${tier}`)
      .toBe(tier);
    await expectCleanScreen(page, "maintainer");
  }
  expect(await words(page)).not.toContain("Something went wrong");
});

test.fixme("after a full run the feed shows the build, the connection, the publish, the share and the install", async ({ page }) => {
  // Waits for Waves 2 and 3 and for beats 2 to 8 to run first in the same run. Run-book 3.13:
  // - the accounts mini-app's model and screen changes: T2 major (it touches money fields)
  // - the Demo POS connection: T2 major
  // - the first publish: T2 major
  // - the public share: T3 platform, Approved
  // - the install at the second restaurant (tier not confirmed)
  // Filter by "T2 major": only the T2 rows. Filter by "T3 platform": the share, Approved.
  await page.goto(`${CONSOLE}/`);
  await page.getByLabel("Tier").selectOption({ label: "T2 major" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  const feed = page.getByRole("list", { name: "Changes, newest first" });
  await expect(feed.getByRole("listitem").filter({ hasText: "Marigold Kitchen" })).toHaveCount(3);
  await page.getByLabel("Tier").selectOption({ label: "T3 platform" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(feed.getByRole("listitem").filter({ hasText: "Approved" }).first()).toBeVisible();
});
