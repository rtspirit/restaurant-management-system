# Verified APIs (checked 2026-11-21)

Every fact below comes from a page opened on 2026-11-21. Versions come from the npm registry (`https://registry.npmjs.org/<pkg>/latest`) on the same day. "NOT CONFIRMED" means no official page said it. Do not treat those items as facts. Test them in the Wave 0 spike.

---

## Surprises and risks for today's build

1. **Firewall credential injection works, on Hobby too.** The Vercel Sandbox firewall can add or replace an `Authorization` header on outgoing HTTPS calls to an allowed domain. The key never enters the sandbox. This matches the plan. One SDK reference page still says "transformation and forwarding rules are available on Enterprise and Pro plans", but the 2026-08-05 changelog says all firewall features are now on Hobby. Trust the changelog, but check on the first sandbox create.
2. **Codex still needs some API key inside the sandbox.** The Codex SDK passes the key as `CODEX_API_KEY`. Give it a dummy value and let the firewall overwrite the header. NOT CONFIRMED that Codex starts and works with a dummy key. Test this first in the spike.
3. **Codex may use WebSockets to OpenAI.** Codex config has a `supports_websockets` setting for providers. NOT CONFIRMED that the firewall injects headers into a WebSocket upgrade. If the spike fails with 401, try disabling WebSockets or use the fallback in plan section 5.
4. **Codex is a Rust binary.** The firewall re-signs TLS with a per-sandbox CA. The sandbox sets `SSL_CERT_FILE` and similar variables. NOT CONFIRMED that Codex trusts that CA. If calls fail with TLS errors, this is the cause.
5. **The Codex SDK runs where the `codex` binary runs.** The SDK spawns `codex exec --experimental-json` as a child process. It cannot drive a remote sandbox. Either run a small Node script inside the sandbox, or call `codex exec --json` directly with `sandbox.runCommand` from the Vercel function and parse the JSON lines. The default sandbox image (`universal`) already has the `codex` CLI installed.
6. **Codex sandbox must be `danger-full-access` with approval `never`.** The Codex docs say: if the container is your security boundary, use `--sandbox danger-full-access` so Codex does not try to build a second sandbox. The approval value `untrusted` is retired in the docs, though the SDK type still lists it.
7. **Vercel Hobby limits are tight.** Function max duration is 300 s on Hobby. Sandbox sessions are max 45 minutes and 5 Active CPU hours per month. A Codex run streamed through one function call cannot last longer than 5 minutes on Hobby. Pro allows 800 s per function and 24 h sandbox sessions.
8. **Custom Postgres logins work through the pooler.** Use the username `[ROLE].[PROJECT-REF]`. This matches the plan.
9. **Transaction mode (port 6543) loses session state.** `SET ROLE` does not survive between transactions. Prepared statements are not supported. Put `SET LOCAL ROLE` inside each transaction (inference from the docs, see section 5), and set `prepare: false` in Drizzle / postgres.js.
10. **Supabase `anon` and `service_role` keys are deprecated by end of 2026.** Use `sb_publishable_...` and `sb_secret_...`. New projects sign JWTs with asymmetric keys by default, so the Hono API can verify with JWKS and `jose`.
11. **Next.js 16 renamed `middleware.ts` to `proxy.ts`.** The Supabase session refresh code goes in `proxy.ts`.
12. **TypeScript 7.0 is "latest" on npm but ships no JavaScript API.** typescript-eslint and other tools that import `typescript` break. Next.js 16 uses the `tsc` CLI and supports TS 7. Safest today: pin `typescript@6.0.3`, or keep TS 6 next to TS 7 via `@typescript/typescript6`.
13. **AI SDK v7 model strings go to Vercel AI Gateway by default.** A plain string like `"openai/gpt-6.2-sol"` routes through the Gateway, not OpenAI. To use our one OpenAI key, import `openai` from `@ai-sdk/openai` and call `openai('gpt-6.2-sol')`.
14. **MCP TypeScript SDK v2 is split into new packages.** Use `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (2.4.0), not `@modelcontextprotocol/sdk` (v1, bug fixes only). `createMcpHonoApp()` rejects non-localhost `Host` headers by default. On Vercel you must pass `allowedHosts`.
15. **Migrations with `CREATE ROLE ... PASSWORD '...'` would put secrets in git.** Create roles without a password in migrations, then set passwords by hand or from a secret store. (Our own rule, not from docs.)
16. **3072-dim embeddings cannot use an HNSW index on `vector`.** Max is 2,000 dimensions for `vector`. Use `text-embedding-3-small` (1536) or index `halfvec(3072)`.

### Model ids for env vars

| Env var | Id | Cheaper fallback |
|---|---|---|
| `RMS_BUILD_MODEL` | `gpt-6.2-sol` (Codex docs: "for everyday coding") | `gpt-6-luna` |
| `RMS_ASK_MODEL` | `gpt-6.2-sol` | `gpt-6-luna` |
| `RMS_EMBED_MODEL` | `text-embedding-3-small` (1536 dims) | none cheaper listed; `text-embedding-3-large` (3072) is the bigger one |

Use `gpt-6.2-astra` for `RMS_BUILD_MODEL` only if Sol fails the build tasks. It costs 4x Sol.

---

## 1. OpenAI Codex SDK

### Caveats and NOT CONFIRMED
- `developers.openai.com/codex/sdk` now redirects (308) to `https://learn.chatgpt.com/docs/codex-sdk`. The page is owned by OpenAI.
- Option and event details below come from the SDK source on GitHub `main` (`sdk/typescript/src/*`). npm `latest` is 0.171.0. `main` may be slightly ahead of the published version.
- NOT CONFIRMED: Codex works with a dummy `CODEX_API_KEY` while the Vercel firewall injects the real header.
- NOT CONFIRMED: Codex trusts the Vercel sandbox proxy CA.
- NOT CONFIRMED: whether the built-in `openai` provider uses WebSockets by default, and whether the firewall handles that.
- The SDK type still lists approval mode `"untrusted"`, but the sandboxing docs say it is retired. Use `"never"`.
- Codex requires a Git repo in the working directory unless you pass `skipGitRepoCheck: true`.
- Linux: the Codex sandbox needs `bubblewrap` (`bwrap`) or unprivileged user namespaces. We turn it off, so this does not matter for us.
- The `codex mcp-server` command was removed. Not relevant to us.

