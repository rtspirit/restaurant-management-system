# Spike S1b: Codex in a Vercel Sandbox, model calls through OpenRouter

Run on 2026-11-21. One sandbox, 132 s long. Code: `spikes/s1b-openrouter/`. Builds on `s1-codex-in-sandbox.md`.

## The answer

**GO with Codex through OpenRouter.** It worked on the first try. Codex ran inside the sandbox with a dummy key. The firewall added the real key. A real model made real edits. Events streamed out as they happened. This also closes the gap the first spike left open (a full turn with a real model).

Three agent runs, all passed:

| Run | Model | Task | First event | Done | Model calls | Tokens in (cached) / out | Cost |
|---|---|---|---|---|---|---|---|
| 1 | `openai/gpt-6.2-sol` | the greeting task, new thread | 0.34 s | 9.4 s | 4 | 29,831 (21,998) / 431 | $0.026 |
| 2 | same, **follow-up on the same thread** | add a menu page from a JSON file and link it | 0.39 s | 13.8 s | 3 | 24,974 (23,850) / 871 | $0.014 |
| 3 | `anthropic/claude-sonnet-5.5` | both tasks in one go, new thread | 0.36 s | 8.6 s | 4 | 52,299 (38,680) / 992 | $0.048 |

Files read back after each run. Run 1: `<h1>Hello, Marigold Kitchen</h1>` and `<p>Open today</p>`. Run 2: `App.tsx` changed, `menu.json` added. Run 3: `App.tsx` changed, `Menu.tsx` and `menu.json` added.

## What did not work, or was not done

1. **The fallback tool loop was not tested.** Not needed. It stays the backup plan.
2. **No local dry run.** The `codex` CLI is not on this machine. The dry run was done inside the sandbox against a listener on localhost (no network, no model call).
3. **Privacy option cannot be sent by Codex.** Codex has no setting to add a field to the request body. See "Privacy".
4. **Codex warns `Model metadata for <id> not found`** for both models (Codex 0.169.0). It still works, with default settings.
5. **No `file_change` events.** With these models Codex edits through shell commands (`apply_patch` in a shell, or `cat > file`). They arrive as `command_execution`.
6. The TLS issuer line in the probe printed nothing (my filter was wrong). Codex's calls went through the firewall's certificate with no error.

## The config and commands that worked

```bash
# from spikes/s1b-openrouter/   (model ids are settings, passed by env var)
../../scripts/preflight-vercel.sh link --yes --project rms-api && bash pull-oidc.sh
export RMS_ENV_FILE=<repo>/.env.local RMS_BUILD_MODEL=<id> RMS_BUILD_CONTEXT=400000 RMS_EMBED_MODEL=<id>
node key.mjs && node direct.mjs            # key limit; Responses, chat, stateful fields, embeddings
node create.mjs && node probe.mjs && node codex.mjs
RMS_RESUME=<thread_id> RMS_TASK="<next task>" node codex.mjs     # follow-up turn
node stop.mjs && node stop.mjs --delete && node cost.mjs
```

```ts
// @vercel/sandbox 4.1.0, Hobby, 1 vCPU / 2 GB. Created in 0.27 s.
networkPolicy: { allow: { "openrouter.ai": [
  { match: { path: { startsWith: "/api/v1/responses" }, method: ["POST"] },
    transform: [{ headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, Host: "openrouter.ai" } }] },
  { response: { statusCode: 403 } },
] } }     // no "*" entry: every other host is blocked, DNS included
```

```bash
# inside the sandbox, run from the app folder, env: { RMS_LLM_DUMMY_KEY: "<any dummy text>" }
codex exec --json --skip-git-repo-check --cd /vercel/app --model "$RMS_BUILD_MODEL" \
  --config approval_policy='"never"' --config sandbox_mode='"danger-full-access"' \
  --config analytics.enabled=false --config check_for_update_on_startup=false \
  --config web_search='"disabled"' --config features.image_generation=false \
  --config model_context_window=400000 \
  --config model_provider='"rmsllm"' \
  --config model_providers.rmsllm.name='"OpenRouter through the firewall"' \
  --config model_providers.rmsllm.base_url='"https://openrouter.ai/api/v1"' \
  --config model_providers.rmsllm.env_key='"RMS_LLM_DUMMY_KEY"' \
  --config model_providers.rmsllm.wire_api='"responses"' \
  --config model_providers.rmsllm.supports_websockets=false \
  "<task>" </dev/null | tee /vercel/codex-events.jsonl
# follow-up turn: codex exec resume <thread_id> --json --skip-git-repo-check --model ... <same --config lines> "<task>"
# ("exec resume" has no --cd and no --sandbox flag. Run it from the app folder; sandbox_mode comes from --config.)
```

**Proven in the sandbox**

