// Rebuilds the demo from nothing: every restaurant, store and sign-in user is removed, then
// Marigold Kitchen and Slice Yard are created with their owners, staff users and the maintainer.
//
// Run (after `pnpm build`):
//   pnpm --filter @rms/seed reset-demo
//   or, once tsx is on the root path: pnpm exec tsx --env-file=.env.local scripts/reset-demo.ts
// Needs DEMO_PASSWORD (10+ characters) in .env.local. Refuses anything but a local database and
// sign-in service unless RMS_ALLOW_RESET=1 is set. Never prints a password.
import { adminDb, closeAll } from "../packages/db/src/index.ts";
import { checkDemoPassword, checkResetAllowed, resetDemo } from "../packages/seed/src/index.ts";

const main = async (): Promise<number> => {
  for (const check of [checkResetAllowed(process.env), checkDemoPassword(process.env)]) {
    if (!check.ok) {
      console.error(check.reason);
      return 1;
    }
  }
  try {
    const lines = await resetDemo(adminDb(), process.env);
    for (const l of lines) console.log(l);
    return 0;
  } catch (err) {
    console.error(`Reset failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return 1;
  } finally {
    await closeAll();
  }
};

// No top-level await: the repo root is not an ES module package.
void main().then((code) => {
  process.exitCode = code;
});
