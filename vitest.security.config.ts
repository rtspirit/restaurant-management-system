// The isolation and attack suite (tests/security). Run with `pnpm test:security`.
//
// Needs: the local database and sign-in service running, and the workspace packages built (`pnpm build`).
// It refuses to run against anything that is not 127.0.0.1 or localhost, and a missing database is a failure, not a skip.
// One worker, one file at a time: the tests share one test world and one database, so runs must be repeatable.
//
// Settings (environment variables):
//   RMS_ENV_FILE=<path>           settings file to load. Default: ./.env.local, then the main checkout's when run in a git worktree.
//   RMS_REQUIRE_DATA_API=1        fail (instead of skipping loudly) when the Data API routes are still the empty stub.
//   RMS_SECURITY_CLEAN_ONLY=1     remove anything an interrupted run left in the database, run no tests.
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
