# Wave 2 preparation: notes for the lead

Branch `worktree-agent-a6e330504e715f952`, five commits on top of `main` at `0cb7432`: contracts, scaffold, migration, briefs, these notes. Nothing pushed, nothing merged. No model call, no Vercel command, no hosted database.

## What is not finished or not proven

- **The isolation suite is red on this branch, for one expected reason.** `tests/security/contracts/identity-fields.test.ts` insists that every new request shape has an example in that file. That file belongs to the Wave 1 integration, so I did not touch it. The examples to paste are at the bottom of this file. The same walk already runs, and passes, for all the new shapes in `packages/contracts/src/wave2.test.ts`.
- **Two other tests in that suite fail when the whole suite runs, and pass on their own** (`store-roles.test.ts` "each role sees its own copy", `known-limits.test.ts` "it can also write B's rows"). The extra rows they trip on are written by the Data API tests in the same test world. I believe this is on `main` already and not from this branch, but I did not prove it on a clean `main`. The integration agent's own run of the suite passed while mine was running.
- **The loader in `@rms/seed` does not exist yet.** Tasks L (the sync) and I (sample numbers in previews) are written against a guessed signature. See question 2.
- **Snapshots of a sandbox are untested** (spike notes). Task I has a fallback and a time box.
- **The duplicate thresholds are starting values**, not measured. Task M measures them.

## Decisions I made, and why

1. **The mini-app's frame never holds a token. The RMS shell makes its Data API calls for it** (`frame.ts`). You asked for a hand-off that gives the frame a run token. I changed that, for three reasons. A preview frame is served from a public sandbox address, and a browser will not let such a page call an API on this machine without a permission prompt, so previews would not work in local development. A token that agent-written code never sees cannot be leaked by it. And the Data API then needs to accept browser calls from one origin (the web app), not from every sandbox address. The run token, its expiry and its refresh are still in the contract (`PreviewGrant`), between the API and the shell. The same shape serves published mini-apps with app tokens. Cost: every data call takes one extra hop inside the browser, and a mini-app opened on its own (no RMS around it) shows "Open this from RMS". If you want the original design back, it is one extra field on `rms.init` and one refresh message, plus opening the Data API to sandbox origins.
2. **The sandbox never calls RMS.** Its only open address is OpenRouter. That follows from decision 1 (the browser fetches preview data) and from running `propose_model_changes` and the models part of `catalog_lookup` on the platform, at plan time. So there is no RMS credential inside the sandbox at all, which is stricter than "only the run token". The price: the build agent cannot ask for a different model mid-build. It says so and the owner's next message starts a new plan.
3. **Generators first, agent second.** The planner (a server-side model call) returns the plan AND the generator calls. The runner runs those deterministically, shows the preview, and only then gives the build agent a turn to refine. C2 works without Codex. This is also the section 6 fallback, built in.
4. **Events are numbered across a session, and the stream is per session** (`/agent/v1/sessions/:id/events?after=`). One number replays and resumes a whole conversation. `user.message` and `user.reply` are stored events so a reload shows the owner's side too.
5. **The request that reads the stream moves the run along.** There is no background worker today. A lease on the run (two new columns) makes sure only one request does it. `run.paused` at 270 seconds, the browser reconnects.
6. **A build run ends as `waiting`, not `done`,** until the owner's next message or the session closes. The Data API only honours a run token while its run is running, paused or waiting, so this is what keeps the preview alive while the owner tries it. New event `run.waiting`.
7. **`preview.ready` carries no address.** The web app asks for a fresh `PreviewGrant` each time, so a stored event never holds a dead address.
8. **`AgentDriver` is now start, read, stop** instead of one long call, and `file_change` is gone (spike findings: turns outlive the function, Codex edits through shell commands, token counts on a resumed thread are running totals). ADR 0007 says the interface is unchanged: this changes it. Worth one line in an ADR.
9. **The template is Vite and React, static build.** Screens only, fast dev server, static output for Wave 3. Inside the sandbox it is installed with npm from a self-contained bundle (our packages packed into `vendor/`), because the sandbox has no workspace. `LOCKED_TEMPLATE_FILES` moved to `build.ts` and now matches the real template. Lint is done with the TypeScript compiler API in `rms check`, not ESLint: no new dependency.
10. **Ask has its own route** (`/ask`), so tasks I and K share no file. K also gets a **report tool** over the library's named queries. Without it the model would have to write the prime cost query from scratch (stock counts, purchases, postings), and beat 5 needs the right number.
11. **Ask SQL: tables by exact name from a list the platform loads for that restaurant.** A prefix rule is not enough, because an unqualified `pg_class` resolves to the catalog. The huge-cell gap is closed with a size probe that runs in the database first (`ASK_SIZE_PROBE`).
12. **Demo POS needs no stored secret.** The gateway mints a connection token per call. "Connect by address and token" is last in task L, with the checks it needs before a server calls an owner-typed address, and may not ship today.
13. **"You already have this" checks the owner's exact words first,** then the embedding. Beat 6 types the same request again, and I did not want that to depend on a similarity score.
14. **One shared model client** (`packages/agent/src/llm.ts`) and one set of HTTP helpers (`apps/api/src/lib/http.ts`), written now so three tasks do not each write their own. `/data/*` now answers browser calls from the web app's origin only (needed by decision 1). A test covers it.
15. **Package ownership:** the build driver and prompts live in `@rms/runner` (I). `@rms/agent` holds the shared client (lead) and Ask (K). The planner prompt and the per-turn prompt are I's. `AGENTS.md` is H's. All three start from `AGENT_RULES` in contracts, and a test keeps `AGENTS.md` word for word.