### Facts
- Package: `@openai/codex-sdk` **0.171.0**. Node >= 18. Depends on `@openai/codex` 0.171.0 (the CLI, pinned). Install: `npm install @openai/codex-sdk`.
- How it works: the SDK spawns the `codex` CLI and exchanges JSONL events over stdin/stdout. The CLI is installed as an npm dependency, with a per-platform binary package (for example `@openai/codex-linux-x64`). `codexPathOverride` points it at another binary.
- The Vercel Sandbox default image `vcr.vercel.com/vercel/sandbox/universal:latest` installs `@openai/codex` globally (its Dockerfile runs `codex --version`).
- API key: `apiKey` option, sent to the CLI as env var `CODEX_API_KEY`. The CLI also reads `CODEX_API_KEY` itself for `codex exec`.
- Base URL: `baseUrl` option, passed as `--config openai_base_url=...`.
- `env` option: when set, the CLI gets only these variables (no `process.env`), plus SDK-injected ones such as `CODEX_API_KEY`.
- Thread options: `model`, `sandboxMode` (`"read-only" | "workspace-write" | "danger-full-access"`), `workingDirectory` (sent as `--cd`), `additionalDirectories` (`--add-dir`), `skipGitRepoCheck`, `modelReasoningEffort`, `networkAccessEnabled`, `webSearchMode` (`"disabled" | "cached" | "indexed" | "live"`), `approvalPolicy` (`"never" | "on-request" | "on-failure" | "untrusted"`).
- Full access in Codex terms: `sandbox_mode = "danger-full-access"` with `approval_policy = "never"`. Docs: if the container is your boundary, use `danger-full-access` so Codex does not create a second sandbox layer.
- Events from `runStreamed()`: `thread.started` (has `thread_id`), `turn.started`, `turn.completed` (has `usage`), `turn.failed` (has `error.message`), `item.started`, `item.updated`, `item.completed`, `error`.
- Item types: `agent_message`, `reasoning`, `command_execution` (command, aggregated_output, exit_code, status), `file_change` (changes: path + kind add/delete/update), `mcp_tool_call`, `web_search`, `todo_list`, `error`.
- Custom tools: there is no in-process tool callback in the SDK. Tools come from MCP servers in Codex config: `mcp_servers.<id>.url` (streamable HTTP), `mcp_servers.<id>.bearer_token_env_var`, `mcp_servers.<id>.http_headers`, `enabled_tools`, `disabled_tools`, or `command`/`args` for stdio. Pass them with the SDK `config` option. Tip: let the firewall inject the MCP bearer token too, so it stays out of the sandbox.
- `openai_base_url`, `model_provider` and similar keys are ignored in a project-local `.codex/config.toml`. Pass them via the SDK or user-level config.
- Turn off analytics: config key `analytics.enabled` exists.

### Snippets

