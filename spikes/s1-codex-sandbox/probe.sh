#!/usr/bin/env bash
# Runs INSIDE the sandbox. Step 3: prove the firewall and prove the key is not in here.
# Prints status codes, counts and hashes only. Never prints a credential value.
set +e
MODEL="$1"

echo "== machine"
whoami; pwd; echo "cpus=$(nproc)"; free -m | sed -n 2p
echo "== tools"
echo "codex at: $(command -v codex)"; codex --version
echo "node: $(node --version)"

echo "== A. hosts that are NOT on the list (each must fail)"
for u in https://example.com https://chatgpt.com https://registry.npmjs.org/ https://github.com http://1.1.1.1/; do
  code=$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "$u" 2>/tmp/err); rc=$?
  echo "$u -> http=$code curl_exit=$rc $(head -c 120 /tmp/err | tr '\n' ' ')"
done
echo "dns example.com: $(getent hosts example.com || echo 'no answer')"
echo "dns api.openai.com: $(getent hosts api.openai.com | head -1 || echo 'no answer')"

echo "== B. api.openai.com with NO auth header of our own (200 means the firewall added the key)"
code=$(curl -sS -m 20 -o /tmp/models.json -w '%{http_code} http_version=%{http_version}' https://api.openai.com/v1/models); echo "http=$code curl_exit=$?"
node -e '
  const j = JSON.parse(require("fs").readFileSync("/tmp/models.json", "utf8"));
  const ids = (j.data || []).map((m) => m.id);
  console.log("models listed:", ids.length, "| build model present:", ids.includes(process.argv[1]), j.error ? "| error: " + (j.error.code || j.error.type) : "");
' "$MODEL"
rm -f /tmp/models.json

echo "== C. api.openai.com with a DUMMY auth header (200 means the firewall replaced it)"
curl -sS -m 20 -o /dev/null -w 'http=%{http_code}\n' -H 'Authorization: Bearer dummy-not-a-real-key' https://api.openai.com/v1/models

echo "== D. fronting attempt: allowed SNI, different Host header (200 from OpenAI means Host was pinned)"
# The fake host cannot resolve anywhere, so if pinning did not work nothing of ours reaches a third party.
curl -sS -m 20 -o /tmp/front.txt -w 'http=%{http_code}\n' -H 'Host: s1-spike-fronting-test.invalid' https://api.openai.com/v1/models
echo "body looks like OpenAI model list: $(grep -c '"object": *"list"' /tmp/front.txt)"; rm -f /tmp/front.txt

echo "== E. TLS: who signed the certificate the sandbox sees"
curl -sSv -m 10 -o /dev/null https://api.openai.com/v1/models 2>&1 | grep -i -E '^\*  ?(issuer|subject):'
echo "CA env vars:"; env | grep -E 'SSL_CERT|CA_BUNDLE|EXTRA_CA|CA_CERT' | sed 's/=.*/=<path set>/'
ls -la /usr/local/share/ca-certificates/ 2>/dev/null | tail -n +2

echo "== F. WebSocket upgrade with no auth header (101 means upgrades pass and get the key too)"
curl -sS -m 10 -o /dev/null -D /tmp/ws.h --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://api.openai.com/v1/responses; echo "curl_exit=$? (28 = timed out after the upgrade, which is fine)"
head -1 /tmp/ws.h; grep -i -E '^(upgrade|connection|www-authenticate):' /tmp/ws.h; rm -f /tmp/ws.h

echo "== G. is the key in here? (names, counts and hashes only)"
PAT='sk-[A-Za-z0-9_-]{20,}'
echo "env var names that look like credentials (name and value length):"
env | awk -F= '{print "  " $1 " len=" length($0)-length($1)-1}' | grep -i -E 'key|token|secret|openai|auth|oidc|bearer' || echo "  none"
echo "matches in this shell env: $(env | grep -c -E "$PAT")"
echo "matches in every process environ: $(sudo sh -c 'cat /proc/[0-9]*/environ 2>/dev/null' | tr '\0' '\n' | grep -a -c -E "$PAT")"
echo "matches in every process command line: $(sudo sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null' | tr '\0' '\n' | grep -a -c -E "$PAT")"
echo "process count: $(ls -d /proc/[0-9]* | wc -l)"
t=$(date +%s)
sudo timeout 120 grep -rIoE "$PAT" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null > /tmp/hits.txt
echo "filesystem scan exit=$? seconds=$(( $(date +%s) - t ))"
echo "filesystem hits: $(wc -l < /tmp/hits.txt) in $(cut -d: -f1 /tmp/hits.txt | sort -u | wc -l) files"
echo "files (first 8):"; cut -d: -f1 /tmp/hits.txt | sort -u | head -8 | sed 's/^/  /'
echo "CANDIDATE_HASHES_BEGIN"
cut -d: -f2- /tmp/hits.txt | sort -u | while read -r c; do printf '%s' "$c" | sha256sum | cut -d' ' -f1; done
echo "CANDIDATE_HASHES_END"
rm -f /tmp/hits.txt /tmp/err
