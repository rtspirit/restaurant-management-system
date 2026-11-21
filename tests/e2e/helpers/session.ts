// Signing in through the real form.
//
// The local sign-in service allows 30 sign-ins and sign-ups per five minutes from this computer,
// shared with every other agent and test. So the suite signs each seeded user in ONCE, in
// global-setup.ts, and the tests reuse that browser state. Only the tests about the sign-in form
// itself sign in again.
//
// The password is typed into the field and nowhere else. Tracing, video and the HTML report are
// off for this suite (playwright.config.ts), so it is never written to disk.
import type { Page } from "@playwright/test";

export const signInThroughForm = async (page: Page, base: string, email: string, password: string): Promise<void> => {
  await page.goto(`${base}/sign-in`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
};

/** Signs in and waits to leave the sign-in page. Throws a plain error naming the email only. */
export const signIn = async (page: Page, base: string, email: string, password: string): Promise<void> => {
  await signInThroughForm(page, base, email, password);
  try {
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
  } catch {
    const said = (await page.locator("[role=alert], [role=status]").allInnerTexts().catch(() => [])).join(" ").trim();
    throw new Error(`Could not sign in as ${email}.${said ? ` The page said: "${said}"` : ""} (The local sign-in service allows 30 sign-ins per five minutes from this computer.)`);
  }
  await settle(page);
};

/** Waits for the page to go quiet. Some pages keep a connection open, so this gives up politely. */
export const settle = async (page: Page): Promise<void> => {
  await page.waitForLoadState("load");
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
};

/** Opens a page and returns its visible words, whitespace squashed. */
export const open = async (page: Page, url: string): Promise<string> => {
  await page.goto(url);
  await settle(page);
  return words(page);
};

export const words = async (page: Page): Promise<string> => (await page.locator("body").innerText()).replace(/\s+/g, " ");
