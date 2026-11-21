// Steps 4 and 5: put a stub template in the sandbox, run Codex on it with a DUMMY key,
// and stream its JSON event lines back here as they happen.
//
//   node codex.mjs            default transport
//   node codex.mjs --no-ws    custom provider with supports_websockets=false (only if the default fails)
//   node codex.mjs --mock     same as --no-ws but the model is a scripted stand-in on localhost
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { HERE, loadVercelAuth, loadOpenAI, readName, scrubber, saveOut } from "./lib.mjs";

loadVercelAuth();
const { key, model } = loadOpenAI(); // key is used ONLY to scrub output, never sent anywhere here
const scrub = scrubber(key);
const noWs = process.argv.includes("--no-ws");
const mock = process.argv.includes("--mock"); // scripted model on localhost, see mock-openai.mjs
const DUMMY = "dummy-key-the-firewall-swaps-in-the-real-one";
const TASK = "Change the greeting to say Hello, Marigold Kitchen and add a second line that says Open today.";

const sandbox = await Sandbox.get({ name: readName() });
const app = `${sandbox.cwd}/app`;

// The stub template.
await sandbox.mkDir(app).catch(() => {});
await sandbox.mkDir(`${app}/src`).catch(() => {});
await sandbox.writeFiles([
  {
    path: `${app}/package.json`,
    content: Buffer.from(JSON.stringify({ name: "stub-mini-app", private: true, version: "0.0.0", dependencies: { react: "^19.0.0" } }, null, 2) + "\n"),
  },
  {
    path: `${app}/src/App.tsx`,
    content: Buffer.from('export default function App() {\n  return (\n    <main>\n      <h1>Hello</h1>\n    </main>\n  );\n}\n'),
  },
]);

const args = [
  "exec",
  "--json",
  "--skip-git-repo-check",
  "--sandbox", "danger-full-access", // the Vercel sandbox is the boundary, so Codex must not build its own
  "--cd", app,
  "--model", model,
  "--config", 'approval_policy="never"',
  "--config", "analytics.enabled=false",
  "--config", "check_for_update_on_startup=false",
];
if (mock) {
  // Start the scripted stand-in for the model on localhost inside the sandbox.
  await sandbox.writeFiles([{ path: "/tmp/mock-openai.mjs", content: readFileSync(resolve(HERE, "mock-openai.mjs")) }]);
  await sandbox.runCommand({ cmd: "bash", args: ["-c", "rm -f /tmp/mock.log; exec node /tmp/mock-openai.mjs"], detached: true });
  await new Promise((r) => setTimeout(r, 1200));
}
if (noWs || mock) {
  args.push(
    "--config", 'model_provider="rmsfw"',
    "--config", 'model_providers.rmsfw.name="OpenAI through the firewall"',
    "--config", `model_providers.rmsfw.base_url="${mock ? "http://127.0.0.1:8788/v1" : "https://api.openai.com/v1"}"`,
    "--config", 'model_providers.rmsfw.env_key="CODEX_API_KEY"',
    "--config", 'model_providers.rmsfw.wire_api="responses"',
    "--config", "model_providers.rmsfw.supports_websockets=false",
  );
}
args.push(TASK);

const t0 = Date.now();
// stdin is closed with </dev/null so Codex does not wait for piped input.
const cmd = await sandbox.runCommand({
  cmd: "bash",
  args: ["-c", 'exec codex "$@" </dev/null', "--", ...args],
  cwd: app,
  env: { CODEX_API_KEY: DUMMY },
  detached: true,
});
console.log(`started (${mock ? "MOCK MODEL on localhost" : noWs ? "websockets off" : "default transport"}) cmdId=${cmd.cmdId} startMs=${Date.now() - t0}`);

const events = [];
let firstEventMs = null;
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
    if (ev.item?.type === "command_execution") detail = ` $ ${String(ev.item.command).slice(0, 110)}`;
    if (ev.item?.type === "file_change") detail = ` ${JSON.stringify(ev.item.changes)}`;
    if (ev.item?.type === "agent_message") detail = ` "${String(ev.item.text).slice(0, 160).replace(/\n/g, " ")}"`;
    if (ev.type === "turn.completed") detail = ` usage=${JSON.stringify(ev.usage)}`;
    if (ev.type === "turn.failed" || ev.type === "error") detail = ` ${JSON.stringify(ev.error ?? ev.message ?? ev).slice(0, 500)}`;
    if (ev.type === "thread.started") detail = ` thread_id=${ev.thread_id}`;
    console.log(scrub(`[${String(t).padStart(6)}ms] ${ev.type}${item}${detail}`));
  }
}
const done = await cmd.wait();
const totalMs = Date.now() - t0;

console.log("\n--- result ---");
console.log("exit code:", done.exitCode, "| first event ms:", firstEventMs, "| total ms:", totalMs, "| events:", events.length);
const counts = {};
for (const { ev } of events) { const k = ev.item ? `${ev.type}/${ev.item.type}` : ev.type; counts[k] = (counts[k] ?? 0) + 1; }
console.log("event types:", JSON.stringify(counts));
if (stderr.trim()) console.log("--- codex stderr (first 3000 chars) ---\n" + scrub(stderr).slice(0, 3000));

const after = await sandbox.readFileToBuffer({ path: `${app}/src/App.tsx` });
console.log("--- src/App.tsx after the run ---\n" + (after ? after.toString("utf8") : "(missing)"));

// Clues about transport and resume, read from Codex's own state folder.
const clues = await sandbox.runCommand("bash", ["-c", `
  echo "session files:"; find ~/.codex -name '*.jsonl' 2>/dev/null | head -5
  echo "files in ~/.codex that mention websocket: $(grep -rlai 'websocket\\|wss://' ~/.codex 2>/dev/null | wc -l)"
  grep -rhaoiE '.{0,80}(websocket|wss://).{0,120}' ~/.codex 2>/dev/null | sort | uniq -c | sort -rn | head -12
  echo "files in ~/.codex that hold the dummy key: $(grep -rla '${DUMMY}' ~/.codex 2>/dev/null | wc -l)"
  echo "auth.json present: $(test -f ~/.codex/auth.json && echo yes || echo no)"
`]);
console.log("--- clues ---\n" + scrub(await clues.stdout()));

if (mock) {
  const m = await sandbox.runCommand("bash", ["-c", "cat /tmp/mock.log 2>/dev/null | cut -c1-900; pkill -f mock-openai.mjs; true"]);
  console.log("--- what Codex asked the mock model ---\n" + scrub(await m.stdout()));
}
saveOut(`events-${mock ? "mock" : noWs ? "nows" : "default"}.jsonl`, events.map((e) => scrub(JSON.stringify(e))).join("\n") + "\n");
