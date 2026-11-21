# Wave 2, task L: Demo POS server, gateway, connect screen

Branch `worktree-agent-af196bf9c0e288990` (fast-forwarded to `main` at `965830d` first). Nothing pushed. No Vercel command, no model call, no demo reset. Security review is still to be done (not by me).

## Fix round (security review and code review)

| Item | Fix | Test |
|---|---|---|
| Sign-up slower | `seedDemoBooks` defaults `draftSamples` to false; the reset passes true (`reset.ts`, the one lead-owned seed line I changed). New `ensureDraftSamples(adminSql, orgUuid)`: call it when a build starts. It skips with one indexed lookup when a `sample/` row exists. Sign-up's set-up: 0.8 s (was about 10 s). First fill: about 15 s. Already filled: 3 ms. **Task I or the lead must call `ensureDraftSamples` at build start.** | `books.draft.test.ts` |
| Call log kept key text | `redactArgs` keeps only short `[a-z0-9_]` keys; any other key becomes `(other)`; at most 20 names; summary capped at 1,000 characters. Tool names are filtered the same way. | `demo-pos.test.ts` |
| Failed sync still loaded | Every tool answer is compared, before loading, with exactly what the loader will load (`demoPosAnswer` for the same template and arguments). Any drift: `failed`, nothing loaded, no outbox row. The weekly check after loading stays as a second check. | drift test (one bill a cent out) |
| Allow checked names only | The view carries `toolsVersion` (the list's hash). Allow must send it back; it is rechecked under a row lock. `callTool` rechecks the stored list against its hash on every call. Allow writes an audit row (`connection.approve`, counts only). **Lead: please add `toolsVersion` to `ConnectionView` and `ApproveToolsRequest`.** The route takes it out of the body before the strict contract shape is checked. | API and mcp tests |
| Token lifetime, data while waiting | The Demo POS refuses a token made more than 60 seconds ago, whatever its expiry. While `needs_approval` it lists tools and every call answers with an error, no data. **Lead: please set `TOKEN_TTL.connection` to 60.** | mcp tests |
| Loader left on after a crash | Every load holds a per-restaurant loader lock (a transaction advisory lock, gone if the process dies). `sweepBooksLoader` pauses any loader app and removes any sample-numbers build whose restaurant has no load running. The sync runs it first. **Lead: please run it at API start-up too.** The sample-numbers run is also removed in a `finally`. The lock also means one load per restaurant at a time. | `books.draft.test.ts` |
| Name-based demo gate | The template comes from the restaurant profile (name, concept and cuisine), which only the platform writes. Restaurant logins can change the restaurant's name but not the profile. **A real demo flag column needs a schema change: lead.** | API and mcp tests |
| Change recorded after connecting | If recording or confirming the change fails, the connection is set to `error` with no grants. The next press records again. | not tested (needs a governance failure) |
| Error state on screen | "This connection needs attention. Connect it again to carry on." with **Connect again**. | not run in a browser |
| Host check | Kept mine (the SDK's check is Hono middleware for its own app, not a route mounted inside ours). Tests: another host on the right port, a sub-domain, upper case and another port, a trailing dot. A userinfo address cannot even be built into a request. | API test |
| Money format | `$84,310.00`. No progress messages during the sync (not quick to do with one plain request). | API test |

## Not done, or not proven

- **Connect by address and token (`kind: "custom"`) is not built.** The route answers "Connecting your own system is not available yet." (503). No secret is ever stored, so `RMS_SECRETS_KEY` is not needed yet. `disconnect` already deletes a stored secret if one exists.
- **The connect screen was not opened in a browser.** It typechecks and `next build` builds `/settings/connections`. Nobody has clicked through it yet.
- **An `mcp_calls` row for "another restaurant's connection id" cannot be written.** The same-restaurant foreign key (hardening migration) stops a row in restaurant B from pointing at A's connection. So the gateway answers `not_found` and writes no row. The ungranted tool, the write tool and bad arguments each write a `denied` row.
- **Sync time: about 13.5 seconds** for Marigold on this machine (the loader is 13.4 s of it; the nine gateway calls are well under a second). A second sync takes about as long and adds nothing. `rms-api` has no `vercel.json` yet, so nothing sets the function's time limit.
- **Sign-up and the reset are slower now.** `seedDemoBooks` fills the draft store by default (see below): about 10 seconds more per restaurant. `apps/api/src/routes/auth.ts` (lead-owned) calls it during sign-up. If that is too slow for the demo, pass `draftSamples: false` there.
- **On Vercel, untested.** The gateway calls the Demo POS at `API_URL` + `/mcp/demo-pos`, server to server. Vercel deployment protection, if on, would refuse that call.
- Once, a lead-owned seed test failed with a database deadlock while other agents were creating and dropping stores. Run alone, it passed.

## Demo shortcut (say it in the demo notes)

The loader regenerates the numbers from the same template the Demo POS serves (`loadDemoBooks` takes a template, not rows). So the tool answers are CHECKED against what was loaded, not fed into it. After loading, the sync adds up net sales per week from `get_daily_sales` and compares them, to the cent, with `prime_cost_by_week` for all eight weeks. If they differ it answers `failed`. A loader that takes rows from any connected system is later work. The same words are in a comment at the top of `packages/mcp/src/sync.ts`.

## Sample numbers in the draft store

`seedDemoBooks` has a new option, `draftSamples` (default `true`). The reset, sign-up and the books tests all get it.

- **What they are:** exactly the restaurant's own template numbers, the same eight weeks as live (Monday 21 September to Sunday 15 November 2026): sales days, payments, adjustments, gift cards, staff cost, supplier bills, stock counts and delivery payouts, all posted to the draft books. Marigold, week of 9 November: net sales $84,310.00, prime cost 61.3%. Slice Yard, same week: net sales $28,750.00.
- **How they are marked:** every sample row's `source_id` starts with `sample/` (`SAMPLE_SOURCE` in `@rms/seed`). Real numbers start with `demo-pos/`. Task J can show the "Sample numbers" tag on any preview (a preview always reads the draft store).
- **How they get in:** through the Data API like everything else, as the hidden "Demo data" mini-app. The Data API only lets a mini-app into a draft store during one of its builds, so the loader makes a closed session with one `running` run for the hidden app, loads, and deletes both straight after, whether the load worked or not. They hold no events and live for a few seconds.
- **The live store is never touched by this.** Loading twice adds nothing.
- `SeedBooksResult` gained `draft` (rows, posted, and the last week as the draft prime cost report shows it). `SeededBooks` gained `weeks` (every week of the prime cost report), used by the sync's check.

## What I built

- `packages/mcp/src/demo-pos/data.ts`: what each tool answers, as slices of `generateSales(template)`. Every answer is parsed with the tool's output shape before it is sent. The template comes from the restaurant's own name (`TEMPLATES`); any other restaurant gets empty lists.
- `packages/mcp/src/demo-pos/server.ts`: `serveDemoPos`. Checks the bearer connection token (`verifyConnectionToken`), then that the connection exists for THAT restaurant, is the Demo POS, and is `connected` or `needs_approval`. Then a fresh MCP server per request (`createMcpHandler`), registering exactly `DEMO_POS_TOOLS`, each marked read-only.
- `apps/api/src/routes/mcp-demo-pos.ts`: mounts it. No bearer header: 401. The request's host must be `API_URL`'s host (this is the `allowedHosts` check, done as one small middleware because the route is mounted inside the main app). Any `Origin` header (a browser): 403.
- `packages/mcp/src/gateway.ts`: `listTools` and `callTool`. Checks, in order: the connection is this restaurant's, it is `connected`, the tool is on the approved list, it is read-only, it is granted to that consumer, the arguments pass the input shape. Mints a fresh connection token per call, calls with the MCP client (20 seconds, redirects refused, address worked out from `API_URL`, never from a stored row), parses the answer with the output shape, keeps only the structured answer (text content is ignored), and writes one `mcp_calls` row: argument names and dates only.
- `packages/mcp/src/connections.ts`: catalog (the Demo POS row is upserted from code with `adminDb()`), connect, approve, disconnect, and the plain-words view. Connecting twice changes nothing. Connecting after a disconnect switches the same row back on and asks for a new yes.
- `packages/mcp/src/sync.ts`: the sync. Lists the tools again first: a different hash sets `needs_approval`, stops before anything is read and answers "Demo POS changed what it offers. Have a look before RMS reads from it again." Then `list_locations`, `get_stock_items` and the seven dated tools (one chunk: 57 days, from one day early for the opening count). Locations are matched by name. Then `seedDemoBooks(adminDb(), { ..., withSales: true, draftSamples: false })`, the check above, the outbox row `connection.synced`, and `last_synced_at`. Two syncs at once: the second is told "Already bringing in your sales" (a row lock on the connection).
- `apps/api/src/routes/connections.ts`: the six routes. `requireSession`, owner only, strict bodies (a body with `orgId` is refused). A new connection records a `new_connection` change set and confirms it at once with `confirmByOwner`, both on `adminDb()`: pressing Connect is the owner's yes.
- `apps/web/app/(shell)/settings/connections/page.tsx` and `apps/web/components/connections/connections-screen.tsx`: the catalog card, "Connect Demo POS", the plain list of what RMS will read (one line per tool, from its description) with Allow and Not now, then Bring in my sales with "Bringing in your sales. This takes a few seconds." and the result in plain words. `@rms/ui` only. No addresses, tool names or tokens on screen.
- `apps/web/app/(shell)/settings/page.tsx`: a "Connected systems" section linking to the new page.
- `packages/seed/src/books.ts`: the draft sample numbers and the `weeks` above.

## Checks

| Command | Result |
|---|---|
| `pnpm install` | done |
| `pnpm typecheck` | 36 of 36 tasks passed |
| `pnpm build` | 20 of 20 tasks passed (and a forced `next build` of the web app) |
| `pnpm exec turbo run test --continue` (same as `pnpm test`) | 36 of 36 tasks passed. New: `@rms/mcp` 24 tests (17 mine), `apps/api` connections 17 tests, `@rms/seed` draft 6 tests |
| `pnpm test:security` | 916 passed, 4 skipped, 14 files passed, 1 skipped |

What the new tests prove, on throwaway restaurants (ids `...40` to `...46`, stores `o_41414141410x`, all removed afterwards):

- End to end through the API, on a Marigold restaurant with NO sales: books empty, then connect, allow, bring in: 112 sales days, "Brought in 8 weeks of sales for 2 locations. Last week's sales: $84,310."; the prime cost report then shows week of 9 November at $84,310.00 and 61.3%. Again: `nothing_new`, same numbers, no new rows. Disconnect: no grants, the Demo POS refuses its token, a sync is refused.
- Demo POS: no token, a forged token, an expired token, a data token, another restaurant's connection, a connection that does not exist, a disconnected connection: all refused. A browser origin and another host: refused. Marigold's token gets $84,310.00 for the week and its two locations; Slice Yard's gets $28,750.00 and its own.
- Gateway: an ungranted consumer, a write tool, arguments outside the shape: refused with a `denied` row. Another restaurant's connection id: `not_found`, no row, and 404 on every route. A hostile answer (an "instructions" field, an extra field, instruction text in a name) is parsed down to the shape and kept as data; grants, status and books unchanged. An answer that does not fit is dropped with an `error` row.
- Changed tool list (a fake server with one description changed): the sync stops before any tool is called or anything loaded, the connection goes to `needs_approval`, and the screen text says so.
- A restaurant that is not a demo template: "Demo POS has no sales for this restaurant, so nothing was brought in."
- Routes refuse no token (401), staff (403) and a body with `orgId` (400).

## For the lead

- `apps/api/src/routes/auth.ts` (yours): sign-up now also fills the draft store, about 10 seconds. Keep it, or pass `draftSamples: false`.
- The "Demo data" mini-app is never created, published, paused or un-paused by the sync. `seedDemoBooks` does that, as before. A paused app did not block the load.
- No new dependencies. No contract, schema or migration change needed.

## Noticed, out of scope

- The security suite and the seed tests share one database with every agent. A drop of a store can deadlock with another agent's work at the same moment. Running again passes.
