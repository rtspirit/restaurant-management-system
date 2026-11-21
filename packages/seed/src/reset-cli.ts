// The command behind `pnpm reset-demo`. Kept here, not in scripts/, so that the script, the
// reset and the Data API it loads numbers through all share ONE copy of @rms/db (one set of
// database connections to open and close).
import { adminDb, closeAll } from "@rms/db";
import { loadTestEnv } from "@rms/db/testing";
import { checkDemoPassword, checkResetAllowed, resetDemo } from "./reset.js";

/**
 * Runs the reset and prints a short summary. Returns the exit code. Never prints a password.
 *   --no-sales   make the restaurants and their tables, but load no sales, bills or stock counts.
 * Settings come from the environment, or else from the repo's `.env.local` (found from a git
 * worktree too, where the file lives in the main checkout).
 */
export const runResetCli = async (argv: readonly string[]): Promise<number> => {
  const unknown = argv.filter((a) => a !== "--no-sales");
  if (unknown.length > 0) {
    console.error(`Unknown option: ${unknown.join(" ")}. The only option is --no-sales.`);
    return 1;
  }
  if (!process.env.DATABASE_ADMIN_URL) loadTestEnv();
  for (const check of [checkResetAllowed(process.env), checkDemoPassword(process.env)]) {
    if (!check.ok) {
      console.error(check.reason);
      return 1;
    }
  }
  try {
    const lines = await resetDemo(adminDb(), process.env, { withSales: !argv.includes("--no-sales") });
    for (const l of lines) console.log(l);
    return 0;
  } catch (err) {
    console.error(`Reset failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return 1;
  } finally {
    await closeAll();
  }
};
