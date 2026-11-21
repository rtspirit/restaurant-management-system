#!/usr/bin/env bash
# Runs INSIDE the sandbox. Step 3: prove the firewall, prove the key is not in here,
# and record what Codex would send (to a local listener, no network, no model call).
# Prints status codes, counts and hashes only. Never prints a credential value.
set +e
MODEL="$1"
OR=https://openrouter.ai

echo "== machine"
whoami; pwd; echo "cpus=$(nproc)"; free -m | sed -n 2p
echo "codex at: $(command -v codex) $(codex --version 2>&1 | tail -1) | node $(node --version)"

echo "== A. hosts that are NOT on the list (each must fail)"
for u in https://example.com https://api.openai.com/v1/models https://registry.npmjs.org/ https://github.com https://eu.openrouter.ai/api/v1/models http://1.1.1.1/; do
  code=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "$u" 2>/tmp/err); rc=$?
  echo "$u -> http=$code curl_exit=$rc $(head -c 100 /tmp/err | tr '\n' ' ')"
done
echo "dns example.com: $(getent hosts example.com || echo 'no answer')"
echo "dns openrouter.ai: $(getent hosts openrouter.ai | head -1 || echo 'no answer')"

echo "== B. POST $OR/api/v1/responses with NO auth header of our own (200 means the firewall added the key)"
code=$(curl -sS -m 40 -o /tmp/r.json -w '%{http_code} http_version=%{http_version}' "$OR/api/v1/responses" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"input\":\"Reply with the single word: ok\",\"max_output_tokens\":16,\"provider\":{\"data_collection\":\"deny\"}}"); echo "http=$code curl_exit=$?"
node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/r.json","utf8")); console.log(j.error ? "error: "+JSON.stringify(j.error).slice(0,200) : "status: "+j.status+" model: "+j.model+" usage: "+JSON.stringify(j.usage))'
rm -f /tmp/r.json

echo "== C. requests to openrouter.ai that the rule does not match (403 from the firewall means the matcher works)"
# Bodies are not printed: if the matcher did NOT work, /key would answer with details about the key.
for p in "/api/v1/key" "/api/v1/models" "/api/v1/credits" "/"; do
  curl -sS -m 15 -o /tmp/c.txt -w "GET $p -> http=%{http_code} bytes=%{size_download}\n" "$OR$p"
done
curl -sS -m 15 -o /tmp/c.txt -w "POST /api/v1/chat/completions -> http=%{http_code} bytes=%{size_download}\n" -H 'Content-Type: application/json' -d '{}' "$OR/api/v1/chat/completions"
curl -sS -m 15 -o /tmp/c.txt -w "POST /api/v1/keys (key management) -> http=%{http_code} bytes=%{size_download}\n" -H 'Content-Type: application/json' -d '{}' "$OR/api/v1/keys"
rm -f /tmp/c.txt

echo "== D. fronting attempt: allowed SNI, different Host header (must not reach another site)"
curl -sS -m 15 -o /tmp/front.txt -w 'http=%{http_code}\n' -H 'Host: s1b-spike-fronting-test.invalid' -H 'Content-Type: application/json' -d '{}' "$OR/api/v1/responses"
echo "answer starts: $(head -c 120 /tmp/front.txt | tr '\n' ' ')"; rm -f /tmp/front.txt

echo "== E. TLS: who signed the certificate the sandbox sees"
curl -sSv -m 10 -o /dev/null "$OR/" 2>&1 | grep -i -E '^\*  ?(issuer|subject):'

echo "== G. is the key in here? (names, counts and hashes only)"
PAT='sk-[A-Za-z0-9_-]{20,}'
echo "env var names that look like credentials (name and value length):"
env | awk -F= '{print "  " $1 " len=" length($0)-length($1)-1}' | grep -i -E 'key|token|secret|openai|openrouter|auth|oidc|bearer' || echo "  none"
echo "matches in this shell env: $(env | grep -c -E "$PAT")"
echo "matches in every process environ: $(sudo sh -c 'cat /proc/[0-9]*/environ 2>/dev/null' | tr '\0' '\n' | grep -a -c -E "$PAT")"
echo "matches in every process command line: $(sudo sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null' | tr '\0' '\n' | grep -a -c -E "$PAT")"
t=$(date +%s)
sudo timeout 100 grep -rIoE "$PAT" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null > /tmp/hits.txt
echo "filesystem scan exit=$? seconds=$(( $(date +%s) - t ))"
echo "filesystem hits: $(wc -l < /tmp/hits.txt) in $(cut -d: -f1 /tmp/hits.txt | sort -u | wc -l) files; of which sk-or-: $(grep -c 'sk-or-' /tmp/hits.txt)"
echo "CANDIDATE_HASHES_BEGIN"
cut -d: -f2- /tmp/hits.txt | sort -u | while read -r c; do printf '%s' "$c" | sha256sum | cut -d' ' -f1; done
echo "CANDIDATE_HASHES_END"
rm -f /tmp/hits.txt /tmp/err

echo "== H. what Codex sends with our setup (to a local listener on 127.0.0.1, not to the network)"
cat > /tmp/listen.mjs <<'EOF'
import http from "node:http";
import fs from "node:fs";
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const o = { method: req.method, url: req.url, headerNames: Object.keys(req.headers).sort(), auth: /dummy/.test(req.headers.authorization ?? "") ? "Bearer <the dummy>" : (req.headers.authorization ? "<other value>" : "<none>"), bodyBytes: body.length };
    try {
      const j = JSON.parse(body);
      o.bodyKeys = Object.keys(j);
      o.picked = { model: j.model, store: j.store, stream: j.stream, previous_response_id: j.previous_response_id, include: j.include, reasoning: j.reasoning, tool_choice: j.tool_choice, parallel_tool_calls: j.parallel_tool_calls, service_tier: j.service_tier, prompt_cache_key: j.prompt_cache_key ? "<set>" : undefined, text: j.text };
      o.tools = (j.tools || []).map((t) => `${t.type}:${t.name ?? ""}`);
      o.inputTypes = (j.input || []).map((i) => `${i.type}${i.role ? "/" + i.role : ""}`);
      o.instructionsBytes = (j.instructions || "").length;
    } catch {}
    fs.appendFileSync("/tmp/capture.jsonl", JSON.stringify(o) + "\n");
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":{"message":"capture only","type":"invalid_request_error"}}');
  });
}).listen(8787, "127.0.0.1");
EOF
rm -f /tmp/capture.jsonl
node /tmp/listen.mjs & LP=$!
sleep 0.7
mkdir -p /tmp/cap
APP=/tmp/cap BASE_URL=http://127.0.0.1:8787/v1 CONTEXT="$2" . /tmp/codex-args.sh
RMS_LLM_DUMMY_KEY=dummy-key-the-firewall-swaps-in-the-real-one timeout 40 codex "${CODEX_ARGS[@]}" \
  --config model_providers.rmsllm.request_max_retries=0 "say ok" </dev/null >/tmp/cap.out 2>/tmp/cap.err
echo "codex exit=$?"
kill $LP 2>/dev/null
echo "requests captured: $(wc -l < /tmp/capture.jsonl 2>/dev/null || echo 0)"
sort -u /tmp/capture.jsonl 2>/dev/null | head -4
echo "-- codex stdout (event lines, first 600 chars)"; head -c 600 /tmp/cap.out
echo "-- codex stderr (first 800 chars)"; head -c 800 /tmp/cap.err
rm -f /tmp/cap.out /tmp/cap.err /tmp/listen.mjs /tmp/capture.jsonl