```ts
// Inside the sandbox (Node script), from the SDK README and source
import { Codex } from "@openai/codex-sdk";

const codex = new Codex({
  apiKey: "placeholder-firewall-replaces-it", // NOT CONFIRMED that this works
  config: { analytics: { enabled: false } },
});

const thread = codex.startThread({
  model: process.env.RMS_BUILD_MODEL,          // gpt-6.2-sol
  workingDirectory: "/vercel/sandbox/app",     // hypothetical path
  skipGitRepoCheck: true,
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  networkAccessEnabled: true,
});

const { events } = await thread.runStreamed("Add a menu items page");
for await (const event of events) {
  switch (event.type) {
    case "item.completed": console.log("item", event.item); break;
    case "turn.completed": console.log("usage", event.usage); break;
    case "turn.failed":    console.error(event.error.message); break;
  }
}
```

```bash
# Equivalent CLI call (what the SDK runs). --json is the documented alias of --experimental-json
codex exec --json --skip-git-repo-check --sandbox danger-full-access \
  --cd /path/to/app --model gpt-6.2-sol \
  --config approval_policy="never" "Add a menu items page"
```

### Sources
- https://developers.openai.com/codex/sdk (308 to https://learn.chatgpt.com/docs/codex-sdk)
- https://registry.npmjs.org/@openai/codex-sdk/latest
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/threadOptions.ts
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/codexOptions.ts
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/events.ts
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/items.ts
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/exec.ts
- https://developers.openai.com/codex/concepts/sandboxing.md
- https://developers.openai.com/codex/config-reference.md
- https://developers.openai.com/codex/llms-full.txt (CODEX_API_KEY table, Dev Containers / danger-full-access guidance, `--json` flag)
- https://raw.githubusercontent.com/vercel/sandbox/main/images/universal/Dockerfile

---

## 2. OpenAI models

### Caveats and NOT CONFIRMED
- The API models page does not name a "Codex" model. The Codex models page recommends GPT-6.2 Astra for demanding work and GPT-6.2 Sol for everyday coding. I picked Sol for cost.
- Codex docs: current Codex releases do not support Chat Completions-only endpoints (`wire_api = "chat"`). Codex needs the Responses API.
- GPT-5.5, `gpt-5.4`, `gpt-5.3-codex-spark` are retired from Codex with ChatGPT sign-in. API-key sessions are not affected, but do not use them.
- `gpt-6-luna` on Chat Completions supports function calling only with `reasoning_effort: "none"`. Use the Responses API (the AI SDK default) for tools.
- `gpt-6.2-astra` and `gpt-6.2-sol` reject `reasoning effort: none`.

### Facts
| Use | Id | Price per 1M tokens (in / out) | Notes |
|---|---|---|---|
| Flagship | `gpt-6.2-astra` | $8 / $40 | "most capable", 1,050,000 context |
| Balanced (recommended) | `gpt-6.2-sol` | $2 / $10 | "go-to model for everyday work, from coding to powering agents" |
| Cheap | `gpt-6-luna` | $0.10 / $0.50 | "most efficient model for focused, high-volume tasks" |
| Embeddings small | `text-embedding-3-small` | $0.02 | 1536 dims by default |
| Embeddings large | `text-embedding-3-large` | $0.13 | 3072 dims by default |

- Embeddings can be shortened with the `dimensions` parameter.

```bash
RMS_BUILD_MODEL=gpt-6.2-sol      # fallback gpt-6-luna; upgrade gpt-6.2-astra
RMS_ASK_MODEL=gpt-6.2-sol        # fallback gpt-6-luna
RMS_EMBED_MODEL=text-embedding-3-small   # 1536 dims
```

### Sources
- https://developers.openai.com/api/docs/models.md (platform.openai.com/docs/models redirects here)
- https://developers.openai.com/api/docs/models/gpt-6.2-astra.md
- https://developers.openai.com/api/docs/models/gpt-6.2-sol.md
- https://developers.openai.com/api/docs/models/gpt-6-luna.md
- https://developers.openai.com/api/docs/models/text-embedding-3-small.md
- https://developers.openai.com/api/docs/models/text-embedding-3-large.md
- https://developers.openai.com/api/docs/guides/embeddings.md (1536 / 3072)
- https://learn.chatgpt.com/docs/models.md (Codex recommended models; developers.openai.com/codex/models redirects here)

---

## 3. Vercel Sandbox

