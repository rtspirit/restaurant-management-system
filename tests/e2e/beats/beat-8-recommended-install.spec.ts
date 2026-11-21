// Beat 8 (docs/runbook.md 3.12 and section 5 row 8): "A pizza place across town."
// Slice Yard's owner opens the Marketplace: "Recommended for you" with a reason. Install. Open.
// Slice Yard's own numbers only: $28,750.00 and 55.3% for the week of 9 November. Never $84,310.
import { STATE, WEB } from "../helpers/env.js";
import { LAST_WEEK, dollars, weekFigures } from "../helpers/expected.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { open } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

test.use({ storageState: STATE.sliceYardOwner });

test("today: the Marketplace says Nothing to recommend yet", async ({ page }) => {
  // When this fails, the Marketplace has listings: switch on the fixme tests below.
  const text = await open(page, `${WEB}/mini-apps/marketplace`);
  expect(text).toContain("Recommended for you");
  expect(text).toContain("Nothing to recommend yet");
  await expectCleanScreen(page);
});

test.fixme("the accounts mini-app is recommended with a reason, installs, and shows only Slice Yard's numbers", async ({ page }) => {
  // Waits for Wave 3, and for beat 7 to have approved the share. Steps (run-book 3.12):
  // 1. As owner@sliceyard.test (or a new "Counter service" sign-up), Mini-apps, Marketplace.
  // 2. Under "Recommended for you" the accounts mini-app shows with a plain reason (wording not
  //    confirmed). Press Install. Open it.
  // 3. Week of 9 to 15 November 2026: net sales $28,750.00, food and drink $8,150.00 (28.3%),
  //    staff $7,743.00 (26.9%), prime cost 55.3%. Never $84,310 or anything of Marigold's.
  const mine = weekFigures("slice_yard", LAST_WEEK);
  const theirs = weekFigures("marigold", LAST_WEEK);
  await open(page, `${WEB}/mini-apps/marketplace`);
  const card = page.getByRole("article").filter({ hasText: /money|accounts/i }).first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /install/i }).click();
  await page.getByRole("link", { name: /money|accounts/i }).first().click();
  const app = page.frameLocator("iframe").first();
  await expect(app.getByText(dollars(mine.netSalesMinor)).first()).toBeVisible({ timeout: 60_000 });
  await expect(app.getByText(mine.primeCost).first()).toBeVisible();
  await expect(app.getByText(dollars(theirs.netSalesMinor))).toHaveCount(0);
  await expect(app.getByText("Marigold")).toHaveCount(0);
});

test.fixme("the listing never names the restaurant it came from", async ({ page }) => {
  // Waits for Wave 3. Run-book 3.11: the listing never names the restaurant.
  await open(page, `${WEB}/mini-apps/marketplace`);
  await expect(page.getByText("Marigold")).toHaveCount(0);
  await expect(page.getByText("Downtown")).toHaveCount(0);
});
