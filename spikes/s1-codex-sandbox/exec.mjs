// Runs a local bash script inside the saved sandbox and prints its output (scrubbed).
//   node exec.mjs <script.sh> [--extend <minutes>] [args passed to the script...]
// The build model name is passed to the script as $1. The key is never passed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { HERE, loadVercelAuth, loadOpenAI, readName, scrubber } from "./lib.mjs";

loadVercelAuth();
const { key, model } = loadOpenAI();
const scrub = scrubber(key);
const [script, ...rest] = process.argv.slice(2);
const sandbox = await Sandbox.get({ name: readName() });
const ext = rest.indexOf("--extend");
if (ext >= 0) {
  await sandbox.extendTimeout(Number(rest[ext + 1]) * 60 * 1000);
  rest.splice(ext, 2);
  console.log("timeout extended; now ms:", sandbox.timeout);
}
await sandbox.writeFiles([{ path: "/tmp/run.sh", content: readFileSync(resolve(HERE, script)) }]);
const t0 = Date.now();
const res = await sandbox.runCommand({ cmd: "bash", args: ["/tmp/run.sh", model, ...rest], env: { CODEX_API_KEY: "dummy-key-the-firewall-swaps-in-the-real-one" } });
console.log(scrub(await res.stdout()));
const err = scrub(await res.stderr());
if (err.trim()) console.log("--- stderr ---\n" + err.slice(0, 3000));
console.log("exit:", res.exitCode, "ms:", Date.now() - t0);
