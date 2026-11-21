// Runs one bash line inside the saved sandbox and prints its output (scrubbed). The key is never passed.
//   node exec.mjs '<bash line>'
import { Sandbox } from "@vercel/sandbox";
import { loadVercelAuth, loadKey, readName, scrubber } from "./lib.mjs";

loadVercelAuth();
const scrub = scrubber(loadKey());
const sandbox = await Sandbox.get({ name: readName() });
const t0 = Date.now();
const res = await sandbox.runCommand("bash", ["-c", process.argv[2]]);
console.log(scrub(await res.stdout()));
const err = scrub(await res.stderr());
if (err.trim()) console.log("--- stderr ---\n" + err.slice(0, 3000));
console.log("exit:", res.exitCode, "ms:", Date.now() - t0, "| sandbox status:", sandbox.status);
