// The isolation and attack suite (tests/security). Run with `pnpm test:security`.
// It needs the local database and sign-in service, and the workspace packages built (`pnpm build`).
// One worker, one file at a time: the tests share one test world and one database, so runs must be repeatable.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["tests/security/**/*.test.ts"],
    globalSetup: ["tests/security/global-setup.ts"],
    setupFiles: ["tests/security/setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 20_000,
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
    // A security suite that finds no tests has not passed.
    passWithNoTests: false,
    allowOnly: false,
  },
});
