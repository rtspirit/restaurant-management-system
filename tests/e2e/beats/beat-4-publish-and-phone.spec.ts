// Beat 4 (docs/runbook.md 3.8 and section 5 row 4): "Publish, and it's part of RMS, on the phone too."
// Publish, confirm. Open it from the RMS menu. Show it on the phone. A mini-app always opens INSIDE
// RMS (ADR 0008); opened on its own it shows "Open this from RMS".
//
// This file runs on both projects. The phone project (390x844) is the "phone" of the demo.
import { STATE, WEB } from "../helpers/env.js";
import { expectCleanScreen, expectNoSidewaysScroll } from "../helpers/page-checks.js";
import { open } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

test.use({ storageState: STATE.marigoldOwner });

test("today: no mini-app is published yet, and Home says so plainly on this screen size", async ({ page }) => {
  // When this fails (a mini-app shows on Home), publishing has landed: switch on the fixme tests below.
  const text = await open(page, `${WEB}/`);
  expect(text).toContain("No mini-apps yet");
  await expectCleanScreen(page);
});

test("today: every RMS screen fits a phone without sideways scroll", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "Phone-size only.");
  for (const path of ["/", "/mini-apps", "/mini-apps/marketplace", "/menu", "/staff", "/locations", "/settings"]) {
    await open(page, `${WEB}${path}`);
    await expectNoSidewaysScroll(page);
  }
});

test.fixme("Publish puts the mini-app in the RMS menu", async ({ page }) => {
  // Waits for Wave 3. Steps (run-book 3.8):
  // 1. In the build conversation press "Publish". RMS says in one sentence what will happen. Confirm.
  // 2. The mini-app appears in the RMS menu (and on Home, under "Your mini-apps").
  // 3. The console's change feed shows the first publish as T2 major.
  await open(page, `${WEB}/mini-apps`);
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByRole("button", { name: /confirm|publish/i }).last().click();
  await expect(page.getByRole("navigation").getByRole("link", { name: /money|accounts/i })).toBeVisible();
});

test.fixme("on a phone the published mini-app opens inside RMS and fits the screen", async ({ page }, info) => {
  // Waits for Wave 3. Phone project only. Sign in to RMS on the phone, open the mini-app from the
  // menu: it shows inside the RMS frame, no sideways scroll, numbers readable.
  test.skip(info.project.name !== "phone", "Phone-size only.");
  await open(page, `${WEB}/`);
  await page.getByRole("link", { name: /money|accounts/i }).first().click();
  await expect(page.frameLocator("iframe").first().locator("body")).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test.fixme("a mini-app opened on its own says to open it from RMS", async ({ page }) => {
  // Waits for Wave 3 (ADR 0008). Open the mini-app's own address (rms-apps) directly, outside
  // RMS: it shows "Open this from RMS" and no data.
  await expect(page.getByText("Open this from RMS")).toBeVisible();
});
