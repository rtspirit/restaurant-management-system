// Step 1a: one cheap call. Does the key work, and what is its limit? Prints numbers only.
//   node key.mjs            key info
//   node key.mjs --models '<regex>'   also list matching model ids from the live model list (public endpoint)
import { loadKey, orFetch, scrubber } from "./lib.mjs";

const key = loadKey();
const scrub = scrubber(key);
const r = await orFetch(key, "/key");
const d = r.json?.data ?? {};
console.log("GET /key ->", r.status, `${r.ms}ms`);
console.log(scrub(JSON.stringify({
  limit: d.limit, limit_remaining: d.limit_remaining, limit_reset: d.limit_reset, usage: d.usage,
  usage_daily: d.usage_daily, is_free_tier: d.is_free_tier, expires_at: d.expires_at,
  effective_budget: d.effective_budget, is_management_key: d.is_management_key ?? d.is_provisioning_key,
})));
const c = await orFetch(key, "/credits");
console.log("GET /credits ->", c.status, scrub(JSON.stringify(c.json?.data ?? c.json?.error ?? null)));

if (process.argv.includes("--models")) {
  const m = await fetch("https://openrouter.ai/api/v1/models").then((x) => x.json());
  const all = m.data ?? [];
  console.log("models listed:", all.length);
  const want = new RegExp(process.argv[process.argv.indexOf("--models") + 1] ?? "."); // id filter, e.g. '^openai/'
  for (const x of all.filter((x) => want.test(x.id)).sort((a, b) => a.id.localeCompare(b.id))) {
    const p = x.pricing ?? {};
    console.log(` ${x.id} | ctx=${x.context_length} | in=$${(+p.prompt * 1e6).toFixed(2)}/M out=$${(+p.completion * 1e6).toFixed(2)}/M | created=${new Date(x.created * 1000).toISOString().slice(0, 10)} | tools=${(x.supported_parameters ?? []).includes("tools")}`);
  }
  const e = await fetch("https://openrouter.ai/api/v1/embeddings/models").then((x) => x.json()).catch(() => null);
  console.log("embedding models listed:", e?.data?.length ?? "endpoint failed");
  for (const x of (e?.data ?? []).filter((x) => want.test(x.id))) {
    console.log(` ${x.id} | ctx=${x.context_length} | in=$${(+x.pricing?.prompt * 1e6).toFixed(4)}/M`);
  }
}
