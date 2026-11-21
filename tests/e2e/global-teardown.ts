// Runs once after the browser suite, whatever the tests did: removes every e2e-* sign-up and the
// restaurant it made, and checks none is left.
import { closeAll } from "@rms/db";
import { removeSuiteSignUps, suiteUsers } from "./helpers/cleanup.js";

export default async function globalTeardown(): Promise<void> {
  try {
    await removeSuiteSignUps();
    const left = await suiteUsers();
    if (left.length > 0) throw new Error(`The browser suite left ${left.length} test sign-up(s) behind.`);
  } finally {
    await closeAll();
  }
}
