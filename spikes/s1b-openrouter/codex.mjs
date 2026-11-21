// Step 4: put a stub template in the sandbox, run Codex on it with a DUMMY key through OpenRouter,
// and stream its JSON event lines back here as they happen. Then read the files back and add up the cost.
//   RMS_BUILD_MODEL=<OpenRouter id> RMS_BUILD_CONTEXT=<tokens> node codex.mjs
//   RMS_TASK="<other task>"      a different task
//   RMS_RESUME=<thread id>       follow-up turn on an existing thread (the app folder is kept as it is)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { HERE, loadVercelAuth, loadKey, readName, scrubber, saveOut, model, orFetch, TASK, DUMMY } from "./lib.mjs";

loadVercelAuth();
const key = loadKey(); // used to scrub output and, afterwards, to ask OpenRouter what the calls cost. Never sent into the sandbox.
const scrub = scrubber(key);
const MODEL = model();
const CONTEXT = process.env.RMS_BUILD_CONTEXT ?? "400000";
const task = process.env.RMS_TASK || TASK;
const resume = process.env.RMS_RESUME || "";

const sandbox = await Sandbox.get({ name: readName() });
const app = `${sandbox.cwd}/app`;

const files = [
  { path: "/tmp/codex-args.sh", content: readFileSync(resolve(HERE, "codex-args.sh")) },
  { path: "/tmp/run-codex.sh", content: readFileSync(resolve(HERE, "run-codex.sh")) },
];
if (!resume) {
  // The stub template (reset on every fresh run).
  await sandbox.runCommand("bash", ["-c", `rm -rf "${app}" && mkdir -p "${app}/src"`]);
  files.push(
    { path: `${app}/package.json`, content: Buffer.from(JSON.stringify({ name: "stub-mini-app", private: true, version: "0.0.0", dependencies: { react: "^19.0.0" } }, null, 2) + "\n") },
    { path: `${app}/src/App.tsx`, content: Buffer.from('export default function App() {\n  return (\n    <main>\n      <h1>Hello</h1>\n    </main>\n  );\n}\n') },
  );
}
await sandbox.writeFiles(files);

const t0 = Date.now();
const cmd = await sandbox.runCommand({
  cmd: "bash",
  args: ["/tmp/run-codex.sh", MODEL, CONTEXT, app, task, resume],
  cwd: sandbox.cwd,
  env: { RMS_LLM_DUMMY_KEY: DUMMY },
  detached: true,
});
console.log(`started model=${MODEL} ${resume ? "RESUME " + resume : "fresh thread"} cmdId=${cmd.cmdId} startMs=${Date.now() - t0}\ntask: ${task}`);

const events = [];
let firstEventMs = null;
let threadId = resume;
let buf = "";
let stderr = "";
for await (const log of cmd.logs()) {
  if (log.stream === "stderr") { stderr += log.data; continue; }
  buf += log.data;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const t = Date.now() - t0;
    if (firstEventMs === null) firstEventMs = t;
    let ev; try { ev = JSON.parse(line); } catch { ev = { type: "(not json)", raw: line.slice(0, 200) }; }
    events.push({ t, ev });
    const item = ev.item ? ` ${ev.item.type}${ev.item.status ? ":" + ev.item.status : ""}` : "";
    let detail = "";
    if (ev.item?.type === "command_execution") detail = ` $ ${String(ev.item.command).slice(0, 90).replace(/\n/g, " ")}`;
    if (ev.item?.type === "file_change") detail = ` ${JSON.stringify(ev.item.changes)}`;
    if (ev.item?.type === "agent_message") detail = ` "${String(ev.item.text).slice(0, 160).replace(/\n/g, " ")}"`;
    if (ev.item?.type === "error") detail = ` "${String(ev.item.message).slice(0, 200)}"`;
    if (ev.type === "turn.completed") detail = ` usage=${JSON.stringify(ev.usage)}`;
    if (ev.type === "turn.failed" || ev.type === "error") detail = ` ${JSON.stringify(ev.error ?? ev.message ?? ev).slice(0, 700)}`;
    if (ev.type === "thread.started") { detail = ` thread_id=${ev.thread_id}`; threadId = ev.thread_id; }
    console.log(scrub(`[${String(t).padStart(6)}ms] ${ev.type}${item}${detail}`));
  }
}
const done = await cmd.wait();
const totalMs = Date.now() - t0;

console.log("\n--- result ---");
console.log("exit code:", done.exitCode, "| first event ms:", firstEventMs, "| total ms:", totalMs, "| events:", events.length, "| thread:", threadId);
const counts = {};
for (const { ev } of events) { const k = ev.item ? `${ev.type}/${ev.item.type}` : ev.type; counts[k] = (counts[k] ?? 0) + 1; }
console.log("event types:", JSON.stringify(counts));
if (stderr.trim()) console.log("--- codex stderr (first 2000 chars) ---\n" + scrub(stderr).slice(0, 2000));

const back = await sandbox.runCommand("bash", ["-c", `
  cd "${app}" && for f in $(find . -type f -not -path './node_modules/*' -not -path './.git/*' | sort); do echo "### $f"; head -c 1500 "$f"; echo; done
  echo "### event lines saved in the sandbox file: $(wc -l < /vercel/codex-events.jsonl 2>/dev/null)"
  echo "### files in ~/.codex that hold the dummy key: $(grep -rla '${DUMMY}' ~/.codex 2>/dev/null | wc -l) | auth.json present: $(test -f ~/.codex/auth.json && echo yes || echo no)"
  echo "GEN_IDS $(grep -hoE 'gen-[0-9]+-[A-Za-z0-9]+' ~/.codex/sessions/*/*/*/*${threadId}*.jsonl 2>/dev/null | sort -u | tr '\\n' ' ')"
`]);
const backOut = scrub(await back.stdout());
console.log("--- app folder after the run ---\n" + backOut.split("GEN_IDS")[0]);

// Ask OpenRouter (from this machine, with the real key) what each model call of this thread cost.
const ids = (backOut.split("GEN_IDS")[1] ?? "").trim().split(/\s+/).filter(Boolean);
let total = 0, upstream = 0, n = 0;
const seen = {};
for (const id of ids) {
  const g = (await orFetch(key, `/generation?id=${encodeURIComponent(id)}`)).json?.data;
  if (!g) continue;
  if (n === 0) console.log("generation record fields:", Object.keys(g).join(","));
  n++; total += g.total_cost ?? 0; if (g.is_byok) upstream += g.upstream_inference_cost ?? 0;
  const k = `${g.provider_name}${g.is_byok ? " (account's own provider key)" : ""}`; seen[k] = (seen[k] ?? 0) + 1;
}
console.log(`--- cost for the whole thread so far (${n} of ${ids.length} model calls found) ---`);
console.log("charged to OpenRouter credit USD:", total.toFixed(6), "| paid at the provider through the account's own provider key USD:", upstream.toFixed(6), "| served by:", JSON.stringify(seen));
saveOut(`events-${MODEL.replace(/[^a-z0-9.-]+/gi, "_")}-${Date.now().toString(36)}.jsonl`, events.map((e) => scrub(JSON.stringify(e))).join("\n") + "\n");