### Caveats and NOT CONFIRMED
- Conflict: the SDK reference `allow` section says "Transformation and forwarding rules are available on Enterprise and Pro plans". The changelog of 2026-08-05 says "All Vercel Sandbox firewall features are now available on the Hobby plan." The firewall concept page has no plan note. Assume Hobby works; verify on first create.
- Sandbox limits on the Pro **trial**: NOT CONFIRMED. The trial page lists general Active CPU (16 CPU-hrs) and memory limits and says sandbox failover regions are not available. It says nothing else about sandbox.
- Firewall matching is by TLS SNI. Plain HTTP cannot be filtered by domain.
- A matcher-scoped rule does not block other requests. Requests that match no rule still reach the allowed domain without the injected header. Add a final `{ response: { statusCode: 403 } }` rule to block them.
- Postgres connections can be allowed by domain (TLS required), but transforms do not apply to Postgres.
- Policy readback redacts header values (`"<redacted>"`). Keep your own copy of the policy for updates.
- `@vercel/sandbox` 4.1.0 needs Node >= 22.19.0.
- `sandbox.updateNetworkPolicy()` is deprecated. Use `sandbox.update({ networkPolicy })`.
- Sandboxes are persistent by default (auto-snapshot on stop). Pass `persistent: false` for one-off build sandboxes.

### Facts
- Package: `@vercel/sandbox` **4.1.0**. Also exports `@vercel/sandbox/proxy` (`defineSandboxProxy`).
- Default image: `vcr.vercel.com/vercel/sandbox/universal:latest` (Ubuntu 26.04, Node 24, Python 3.14, coding agents incl. Codex). Node-only images: `vercel/sandbox/node:22|24|26` (with pnpm).
- Working directory: `/vercel` on managed images. `sandbox.cwd` reads it.
- Default timeout 5 minutes. Extend with `timeout` on create or `sandbox.extendTimeout(ms)`.

| | Hobby | Pro |
|---|---|---|
| Max session | 45 minutes | 24 hours |
| Active CPU | 5 h/month included | $0.128/h |
| Memory | 420 GB-h/month included | $0.0212/GB-h |
| Creations | 5,000/month | $0.60 per 1M |
| Concurrent sandboxes | 10 | 10,000 |
| Max vCPUs / memory | 4 / 8 GB | 8 / 16 GB |
| Open ports | 15 | 15 |

- Hobby: when the quota runs out, sandbox creation pauses until 30 days after first use. No charges.
- Pro: usage first comes out of the $20/month credit.
- Auth from a Vercel function: OIDC token, automatic. Local script: `vercel link` then `vercel env pull` gives `VERCEL_OIDC_TOKEN` in `.env.local` (expires after 12 hours). Outside Vercel: pass `teamId`, `projectId`, `token`. An OIDC token belongs to one project; the sandbox is created in that project.

### Snippets

```ts
import { Sandbox } from "@vercel/sandbox";

// Create, deny all egress except OpenAI, inject the key outside the VM
const sandbox = await Sandbox.create({
  persistent: false,
  ports: [3000],
  timeout: 30 * 60 * 1000,
  networkPolicy: {
    allow: {
      "api.openai.com": [
        { transform: [{ headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }] },
      ],
    },
  },
});
// No "*": [] entry, so only listed domains are reachable.

// Run a command and stream logs
const cmd = await sandbox.runCommand({ cmd: "pnpm", args: ["dev"], cwd: "/vercel/app", detached: true });
for await (const log of cmd.logs()) {
  (log.stream === "stdout" ? process.stdout : process.stderr).write(log.data);
}

// Blocking command
const result = await sandbox.runCommand("node", ["--version"]);
console.log(result.exitCode, await result.stdout());

// Files
await sandbox.writeFiles([{ path: "hello.txt", content: Buffer.from("hi") }]);
const buf = await sandbox.readFileToBuffer({ path: "hello.txt" }); // null if missing

// Preview URL for a port listed in `ports`
const previewUrl = sandbox.domain(3000);

// Snapshot (stops the session) and restore
const snap = await sandbox.snapshot({ expiration: 14 * 24 * 60 * 60 * 1000 });
const next = await Sandbox.create({ source: { type: "snapshot", snapshotId: snap.snapshotId } });

// Change the policy live
await sandbox.update({ networkPolicy: "deny-all" });
```

Exact policy shapes from the docs:

```json
{
  "allow": {
    "api.example.com": [
      {
        "match": { "path": { "startsWith": "/v1/" }, "method": ["POST"] },
        "transform": [{ "headers": { "x-api-key": "your_api_key_here" } }]
      },
      { "response": { "statusCode": 403 } }
    ]
  }
}
```

- Modes: `"allow-all"` (default), `"deny-all"` (also blocks DNS), or a user-defined object.
- `allow` is either a list of domains or a map `domain -> rules[]`. Each rule has one action: `transform`, `forwardURL`, or `response`. Optional `match` with `path`, `method`, `queryString`, `headers` (each `exact`, `startsWith`, or `regex`).
- `subnets.allow` / `subnets.deny` take CIDR ranges. `subnets.deny` wins over all allows.
- Empty policy `{}` behaves as `deny-all`. `*.example.com` does not match `example.com`.
- The changelog says the firewall "adds or replaces the specified headers".
- For domains with rules, the firewall terminates TLS with a per-sandbox CA. The sandbox sets `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` and others to `/etc/ssl/certs/ca-certificates.crt`. The CA is also at `/usr/local/share/ca-certificates/vercel-proxy-ca.crt`.

