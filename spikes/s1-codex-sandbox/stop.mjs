// Step 8: stop the sandbox, print what it used, then list every sandbox in the project
// and confirm none is running.
//   node stop.mjs          stop the saved sandbox, then list
//   node stop.mjs --list   list only
//   node stop.mjs --delete remove the stopped sandbox record this spike created, then list
import { Sandbox } from "@vercel/sandbox";
import { loadVercelAuth, readName } from "./lib.mjs";

loadVercelAuth();

if (process.argv.includes("--delete")) {
  // Removes the stopped sandbox record that THIS spike created (the saved name only).
  const sandbox = await Sandbox.get({ name: readName() });
  if (sandbox.status !== "stopped") throw new Error(`not stopped (${sandbox.status}); run stop first`);
  await sandbox.delete();
  console.log("deleted sandbox record:", sandbox.name);
} else if (!process.argv.includes("--list")) {
  const sandbox = await Sandbox.get({ name: readName() });
  const t0 = Date.now();
  const final = await sandbox.stop();
  console.log("stopped in ms:", Date.now() - t0);
  console.log("final status:", final.status ?? sandbox.status);
  console.log("activeCpuDurationMs:", final.activeCpuDurationMs, "| networkTransfer:", JSON.stringify(final.networkTransfer));
  console.log("session duration ms:", final.duration ?? final.durationMs, "| created:", final.createdAt, "| stopped:", final.stoppedAt);
  console.log("snapshot taken:", Boolean(final.snapshot));
}

const page = await Sandbox.list({ limit: 50 });
const all = page.sandboxes ?? (await page.toArray?.()) ?? [];
console.log("sandboxes in project:", all.length);
let live = 0;
for (const s of all) {
  if (!["stopped", "failed", "aborted"].includes(s.status)) live++;
  console.log(` ${s.name} status=${s.status} persistent=${s.persistent} vcpus=${s.vcpus} totalActiveCpuMs=${s.totalActiveCpuDurationMs} totalDurationMs=${s.totalDurationMs}`);
}
console.log("NOT stopped:", live);
