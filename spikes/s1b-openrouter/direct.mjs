// Step 1 and step 6: direct checks from this machine, no sandbox. A handful of tiny calls.
//   RMS_BUILD_MODEL=<id> RMS_EMBED_MODEL=<id> node direct.mjs [responses] [chat] [state] [embed] [privacy-off]
// Prints status codes, routing, usage and cost. Never prints the key.
import { loadKey, orFetch, scrubber, model, PRIVACY } from "./lib.mjs";

const key = loadKey();
const scrub = scrubber(key);
const want = new Set(process.argv.slice(2));
const all = want.size === 0;
const provider = want.has("zdr") ? { ...PRIVACY, zdr: true } : PRIVACY;

const tool = {
  name: "read_file",
  description: "Read a file from the app folder",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
};
const ask = "Call read_file for src/App.tsx. Do not answer in words.";
const costHeaders = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => /cost|usage|generation|x-openrouter|ratelimit|request-id/i.test(k)));
const show = (label, r, extra = {}) => {
  console.log(`\n== ${label} -> ${r.status} ${r.ms}ms`);
  console.log(scrub(JSON.stringify({ ...extra, error: r.json?.error, cost_headers: costHeaders(r.headers) })));
};

if (all || want.has("responses")) {
  const r = await orFetch(key, "/responses", {
    model: model(), input: ask, max_output_tokens: 200, provider,
    tools: [{ type: "function", strict: true, ...tool }],
  });
  const j = r.json ?? {};
  show(`POST /responses (function tool, provider=${JSON.stringify(provider)})`, r, {
    id_prefix: String(j.id ?? "").slice(0, 8), status: j.status, model: j.model, provider: j.provider,
    output: (j.output ?? []).map((o) => ({ type: o.type, name: o.name, arguments: o.arguments })),
    usage: j.usage, store: j.store, previous_response_id: j.previous_response_id,
  });
}

if (all || want.has("chat")) {
  const r = await orFetch(key, "/chat/completions", {
    model: model(), messages: [{ role: "user", content: ask }], max_tokens: 200, provider,
    tools: [{ type: "function", function: tool }],
  });
  const j = r.json ?? {};
  const m = j.choices?.[0]?.message;
  show(`POST /chat/completions (function tool, provider=${JSON.stringify(provider)})`, r, {
    model: j.model, provider: j.provider, finish_reason: j.choices?.[0]?.finish_reason,
    tool_calls: (m?.tool_calls ?? []).map((t) => t.function), content: m?.content, usage: j.usage,
  });
}

// What does OpenRouter do with the two stateful fields Codex might send? Errors cost nothing.
if (all || want.has("state")) {
  for (const extra of [{ store: true }, { store: false }, { previous_response_id: "resp_does_not_exist" }]) {
    const r = await orFetch(key, "/responses", { model: model(), input: "Say ok.", max_output_tokens: 16, provider, ...extra });
    show(`POST /responses with ${JSON.stringify(extra)}`, r, { status: r.json?.status, usage: r.json?.usage });
  }
}

if (all || want.has("embed")) {
  const r = await orFetch(key, "/embeddings", { model: model("RMS_EMBED_MODEL"), input: "brunch", provider });
  const j = r.json ?? {};
  show(`POST /embeddings (provider=${JSON.stringify(provider)})`, r, {
    model: j.model, provider: j.provider, vectors: j.data?.length, dimensions: j.data?.[0]?.embedding?.length, usage: j.usage,
  });
}

const k = await orFetch(key, "/key");
console.log("\nkey usage so far (USD):", k.json?.data?.usage, "| limit_remaining:", k.json?.data?.limit_remaining);
