// Step 3: create ONE small sandbox with the firewall on.
// Everything is denied except openrouter.ai. On that host only POST /api/v1/responses passes, and the
// firewall adds the real key to it. Every other request to the host gets a 403 from the firewall.
//   node create.mjs            tight rule (POST /api/v1/responses only)
//   node create.mjs --loose    no matcher: every request to openrouter.ai gets the key (only if tight fails)
import { Sandbox } from "@vercel/sandbox";
import { loadVercelAuth, loadKey, scrubber, saveName, LLM_HOST } from "./lib.mjs";

loadVercelAuth();
const key = loadKey();
const scrub = scrubber(key);
const loose = process.argv.includes("--loose");

// "Host" is pinned so a client cannot keep the allowed SNI and ask the CDN for another site.
const inject = { transform: [{ headers: { Authorization: `Bearer ${key}`, Host: LLM_HOST } }] };
export const rules = loose
  ? [inject]
  : [{ match: { path: { startsWith: "/api/v1/responses" }, method: ["POST"] }, ...inject }, { response: { statusCode: 403 } }];
const networkPolicy = { allow: { [LLM_HOST]: rules } }; // no "*" entry: every other host is blocked, DNS included

const name = `s1b-openrouter-spike-${Date.now().toString(36)}`;
let sandbox;
const t0 = Date.now();
try {
  sandbox = await Sandbox.create({
    name,
    persistent: false,
    timeout: 12 * 60 * 1000,
    resources: { vcpus: 1 },
    networkPolicy,
    tags: { purpose: "spike-s1b" },
  });
} catch (err) {
  console.error("create failed:", scrub(err?.message ?? err));
  if (err?.json) console.error(scrub(JSON.stringify(err.json)));
  if (err?.text) console.error(scrub(String(err.text).slice(0, 600)));
  process.exit(1);
}

saveName(sandbox.name);
console.log("created in ms:", Date.now() - t0, "| rule:", loose ? "loose" : "tight");
console.log("name:", sandbox.name);
console.log("status:", sandbox.status, "vcpus:", sandbox.vcpus, "memoryMB:", sandbox.memory, "region:", sandbox.region);
console.log("cwd:", sandbox.cwd, "timeoutMs:", sandbox.timeout, "persistent:", sandbox.persistent);
const readback = JSON.stringify(sandbox.networkPolicy);
console.log("policy readback contains key:", readback.includes(key));
console.log("policy readback:", scrub(readback));
