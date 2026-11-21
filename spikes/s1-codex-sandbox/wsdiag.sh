#!/usr/bin/env bash
# Runs INSIDE the sandbox. Why does Codex's WebSocket client reject the firewall's 101 answer?
# Its library (tungstenite) aborts a handshake with "Attack attempt detected" when the answer
# arrives in many tiny pieces (more than 64 reads averaging under 128 bytes) or is over 64 KB.
# Count how the 101 answer arrives through the firewall.
cat > /tmp/wsdiag.mjs <<'EOF'
import tls from "node:tls";
const s = tls.connect({ host: "api.openai.com", port: 443, servername: "api.openai.com", ALPNProtocols: ["http/1.1"] }, () => {
  s.write([
    "GET /v1/responses HTTP/1.1", "Host: api.openai.com", "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "OpenAI-Beta: responses_websockets=2026-02-06", "", "",
  ].join("\r\n"));
});
let chunks = [], total = "";
s.on("data", (d) => {
  if (total.includes("\r\n\r\n")) return;
  chunks.push(d.length); total += d.toString("latin1");
  if (total.includes("\r\n\r\n")) {
    console.log("status:", total.split("\r\n")[0]);
    console.log("reads until end of headers:", chunks.length, "| bytes:", total.length, "| average bytes per read:", Math.round(total.length / chunks.length));
    console.log("read sizes:", chunks.join(","));
    console.log("tungstenite would abort:", chunks.length > 64 && chunks.length * 128 > total.length);
    s.destroy();
  }
});
s.on("error", (e) => console.log("error", e.message));
setTimeout(() => process.exit(0), 8000);
EOF
node /tmp/wsdiag.mjs
rm -f /tmp/wsdiag.mjs
