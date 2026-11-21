#!/usr/bin/env bash
# Runs INSIDE the sandbox. Follow-up checks after the first Codex run failed.
set +e
MODEL="$1"

echo "== 1. where does 'Attack attempt detected' come from? (in the codex binary = client side)"
BIN=$(readlink -f "$(command -v codex)"); echo "codex binary: $BIN"
for f in "$BIN" $(find "$(dirname "$BIN")/.." -type f -size +5M 2>/dev/null | head -5); do
  echo "  $(basename "$f"): $(grep -a -c 'Attack attempt detected' "$f" 2>/dev/null)"
done

echo "== 2. the 403 from the Host-mismatch test: who answered?"
curl -sS -m 15 -o /tmp/b.txt -D /tmp/h.txt -H 'Host: s1-spike-fronting-test.invalid' https://api.openai.com/v1/models
head -1 /tmp/h.txt; grep -i -E '^(server|cf-ray|content-type|x-vercel[^:]*):' /tmp/h.txt | sed -E 's/(cf-ray: ).*/\1<present>/I'
echo "body: $(head -c 200 /tmp/b.txt | tr '\n' ' ')"

echo "== 3. tiny plain HTTP call to the Responses API (no auth header of ours)"
curl -sS -m 60 -o /tmp/r.json -w 'http=%{http_code}\n' https://api.openai.com/v1/responses \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"input\":\"Reply with the single word: ok\",\"max_output_tokens\":16}"
node -e '
  const j = JSON.parse(require("fs").readFileSync("/tmp/r.json", "utf8"));
  if (j.error) console.log("error:", j.error.type, "|", j.error.code, "|", String(j.error.message).slice(0, 200));
  else console.log("status:", j.status, "| model:", j.model, "| usage:", JSON.stringify(j.usage), "| text:", JSON.stringify(j.output_text ?? j.output?.flatMap((o) => o.content ?? []).map((c) => c.text).join("")));
'

echo "== 4. TLS issuer the sandbox sees"
curl -sSv -m 10 -o /dev/null https://api.openai.com/v1/models 2>&1 | grep -i -E 'issuer|subject:|SSL connection' | head -4

echo "== 5. filesystem scan sanity (how many files, and a second scan of writable places incl. binary files)"
echo "regular files on root fs: $(sudo find / -xdev -type f 2>/dev/null | wc -l)"
PAT='sk-[A-Za-z0-9_-]{20,}'
echo "matches incl. binary in /vercel /home /root /tmp /etc /run /var /opt: $(sudo grep -raoE "$PAT" /vercel /home /root /tmp /etc /run /var /opt 2>/dev/null | wc -l)"
rm -f /tmp/b.txt /tmp/h.txt /tmp/r.json
