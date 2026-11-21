// Step 2: create ONE small sandbox with the firewall on.
// Everything is denied except api.openai.com, and the firewall adds the real key to those calls.
import { Sandbox } from "@vercel/sandbox";
import { loadVercelAuth, loadOpenAI, scrubber, saveName } from "./lib.mjs";

loadVercelAuth();
const { key } = loadOpenAI();
const scrub = scrubber(key);

// The exact policy under test. No "*" entry, so every other host is blocked (DNS too).
// One rule with no matcher: every request to api.openai.com gets the header set or replaced.
// "Host" is pinned so a client cannot keep the allowed SNI and ask the CDN for another site
// (domain fronting), which would send our key to that site.
const networkPolicy = {
  allow: {
    "api.openai.com": [
      { transform: [{ headers: { Authorization: `Bearer ${key}`, Host: "api.openai.com" } }] },
    ],
  },
};

const name = `s1-codex-spike-${Date.now().toString(36)}`;
const vcpuChoices = [1, 2]; // smallest first

let sandbox;
const t0 = Date.now();
for (const vcpus of vcpuChoices) {
  try {
    sandbox = await Sandbox.create({
      name,
      persistent: false,
      timeout: 10 * 60 * 1000,
      resources: { vcpus },
      networkPolicy,
      tags: { purpose: "spike-s1" },
    });
    break;
  } catch (err) {
    console.error(`create with vcpus=${vcpus} failed:`, scrub(err?.message ?? err));
    if (err?.json) console.error(scrub(JSON.stringify(err.json)));
    if (err?.text) console.error(scrub(String(err.text).slice(0, 600)));
  }
}
if (!sandbox) process.exit(1);

saveName(sandbox.name);
console.log("created in ms:", Date.now() - t0);
console.log("name:", sandbox.name);
console.log("status:", sandbox.status, "vcpus:", sandbox.vcpus, "memoryMB:", sandbox.memory, "region:", sandbox.region);
console.log("image:", sandbox.image, "cwd:", sandbox.cwd, "timeoutMs:", sandbox.timeout, "persistent:", sandbox.persistent);
const readback = JSON.stringify(sandbox.networkPolicy);
console.log("policy readback contains key:", readback.includes(key));
console.log("policy readback:", scrub(readback));
