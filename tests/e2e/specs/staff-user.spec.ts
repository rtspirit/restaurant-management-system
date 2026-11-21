// A staff member (staff@marigold.test, Downtown only): the team list without pay or contact
// details, only their own location, and nothing that is the owner's alone.
import { STATE, WEB } from "../helpers/env.js";
import { expectCleanScreen } from "../helpers/page-checks.js";
import { open } from "../helpers/session.js";
import { expect, test } from "../fixtures.js";

test.use({ storageState: STATE.marigoldStaff });

test("Home names the restaurant and says this is a staff member", async ({ page }) => {
  const text = await open(page, `${WEB}/`);
  expect(text).toContain("Marigold Kitchen");
  expect(text).toContain("Staff");
  await expectCleanScreen(page);
});

test("Staff shows the Downtown team only, with no pay and no contact details", async ({ page }) => {
  const text = await open(page, `${WEB}/staff`);
  expect(text).toContain("14 people at 1 location");
  expect(text).toContain("Downtown");
  expect(text).not.toContain("Riverside");
  expect(text).not.toContain("Hourly rate");
  expect(text).not.toContain("Email");
  expect(text).not.toMatch(/\$\d/);
  expect(text).not.toMatch(/@marigold\.test/);
  await expectCleanScreen(page);
});

test("Locations shows Downtown only", async ({ page }) => {
  const text = await open(page, `${WEB}/locations`);
  expect(text).toContain("Downtown");
  expect(text).not.toContain("Riverside");
  expect(text).not.toContain("Wharf Road");
  await expectCleanScreen(page);
});

test("no location switcher offers Riverside", async ({ page }) => {
  await open(page, `${WEB}/`);
  const options = await page.getByLabel("Location").locator("visible=true").locator("option").allInnerTexts();
  expect(options.join(" ")).not.toContain("Riverside");
});

test("pay never reaches a staff member's browser, whatever the screen", async ({ page }) => {
  const bodies: string[] = [];
  page.on("response", async (res) => {
    if (new URL(res.url()).pathname.startsWith("/auth/parent/")) bodies.push(await res.text().catch(() => ""));
  });
  for (const path of ["/", "/menu", "/staff", "/locations"]) await open(page, `${WEB}${path}`);
  const page2 = (await page.content()).toLowerCase();
  for (const word of ["hourly_rate", "pay_rate", "wage", "salary"]) {
    expect(page2, `the page source carries "${word}"`).not.toContain(word);
    for (const b of bodies) expect(b.toLowerCase(), `an API answer carries "${word}"`).not.toContain(word);
  }
});

// Waits for Wave 2: the build, Ask and connection routes are owner-only (docs/briefs/wave2.md,
// "Wave 2 routes are owner-only: a staff role gets forbidden"). Today the Build tab is still a stub
// that anyone signed in can type into, and it builds nothing.
test.fixme("a staff member is not offered Build, Ask or Connected systems", async ({ page }) => {
  // Expected once Wave 2 lands:
  // 1. Open /mini-apps as staff@marigold.test: no "What do you want to build?" box, or a plain
  //    line saying building is for owners.
  // 2. Open /ask: no question box, or a plain line saying Ask is for owners (ADR 0002).
  // 3. Open /settings: no "Connect Demo POS".
  await open(page, `${WEB}/mini-apps`);
  await expect(page.getByText("What do you want to build?")).toHaveCount(0);
});
