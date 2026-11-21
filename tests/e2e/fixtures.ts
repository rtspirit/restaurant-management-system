// The suite's `test`: Playwright's, plus a watch on the browser console. Any console error or
// uncaught page error fails the test, unless the test says which ones it expects.
import { test as base, expect } from "@playwright/test";

type ConsoleWatch = {
  /** Every console error and uncaught page error seen so far in this test. */
  errors: string[];
  /** Errors matching this are expected in this test (for example the 403s an owner gets in the console). */
  allow: (pattern: RegExp) => void;
};

export const test = base.extend<{ consoleWatch: ConsoleWatch }>({
  consoleWatch: [
    async ({ page }, use) => {
      const errors: string[] = [];
      const allowed: RegExp[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text().slice(0, 300));
      });
      page.on("pageerror", (err) => errors.push(`Uncaught: ${err.message.slice(0, 300)}`));
      await use({ errors, allow: (p) => allowed.push(p) });
      const unexpected = errors.filter((e) => !allowed.some((p) => p.test(e)));
      expect(unexpected, `The browser console reported errors:\n${unexpected.join("\n")}`).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** True on the phone-sized project. */
export const phoneProject = (projectName: string): boolean => projectName === "phone";
