# Wave 2 preparation: notes for the lead

Branch `worktree-agent-a6e330504e715f952`. `main` (with the Wave 1 integration) is merged in. On top of it: contracts 0.4.0, the package shells, one migration, the briefs, ADR 0008, and the changes from the architect review. Nothing pushed. No model call, no Vercel command, no hosted database, no demo reset.

## What is not finished or not proven

- **A build preview shows no numbers today.** A preview reads the draft store. The loader (`loadDemoBooks`) and the reset fill the live store only. So in beat 2 the accounts mini-app's preview shows its screens with "No numbers yet". Numbers appear in the published mini-app, after Demo POS is connected. If the preview must show sample numbers, the loader needs a way to write the draft store: a change in `@rms/seed` (lead-owned), not in any Wave 2 task. See question 1.
- **Demo POS answers are checked against what is loaded, not fed into it.** `loadDemoBooks` takes a template and regenerates the numbers. Task L calls the tools through the gateway for real, then loads with `seedDemoBooks`, then compares the two to the cent. A demo shortcut, written down in the brief.
- **A dev-server preview from a real sandbox has never been run.** It is now step 1 of task I and step 1 of task H, before anything else.
- **Sandbox snapshots are untested** (spike notes). Task I has a fallback and a time box.
- **The duplicate thresholds are starting values**, not measured. Task M measures them.
- **I could not check** how `seedDemoBooks` behaves once the hidden "Demo data" mini-app is paused after loading (that change is not on `main` yet). Task L is told to stop and report if a paused app blocks the load.

## For the rehearsal

- Before beat 3, reset with no sales: `pnpm reset-demo --no-sales`. The restaurants, their set-up data and the library tables exist, the books are empty. Connecting Demo POS and pressing "Bring in my sales" is what makes the numbers appear.
- Beat 5 (Ask) only has an answer after beat 3. Before it, Ask says there are no sales yet.
- Beat 2's preview has no numbers (above). Say so, or decide question 1.
- The web app runs on `localhost:3000`. Previews open from `127.0.0.1` or a sandbox address, never `localhost`.
- "Try it on my phone" needs the web app reachable from the phone (deployed, not `localhost`).
- The OpenRouter key expires on 2026-11-22 at 18:26 UTC.

## Decisions, and why

1. **The mini-app's frame never holds a token. The shell makes its Data API calls** (ADR 0008, accepted with changes). Hardened after review: one grant is bound to one frame and one origin; a relayed body has a size cap; a frame is never served from the web app's own host (`isSeparateSite`), and never from `localhost`; routes are named from a fixed list, never an address. `PreviewGrant` now has a sibling, `AppGrant`, for published mini-apps, so Wave 3 does not change the contract.
2. **The sandbox never calls RMS.** Its only open address is OpenRouter. `propose_model_changes` and the models part of `catalog_lookup` run on the platform at plan time. No RMS credential is inside the sandbox.
3. **Generators first, agent second.** The planner returns the plan and the generator calls. The runner runs them, shows the preview, and only then gives the build agent a turn. C2 works without Codex.
4. **Task I proves the sandbox preview first, and hands back at C2 with the API running locally.** The shell relays data calls, so the sandbox never needs to reach the API.
5. **Events are numbered across a session, and stored only through `appendAgentEvents` in `@rms/db`.** It locks the session row before it takes the next number, so a cancel and the request moving a run along cannot both store the same number. Tested with eight writers at once.
6. **The request that reads the stream moves the run along.** A lease on the run makes sure only one does. `run.paused` at 270 seconds.
7. **A build run ends as `waiting`, not `done`,** so its run token keeps working while the owner tries the preview.
8. **The locked files have one written rule** (`build.ts`): every file is locked, editable or ignored. The runner writes `rms.config.ts`, `.rms/catalog.json` and `.env.local`, THEN hashes every locked file, THEN writes `.rms/locked.json`, THEN lets anything run. `.env.local` is locked and runner-written. The check inside the sandbox only tells the agent early. The runner's own comparison from outside is the one that counts.
9. **Ask SQL has no dollar sign, anywhere, and no pattern replacement.** `askSqlPrecheck` refuses it before parsing. The size probe is `askProbeSql`, which joins strings. `askQuery` in `@rms/db` stays the one place a statement is wrapped: the tool calls it twice with plain text. The review's string is a test.
10. **The template is Vite and React, static build.** Its dev policy is a response header (a meta tag cannot set `frame-ancestors`), loose enough for Vite's own inline script.
11. **Ask has its own route and a report tool** over the library's named queries, so beat 5 does not depend on a model writing the prime cost query.
12. **Demo POS needs no stored secret.** The gateway mints a connection token per call.
13. **"You already have this" checks the owner's exact words first,** then the embedding. Profile requests append. The hidden `system` mini-app is skipped everywhere an owner's mini-apps are listed or compared.
14. **`AgentDriver` is start, read, stop** (spike findings). Recorded in ADR 0008.

