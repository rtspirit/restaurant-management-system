// Step 3: run probe.sh inside the sandbox and compare any "sk-..." strings found there
// with the real key. The comparison happens HERE, by hash. The key never goes in.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { HERE, loadVercelAuth, loadOpenAI, readName, scrubber, sha256, saveOut } from "./lib.mjs";

loadVercelAuth();
const { key, model } = loadOpenAI();
const scrub = scrubber(key);

const sandbox = await Sandbox.get({ name: readName() });
await sandbox.writeFiles([{ path: "/tmp/probe.sh", content: readFileSync(resolve(HERE, "probe.sh")) }]);
const t0 = Date.now();
const res = await sandbox.runCommand("bash", ["/tmp/probe.sh", model]);
const out = scrub(await res.stdout());
const err = scrub(await res.stderr());
console.log(out);
if (err.trim()) console.log("--- stderr ---\n" + err.slice(0, 2000));
console.log("probe exit:", res.exitCode, "ms:", Date.now() - t0);

const hashes = out.split("CANDIDATE_HASHES_BEGIN")[1]?.split("CANDIDATE_HASHES_END")[0]?.trim().split("\n").filter(Boolean) ?? [];
const keyHash = sha256(key);
console.log("distinct sk- strings found in sandbox files:", hashes.length);
console.log("any of them equal to the real key:", hashes.includes(keyHash));
console.log("raw output contained the key before scrubbing:", (await res.stdout()).includes(key));
saveOut("probe.txt", out);
