# Wave 2, task M: notes

Branch `worktree-agent-a8dc011f105c21e1e`, cut from `main` at `965830d` (the worktree started behind `main`; it was fast-forwarded first). Nothing pushed.

## Read first: the thresholds in the contract do not work with this embedding model

`DUPLICATE_THRESHOLDS` is `same 0.82, similar 0.70`. Measured with `openai/text-embedding-3-small` (RMS_EMBED_MODEL), no request that should match goes above 0.76. **With the contract values, only the word-for-word check ever says "you already have this".** Beat 6 still works, because the owner types the exact opening prompt again, and that is matched word for word before any embedding. But a reworded request never matches.

**Proposal for the lead (contract change, yours to make): `same: 0.60, similar: 0.38`.** The code reads `DUPLICATE_THRESHOLDS`, so changing the contract is all it takes. The live test asserts the demo cases with these values (`RECOMMENDED` in `packages/memory/test/thresholds.live.test.ts`). Keep that constant in step if you choose other numbers.

The gap is thin. The lowest true demo match is 0.403 ("am I making money?") and the highest unrelated request is 0.369 ("a recipe book for the kitchen", against Waste). A threshold between 0.38 and 0.40 separates them on these examples. More examples would make it safer.

## How a request is compared

1. **Word for word.** `normaliseRequest(text)` equals a stored request: `same`. No model call.
2. **Similarity.** For each of the restaurant's own mini-apps (not deleted, not `system`), the higher of:
   - the whole profile: cosine with the stored profile embedding, worked out **in the database** (`1 - (embedding operator(extensions.<=>) $1::extensions.vector)`), inside `withOrg` and with `org_id = rms.current_org()`
   - its best single line: cosine with its purpose, one capability or one earlier request.
   I added the second because whole-profile vectors cannot meet the demo cases at any threshold. Measured whole-profile: "billing and accounts" scored Vendors 0.430 above Money 0.421, and "am I making money?" (Money 0.295) tied with "I need a staff rota" (Money 0.288). Per line, Money comes first for all four demo phrasings. The lines come from the same fenced read as the candidates. They are embedded in the same call as the request, and line vectors are cached in the process by exact text (at most 2000). A vector depends only on the text and the model, so the cache tells nobody whose line it was. Cost: a few hundred tokens per check at demo size, about $0.00001.
