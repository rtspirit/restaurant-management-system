// Checks phone mode the way a phone sees it, from this laptop: opens the phone address (never
// 127.0.0.1, so the page is NOT a secure context, like on a real phone), signs in as the seeded
// Marigold owner, reaches home, opens Menu, signs out. Any browser request to this laptop's own
// loopback address is blocked and counted, because a phone could not reach it.
//
//   node scripts/demo-phone-check.mjs            (phone mode must be running: scripts/demo-phone.sh)
//   BROWSERS=chromium,webkit node scripts/demo-phone-check.mjs
//
// The password is DEMO_PASSWORD from .env.local. It is read here and typed into the page. It is
// never printed, logged or stored.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { chromium, devices, webkit } from "@playwright/test";

const root = new URL("..", import.meta.url).pathname;
const phone = parseEnv(readFileSync(`${root}.env.phone`, "utf8"));
const password = parseEnv(readFileSync(`${root}.env.local`, "utf8")).DEMO_PASSWORD;
if (!password) throw new Error("DEMO_PASSWORD is not set in .env.local");
const origin = phone.WEB_URL;
const apiUrl = phone.NEXT_PUBLIC_API_URL;
// The other name of this laptop: where the mini-app host lives. Cookies set on the shell's host
// must not be readable there. The web server answers on every name, so its own pages stand in
// for the mini-app host when that is not built yet.
const otherHost = phone.APPS_URL ? new URL(phone.APPS_URL).hostname : null;
const otherPage = otherHost ? `http://${otherHost}:${new URL(origin).port}/gallery` : null;
if (!origin || /127\.0\.0\.1|localhost/.test(origin)) throw new Error("Phone mode is not running (no phone address in .env.phone)");
const consolePort = process.env.CONSOLE_PORT ?? "3001";

const PROFILES = {
  chromium: { engine: chromium, context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  webkit: { engine: webkit, context: { ...devices["iPhone 13"] } },
};
const wanted = (process.env.BROWSERS ?? "chromium,webkit").split(",");

let failed = false;
for (const name of wanted) {
  const profile = PROFILES[name];
  const steps = [];
  const blocked = [];
  const problems = [];
  let browser;
  try {
    browser = await profile.engine.launch();
  } catch {
    console.log(`${name}: SKIPPED (browser not installed for Playwright)`);
    continue;
  }
  try {
    const context = await browser.newContext(profile.context);
    await context.route(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//, (route) => {
      blocked.push(new URL(route.request().url()).origin);
      return route.abort();
    });
    const page = await context.newPage();
    const consoleHits = [];
    let probing = false;
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.port === consolePort) consoleHits.push(r.url());
      if (u.hostname === "0.0.0.0") blocked.push(u.origin);
    });
    page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
    page.on("console", (m) => {
      // The deliberate no-token probe below logs its own 401.
      if (m.type() === "error" && !(probing && m.text().includes("401"))) problems.push(`console: ${m.text().slice(0, 160)}`);
    });

    await page.goto(origin, { waitUntil: "networkidle" });
    steps.push(`opened ${new URL(page.url()).pathname}`);
    steps.push(`secure context: ${await page.evaluate(() => window.isSecureContext)}`);

    await page.getByLabel("Email").fill("owner@marigold.test");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => u.pathname === "/", { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    steps.push(`signed in, home: "${(await page.locator("h1").first().textContent())?.trim()}"`);

    probing = true;
    const apiStatus = await page.evaluate(async (u) => (await fetch(`${u}/auth/me`)).status, apiUrl);
    await page.waitForTimeout(200);
    probing = false;
    steps.push(`API from the shell page: answers ${apiStatus} without a token (cross-origin allowed)`);
    if (apiStatus !== 401) problems.push(`the API did not answer the shell page as expected (${apiStatus})`);

    const shellCookies = (await context.cookies(origin)).filter((c) => c.name.startsWith("sb-")).length;
    if (otherPage) {
      const other = await context.newPage();
      await other.goto(otherPage, { waitUntil: "domcontentloaded" });
      const seen = await other.evaluate(() => document.cookie.split(";").filter((c) => c.trim().startsWith("sb-")).length);
      const sent = (await context.cookies(`http://${otherHost}/`)).filter((c) => c.name.startsWith("sb-")).length;
      await other.close();
      steps.push(`sign-in cookies: ${shellCookies} on the shell's host, ${seen} readable and ${sent} sent on ${otherHost}`);
      if (shellCookies === 0) problems.push("no sign-in cookie on the shell's host (the test proves nothing)");
      if (seen + sent > 0) problems.push(`sign-in cookies reach ${otherHost}`);
    }

    await page.getByRole("link", { name: "Menu", exact: true }).filter({ visible: true }).first().click();
    await page.waitForURL((u) => u.pathname === "/menu", { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    steps.push(`menu: "${(await page.locator("h1").first().textContent())?.trim()}"`);

    await page.getByRole("button", { name: "More" }).filter({ visible: true }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL((u) => u.pathname === "/sign-in", { timeout: 30_000 });
    steps.push(`signed out, now on ${page.url()}`);
    if (new URL(page.url()).origin !== origin) problems.push(`sign-out left the phone address for ${new URL(page.url()).origin}`);

    await page.goto(`${origin}/menu`, { waitUntil: "networkidle" });
    steps.push(`after sign-out, /menu goes to ${new URL(page.url()).pathname}`);
    if (new URL(page.url()).pathname !== "/sign-in") problems.push("still signed in after sign-out");
    if (consoleHits.length) problems.push(`the page called the console (${consoleHits.length} requests)`);
    if (blocked.length) problems.push(`requests to this laptop's own loopback address (a phone cannot reach them): ${[...new Set(blocked)].join(", ")}`);
    await context.close();
  } catch (e) {
    problems.push(`stopped: ${e instanceof Error ? e.message.split("\n")[0] : "unknown"}`);
  } finally {
    await browser.close();
  }
  const ok = problems.length === 0;
  failed ||= !ok;
  console.log(`${name}: ${ok ? "PASS" : "FAIL"}\n  ${steps.join("\n  ")}${problems.length ? `\n  problems:\n    ${problems.join("\n    ")}` : ""}`);
}
process.exit(failed ? 1 : 0);
