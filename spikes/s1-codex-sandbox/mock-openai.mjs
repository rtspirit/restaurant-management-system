// Runs INSIDE the sandbox on 127.0.0.1. A stand-in for the OpenAI Responses API.
// Used only because the real account had no credits during the spike, so no real model turn
// could finish. It scripts two answers: first "apply this patch", then "done".
// Everything else in the run is real: the Codex binary, its tools, the sandbox, the event stream.
import http from "node:http";
import fs from "node:fs";

const log = (o) => fs.appendFileSync("/tmp/mock.log", JSON.stringify(o) + "\n");
const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/App.tsx",
  "@@",
  "-      <h1>Hello</h1>",
  "+      <h1>Hello, Marigold Kitchen</h1>",
  "+      <p>Open today.</p>",
  "*** End Patch",
].join("\n");
let n = 0;
const fn = (name, args) => ({ type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: JSON.stringify(args), status: "completed" });

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let i = 0;
  const next = () => {
    if (i >= events.length) return res.end();
    const e = events[i++];
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    setTimeout(next, 300); // spaced out so streaming can be seen on the other end
  };
  next();
}

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method !== "POST") {
      log({ method: req.method, url: req.url });
      res.writeHead(404, { "content-type": "application/json" });
      return res.end('{"error":{"message":"not found","type":"invalid_request_error"}}');
    }
    const j = JSON.parse(body);
    const tools = (j.tools || []).map((t) => ({ type: t.type, name: t.name }));
    const input = j.input || [];
    const hasOutput = input.some((i) => /_output$/.test(i.type));
    log({ post: req.url, model: j.model, stream: j.stream, keys: Object.keys(j), tools: tools.map((t) => `${t.type}:${t.name ?? ""}`), inputTypes: input.map((i) => i.type) });
    const id = `resp_mock_${++n}`;
    const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 120 };
    let item;
    if (!hasOutput) {
      const has = (type, name) => tools.some((t) => t.type === type && t.name === name);
      const sh = `apply_patch <<'EOF'\n${PATCH}\nEOF`;
      if (has("custom", "apply_patch")) item = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: PATCH, status: "completed" };
      else if (has("function", "apply_patch")) item = fn("apply_patch", { input: PATCH });
      else if (has("function", "exec_command")) item = fn("exec_command", { cmd: sh });
      else if (has("function", "shell_command")) item = fn("shell_command", { command: sh });
      else item = fn("shell", { command: ["bash", "-lc", sh] });
    } else {
      item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Updated the greeting and added the second line.", annotations: [] }] };
    }
    sse(res, [
      { type: "response.created", response: { id, status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, status: "completed", usage } },
    ]);
  });
}).listen(8788, "127.0.0.1");