## The migration (`20261121120600_wave2.sql`)

Applied to the local database. Wall checks print `FAILS=0`.

- Added: unique `(session_id, seq)` on `agent_events` and `seq >= 1`; `lease_owner`, `lease_until`, `driver_cursor`, `driver_state` on `agent_runs`; `requests text[]` on `app_profiles`.
- Not added, on purpose: a vector index, the Demo POS catalog row, any new table.
- Tried and removed: a unique index for one active run per session (it broke six isolation tests). I had applied it locally, so I dropped that one index by hand on the local database (as the local `postgres` user, 127.0.0.1 only). The file and the local database agree.

## Questions for the lead

1. **Should a build preview show sample numbers?** Recommendation: not today. Say "No numbers yet" in the preview and show the numbers after publish. If yes, `@rms/seed` needs a loader that can write a draft store.
2. **Is "tool answers are checked, not loaded" acceptable for beat 3?** Recommendation: yes for the demo. It is listed as a shortcut to undo.
3. **New settings the tasks will ask for:** `RMS_SANDBOX` (`local` or `vercel`), `RMS_SANDBOX_SNAPSHOT_ID`, `RMS_LIVE`, and `RMS_SECRETS_KEY` only if L reaches custom connections. Recommendation: add the first two when task I reports step 1.

## New dependencies

| Package | Version | Where | Note |
|---|---|---|---|
| `@vercel/sandbox` | 4.1.0 | `packages/sandbox` | as proven in the spikes |
| `ai` | 7.0.177 | `agent`, `memory`, `runner` | not the newest (7.0.179 was under a day old and pnpm's release-age guard refused it). The guard was left on |
| `@openrouter/ai-sdk-provider` | 3.1.0 | `packages/agent` | |
| `libpg-query` | 18.2.4 | `packages/agent` | same version as `packages/data` |
| `@modelcontextprotocol/server`, `/client` | 2.4.0 | `packages/mcp` | |
| `@modelcontextprotocol/hono` | 2.0.2 | `packages/mcp` | |
| `vite` | 8.3.8 | `packages/app-template` | |
| `@vitejs/plugin-react` | 6.3.0 | `packages/app-template` | |

pnpm reports "Agent skills awaiting approval: ai". I did not run `pnpm approve`. Nothing needs it.

## What a reviewer should look at first

1. `packages/contracts/src/frame.ts` and `docs/adr/0008-preview-relay.md`.
2. `packages/contracts/src/ask.ts`: `askSqlPrecheck`, `askProbeSql`, `ASK_SQL_RULES`.
3. `packages/contracts/src/build.ts`: the locked-file rule and its order.
4. `packages/db/src/events.ts`: the one way to store an event.
5. `packages/contracts/src/agent.ts`: run statuses, stop events, the driver shape.
6. `apps/api/src/index.ts`: `/data/*` answers the web app's origin only.

## Noticed, out of scope

- The scratchpad folder is shared by every agent in this session. Files with the same name overwrite each other. The briefs now say to prefix names.
- The security suite uses one fixed set of test restaurants. Two agents running it at once disturb each other.
- `rms-api` has no `vercel.json`, so nothing sets the function's time limit yet. Needed before the event stream is deployed.