### Sources
- https://vercel.com/docs/sandbox
- https://vercel.com/docs/sandbox/concepts/firewall
- https://vercel.com/docs/sandbox/sdk-reference
- https://vercel.com/docs/sandbox/pricing
- https://vercel.com/docs/sandbox/concepts/authentication
- https://vercel.com/docs/sandbox/concepts/images
- https://vercel.com/docs/sandbox/concepts/security
- https://vercel.com/docs/plans/pro-plan/trials
- https://vercel.com/changelog/full-sandbox-egress-firewall-now-available-on-hobby-plan
- https://vercel.com/changelog/safely-inject-credentials-in-http-headers-with-vercel-sandbox
- https://registry.npmjs.org/@vercel/sandbox/latest

---

## 4. Vercel AI SDK

### Caveats and NOT CONFIRMED
- Model strings (for example `"openai/gpt-6.2-sol"`) go through Vercel AI Gateway by default. Use the `@ai-sdk/openai` provider to hit OpenAI with our own key.
- The getting-started page uses `isStepCount(n)` for multi-step loops and `toUIMessageStream` + `createUIMessageStreamResponse`. Older names (`stepCountIs`, `toUIMessageStreamResponse`) are from earlier majors. NOT CONFIRMED whether they still exist in v7.
- The embeddings page shows both `openai.embeddingModel(...)` and `openai.embedding(...)`. NOT CONFIRMED which one is preferred.
- `ai` 7.x and `@ai-sdk/openai` 4.x need Node >= 22.

### Facts
- Packages: `ai` **7.0.179**, `@ai-sdk/openai` **4.0.122**, `@ai-sdk/react` **4.0.183**. Zod for schemas.
- The OpenAI provider uses the Responses API by default (`openai(id)` = `openai.responses(id)`). `openai.chat(id)` uses Chat Completions.
- `createOpenAI({ apiKey, baseURL })`. Defaults: `OPENAI_API_KEY`, `OPENAI_BASE_URL`.

### Snippets

```ts
// app/api/chat/route.ts (adapted from the AI SDK Next.js guide)
import { streamText, UIMessage, convertToModelMessages, tool, isStepCount,
         createUIMessageStreamResponse, toUIMessageStream } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const result = streamText({
    model: openai(process.env.RMS_ASK_MODEL!),
    messages: await convertToModelMessages(messages),
    stopWhen: isStepCount(5),
    tools: {
      weather: tool({
        description: "Get the weather in a location",
        inputSchema: z.object({ location: z.string() }),
        execute: async ({ location }) => ({ location, temperature: 72 }),
      }),
    },
  });
  return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) });
}
```

```tsx
// Client
"use client";
import { useChat } from "@ai-sdk/react";
const { messages, sendMessage } = useChat(); // POSTs to /api/chat by default
// render message.parts; part.type === "text" -> part.text
```

```ts
// Embeddings
import { embed, embedMany } from "ai";
import { openai } from "@ai-sdk/openai";
const { embedding } = await embed({
  model: openai.embedding(process.env.RMS_EMBED_MODEL!),
  value: "sunny day at the beach",
});
```

### Sources
- https://ai-sdk.dev/docs/getting-started/nextjs-app-router
- https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- https://ai-sdk.dev/docs/ai-sdk-core/embeddings
- https://ai-sdk.dev/providers/ai-sdk-providers/openai
- https://registry.npmjs.org/ai/latest, https://registry.npmjs.org/@ai-sdk/openai/latest, https://registry.npmjs.org/@ai-sdk/react/latest

---

## 5. Supabase database and auth

### Caveats and NOT CONFIRMED
- `SET LOCAL ROLE` in transaction mode: the docs say `set`/`reset` and other session state are lost between transactions, and to "run them inside the transaction that needs them". They do not mention `SET LOCAL ROLE` by name. Using `SET LOCAL ROLE` inside `BEGIN ... COMMIT` is our inference. The login role must be a member of the target role (standard Postgres; not from Supabase docs).
- Prepared statements are not supported by the shared pooler in transaction mode. Drizzle / postgres.js: `prepare: false`.
- Query pipelining is not supported in transaction mode.
- Each "user + database + mode" combination gets its own pool of up to "Pool Size" connections. Many custom login roles can exhaust Postgres connections.
- Whether custom roles need `GRANT USAGE ON SCHEMA extensions` to use the `vector` type: NOT CONFIRMED.
- Disabling the Data API does not stop Auth: NOT CONFIRMED on the page, but the page only talks about REST/GraphQL data endpoints.
- `@supabase/ssr` `setAll` also receives cache headers (`Cache-Control`, `Expires`, `Pragma`) that the Supabase guide says to apply to the response. The Next.js example template ignores them.
- The pooler host cannot be built from the region (`aws-[INDEX]-[REGION]`). Copy it from the dashboard Connect dialog.

