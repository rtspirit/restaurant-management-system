# Spike S1: Codex inside a Vercel Sandbox, key kept outside

Run on 2026-11-21. One sandbox, 4 min 50 s long. Code: `spikes/s1-codex-sandbox/`.

## The answer

**GO, with one thing still to prove.** Use the `codex` CLI inside the sandbox (`codex exec --json`), started by the Sandbox SDK's `runCommand`. Turn Codex's WebSockets off. The key stays in the firewall rule and never enters the sandbox.

**Not proven: one full turn with the real model.** The OpenAI account has no credits. Every model call came back `429 insufficient_quota / credit_balance_exhausted`, for `RMS_BUILD_MODEL` and for the cheaper fallback. That answer comes after sign-in, so it also proves the key was added and accepted. The fallback in step 7 uses the same account, so it could not be tested either.

To cover the gap, the edit was run with a **scripted stand-in for the model** on localhost inside the sandbox. The Codex binary, its tools, the file edit and the event stream were all real. Once credits are added, run `node codex.mjs --no-ws` once to close this (about 5 minutes).

## What did not work, and why

1. **Real model turn.** No credits on the account. Not a design problem.
2. **Codex's default transport.** Codex 0.169.0 tries a WebSocket to `api.openai.com/v1/responses` first. Through the firewall it fails with `Attack attempt detected`, retries 5 times (about 13 s), then falls back to plain HTTPS, which works. The text comes from Codex's own WebSocket library, not from Vercel or OpenAI. Likely cause: the firewall sends the `101` answer in about 62 tiny pieces (15 bytes each on average), and the library treats many tiny reads as an attack. Measured, not fully proven. `curl` replaying Codex's exact handshake gets a clean `101`.
3. **Model list refresh.** In default mode Codex logs `failed to refresh available models: request timed out` and waits 5 s before the first event. With the custom provider below this does not happen.
4. **Fetching the token through the guard.** `link` works but cannot fetch the token, and `env pull` stops: the guard sets `VERCEL_ORG_ID`, and the CLI then demands `VERCEL_PROJECT_ID`. Fix used: set `VERCEL_PROJECT_ID` to the id in `.vercel/project.json` after checking team and project name (`pull-oidc.sh`). The guard allows this variable.

## The config and commands that worked

```bash
# from spikes/s1-codex-sandbox/
../../scripts/preflight-vercel.sh link --yes --project rms-api
bash pull-oidc.sh        # runs: VERCEL_PROJECT_ID=<id> ../../scripts/preflight-vercel.sh env pull .env.local --yes
RMS_ENV_FILE=<repo>/.env.local node create.mjs && node probe.mjs && node codex.mjs --no-ws && node stop.mjs
```

```ts
// @vercel/sandbox 4.1.0, Hobby plan, OIDC token from `vercel env pull`
await Sandbox.create({
  name, persistent: false, timeout: 10 * 60 * 1000, resources: { vcpus: 1 },   // 1 vCPU, 2 GB is accepted
  networkPolicy: { allow: { "api.openai.com": [
    { transform: [{ headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, Host: "api.openai.com" } }] },
  ] } },   // no "*" entry: every other host is blocked, DNS included
});
```

```bash
# inside the sandbox, via sandbox.runCommand({ detached: true, env: { CODEX_API_KEY: "<any dummy text>" } })
codex exec --json --skip-git-repo-check --sandbox danger-full-access --cd /vercel/app \
  --model "$RMS_BUILD_MODEL" \
  --config approval_policy='"never"' --config analytics.enabled=false --config check_for_update_on_startup=false \
  --config model_provider='"rmsfw"' \
  --config model_providers.rmsfw.name='"OpenAI through the firewall"' \
  --config model_providers.rmsfw.base_url='"https://api.openai.com/v1"' \
  --config model_providers.rmsfw.env_key='"CODEX_API_KEY"' \
  --config model_providers.rmsfw.wire_api='"responses"' \
  --config model_providers.rmsfw.supports_websockets=false \
  "<task>" </dev/null
```

Events are read with `for await (const log of cmd.logs())`, one JSON object per line on stdout.

## Answers to the NOT CONFIRMED items