## The migration (`20261121120600_wave2.sql`)

Applied to the local database with `supabase migration up`. `db-walls.smoke.sh` prints `FAILS=0` (63 checks).

- Added: unique `(session_id, seq)` on `agent_events` and `seq >= 1`; `lease_owner`, `lease_until`, `driver_cursor`, `driver_state` on `agent_runs`; `requests text[]` on `app_profiles` (at most ten).
- Not added, on purpose: a vector index (a restaurant has a handful of mini-apps), the Demo POS catalog row (task L upserts it), any new table.
- **Tried and removed:** a unique index for "one active run per session". The isolation suite inserts several running runs into one session, so it broke six tests. The runner locks the session row instead. I had already applied it locally, so I dropped that one index by hand on the local database (as the local `postgres` user, 127.0.0.1 only) and took it out of the file. The file and the local database agree.
- If the integration's `20261121120500_*.sql` lands after this one is already applied locally, `migration up` will want `--include-all`.

## Questions for the lead

1. **Is the frame relay (decision 1) accepted?** Recommendation: yes. Tasks H and J both build on it, so settle it before they start.
2. **The seed loader: name, input and target store.** Recommendation: `loadSalesIntoStore(adminSql, orgUuid, data, { env: "live" | "draft", source })`, where `data` is the `days`, `deliveryPayouts`, `vendorBills`, `items`, `stockCounts`, `locations` and `currency` parts of `GeneratedSales`, and nothing else. L needs it to finish the sync. I needs the `draft` option so previews show sample numbers. Without `draft`, beat 2's preview is empty.
3. **Who adds the examples to `tests/security/contracts/identity-fields.test.ts`?** Recommendation: the integration agent, at its merge, from the block below.
4. **The OpenRouter key expires on 2026-11-22 at 18:26 UTC** and the account's own OpenAI key takes spend outside the key's limit (spike S1b). Recommendation: nothing to do for today. Note it for the rehearsal.
5. **New settings the tasks will ask for:** `RMS_SANDBOX` (`local` or `vercel`), `RMS_SANDBOX_SNAPSHOT_ID`, `RMS_LIVE`, and `RMS_SECRETS_KEY` only if L reaches custom connections. Recommendation: add the first two to `.env.local` when I reports its snapshot.
6. **"Try it on my phone" only works when the web app is reachable from a phone** (deployed, not `localhost`). Recommendation: accept for today, J says so on screen.

## New dependencies

| Package | Version | Where | Note |
|---|---|---|---|
| `@vercel/sandbox` | 4.1.0 | `packages/sandbox` | as proven in the spikes |
| `ai` | 7.0.177 | `agent`, `memory`, `runner` | NOT 7.0.179 (the newest): it was 20 hours old and pnpm's release-age guard refused it. pnpm tried to add an exception to `pnpm-workspace.yaml`. I reverted that and pinned the version before |
| `@openrouter/ai-sdk-provider` | 3.1.0 | `packages/agent` | |
| `libpg-query` | 18.2.4 | `packages/agent` | same version as `packages/data` |
| `@modelcontextprotocol/server`, `/client` | 2.4.0 | `packages/mcp` | |
| `@modelcontextprotocol/hono` | 2.0.2 | `packages/mcp` | |
| `vite` | 8.3.8 | `packages/app-template` | |
| `@vitejs/plugin-react` | 6.3.0 | `packages/app-template` | |

