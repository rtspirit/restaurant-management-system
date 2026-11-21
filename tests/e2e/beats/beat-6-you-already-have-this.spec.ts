// Beat 6 (docs/runbook.md 3.10 and section 5 row 6): "And it doesn't build the same thing twice."
// Build tab. Type the exact opening prompt again. "You already have this" with three choices.
import { STATE, WEB } from "../helpers/env.js";
import { open } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

test.use({ storageState: STATE.marigoldOwner });

test("today: the Build tab lists no mini-apps of the owner's yet", async ({ page }) => {
  // When this fails, mini-apps are listed: beat 6 can be rehearsed once beat 2 builds one.
  await open(page, `${WEB}/mini-apps`);
  await expect(page.getByText("No mini-apps yet")).toBeVisible();
});

test.fixme("the same request, word for word, gets You already have this with three choices", async ({ page }) => {
  // Waits for Wave 2 task M, and for beat 2 to have built the accounts mini-app in the same run.
  // Steps (run-book 3.10): type EXACTLY "I want to see how much money I'm making" again (the same
  // words match first, with no model call). Expected: "You already have this", the mini-app's
  // name, a plain reason ("It already shows ..."), and three choices: open it, add to it, build a
  // separate one anyway.
  await open(page, `${WEB}/mini-apps`);
  const box = page.getByRole("textbox", { name: "Say what you need" });
  await box.fill("I want to see how much money I'm making");
  await box.press("Enter");
  await expect(page.getByText("You already have this")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: /open/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /add to it/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /separate/i })).toBeVisible();
});
