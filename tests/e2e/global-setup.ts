// Runs once before the browser suite.
//
// 1. Checks the three servers answer (a plain message if one does not).
// 2. Removes anything an interrupted run left behind (e2e-* sign-ups and their restaurants).
// 3. Signs each seeded user in ONCE through the real form and saves the browser state for the
//    tests to reuse. A state saved in the last 20 minutes that still works is reused instead,
//    which keeps three runs in a row well under the sign-in limit (30 per five minutes).
import { existsSync, mkdirSync, statSync } from "node:fs";
import { type Browser, chromium } from "@playwright/test";
import { closeAll } from "@rms/db";
import { removeSuiteSignUps } from "./helpers/cleanup.js";
import { API, AUTH_DIR, CONSOLE, STATE, USERS, WEB, demoPassword } from "./helpers/env.js";
import { settle, signIn } from "./helpers/session.js";

const FRESH_MS = 20 * 60_000;

const answers = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return res.status < 500;
  } catch {
    return false;
  }
};

/** A saved state still opens the app without bouncing to sign-in. */
const stillWorks = async (browser: Browser, file: string, base: string): Promise<boolean> => {
  if (!existsSync(file) || Date.now() - statSync(file).mtimeMs > FRESH_MS) return false;
  const context = await browser.newContext({ storageState: file });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await settle(page);
    const path = new URL(page.url()).pathname;
    const text = await page.locator("body").innerText();
    return !path.startsWith("/sign-in") && !/Signing you out/.test(text);
  } catch {
    return false;
  } finally {
    await context.close();
  }
};

const save = async (browser: Browser, file: string, base: string, email: string): Promise<void> => {
  if (await stillWorks(browser, file, base)) return;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, base, email, demoPassword());
    await context.storageState({ path: file });
  } finally {
    await context.close();
  }
};

export default async function globalSetup(): Promise<void> {
  const down = [];
  for (const [name, url] of [["API", `${API}/health`], ["web app", `${WEB}/sign-in`], ["console", `${CONSOLE}/sign-in`]] as const) {
    if (!(await answers(url))) down.push(`${name} (${url})`);
  }
  if (down.length > 0) throw new Error(`Not answering: ${down.join(", ")}. Start the servers (see docs/runbook.md section 2) and try again.`);

  try {
    await removeSuiteSignUps();
  } finally {
    await closeAll();
  }

  mkdirSync(AUTH_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    await save(browser, STATE.marigoldOwner, WEB, USERS.marigoldOwner);
    await save(browser, STATE.marigoldStaff, WEB, USERS.marigoldStaff);
    await save(browser, STATE.sliceYardOwner, WEB, USERS.sliceYardOwner);
    await save(browser, STATE.maintainer, CONSOLE, USERS.maintainer);
    await save(browser, STATE.ownerInConsole, CONSOLE, USERS.marigoldOwner);
  } finally {
    await browser.close();
  }
}
