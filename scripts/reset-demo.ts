// Rebuilds the demo from nothing: every restaurant, store and sign-in user is removed, then
// Marigold Kitchen and Slice Yard are created with their owners, staff users and the maintainer,
// the model library is installed, and each restaurant gets its tables and eight weeks of sales,
// bills, staff cost and stock counts, posted to its books.
//
// Run (after `pnpm build`):
//   pnpm reset-demo                 the full reset
//   pnpm reset-demo --no-sales      restaurants and tables only, no numbers
// Needs DEMO_PASSWORD (10+ characters) in .env.local. Refuses anything but a local database and
// sign-in service unless RMS_ALLOW_RESET=1 is set. Never prints a password.
import { runResetCli } from "../packages/seed/src/index.ts";

// No top-level await: the repo root is not an ES module package.
void runResetCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
