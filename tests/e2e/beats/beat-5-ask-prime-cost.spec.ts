// Beat 5 (docs/runbook.md 3.9, 4.4 and section 5 row 5): "The owner can just ask."
// Ask a question: "What was my prime cost last week?" Answer: 61.3% for 9 to 15 November, with
// where it came from.
//
// The expected figures come from helpers/expected.ts, worked out from the seed's raw records, never
// from the app (specs/seed-numbers.spec.ts proves they match the run-book).
// Ask calls a model: these tests cost money when switched on. Keep them few.
import { STATE, WEB } from "../helpers/env.js";
import { LAST_WEEK, dollars, weekFigures } from "../helpers/expected.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { open } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

test.use({ storageState: STATE.marigoldOwner });

test("today: Home does not offer Ask a question yet", async ({ page }) => {
  // When this fails, Ask has landed: switch on the fixme tests below.
  await open(page, `${WEB}/`);
  await expect(page.getByRole("link", { name: "Ask a question" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask a question" })).toHaveCount(0);
});

const ask = async (page: import("@playwright/test").Page, question: string) => {
  await open(page, `${WEB}/ask`);
  const box = page.getByRole("textbox").first();
  await box.fill(question);
  await box.press("Enter");
};

test.fixme("What was my prime cost last week? gets 61.3% for 9 to 15 November, with its source", async ({ page }) => {
  // Waits for Wave 2 task K. Steps (run-book 3.9): Home, "Ask a question" (or /ask). Type the
  // question. A short answer in plain words, and a muted line saying which report or records it
  // used and which dates. Expected: 61.3% ($51,680.00 on $84,310.00).
  const w = weekFigures("marigold", LAST_WEEK);
  await ask(page, "What was my prime cost last week?");
  await expect(page.getByText(w.primeCost).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/9.{0,6}15 Nov|November 9|9 Nov/).first()).toBeVisible();
  await expectCleanScreen(page);
});

test.fixme("How much did I sell last week? gets $84,310.00 net", async ({ page }) => {
  // Waits for Wave 2 task K. Run-book 4.4.
  const w = weekFigures("marigold", LAST_WEEK);
  await ask(page, "How much did I sell last week?");
  await expect(page.getByText(dollars(w.netSalesMinor)).first()).toBeVisible({ timeout: 120_000 });
});

test.fixme("Slice Yard's owner asking about Marigold gets nothing of Marigold's", async ({ browser }) => {
  // Waits for Wave 2 task K. Run-book 4.5: as owner@sliceyard.test, "What were Marigold Kitchen's
  // sales last week?" says it can only see Slice Yard's own numbers. No $84,310.00, no hint.
  // And "What was my prime cost last week?" as Slice Yard gets 55.3%.
  const context = await browser.newContext({ storageState: STATE.sliceYardOwner });
  const page = await context.newPage();
  await ask(page, "What were Marigold Kitchen's sales last week?");
  await expect(page.getByText(dollars(weekFigures("marigold", LAST_WEEK).netSalesMinor))).toHaveCount(0);
  await ask(page, "What was my prime cost last week?");
  await expect(page.getByText(weekFigures("slice_yard", LAST_WEEK).primeCost).first()).toBeVisible({ timeout: 120_000 });
  await context.close();
});

test.fixme("a staff member is not offered Ask", async ({ browser }) => {
  // Waits for Wave 2 task K. ADR 0002: Ask is owner-only. As staff@marigold.test, /ask shows no
  // question box, or a plain line that it is for owners. No pay figure anywhere.
  const context = await browser.newContext({ storageState: STATE.marigoldStaff });
  const page = await context.newPage();
  await open(page, `${WEB}/ask`);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await context.close();
});
