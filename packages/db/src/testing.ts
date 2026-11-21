// Test helper: load the repo's settings file wherever the tests run from (the main checkout,
// a git worktree inside it, or CI). Never hard-code a machine path in a test.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Loads `.env.local` from the nearest workspace root that has one, walking up from the current
 * directory (a worktree has no settings file of its own, so the walk reaches the main checkout).
 * Variables already set in the environment win. `RMS_ENV_FILE` names a file to use instead.
 * Returns true when a file was loaded.
 */
export const loadTestEnv = (): boolean => {
  const explicit = process.env.RMS_ENV_FILE;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error("RMS_ENV_FILE does not exist");
    process.loadEnvFile(explicit);
    return true;
  }
  let dir = process.cwd();
  for (;;) {
    const file = join(dir, ".env.local");
    if (existsSync(file) && existsSync(join(dir, "pnpm-workspace.yaml"))) {
      process.loadEnvFile(file);
      return true;
    }
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
};

/** Throws a plain error naming any missing setting. Database tests must fail, not skip. */
export const requireTestEnv = (...names: string[]): void => {
  loadTestEnv();
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) throw new Error(`These tests need settings that are missing: ${missing.join(", ")}. Run scripts/dev-db-roles.sh with the local stack started.`);
};