- **Other hosts blocked.** `example.com`, `api.openai.com`, `registry.npmjs.org`, `github.com`, `eu.openrouter.ai` do not resolve. Plain HTTP to an IP is reset.
- **Key added by the firewall.** `POST /api/v1/responses` with no auth header returned 200 with a model answer. Codex sends the dummy as its header, and its calls were accepted, so the header is replaced.
- **The path rule works** (untested in the first spike). `GET /api/v1/key`, `/models`, `/credits`, `/`, `POST /chat/completions` and `POST /api/v1/keys` all got 403 from the firewall. A wrong `Host` header got `403 request authority does not match SNI`.
- **Key not inside.** No credential-like env var. Zero `sk-...` matches in any process environment or command line. File scan: 4 distinct `sk-...` strings, none starts with `sk-or-`, none equals the key (compared by hash, outside). Policy readback shows only `{"allow":["openrouter.ai"]}`. The dummy is not written to `~/.codex`.
- **What Codex sends** (captured on localhost): one `POST /v1/responses`, `stream: true`, **`store: false`, no `previous_response_id`**. So OpenRouter's "no stored state" rule is not a problem. Tools sent: `exec_command`, `write_stdin`, `request_user_input`, `view_image`, `multi_agent_v1`, `get_goal`, `create_goal`, `update_goal`. **No web search and no image tool.** No model-list call.
- **Events seen:** `thread.started`, `turn.started`, `item.started` and `item.completed` (`command_execution`, `agent_message`, `error` for the metadata warning), `turn.completed` with usage. The same lines were also saved in the sandbox file (24 lines after two turns).

**Direct checks from this machine**

- `GET /api/v1/key` works and gives the limit. `POST /responses` and `POST /chat/completions` both work for the build model, and both made a correct tool call.
- `store: true` and `previous_response_id` each return 400 ("not supported on this proxy"). `store: false` is fine.
- Cost: no cost header. The response body has `usage.cost`, `usage.is_byok` and `usage.cost_details.upstream_inference_cost`. The `x-generation-id` header (also stored in Codex's session file) can be looked up with `GET /api/v1/generation?id=...` for cost, provider and timing.

## Models, prices and what each run cost

| Use | Id (from the live list, 476 models) | Context | Price per 1M (in / out) |
|---|---|---|---|
| Build, first choice | `openai/gpt-6.2-sol` | 1,050,000 | $2 / $10 |
| Build, other lab | `anthropic/claude-sonnet-5.5` | 1,000,000 | $2 / $10 |
| Embeddings | `openai/text-embedding-3-small` | 8,192 | $0.02 |

- Agent runs: $0.040 for Sol (runs 1 and 2), $0.048 for Sonnet (run 3). Direct calls and the probe: under $0.003. **Whole spike: about $0.09.**
- Key limit: $50.00 before, **$49.95 after**. Account credit: $36.78 before, $36.74 after.
- Sandbox: 132 s session, **9.9 s active CPU**, 1.06 MB in, 0.64 MB out. Stopped and deleted. None left.
- **Surprise: the OpenRouter account seems to have its own OpenAI key saved in it.** OpenRouter marked the Sol and embedding calls `is_byok: true`, provider "OpenAI", and charged $0 for them. That means the $0.041 was billed by OpenAI to that saved key's account, not to OpenRouter credit. The $50 key limit does not count this spend (`include_byok: false`). I did not open the account settings to confirm.

## Privacy option and its effect

- The field is `provider: { data_collection: "deny" }` (refuse providers that keep or may train on prompts). The stricter one is `provider: { zdr: true }` (zero data retention only).
- Both models still route with both options on (200 each). Embeddings route with `data_collection: "deny"`.
- Effect seen on Sol: with `data_collection: "deny"` alone it still used the account's own OpenAI key. With `zdr: true` added it used OpenRouter's own OpenAI route and was charged to OpenRouter credit.
- **The build agent cannot send this field.** For Codex, set it on the OpenRouter side: account privacy settings, or a guardrail on the build key. Not tested (it changes account settings; Rahul's call). The Ask agent and embeddings run in our own functions and can send the field on every call.

## Embeddings

Yes. `POST /api/v1/embeddings` with `openai/text-embedding-3-small` returned one vector of **1536** numbers. 2 tokens, $0.00000004. The 1536-dimension plan stays.

## What changes for the Wave 2 runner (compared with the first spike's plan)

- Firewall: allow `openrouter.ai` only, with the path rule above. Codex provider block as above. Model ids in OpenRouter's form.
- **Follow-up turns are proven**: `codex exec resume <thread_id>` in the same sandbox. `thread_id` is in the first event.
- **Writing events to a file in the sandbox is proven** (`tee`, append on resume). Reading on from a line number past 300 s is still untested.
- **Do not rely on `file_change` events.** Work out what changed by comparing the app folder (or `git status`) after each turn.
- **Usage on a resumed turn is the thread's running total**, not the turn's. Subtract the previous total. For money, read the `gen-...` ids from Codex's session file and ask `GET /generation`, or use the change in `GET /key`.
- A small build step took 9 to 14 s and $0.01 to $0.05. Package installs, snapshots and long runs are still untested.

## Open risks

1. **Spend through the account's own OpenAI key is outside the key limit.** It also depends on that OpenAI account having credit (the reason for ADR 0007). Decide: remove that key from OpenRouter, or turn on "include in limit" for the build key.
2. **The key expires on 2026-11-22 18:26 UTC.** The account credit ($36.74) is lower than the key limit ($50).
3. **Anything in the sandbox can spend the key** on any model through `POST /responses`. Add a guardrail with an allowed-model list and a small cap on the build key.
4. **Privacy for the build agent is not enforced yet** (see above).
5. **Model metadata warning.** Codex uses default settings for both ids. Pin a newer Codex in a prepared snapshot and test again. OpenRouter's guide loads its model list through an `auth` command; that needs one more firewall path and is untested.
6. **Extra tools.** Codex offers the model `multi_agent_v1`, goals, `request_user_input` and `view_image`. Harmless here. Consider turning them off.
7. Only small tasks were run. A real build step with installs and a dev server is not measured.
