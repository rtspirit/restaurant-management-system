// Checkpoint C1 walkthrough, in a real browser (Playwright, headless Chromium).
//
// Signs in as both demo owners, looks at Home, the location switcher, Mini-apps (Build and
// Marketplace), Menu, Staff and Locations on a desktop and a phone, signs a brand-new owner up
// through the five onboarding questions, and opens the maintainer console. It CHECKS what it
// sees (the right restaurant, nothing of the other one, staff pay hidden from staff, an owner
// kept out of the console) and saves screenshots to docs/design/c1/.
//
// Before running: `pnpm build`, `pnpm reset-demo`, and the API (8787), the web app (3000) and
// the console (3001) running locally. See docs/briefs/wave1-integration-notes.md.
//   pnpm c1-walkthrough
//
// Local only. It uses the seeded demo users and DEMO_PASSWORD from the settings file, and never
// prints a password. The new owner's password is random and is thrown away.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, type Page, chromium } from "@playwright/test";
import { loadTestEnv } from "@rms/db/testing";

loadTestEnv();
const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing setting ${name}`);
  return v;
};
const WEB = need("WEB_URL").replace(/\/$/, "");
const ADMIN = need("ADMIN_URL").replace(/\/$/, "");
const DEMO_PASSWORD = need("DEMO_PASSWORD");
for (const url of [WEB, ADMIN, need("NEXT_PUBLIC_API_URL"), need("SUPABASE_URL")]) {
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error("The walkthrough only runs against this computer");
}

const OUT = join(import.meta.dirname, "..", "docs", "design", "c1");
mkdirSync(OUT, { recursive: true });

const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;
type Size = keyof typeof SIZES;

const checks: string[] = [];
const check = (ok: boolean, what: string): void => {
  if (!ok) throw new Error(`CHECK FAILED: ${what}`);
  checks.push(what);
};

const shot = async (page: Page, name: string, fullPage = false): Promise<void> => {
  // Let web fonts and any last paint settle, so two runs give the same picture.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  // A whole-page picture only makes sense on a desktop: on a phone the bottom bar is pinned to
  // the screen, so it would be drawn across the middle of a tall picture.
  const phone = (page.viewportSize()?.width ?? 1440) < 700;
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: fullPage && !phone });
};

/** Waits for the page to go quiet. Some pages keep a connection open, so this gives up politely. */
const settle = async (page: Page): Promise<void> => {
  await page.waitForLoadState("load");
  await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
};

const signIn = async (page: Page, base: string, email: string, password: string): Promise<void> => {
  await page.goto(`${base}/sign-in`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 20_000 });
  await settle(page);
};

const open = async (page: Page, base: string, path: string): Promise<string> => {
  await page.goto(`${base}${path}`);
  await settle(page);
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
};

/** The colour everything pressable takes, as the shell set it for this restaurant. */
const themeOf = (page: Page): Promise<string> => page.evaluate(() => document.querySelector(".rms-theme")?.getAttribute("style") ?? "");

type Restaurant = {
  slug: "marigold" | "sliceyard";
  name: string;
  owner: string;
  staff: string;
  locations: string[];
  /** Words that belong to the OTHER restaurant and must never show here. */
  foreign: string[];
  /** One thing from this restaurant's own menu and team. */
  dish: string;
  staffCount: number;
};

const MARIGOLD: Restaurant = {
  slug: "marigold", name: "Marigold Kitchen", owner: "owner@marigold.test", staff: "staff@marigold.test",
  locations: ["Downtown", "Riverside"], foreign: ["Slice Yard", "Mill Street", "sliceyard"], dish: "Bar", staffCount: 24,
};
const SLICE_YARD: Restaurant = {
  slug: "sliceyard", name: "Slice Yard", owner: "owner@sliceyard.test", staff: "staff@sliceyard.test",
  locations: ["Mill Street"], foreign: ["Marigold", "Downtown", "Riverside"], dish: "Pizzas", staffCount: 9,
};

const themes: Record<string, string> = {};

/** One owner, one screen size: every C1 screen, checked and photographed. */
const ownerTour = async (browser: Browser, r: Restaurant, size: Size): Promise<void> => {
  const context = await browser.newContext(SIZES[size]);
  const page = await context.newPage();
  const seen: string[] = [];
  const visit = async (path: string) => {
    const words = await open(page, WEB, path);
    seen.push(words);
    return words;
  };

  await signIn(page, WEB, r.owner, DEMO_PASSWORD);
  const home = await visit("/");
  check(home.includes(r.name), `${r.slug} ${size}: Home shows ${r.name}`);
  themes[r.slug] = await themeOf(page);
  await shot(page, `${r.slug}-home-${size}`);

  // The location switcher: a restaurant with one location has nothing to switch between.
  const switcher = page.getByLabel("Location").locator("visible=true");
  if (r.locations.length > 1) {
    const options = await switcher.first().locator("option").allInnerTexts();
    check(JSON.stringify(options) === JSON.stringify(["All locations", ...r.locations]), `${r.slug} ${size}: the switcher lists All locations, ${r.locations.join(" and ")}`);
    await switcher.first().selectOption({ label: r.locations[1] as string });
    await switcher.first().focus();
  } else {
    check((await switcher.count()) === 0, `${r.slug} ${size}: one location, so no switcher`);
  }
  await shot(page, `${r.slug}-location-switcher-${size}`);

  const build = await visit("/mini-apps");
  check(/build/i.test(build) && /marketplace/i.test(build), `${r.slug} ${size}: Mini-apps has Build and Marketplace`);
  await shot(page, `${r.slug}-mini-apps-build-${size}`);
  await visit("/mini-apps/marketplace");
  await shot(page, `${r.slug}-mini-apps-marketplace-${size}`);

  const menu = await visit("/menu");
  check(menu.includes(r.dish) && /\$\d+\.\d\d/.test(menu), `${r.slug} ${size}: Menu shows its groups and prices`);
  await shot(page, `${r.slug}-menu-${size}`, true);

  const staff = await visit("/staff");
  check(staff.includes(`${r.staffCount} people`), `${r.slug} ${size}: Staff shows ${r.staffCount} people`);
  check(staff.includes("Hourly rate") && staff.includes("Email"), `${r.slug} ${size}: the owner sees pay and contact details`);
  await shot(page, `${r.slug}-staff-${size}`, true);

  const places = await visit("/locations");
  for (const l of r.locations) check(places.includes(l), `${r.slug} ${size}: Locations shows ${l}`);
  check(places.includes("Opening hours") && places.includes("Day ends at"), `${r.slug} ${size}: Locations shows hours and when the day ends`);
  await shot(page, `${r.slug}-locations-${size}`, true);

  const all = seen.join(" ");
  for (const word of r.foreign) check(!all.toLowerCase().includes(word.toLowerCase()), `${r.slug} ${size}: nothing of the other restaurant ("${word}")`);

  if (size === "desktop") {
    // Sign out for real, and make sure the door is shut behind us.
    await page.goto(`${WEB}/`);
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.waitForURL((url) => url.pathname.startsWith("/sign-in"), { timeout: 20_000 });
    await page.goto(`${WEB}/staff`);
    await settle(page);
    check(new URL(page.url()).pathname.startsWith("/sign-in"), `${r.slug}: after signing out, Staff sends you to sign-in`);
  }
  await context.close();
};

/** A staff member: the team list without pay or contact details, and only their own location. */
const staffTour = async (browser: Browser): Promise<void> => {
  const context = await browser.newContext(SIZES.desktop);
  const page = await context.newPage();
  await signIn(page, WEB, MARIGOLD.staff, DEMO_PASSWORD);
  const staff = await open(page, WEB, "/staff");
  check(!staff.includes("Hourly rate") && !staff.includes("Email") && !/\$\d/.test(staff), "marigold staff user: no pay or contact details on the Staff screen");
  check(staff.includes("Downtown") && !staff.includes("Riverside"), "marigold staff user: sees the Downtown team only");
  await shot(page, "marigold-staff-as-staff-desktop", true);
  const places = await open(page, WEB, "/locations");
  check(places.includes("Downtown") && !places.includes("Riverside"), "marigold staff user: sees the Downtown location only");
  await context.close();
};

/** A brand-new owner: sign-up, the five questions (counter service), and a new Slice Yard of their own. */
const newOwnerTour = async (browser: Browser): Promise<void> => {
  const context = await browser.newContext(SIZES.desktop);
  const page = await context.newPage();
  const email = `walkthrough-${randomBytes(5).toString("hex")}@c1.rms.test`;
  const password = randomBytes(18).toString("base64url");

  await page.goto(`${WEB}/sign-up`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator("#confirm").fill(password);
  await shot(page, "newowner-sign-up-desktop");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/onboarding"), { timeout: 20_000 });

  const next = () => page.getByRole("button", { name: "Next" }).click();
  const question = async (n: number, title: string) => {
    await page.getByRole("heading", { name: title }).waitFor();
    check(true, `new owner: question ${n} is "${title}"`);
  };
  await question(1, "What is your restaurant called?");
  await page.locator("#restaurantName").fill("Corner Slice (walkthrough)");
  await shot(page, "newowner-onboarding-1-desktop");
  await next();
  await question(2, "How do guests order?");
  await page.getByLabel("Counter service: guests order at the counter").check();
  await shot(page, "newowner-onboarding-2-desktop");
  await next();
  await question(3, "What kind of food do you serve?");
  await page.locator("#cuisine").fill("Pizza");
  await shot(page, "newowner-onboarding-3-desktop");
  await next();
  await question(4, "How many locations do you have?");
  await page.locator("#locationCount").fill("1");
  await shot(page, "newowner-onboarding-4-desktop");
  await next();
  await question(5, "Which of these do you use today?");
  await page.getByLabel("Square").check();
  await shot(page, "newowner-onboarding-5-desktop");
  await page.getByRole("button", { name: "Finish" }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 60_000 });
  await settle(page);

  const home = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check(home.includes("Slice Yard") && !home.includes("Marigold"), "new owner: lands in a Slice Yard");
  await shot(page, "newowner-home-desktop");
  const staff = await open(page, WEB, "/staff");
  check(staff.includes("9 people") && staff.includes("Hourly rate"), "new owner: their own Slice Yard has its team, and they are its owner");
  const places = await open(page, WEB, "/locations");
  check(places.includes("Mill Street") && !places.includes("Downtown"), "new owner: their own Slice Yard has its one location");
  await page.setViewportSize(SIZES.phone.viewport);
  await open(page, WEB, "/");
  await shot(page, "newowner-home-phone");
  await context.close();
};

/** The maintainer console: the feed and the queue. Then an owner tries the same door. */
const consoleTour = async (browser: Browser): Promise<void> => {
  for (const size of ["desktop", "phone"] as const) {
    const context = await browser.newContext(SIZES[size]);
    const page = await context.newPage();
    await signIn(page, ADMIN, "maintainer@rms.test", DEMO_PASSWORD);
    await page.getByRole("heading", { name: "Change feed" }).waitFor();
    await settle(page);
    const feed = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check(feed.includes("Marigold Kitchen") && feed.includes("Slice Yard"), `console ${size}: the feed shows changes for both restaurants`);
    await shot(page, `console-feed-${size}`, true);
    await page.goto(`${ADMIN}/queue`);
    await page.getByRole("heading", { name: "Review queue" }).waitFor();
    await settle(page);
    await shot(page, `console-queue-${size}`, true);
    await context.close();
  }

  const context = await browser.newContext(SIZES.desktop);
  const page = await context.newPage();
  const refused: number[] = [];
  page.on("response", (res) => {
    if (new URL(res.url()).pathname.startsWith("/admin/")) refused.push(res.status());
  });
  await signIn(page, ADMIN, MARIGOLD.owner, DEMO_PASSWORD);
  await page.getByText("This account is not a maintainer.").first().waitFor({ timeout: 20_000 });
  const feed = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check(!feed.includes("Slice Yard") && !feed.includes("Standard records"), "an owner in the console sees no changes at all");
  await shot(page, "console-owner-refused-desktop");
  await page.goto(`${ADMIN}/queue`);
  await page.getByText("This account is not a maintainer.").first().waitFor({ timeout: 20_000 });
  check(refused.length >= 2 && refused.every((s) => s === 403), "every console request an owner makes is refused (403)");
  await context.close();
};

const browser = await chromium.launch();
let failed = false;
try {
  for (const r of [MARIGOLD, SLICE_YARD]) for (const size of ["desktop", "phone"] as const) await ownerTour(browser, r, size);
  check(themes.marigold !== "" && themes.sliceyard !== "" && themes.marigold !== themes.sliceyard, "each restaurant has its own brand colour");
  await staffTour(browser);
  await newOwnerTour(browser);
  await consoleTour(browser);
} catch (e) {
  failed = true;
  console.error(e instanceof Error ? e.message : "The walkthrough failed");
} finally {
  await browser.close();
}
console.log(`${checks.length} checks passed.`);
for (const c of checks) console.log(`  ok  ${c}`);
console.log(`Brand colours as set by the shell:\n  Marigold Kitchen: ${themes.marigold ?? ""}\n  Slice Yard: ${themes.sliceyard ?? ""}`);
console.log(failed ? "C1 WALKTHROUGH: NOT YET" : `C1 WALKTHROUGH: PASS. Screenshots are in ${OUT}`);
process.exitCode = failed ? 1 : 0;
