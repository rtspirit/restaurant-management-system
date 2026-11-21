#!/usr/bin/env bash
# Runs INSIDE the sandbox. Two follow-ups after the first Codex run:
#  1. Is the fallback model refused too? (one tiny call)
#  2. Why did Codex's WebSocket fail when a plain curl upgrade got 101?
#     Point Codex at a local listener to see the exact handshake it sends (no network involved),
#     then replay that same handshake through the firewall with curl and look at the answer.
set +e
MODEL="$1"; FALLBACK="$2"

if [ -n "$FALLBACK" ]; then
  echo "== fallback model, tiny plain HTTP call"
  curl -sS -m 60 -o /tmp/r.json -w 'http=%{http_code}\n' https://api.openai.com/v1/responses \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$FALLBACK\",\"input\":\"Reply with the single word: ok\",\"max_output_tokens\":16}"
  node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/r.json","utf8")); console.log(j.error ? "error: "+j.error.type+" | "+j.error.code : "status: "+j.status+" usage: "+JSON.stringify(j.usage))'
  rm -f /tmp/r.json
fi

cat > /tmp/listen.mjs <<'EOF'
import http from "node:http";
import fs from "node:fs";
const log = (o) => fs.appendFileSync("/tmp/capture.jsonl", JSON.stringify(o) + "\n");
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let keys, tools;
    try { const j = JSON.parse(body); keys = Object.keys(j); tools = (j.tools || []).map((t) => `${t.type}:${t.name ?? ""}`); } catch {}
    log({ kind: "http", method: req.method, url: req.url, headers: req.headers, bodyBytes: body.length, bodyKeys: keys, tools });
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":{"message":"capture only","type":"invalid_request_error"}}');
  });
});
srv.on("upgrade", (req, socket) => {
  log({ kind: "upgrade", method: req.method, url: req.url, headers: req.headers });
  socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
});
srv.listen(8787, "127.0.0.1");
EOF
rm -f /tmp/capture.jsonl
node /tmp/listen.mjs & LP=$!
sleep 0.7
mkdir -p /tmp/cap && cd /tmp/cap
timeout 25 codex exec --json --skip-git-repo-check --sandbox danger-full-access --model "$MODEL" \
  -c 'approval_policy="never"' -c analytics.enabled=false -c check_for_update_on_startup=false \
  -c 'openai_base_url="http://127.0.0.1:8787/v1"' "say ok" </dev/null >/tmp/cap.out 2>/tmp/cap.err
echo "codex exit=$?"
kill $LP 2>/dev/null

cat > /tmp/replay.mjs <<'EOF'
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const rows = fs.readFileSync("/tmp/capture.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const redact = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, /authorization/i.test(k) ? (String(v).includes("dummy") ? "Bearer <the dummy>" : "<other value>") : v]));
console.log("== what Codex sent to the local listener");
const seen = new Set();
for (const r of rows) {
  const sig = `${r.kind} ${r.method} ${r.url}`;
  if (seen.has(sig)) continue; seen.add(sig);
  console.log(sig, r.bodyBytes ? `bodyBytes=${r.bodyBytes}` : "");
  console.log("  headers:", JSON.stringify(redact(r.headers)));
  if (r.bodyKeys) console.log("  body keys:", r.bodyKeys.join(","), "\n  tools:", (r.tools || []).join(" "));
}
const up = rows.find((r) => r.kind === "upgrade");
if (!up) { console.log("no websocket upgrade was captured"); process.exit(0); }
console.log("== replay of that exact upgrade through the firewall to api.openai.com");
const args = ["-sS", "-m", "10", "--http1.1", "-o", "/tmp/ws.body", "-D", "/tmp/ws.h"];
for (const [k, v] of Object.entries(up.headers)) if (k !== "host") args.push("-H", `${k}: ${v}`);
args.push("https://api.openai.com" + up.url);
const r = spawnSync("curl", args, { encoding: "utf8" });
console.log("curl exit:", r.status, "(28 = still open after 10 s)");
const h = fs.existsSync("/tmp/ws.h") ? fs.readFileSync("/tmp/ws.h", "utf8") : "";
console.log("status line:", h.split("\r\n")[0]);
console.log("response header names:", h.split("\r\n").slice(1).map((l) => l.split(":")[0]).filter(Boolean).join(", "));
console.log("response header bytes:", h.length);
const b = fs.existsSync("/tmp/ws.body") ? fs.readFileSync("/tmp/ws.body") : Buffer.alloc(0);
console.log("body bytes:", b.length, "| body start:", JSON.stringify(b.subarray(0, 240).toString("latin1")));
EOF
node /tmp/replay.mjs
echo "== codex stderr during capture (first lines)"; head -c 600 /tmp/cap.err
rm -f /tmp/ws.h /tmp/ws.body /tmp/cap.out /tmp/cap.err /tmp/listen.mjs /tmp/replay.mjs