3. **If the embedding call fails:** a cautious word-overlap check (share of the request's content words found in the profile, at least 0.5). It says `similar` at most, never `same`. The failure is logged as `{"area":"memory","event":"duplicate_embed_failed"}` with no request text. A build is never blocked.

`reason` is made from the purpose ("It already does this: weekly sales, costs, profit and prime cost."). No score leaves the server. The route test checks the response text has no "score", "similarity" or "distance".

## Live measurement (RMS_LIVE=1, real embeddings, repeatable run to run)

Restaurant A has three profiles. Money: "Weekly sales, costs, profit and prime cost.", capabilities "Weekly profit and loss / Prime cost by week / Sales by day", request "Build me an accounts app". Vendors: "Who I buy from and what I owe.". Waste: "What the kitchen throws away and why.". Score = the higher of whole profile and best line.

| Request | Kind | Scores |
|---|---|---|
| I want to see how much money I'm making | demo, must be Money | Money 0.431, Vendors 0.357, Waste 0.274 |
| show me my profit each week | demo, must be Money | Money 0.627, Waste 0.422, Vendors 0.313 |
| am I making money? | demo, must be Money | Money 0.403, Vendors 0.292, Waste 0.209 |
| billing and accounts | demo, must be Money | Money 0.494, Vendors 0.430, Waste 0.207 |
| I need a staff rota | demo, must be none | Vendors 0.325, Money 0.311, Waste 0.229 |
| what is my profit and loss | reworded Money | Money 0.758 |
| how is my prime cost doing | reworded Money | Money 0.540 |
| who are my suppliers | reworded Vendors | Vendors 0.589 |
| how much do I owe my suppliers | reworded Vendors | Vendors 0.735 |
| track what food we waste | reworded Waste | Waste 0.627 |
| count the cash in the till each night | related, different | Money 0.390 |
| a list of my staff and what I pay them | related, different | Vendors 0.509 |
| a booking system for tables | unrelated | Money 0.340 |
| a recipe book for the kitchen | unrelated | Waste 0.369 |
| remind me when the fridge needs servicing | unrelated | Waste 0.271 |

Whole-profile only (the first run, before per-line scoring): true matches 0.295 to 0.627, unrelated up to 0.37.

With 0.60 / 0.38, the demo verdicts are: "how much money I'm making" similar Money; "profit each week" same Money (then Waste); "am I making money?" similar Money; "billing and accounts" similar Money (then Vendors); "staff rota" none. Once the exact demo request is stored, it is `same` with no model call.

**Cross-restaurant:** restaurant B holds an identical Money profile, with a canary string and the exact demo request. In 7 checks from A, A never saw B's mini-app id or the canary. B's own check found only B's mini-app. The database test also proves row-level security alone hides A's profile from the API login fenced to B, using queries with no `org_id` filter: a canary search and a nearest-vector search. The same query run as A does find it, which shows the fence is doing the hiding.

**Spend:** about 2,000 embedding tokens over all runs (under $0.0001), plus three real summary calls on RMS_BUILD_MODEL, each with a few hundred tokens in (about $0.01 or less in all). The key's counter showed 0.0495 USD before and after: the whole key's total today, unchanged at its resolution. OpenRouter returned no per-call cost for embeddings, so `usage_events.cost_micros` is 0 for those rows. Token counts are recorded.

## What was built

- `packages/memory/src/profiles.ts`: `saveAppProfile` (requests append, row lock on the mini-app, embedding written only if the text is unchanged, refuses `system`, deleted and other restaurants' mini-apps, refuses a vector that is not 1536 numbers), `checkDuplicate`, `checkDuplicateWithThresholds` and `similaritiesForMeasurement` (for the live test only, never on a route).
- `packages/memory/src/summaries.ts`: `summariseSession` (owner-facing events only, at least two owner messages, events passed as a marked data block with `AGENT_RULES.untrusted`, zod-checked output, summary plus facts in `org_memory` with `source_session_id` and embeddings, older notes of the same session marked superseded), `recall`, and `recallBlock`. **Task I: put recalled notes in the planner's prompt only through `recallBlock(await recall(tenant))`.** It marks them as data.
- `packages/memory/src/models.ts`: the embedder and summariser behind one seam (`useMemoryModels` for tests); model calls through `@rms/agent` only.
- `packages/memory/src/text.ts`: request merging, word overlap, reason words, data block, vector checks.
- `apps/api/src/routes/memory.ts`: `POST /memory/v1/duplicates` and `GET /memory/v1/summaries` (owner only, newest first, at most 20).
- Tests: `packages/memory/test/text.test.ts`, `packages/memory/test/memory.db.test.ts` (fake embedder, local database), `packages/memory/test/thresholds.live.test.ts` (live, skipped unless `RMS_LIVE=1`), `apps/api/src/routes/memory.test.ts`.

Usage rows: `embed_input` (tokens) for every embedding call, `llm_input` and `llm_output` for every summary.

## Not done, on purpose or out of scope

- **The owner deleting memories, and a "What RMS knows" screen.** The brief puts editing and deleting memories out of scope, and `MEMORY_ROUTES` has no delete route. The owner can list summaries (`GET /memory/v1/summaries`). If you want delete for the demo: add `MEMORY_ROUTES.forget` (POST `{ id }`) to the contract, and I add a route that sets `deleted_at` inside `withOrg`. `recall` already skips deleted rows.
- `recall` takes `(tenant, { limit })` as the brief says, not `(orgUuid, text)`. It returns the latest notes, not the closest to a text.
- Marketplace matches, a vector index, any migration change.

## Files outside `packages/memory/**` and `routes/memory.ts`

- `apps/api/src/routes/memory.test.ts`, the route test, next to the route. Nobody else owns it.
- `docs/briefs/wave2-task-m-notes.md` (this file), as asked.

## Noticed, out of scope

- The worktree was created from an older `main` (`47ee539`) without the Wave 2 briefs. Other Wave 2 worktrees may have started there too.
- OpenRouter's embeddings response through `@openrouter/ai-sdk-provider` carried no cost in `providerMetadata`, so per-call spend for embeddings cannot be recorded from the response.