### Facts
- Connection strings:
  - Direct (IPv6 only unless IPv4 add-on): `postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres`
  - Shared pooler, session mode (IPv4): `postgresql://postgres.[PROJECT-REF]:[PASSWORD]@[POOLER-HOST]:5432/postgres`
  - Shared pooler, transaction mode (IPv4, for serverless): `postgresql://postgres.[PROJECT-REF]:[PASSWORD]@[POOLER-HOST]:6543/postgres`
  - Pooler host format: `aws-[INDEX]-[REGION].pooler.supabase.com`
- Custom roles through the shared pooler: "If you connect as a custom role through the shared pooler, the username is `[ROLE].[PROJECT-REF]`." Create with `create role "role_name" with login password '...';`. Percent-encode special characters in passwords.
- Data API: new objects in `public` are exposed by default. Two ways to close it:
  1. Dashboard > Integrations > Data API > turn **Enable Data API** off. "None of the auto-generated REST endpoints respond, regardless of grants or RLS."
  2. Or turn off **Automatically expose new tables**, and only add schemas to "Exposed schemas" on purpose.
- pgvector: `create extension vector with schema extensions;` Columns: `extensions.vector(1536)`. HNSW index max 2,000 dims for `vector`, 4,000 for `halfvec`.
- API keys: `sb_publishable_...` (safe in browser) and `sb_secret_...` (server only, bypasses RLS). `anon` and `service_role` are deprecated "by the end of 2026". Both systems work side by side.
- JWT: new projects use asymmetric signing keys by default (ES256 recommended). JWKS at `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`. HS256 shared secret is "not recommended"; if you must, verify via `GET /auth/v1/user`.
- Next.js: `@supabase/ssr` **0.12.7**, `@supabase/supabase-js` **2.119.2** (Node >= 22). Use `supabase.auth.getClaims()` to protect pages. It verifies the signature (locally with asymmetric keys).

### Snippets

```ts
// lib/supabase/server.ts (from vercel/next.js examples/with-supabase)
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch { /* called from a Server Component; proxy refreshes sessions */ }
        },
      },
    },
  );
}
```

```ts
// proxy.ts (Next.js 16; was middleware.ts)
import { updateSession } from "@/lib/supabase/proxy"; // creates a server client on the request, calls supabase.auth.getClaims(), returns supabaseResponse
import { type NextRequest } from "next/server";
export async function proxy(request: NextRequest) { return await updateSession(request); }
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
```