| Item | Answer |
|---|---|
| Header injection on Hobby | **Yes.** Create succeeded. `curl https://api.openai.com/v1/models` with no auth header returned 200 (99 models, build model present). With a dummy header it also returned 200, so the header is replaced. |
| Other hosts blocked | **Yes.** `example.com`, `chatgpt.com`, `registry.npmjs.org`, `github.com` do not resolve. Plain HTTP to an IP is reset. |
| Key not inside | **Yes.** No credential-like env var. Zero `sk-...` matches in any process environment or command line. 35,223 files scanned: 4 distinct `sk-...` strings (license lists, docs), none equal to the key (compared by hash, outside). Policy readback shows only `{"allow":["api.openai.com"]}`. |
| Codex starts with a dummy key | **Yes.** It runs and its calls are accepted by OpenAI. The dummy is not written to `~/.codex`. |
| Codex trusts the firewall's TLS certificate | **Yes.** The sandbox sees issuer `Vercel Network Proxy CA`. Codex got OpenAI's answers through it with no TLS error. |
| WebSockets | Codex uses them by default. The firewall passes upgrades and adds the key (`101`). Codex's client still rejects the answer (see above). **Turn them off** with the custom provider. |
| Can the SDK drive a remote sandbox | **No, and not needed.** The image has `codex-cli 0.169.0` at `/usr/local/bin/codex`. `runCommand` plus `--json` gives the same events. |
| Codex's own sandbox | `danger-full-access` with `approval_policy="never"` works. No second sandbox, no prompts. |
| Bonus | The firewall itself answers `403 request authority does not match SNI` when the Host header differs from the allowed domain. Tested with the Host pin in place, not without. |

## Timings and resource use

| What | Result |
|---|---|
| Sandbox create | 0.2 s, already `running` |
| Codex, default transport | first event 5.5 s, gave up at 18.7 s (WebSocket retries, then the 429) |
| Codex, WebSockets off, real API | first event 0.18 s, OpenAI's answer (the 429) at 1.3 s |
| Codex, WebSockets off, stand-in model | first event 0.14 s, file changed at 0.8 s, done at 2.1 s. Events arrived as they were sent, not in one batch |
| Events seen | `thread.started`, `turn.started`, `item.started` and `item.completed` (`file_change`, `agent_message`, `error`), `turn.completed` with usage, `turn.failed`, `error` |
| File read back | `<h1>Hello, Marigold Kitchen</h1>` and `<p>Open today.</p>` (stand-in model run) |
| Sandbox use | 290 s session, **10.4 s active CPU**, 1 vCPU, 2 GB, 340 KB in, 222 KB out |
| OpenAI use | 4 model list calls, 3 empty WebSocket opens by hand plus Codex's own failed tries, about 4 model calls, all refused. **0 tokens.** |

## What this means for the Wave 2 runner

- **Start, do not hold.** The function starts Codex with `detached: true` and returns. Codex keeps running in the sandbox after the function ends. Have the command also write its events to a file in the sandbox.
- **Getting events out past 300 s.** Each function call streams for under 300 s, saves events and the last line number to the database, then ends. The next call does `Sandbox.get({ name })` and reads on from that line (tail the file, or `sandbox.getCommand(cmdId).logs()`). Not tested here.
- **Resuming a run.** Codex keeps each thread in `~/.codex/sessions` (here `/vercel/.codex`). A follow-up turn is `codex exec resume <thread_id> --json ...` in the same sandbox. `thread_id` is in the first event. Not tested here.
- **Snapshots.** Not tested. Sandboxes are persistent by default and snapshot on stop, which would keep both the app folder and `~/.codex`. Hobby sessions end at 45 minutes.
- **Installing packages** needs the registry. Open it first, install, then lock the policy with `sandbox.update({ networkPolicy })`, or start from a prepared snapshot.

## Open risks

1. **Real model turn unproven** until the account has credits.
2. **Anything in the sandbox can spend our key**, on any OpenAI endpoint, even though it cannot read it. Add match rules (only `POST /v1/responses`), a final `403` rule, and a project key with a spend cap. Matchers were not tested.
3. **Codex offers the model OpenAI's hosted `web_search` tool by default.** That runs at OpenAI, so our firewall does not stop it. Turn it off in config.
4. **`Model metadata for <build model> not found`** warning from Codex 0.169.0 (npm has 0.171.0). Codex falls back to default settings; build quality may suffer. Pin a newer Codex in a prepared snapshot.
5. **The WebSocket failure is a firewall and Codex mismatch.** Either side may change it. Keep the custom provider.
6. **The guard and `env pull`** need the `VERCEL_PROJECT_ID` step. Worth folding into the guard.
