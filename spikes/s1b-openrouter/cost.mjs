// After the runs: ask OpenRouter what each model call cost, from the generation ids saved in out/gen-ids.txt
// (they come from Codex's own session files). Then print the key's counters. Numbers only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUT, loadKey, orFetch } from "./lib.mjs";

const key = loadKey();
const lines = readFileSync(resolve(OUT, "gen-ids.txt"), "utf8").split("\n").filter((l) => l.startsWith("THREAD "));
let grandCredit = 0, grandOwn = 0;
for (const line of lines) {
  const [, file, ...ids] = line.trim().split(/\s+/);
  if (!ids.length) continue;
  const rows = [];
  for (const id of ids) {
    const g = (await orFetch(key, `/generation?id=${encodeURIComponent(id)}`)).json?.data;
    if (g) rows.push(g);
  }
  const sum = (f) => rows.reduce((a, g) => a + (f(g) ?? 0), 0);
  const credit = sum((g) => g.total_cost), own = sum((g) => (g.is_byok ? g.upstream_inference_cost : 0));
  grandCredit += credit; grandOwn += own;
  console.log(`thread ${file.slice(-41, -6)} | model ${rows[0]?.model} | calls ${rows.length}/${ids.length}`);
  console.log(`  served by: ${[...new Set(rows.map((g) => `${g.provider_name}${g.is_byok ? " (own provider key)" : ""}`))].join(", ")} | api: ${[...new Set(rows.map((g) => g.api_type))].join(",")} | streamed: ${rows.every((g) => g.streamed)}`);
  console.log(`  tokens in ${sum((g) => g.native_tokens_prompt)} (cached ${sum((g) => g.native_tokens_cached)}) out ${sum((g) => g.native_tokens_completion)} (reasoning ${sum((g) => g.native_tokens_reasoning)})`);
  console.log(`  per call: ${rows.map((g) => `${Math.round(g.generation_time ?? g.latency)}ms/$${((g.is_byok ? g.upstream_inference_cost : g.total_cost) ?? 0).toFixed(4)}`).join("  ")}`);
  console.log(`  cost USD: OpenRouter credit ${credit.toFixed(6)} | own provider key ${own.toFixed(6)}`);
}
console.log(`\nall agent runs USD: OpenRouter credit ${grandCredit.toFixed(6)} | own provider key ${grandOwn.toFixed(6)}`);
const d = (await orFetch(key, "/key")).json?.data ?? {};
console.log("key now:", JSON.stringify({ limit: d.limit, limit_remaining: d.limit_remaining, usage: d.usage, byok_usage: d.byok_usage, include_byok_in_limit: d.include_byok_in_limit }));
const c = (await orFetch(key, "/credits")).json?.data ?? {};
console.log("account credit left USD:", c.total_credits != null ? (c.total_credits - c.total_usage).toFixed(4) : "unknown");
