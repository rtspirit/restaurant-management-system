// Beat 2 (docs/runbook.md 3.5, 3.6, 4.1 and section 5 row 2):
// "Now the owner asks for what they actually want."
// Mini-apps, Build. Type "I want to see how much money I'm making". Answer up to three questions.
// Press Build it. The live preview appears with sample numbers.
import { STATE, WEB } from "../helpers/env.js";
import { LAST_WEEK, dollars, weekFigures } from "../helpers/expected.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { open } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

test.use({ storageState: STATE.marigoldOwner });

const OPENING = "I want to see how much money I'm making";

test("today: the Build tab is a stub that says plainly it builds nothing", async ({ page }) => {
  // When this fails, the build conversation has landed: switch on the fixme tests below.
  await open(page, `${WEB}/mini-apps`);
  const box = page.getByRole("textbox", { name: "Say what you need" });
  await box.fill(OPENING);
  await box.press("Enter");
  await expect(page.getByText("Thanks. Building is not switched on yet, so nothing has been made or changed.")).toBeVisible();
  await expect(page.getByText(OPENING)).toBeVisible();
  await expectCleanScreen(page);
});

test.fixme("the owner asks for the accounts mini-app and gets questions, a plan and a live preview", async ({ page }) => {
  // Waits for Wave 2 (build conversation, sandbox, preview). The accounts mini-app itself is Wave 4.
  // Steps (run-book 3.5 and 4.1):
  // 1. /mini-apps, type the opening prompt, press send.
  // 2. RMS asks at most three short questions. Answer with the run-book's table:
  //    "Both together, and let me switch between Downtown and Riverside."
  //    "Every week. My week runs Monday to Sunday."
  //    "Food and drink, and staff. We count stock every Sunday night after close."
  // 3. Cards "Here's what I'll build" and "What I assumed" appear. Press "Build it".
  //    The plan names: a money overview for the week, sales day by day, a weekly profit and loss,
  //    prime cost by week; it reuses the standard records (no new tables for sales, bills, staff
  //    cost, stock counts). Assumed: weeks Monday to Sunday, day ends 4am, prime cost = food and
  //    drink + staff, Sunday stock counts, US dollars.
  // 4. Progress in plain words ("Setting up", "Building the screen", "Checking it works"); a Stop
  //    button replaces the box while it works.
  // 5. The preview appears beside the conversation with a "Sample numbers" tag.
  // Expected numbers in the preview, if the draft copy holds the eight weeks (not confirmed):
  // net sales $84,310.00, food and drink $25,460.00 (30.2%), staff $26,220.00 (31.1%), prime cost 61.3%.
  const w = weekFigures("marigold", LAST_WEEK);
  await open(page, `${WEB}/mini-apps`);
  await page.getByRole("textbox", { name: "Say what you need" }).fill(OPENING);
  await page.getByRole("textbox", { name: "Say what you need" }).press("Enter");
  await expect(page.getByText("Here's what I'll build")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("What I assumed")).toBeVisible();
  await page.getByRole("button", { name: "Build it" }).click();
  await expect(page.getByText("Sample numbers")).toBeVisible({ timeout: 300_000 });
  const preview = page.frameLocator("iframe").first();
  await expect(preview.getByText(dollars(w.netSalesMinor))).toBeVisible();
  await expect(preview.getByText(w.primeCost)).toBeVisible();
  await expectCleanScreen(page);
});

test.fixme("follow-ups change the preview: money in day by day, then prime cost with a 62% target", async ({ page }) => {
  // Waits for Wave 2 (and the accounts mini-app, Wave 4).
  // Run-book 4.1 step 1: "Show me what I took each day last week."
  //   Mon 9 Nov $8,140.00, Tue $8,960.00, Wed $9,870.00, Thu $11,420.00, Fri $15,830.00,
  //   Sat 14 Nov $17,950.00 (the biggest), Sun $12,140.00. Total $84,310.00.
  // Run-book 4.1 step 4: "Show my prime cost each week and warn me if it goes over 62%."
  //   Last week 61.3%, under the target. Only 19 October (64.1%) goes over.
  const w = weekFigures("marigold", LAST_WEEK);
  const preview = page.frameLocator("iframe").first();
  for (const day of w.daily) await expect(preview.getByText(dollars(day))).toBeVisible();
  await expect(preview.getByText("64.1%")).toBeVisible();
});

test.fixme("the vendor list (checkpoint C2) builds from a prompt and reuses the standard supplier record", async ({ page }) => {
  // Waits for Wave 2. Run-book 3.5 and 4.2.
  // Type "I need a list of my suppliers with their phone numbers." The preview lists Marigold's four
  // suppliers: Lanterbury Greengrocers Co-op, Quillfield Meat and Seafood, Pellbrook Beverage Supply,
  // Tidewell Paper and Cleaning, each with 14 days to pay. No new table is made (feed: no new_model).
  await open(page, `${WEB}/mini-apps`);
  await page.getByRole("textbox", { name: "Say what you need" }).fill("I need a list of my suppliers with their phone numbers.");
  await page.getByRole("textbox", { name: "Say what you need" }).press("Enter");
  const preview = page.frameLocator("iframe").first();
  for (const v of ["Lanterbury Greengrocers Co-op", "Quillfield Meat and Seafood", "Pellbrook Beverage Supply", "Tidewell Paper and Cleaning"]) {
    await expect(preview.getByText(v)).toBeVisible({ timeout: 300_000 });
  }
});

test.fixme("asking to change a menu price is refused plainly and changes nothing", async ({ page }) => {
  // Waits for Wave 2. Run-book 4.5: "Make the Marigold Burger $24 instead of $22."
  // A good answer says menu prices are kept by RMS and cannot be changed from a mini-app, and
  // offers something it can do. /menu still shows Marigold Burger $22.00.
  await open(page, `${WEB}/menu`);
  await expect(page.getByText("$22.00").first()).toBeVisible();
});
