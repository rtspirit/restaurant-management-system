// Beat 3 (docs/runbook.md 3.7 and section 5 row 3): "They connect their till."
// Settings, Connected systems, Connect Demo POS, Allow, Bring in my sales. Eight weeks arrive and
// the overview reads $84,310.00 and 61.3% for last week.
//
// NOTE for whoever switches this on: the seeded restaurants already have their numbers (the reset
// loads them). A true beat 3 needs a restaurant with none: sign up a new one in the test (as beat
// 1 does, with cleanup) or run on `pnpm reset-demo --no-sales`. Never reset from a test.
import { STATE, WEB } from "../helpers/env.js";
import { LAST_WEEK, dollars, weekFigures } from "../helpers/expected.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { open } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

test.use({ storageState: STATE.marigoldOwner });

test("today: Settings holds only the colour-and-logo placeholder, with no Connected systems yet", async ({ page }) => {
  // When this fails, the connection screen has landed: switch on the fixme tests below.
  const text = await open(page, `${WEB}/settings`);
  expect(text).toContain("Your colour and logo will be set here");
  expect(text).not.toContain("Connected systems");
  expect(text).not.toContain("Connect Demo POS");
  await expectCleanScreen(page);
});

test.fixme("connecting Demo POS lists what it will read, asks first, and brings in eight weeks", async ({ page }) => {
  // Waits for Wave 2 task L. Steps (run-book 3.7):
  // 1. Settings, "Connected systems", press "Connect Demo POS".
  // 2. RMS lists in plain words what it will read (daily sales, payments, ...). Press "Allow".
  // 3. Press "Bring in my sales". Eight weeks, 21 September to 15 November 2026, arrive.
  //    For Marigold: 112 location-days of sales, 128 supplier bills ($204,129.58), 18 stock counts,
  //    32 delivery payouts. Prime cost for the week of 9 November reads 61.3%.
  // 4. Press "Bring in my sales" again: it says there is nothing new, and the numbers do not change.
  const w = weekFigures("marigold", LAST_WEEK);
  await open(page, `${WEB}/settings`);
  await page.getByRole("button", { name: "Connect Demo POS" }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await page.getByRole("button", { name: "Bring in my sales" }).click();
  await expect(page.getByText(dollars(w.netSalesMinor))).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(w.primeCost)).toBeVisible();
  await page.getByRole("button", { name: "Bring in my sales" }).click();
  await expect(page.getByText(/nothing new/i)).toBeVisible();
  await expectCleanScreen(page);
});

test.fixme("if Demo POS changes what it offers, RMS stops and says so", async ({ page }) => {
  // Waits for Wave 2 task L. Run-book 3.7: RMS says
  // "Demo POS changed what it offers. Have a look before RMS reads from it again."
  await open(page, `${WEB}/settings`);
  await expect(page.getByText("Demo POS changed what it offers. Have a look before RMS reads from it again.")).toBeVisible();
});