```ts
// Hono API: verify a Supabase access token (jose 6.2.18)
import { createRemoteJWKSet, jwtVerify } from "jose";
const PROJECT_JWKS = createRemoteJWKSet(
  new URL(`https://${process.env.SUPABASE_PROJECT_REF}.supabase.co/auth/v1/.well-known/jwks.json`),
);
export async function verifyProjectJWT(jwt: string) {
  return jwtVerify(jwt, PROJECT_JWKS); // add issuer/audience checks as needed
}
```

```ts
// Drizzle over transaction mode (prepare: false from the Supabase table)
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
const client = postgres(process.env.DATABASE_URL!, { prepare: false });
export const db = drizzle(client);
// per request: await db.transaction(async (tx) => { await tx.execute(sql`set local role o_123_reader`); ... });
```

### Sources
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI
- https://supabase.com/docs/guides/database/postgres/roles
- https://supabase.com/docs/guides/api/securing-your-api
- https://supabase.com/docs/guides/api/using-custom-schemas
- https://supabase.com/docs/guides/database/extensions/pgvector
- https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes
- https://supabase.com/docs/guides/auth/server-side/nextjs
- https://supabase.com/docs/guides/auth/signing-keys
- https://supabase.com/docs/guides/auth/jwts
- https://supabase.com/docs/guides/api/api-keys
- https://raw.githubusercontent.com/vercel/next.js/canary/examples/with-supabase/lib/supabase/server.ts (and `lib/supabase/proxy.ts`, `proxy.ts`, `lib/supabase/client.ts`)

---

## 6. Supabase CLI

### Caveats and NOT CONFIRMED
- No page says "db push supports non-public schemas" in those words. Migrations are plain SQL files run in order, so `create schema platform;` works like any other statement. Inference, not a quote.
- Do not change the remote database in the dashboard SQL editor once you use migrations. `db push` then fails with sync errors.
- Custom roles have their own path: `supabase db push --include-roles` reads `supabase/roles.sql`. Role passwords in that file or in migrations would be committed. Keep passwords out of git.
- In CLI v3, `--linked`, `--project-ref`, `--db-url`, `--local` still work but are deprecated and removed in v4. Use `--remote`.

### Facts
- npm package `supabase` (CLI) **3.2.0**.
- Steps:

```bash
supabase login                    # personal access token
supabase link <project-ref>       # password optional; CI can set SUPABASE_DB_PASSWORD
supabase migration new create_platform_schema
supabase db push --remote         # applies files in supabase/migrations not yet in supabase_migrations.schema_migrations
supabase db push --remote --dry-run
supabase db push --remote --include-roles   # also applies supabase/roles.sql
```

- `supabase link` has `--skip-pooler` to use a direct connection.

### Sources
- https://supabase.com/docs/guides/deployment/database-migrations
- https://supabase.com/docs/reference/cli/supabase-db-push (also documents `supabase link`)
- https://registry.npmjs.org/supabase/latest

---

## 7. Hono on Vercel

### Caveats and NOT CONFIRMED
- Hobby max function duration is 300 s, even with streaming. A long SSE stream gets a 504 after that.
- Vercel recommends migrating from Edge to Node.js. Use the Node runtime (default, Fluid compute).
- Hono `serveStatic()` is ignored on Vercel. Static files go in `public/`.
- NOT CONFIRMED: SSE specifically (`streamSSE`) is named on the Vercel page. The page shows Hono `stream()` and says Vercel Functions support streaming. `streamSSE` is a standard Hono helper on top of the same streaming.

### Facts
- Zero config. Put a default-exported Hono app in one of: `app|index|server.{js,cjs,mjs,ts,cts,mts}` or the same names under `src/`.
- Routes become Vercel Functions on Fluid compute.
- Max duration (Fluid compute, Node): Hobby default 300 s, max 300 s. Pro default 300 s, max 800 s, beta extended 1800 s. Set `maxDuration` in `vercel.json` under `functions`.
- `hono` **4.13.19**.
- Local dev: `vc dev`.

```ts
// src/index.ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const app = new Hono();
app.get("/runs/:id/events", (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "status", data: "started", id: "1" });
  }),
);
export default app;
```

### Sources
- https://vercel.com/docs/frameworks/backend/hono
- https://vercel.com/docs/functions/limitations
- https://vercel.com/docs/functions/configuring-functions/duration
- https://vercel.com/docs/functions/runtimes/edge
- https://raw.githubusercontent.com/honojs/website/main/docs/helpers/streaming.md
- https://raw.githubusercontent.com/honojs/website/main/docs/getting-started/vercel.md

---

## 8. Next.js, monorepo deploy, tool versions

### Caveats and NOT CONFIRMED
- TypeScript `latest` is 7.0.2, which has no JavaScript API until 7.1 (TS team blog). typescript-eslint imports `typescript` and needs 6.0. Next.js `next build` runs the project-local `tsc` CLI by default, which supports TS 6 and 7 (docs page marked experimental). Recommendation: pin `typescript@6.0.3` today, or follow the blog and alias TS 6 via `@typescript/typescript6` (6.0.2).
- Next 16 builds with Turbopack by default. A custom `webpack` config makes `next build` fail.
- Built-in skipping of unaffected projects needs GitHub, workspaces, unique package names, and explicit `package.json` dependencies between packages.
- Pin pnpm with the `packageManager` field (Corepack). Vercel lists pnpm 6 to 12 as supported.

### Facts: deploy three apps to three Vercel projects
- One Vercel project per app. Set **Root Directory** to the app folder (`apps/web`, `apps/admin`, `apps/apps`).
- Vercel skips builds of unchanged projects automatically (does not use a build slot). Toggle under Settings > Build and Deployment > Root Directory > **Skip deployment**.
- If that does not fit, Ignored Build Step: `npx turbo-ignore --fallback=HEAD^1` (Vercel's default for Turborepo), or `turbo query affected --base=$VERCEL_GIT_PREVIOUS_SHA --packages <name> --exit-code`.
- Build command: `turbo run build` (filter inferred from Root Directory).
- List env vars in `turbo.json` so caches split per environment.
- Next.js 16: Node >= 20.9; `middleware.ts` renamed to `proxy.ts`; async request APIs; Turbopack default; React 19.2.

### Versions (npm `latest`, 2026-11-21)
| Package | Version | Note |
|---|---|---|
| next | 16.4.6 | Node >= 20.9 |
| pnpm | 12.21.0 | |
| turbo | 2.11.13 | `turbo-ignore` 2.11.13 |
| typescript | 7.0.2 | see caveat; 6.0.3 is latest 6.x |
| tailwindcss | 4.3.5 | |
| drizzle-orm | 0.45.4 | `rc` tag is 1.0.0-rc.6; stay on `latest` |
| drizzle-kit | 0.31.11 | |
| zod | 4.6.7 | |
| vitest | 5.1.1 | Node ^22.12 or ^24 or >= 26 |
| @playwright/test | 1.65.1 | |
| hono | 4.13.19 | |
| jose | 6.2.18 | |

### Sources
- https://nextjs.org/docs/app/guides/upgrading/version-16
- https://nextjs.org/docs/app/api-reference/config/next-config-js/useTypeScriptCli
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- https://vercel.com/docs/monorepos
- https://vercel.com/docs/monorepos/turborepo
- https://vercel.com/docs/package-managers
- https://registry.npmjs.org/-/package/<name>/dist-tags and https://registry.npmjs.org/<name>/latest for each package above

---

## 9. MCP TypeScript SDK

### Caveats and NOT CONFIRMED
- v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`) is the stable line, implementing the 2026-07-28 spec. v1 (`@modelcontextprotocol/sdk` 1.32.2) gets fixes for at least six months after 2026-07-27.
- `createMcpHonoApp()` binds to `127.0.0.1` by default and returns 403 for non-localhost `Host`/`Origin`. On Vercel pass `allowedHosts: ["<your>.vercel.app"]`. NOT CONFIRMED how the `host` option behaves on Vercel (there is no bind there); `allowedHosts` is the documented knob.
- `requireBearerAuth` returns 401 if `AuthInfo.expiresAt` is unset. Always fill it.
- The README middleware example and the Hono serving guide differ (`WebStandardStreamableHTTPServerTransport` vs `createMcpHandler`). The guide (`createMcpHandler`) is newer and stateless by default; use it.
- Keep the explicit `c: Context` type in the Hono handler, or `c.get('parsedBody')` does not compile.
- Codex's own SDK still imports types from v1 `@modelcontextprotocol/sdk`. Not a problem for our server.