pnpm reports "Agent skills awaiting approval: ai". I did not run `pnpm approve`. Nothing needs it.

## What the architect reviewer should look at first

1. `packages/contracts/src/frame.ts`: the relay, the origin rules, and whether anything lets a frame name a restaurant, a token or an address.
2. `packages/contracts/src/agent.ts`: session-wide numbering, the run statuses (a build run stays `waiting`), the stop events, the new driver shape.
3. `packages/contracts/src/ask.ts`: `ASK_SQL_RULES` (is the function list short enough, is "tables by exact name" the right rule) and the size probe.
4. `packages/contracts/src/build.ts`: the locked list, `isLockedPath`, and that `propose_model_changes` is platform-only.
5. The migration, and whether the lease and cursor belong on `agent_runs` or should have stayed in `agent_sessions.state`.
6. `apps/api/src/index.ts`: `/data/*` now answers the web app's origin.

## Checks run

| Check | Result |
|---|---|
| `pnpm install` | passes, lockfile within pnpm's supply-chain rules |
| `pnpm typecheck` | 36 of 36 tasks pass |
| `pnpm build` | 20 of 20 pass, including the template's static build |
| `pnpm test` | 36 of 36 pass. New: 61 contract tests, 7 Demo POS shape tests against the real seed, 5 API helper tests, 3 model client tests, 3 manifest file tests, 11 `AGENTS.md` tests |
| `bash tests/security/db-walls.smoke.sh` | `FAILS=0` |
| `pnpm test:security` | 3 fail of 883: the one expected, and the two described at the top |

## Noticed, out of scope

- The scratchpad folder is shared by every agent in this session. My log file was overwritten by another agent's with the same name. Use names with your own prefix.
- The security suite uses one fixed test world. Two agents running it at once share rows.
- `rms-api` has no `vercel.json`, so nothing sets the function's time limit yet. Needed before the event stream is deployed.

## Examples to add to `tests/security/contracts/identity-fields.test.ts`

Paste into `SAMPLES`. They are the same values as `WAVE2_SAMPLES` in `packages/contracts/src/wave2.test.ts`, which passes.

```ts
CatalogLookupInput: { schema: c.CatalogLookupInput, value: { kind: "models", search: "vendors", name: "vendor" } },
ProposeModelChangesInput: { schema: c.ProposeModelChangesInput, value: { why: "To keep a list of suppliers.", changes: [{ op: "use_template", template: "vendor" }, { op: "add_field", model: "x_notes", field: { key: "extra", label: "Extra", type: "text" } }] } },
"RunGeneratorInput (list)": { schema: c.RunGeneratorInput, value: { generator: "list_detail", screen: "vendors", title: "Vendors", model: "vendor", fields: ["name"], form: true } },
"RunGeneratorInput (dashboard)": { schema: c.RunGeneratorInput, value: { generator: "dashboard", screen: "money", title: "Money", query: "weekly_pnl", stats: [{ label: "Sales", column: "net_sales", format: "money" }], chart: { label: "By day", category: "day", value: "net_sales", format: "money" } } },
CheckInput: { schema: c.CheckInput, value: { only: ["locked", "types"] } },
"ConnectRequest (catalog)": { schema: c.ConnectRequest, value: { kind: "catalog", key: "demo_pos" } },
"ConnectRequest (custom)": { schema: c.ConnectRequest, value: { kind: "custom", name: "My POS", url: "https://pos.example.com/mcp", token: "a-long-token-value" }, allowed: ["token"] },
ApproveToolsRequest: { schema: c.ApproveToolsRequest, value: { tools: ["get_daily_sales"] } },
SyncRequest: { schema: c.SyncRequest, value: { from: "2026-09-21", to: "2026-11-15" } },
DemoPosRangeInput: { schema: c.DemoPosRangeInput, value: { from: "2026-11-09", to: "2026-11-15", location: "downtown" } },
DemoPosNoInput: { schema: c.DemoPosNoInput, value: {} },
AskRequest: { schema: c.AskRequest, value: { sessionId: `ses_${hex}`, text: "What was my prime cost last week?" } },
DuplicateCheckRequest: { schema: c.DuplicateCheckRequest, value: { text: "I want to see how much money I am making" } },
```

The existing `AskQueryToolInput` and `StartRunRequest` examples in that file still parse.
