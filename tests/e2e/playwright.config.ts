// The browser suite: the demo beats and the screens they stand on, in headless Chromium, against
// the servers already running on this computer (API 8787, web app 3000, console 3001).
// Not part of `pnpm test`: it needs those servers. Run with `pnpm test:e2e`.
//
// Secrets: tracing, video and the HTML report are OFF. A trace or a report step would record what
// was typed into the password field. Screenshots are taken only when a test fails.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["specs/**/*.spec.ts", "beats/**/*.spec.ts"],
  outputDir: "./test-results",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  // Gentle on the servers Rahul is using, and on the Data API's four-at-once limit per restaurant.
  workers: 2,
  fullyParallel: false,
  // One retry only for a server that restarted mid-run (the lead restarts them after merges).
  retries: process.env.E2E_RETRIES ? Number(process.env.E2E_RETRIES) : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["./beat-reporter.ts"]],
  use: {
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "phone",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
