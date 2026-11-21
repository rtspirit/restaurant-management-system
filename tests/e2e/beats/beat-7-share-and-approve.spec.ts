// Beat 7 (docs/runbook.md 3.11 and section 5 row 7):
// "The owner shares it with other restaurants. We check it first."
// Owner: share publicly. Console: Review queue, Approve. The request waits as T3, then is approved.
import { CONSOLE, STATE, WEB } from "../helpers/env.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { open, words } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

test.describe("the console's review queue", () => {
  test.use({ storageState: STATE.maintainer });

  test("today: the queue renders, and nothing the demo shares can be in it yet", async ({ page }) => {
    // Other agents' tests may leave held changes here, so this checks the queue answers in plain
    // words rather than that it is empty. Run-book 3.11: with nothing shareable, it is empty after a reset.
    await page.goto(`${CONSOLE}/queue`);
    await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
    await expect(page.getByText("Loading...")).toHaveCount(0);
    const text = await words(page);
    expect(text.includes("Nothing is waiting for review.") || text.includes("Waiting for a maintainer") || /Approve|Reject/.test(text)).toBe(true);
    await expectCleanScreen(page, "maintainer");
  });
});

test.fixme("the owner shares the mini-app publicly and it waits for us as T3", async ({ browser }) => {
  // Waits for Wave 3. Steps (run-book 3.11):
  // 1. As owner@marigold.test, open the accounts mini-app, choose to share it publicly, confirm.
  //    Sharing is private by default; a public share is T3 and waits for a maintainer.
  // 2. As maintainer@rms.test, Review queue: the request shows "T3 platform", "Waiting for us",
  //    restaurant Marigold Kitchen.
  // 3. Press "Approve". The status line says "Approved: Marigold Kitchen, ...". The feed shows it
  //    as Approved.
  // What travels: screens and table shapes only. No data, no connection, the listing never names
  // the restaurant.
  const owner = await browser.newContext({ storageState: STATE.marigoldOwner });
  const ownerPage = await owner.newPage();
  await open(ownerPage, `${WEB}/`);
  await ownerPage.getByRole("button", { name: /share/i }).click();
  await owner.close();

  const maintainer = await browser.newContext({ storageState: STATE.maintainer });
  const page = await maintainer.newPage();
  await page.goto(`${CONSOLE}/queue`);
  const row = page.getByRole("listitem").filter({ hasText: "Marigold Kitchen" }).filter({ hasText: "T3 platform" });
  await expect(row.first()).toContainText("Waiting for us");
  await row.first().getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/^Approved: Marigold Kitchen/)).toBeVisible();
  await maintainer.close();
});