### Facts
- Packages: `@modelcontextprotocol/server` **2.4.0**, `@modelcontextprotocol/client` **2.4.0**, `@modelcontextprotocol/hono` **2.0.2** (peer: `hono ^4.11.4`, server `^2.3.0`). Node >= 20. Schemas via Standard Schema (Zod v4 works, import `zod/v4`).
- v2 servers are stateless: a fresh `McpServer` per request, no session id. Good for Vercel functions.

### Snippets

```ts
// Hono route on Vercel with bearer auth (from the Hono and Authorization guides)
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler, McpServer, requireBearerAuth } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import * as z from "zod/v4";

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "rms", version: "1.0.0" });
  server.registerTool(
    "add-note",
    { description: "Append a note", inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({ content: [{ type: "text", text: `Saved: ${text}` }] }),
  );
  return server;
});

async function verifyAccessToken(token: string): Promise<AuthInfo> {
  // our own check (e.g. jose); throw OAuthError(OAuthErrorCode.InvalidToken) to reject
  return { token, clientId: "rms-app", scopes: ["mcp"], expiresAt: Math.floor(Date.now() / 1000) + 300 };
}
const gate = requireBearerAuth({ verifier: { verifyAccessToken }, requiredScopes: ["mcp"] });

const app = createMcpHonoApp({ allowedHosts: [process.env.MCP_PUBLIC_HOST!] });
app.all("/mcp", async (c: Context) => {
  const auth = await gate(c.req.raw);
  if (auth instanceof Response) return auth;
  return handler.fetch(c.req.raw, { authInfo: auth, parsedBody: c.get("parsedBody") });
});
export default app;
```

```ts
// Client: list tools and call one, with a bearer token
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthProvider } from "@modelcontextprotocol/client";

const authProvider: AuthProvider = { token: async () => process.env.MCP_TOKEN! };
const transport = new StreamableHTTPClientTransport(new URL("https://example.vercel.app/mcp"), { authProvider });
const client = new Client({ name: "rms-client", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
const result = await client.callTool({ name: "add-note", arguments: { text: "hi" } });
await client.close();
```

- NOT CONFIRMED: that `AuthProvider` is exported as a type from `@modelcontextprotocol/client` (the guide uses the name without showing the import).

### Sources
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/packages/middleware/hono/README.md
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/serving/hono.md
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/serving/authorization.md
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/serving/sessions-state-scaling.md
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/clients/machine-auth.md
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/get-started/first-client.md
- https://registry.npmjs.org/@modelcontextprotocol/server/latest, https://registry.npmjs.org/@modelcontextprotocol/client/latest, https://registry.npmjs.org/@modelcontextprotocol/hono/latest, https://registry.npmjs.org/@modelcontextprotocol/sdk/latest
