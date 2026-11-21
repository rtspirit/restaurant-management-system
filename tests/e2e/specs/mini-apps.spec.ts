// The Mini-apps area: Build and Marketplace tabs render, in plain words, on both screen sizes.
import { STATE, WEB } from "../helpers/env.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { open } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

for (const [who, state] of [["Marigold owner", STATE.marigoldOwner], ["Slice Yard owner", STATE.sliceYardOwner]] as const) {
  test.describe(who, () => {
    test.use({ storageState: state });

    test("the Build tab invites the owner to say what they need", async ({ page }) => {
      const text = await open(page, `${WEB}/mini-apps`);
      expect(text).toMatch(/build/i);
      expect(text).toMatch(/marketplace/i);
      expect(text).toContain("What do you want to build?");
      await expect(page.getByRole("textbox", { name: "Say what you need" })).toBeVisible();
      for (const idea of ["See how much money I’m making", "Count the till at close", "Keep track of what I owe suppliers"]) {
        await expect(page.getByRole("button", { name: idea })).toBeVisible();
      }
      await expectCleanScreen(page);
    });

    test("pressing an idea fills the box", async ({ page }) => {
      await open(page, `${WEB}/mini-apps`);
      await page.getByRole("button", { name: "See how much money I’m making" }).click();
      await expect(page.getByRole("textbox", { name: "Say what you need" })).toHaveValue("See how much money I’m making");
    });

    test("the Marketplace tab renders", async ({ page }) => {
      const text = await open(page, `${WEB}/mini-apps/marketplace`);
      expect(text).toContain("Recommended for you");
      await expectCleanScreen(page);
    });

    test("Settings renders", async ({ page }) => {
      const text = await open(page, `${WEB}/settings`);
      expect(text).toContain("Settings");
      await expectCleanScreen(page);
    });

    test("an address that does not exist says so plainly", async ({ page, consoleWatch }) => {
      consoleWatch.allow(/status of 404/);
      const res = await page.goto(`${WEB}/no-such-screen`);
      expect(res?.status()).toBe(404);
      await expectCleanScreen(page);
    });
  });
}
