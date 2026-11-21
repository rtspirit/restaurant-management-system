#!/usr/bin/env node
// Starts the built command. Kept as a plain file so the link exists before the package is built.
import("../dist/cli.js").catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, notes: ["The rms command has not been built."] })}\n`);
  process.exitCode = 1;
});
