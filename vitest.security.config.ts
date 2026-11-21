// The isolation and attack suite (tests/security). Run with `pnpm test:security`.
//
// Needs: the local database and sign-in service running, and the workspace packages built (`pnpm build`).
// A missing database is a failure, not a skip.
// One worker, one file at a time: the tests share one test world and one database, so runs must be repeatable.
//
// The suite ATTACKS the database it is pointed at, so it only does that on 127.0.0.1 or localhost.
// Pointed at the hosted settings file it switches to HOSTED MODE: it runs the read-only checks in
// tests/security/hosted and nothing else. No test world, no attack.
//
// Settings (environment variables):
//   RMS_ENV_FILE=<path>           settings file to load. Default: ./.env.local, then the main checkout's when run in a git worktree.
//                                 `RMS_ENV_FILE=.env.hosted` gives hosted mode.
//   RMS_REQUIRE_DATA_API=0        skip loudly (instead of failing) if the Data API routes are ever an empty stub again.
//   RMS_SECURITY_CLEAN_ONLY=1     remove anything an interrupted run left in the local database, run no tests.
import { defineConfig } from "vitest/config";
import { hostedMode, loadEnv } from "./tests/security/helpers/env";

loadEnv();
const hosted = hostedMode();
if (hosted) {
  process.stderr.write("\nSECURITY SUITE: HOSTED MODE. Read-only checks in tests/security/hosted only. No attack tests run.\n\n");
}

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: hosted ? ["tests/security/hosted/**/*.test.ts"] : ["tests/security/**/*.test.ts"],
    // The test world and the per-file guard both insist on a local database. Hosted mode uses neither.
    globalSetup: hosted ? [] : ["tests/security/global-setup.ts"],
    setupFiles: hosted ? [] : ["tests/security/setup.ts"],
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
