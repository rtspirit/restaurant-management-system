# RMS Demo Build (today)

This file is what Claude Code works from today. The full plan is in [00-implementation-plan.md](./00-implementation-plan.md). Where the two differ, **this file wins for the demo**, and every shortcut here is listed so it can be undone later.

---

## 0. Read first

1. **The full plan is not a one-day build. This is a cut of it.** It delivers the whole demo story end to end on the real architecture, and leaves out what the audience will not see.
2. **The build loop (agent writing a mini-app in a sandbox) is the part most likely to slip.** The waves are ordered so there is something to demo at every checkpoint, and section 6 says what to fall back to.
3. **Vercel Sandbox on Hobby allows about 5 CPU hours a month and 45 minute sessions.** A day of building and rehearsing may use it up. If it pauses, start the Pro trial on the personal team.
4. **Demo shortcuts weaken two security layers** (one database instead of two, and possibly one query login instead of one per restaurant). Both are named in section 3 and must be restored before real users.

---

## 1. The demo story

| Beat | What the audience sees |
|---|---|
| 1 | An owner signs up, answers five onboarding questions, and lands in RMS. Their restaurant's profile, locations, staff and menu are already there (parent data) |
| 2 | Mini-apps, Build tab. The owner types "I want to see how much money I'm making". The agent asks up to three plain questions, shows a plan, and builds the accounts mini-app with a live preview |
| 3 | The owner connects "Demo POS". Eight weeks of sales flow in. The P&L and prime cost fill up |
| 4 | Publish. The mini-app appears in the RMS navigation and works on a phone |
| 5 | The owner asks the agent "what was my prime cost last week?" and gets the right number |
| 6 | The owner types the same build request again. The agent says "you already have this" |
| 7 | The owner shares the mini-app publicly. In the maintainer console the request is waiting. We approve it |
| 8 | A second restaurant signs up. The Marketplace recommends the accounts mini-app with a reason. They install it and see only their own numbers |
| 9 | Maintainer console: the change feed shows everything that just happened, by tier |

---

## 2. Demo stack

| Piece | Choice | Note |
|---|---|---|
| Web, admin, mini-app screens, API | Vercel, team `rtspirits-projects` (`team_RM4toarAtl8vljERLdxRvfeh`) | API is a Hono app deployed as Vercel functions today. It moves to Railway unchanged later |
| Database, sign-in, files, embeddings | **Supabase**, one project on the personal account | Postgres, Auth, Storage and pgvector in one place. Schema managed with the Supabase CLI or its MCP server from Claude Code |
| Build and preview | Vercel Sandbox, firewall on | The firewall attaches the OpenAI key to outgoing calls, so the key never enters the sandbox |
| Railway | **Not used today** | Returns with the server-logic runner and background workers |
| Agent | **OpenAI only**, one API key | Build: OpenAI Codex SDK inside the sandbox. Ask: OpenAI through the Vercel AI SDK. Embeddings for the duplicate check and recommendations: OpenAI. Model names come from env vars (`RMS_BUILD_MODEL`, `RMS_ASK_MODEL`, `RMS_EMBED_MODEL`), set to OpenAI's current recommended models at setup. The `AgentDriver` interface stays, so a Claude driver can be added later |

Three Vercel projects: `rms-web`, `rms-admin`, `rms-apps`. Their default `vercel.app` addresses are already separate sites to a browser, so no domains are needed today.

Supabase rules:
- Nothing of ours goes in the `public` schema. Supabase's auto-generated API stays unused and has nothing to expose.
- Connect through the pooler, not the direct address.
- Schemas: `platform` for platform tables, then `o_<id>_parent`, `o_<id>`, `o_<id>_draft` per restaurant.

---

## 3. In, simplified, not today

| Plan area | Today |
|---|---|
| Sign-up, restaurants, locations, roles | **In.** Supabase Auth. Owner and staff roles only |
| Parent data, one-way | **In.** Fake data (section 4). Read-only by database permission |
| Design system | **In, small.** Tokens, about fifteen components, four patterns: list with detail, form, dashboard, report table |
| Model library | **In.** Foundation, Sales, Finance packs. Others later |
| Data API | **In.** Token-scoped, manifest-checked, role-checked, audited. Filters, sorts, totals, batch writes, named queries |
| Build loop | **In.** Intake, duplicate check, plan, reuse-first data, generators, checks, preview |
| Publish | **In, simplified.** Screens only, served by `rms-apps`. No custom server logic in mini-apps today. Jobs are platform-run named queries |
| Ask agent | **In.** Read-only query tool with parser, read-only transaction, time and row limits |
| Memory | **In, small.** Mini-app profiles for the duplicate check, session summaries |
| MCP | **In, small.** Gateway, connect by URL with a token, one catalog entry (Demo POS) that we host |
| Governance | **In, small.** Change sets, rule-based tiers, console feed, approve and reject |
| Marketplace | **In.** Share, scrub, review, list by title and description only, install with table matching, Recommended for you |
| Theme customisation | **In, small.** Brand colour and logo |

**Shortcuts to undo before real users**

| Shortcut | Full plan |
|---|---|
| One database, platform and restaurant schemas side by side | Two databases |
| Query login: one per restaurant if the pooler allows custom logins (check in Wave 0). Otherwise one login that switches role, with the parser as the guard | Always one login per restaurant |
| API on Vercel functions | Railway services |
| No server logic in mini-apps | Locked runner |
| Change summaries written by rules only | Model-written summary on top |

**Not today**: the Claude driver, franchise roll-up, fleet rebuilds, cells, table partitions, budgets beyond a simple counter, impersonation, OAuth connections, Slack and email notices, webhooks, the Inventory, Labour, Guests and Operations packs.

---

## 4. Fake data

Two restaurants, seeded by a script that can reset everything in one command.

| | Marigold Kitchen | Slice Yard |
|---|---|---|
| Type | Full service, dinner-led | Counter-service pizza |
| Locations | 2 (Downtown, Riverside) | 1 |
| Staff | 24 | 9 |
| Menu | About 40 items, 6 categories, bar | About 20 items, 4 categories |
| Role in demo | Builds the accounts mini-app | Installs it from the Marketplace |

**Parent data per restaurant**: profile (concept, cuisine, service style, seats, price band), locations with hours and day cutoff, staff with jobs, menu with categories, items, modifiers and prices, tax rates, licences with expiry dates, equipment list.

**Child data, through Demo POS** (an MCP server we host, one token per restaurant): eight weeks of daily sales per location by category and payment type, discounts and comps with reasons, tips, sales tax, gift card activity, delivery payouts with commission lines, labour hours and cost by job group. Plus a sample vendor bills file to upload.

The numbers must be consistent: daily entries balance, cost of goods runs near 30% of sales, labour near 31%, so prime cost lands near 61% for Marigold. Slice Yard runs leaner. Weekends are busier. One week has an obvious dip to point at.

---

## 5. Waves

The lead (main session, most capable model) runs Wave 0 alone, then fans out. One worktree per task. Each task ends by running its checks. Tasks marked ★ use the most capable model. Others use Opus 5.5.

### Wave 0: foundation (lead, then designer)

- Monorepo scaffold, CI, `CLAUDE.md`, agent definitions, `packages/contracts` v0.
- Supabase project created and linked. Check whether custom database logins work through the pooler.
- Three Vercel projects on the personal team, with the preflight guard.
- ★ Spike, one hour at most: OpenAI Codex SDK inside a Vercel Sandbox, firewall on, editing a stub template and streaming events out. Codex has its own sandbox mode. Set it so it does not fight the Vercel one, since the Vercel sandbox is the boundary. If the spike fails, run the agent loop in a Vercel function that calls the OpenAI API and drives the sandbox by commands.
- Designer: `/impeccable init`, then two or three directions on real screens. **Checkpoint C0: Rahul picks the look.**

### Wave 1: platform base (parallel)

| Task | Done when |
|---|---|
| A. Sign-up, restaurants, roles, onboarding | Two owners can sign up and land in an empty RMS |
| B. Parent data tables, seed script, one-way copy | Both restaurants show profile, staff, menu. A write to a parent schema fails at the database |
| C. ★ Model definition format, compiler, three packs, store provisioning | A restaurant store can be created with live and draft schemas from definitions |
| D. ★ Data API | Reads and writes work only with a valid token, only for models in the manifest, only for the user's role |
| E. `@rms/ui` tokens and components, RMS shell (after C0) | Shell, navigation, Mini-apps area with Build and Marketplace tabs |
| F. Change sets, outbox, audit, console skeleton | Every write shows in the console feed |
| G. ★ Isolation and attack tests | Suite runs in CI and fails on any cross-restaurant read |

**Checkpoint C1**: sign in as both restaurants, see parent data, isolation suite green.

### Wave 2: agent and build (parallel)

| Task | Done when |
|---|---|
| H. App template, `@rms/sdk`, patterns, generators | One command produces a working list page from a model |
| I. ★ Sandbox, runner, OpenAI driver, event stream | A prompt produces file changes and streamed events in the browser |
| J. Build conversation screen with live preview | The owner sees plan, progress in plain words, and the preview |
| K. ★ Ask agent and query tool | Correct answers on seeded data. Attack suite extended and green |
| L. Demo POS server, gateway, connect screen | Connecting pulls eight weeks of sales into the restaurant's store |
| M. Mini-app profiles, duplicate check, session summaries | Asking for the same mini-app twice triggers "you already have this" |

**Checkpoint C2**: a simple mini-app (vendor list) built from a prompt and previewed.

### Wave 3: publish, govern, share (parallel)

| Task | Done when |
|---|---|
| N. ★ Publish, `rms-apps` host, token hand-off | A published mini-app opens inside RMS and on a phone |
| O. Tier rules, feed, approve and reject | First publish shows as T2. Public share waits as T3 |
| P. Share flow, scrub, review, install, recommendations | Slice Yard sees the listing with a reason and installs it |

**Checkpoint C3**: beats 4, 7 and 8 work.

### Wave 4: the accounts mini-app and rehearsal

- Build the accounts mini-app on Marigold **through the product**: daily sales in, posting rules, balanced ledger, weekly P&L, prime cost, delivery payout view.
- Fix what the build exposes. `/impeccable critique`, `audit`, `polish` on the five demo screens.
- Run the nine beats twice from a clean reset.

**Checkpoint C4**: full run-through with Rahul.

---

## 6. If something slips

| If this is late | Then |
|---|---|
| Build loop (I) | Ship the accounts mini-app as a ready-made Marketplace listing. Beats 1, 3, 4, 5, 8 and 9 still work. Show the build conversation on a simpler mini-app |
| Generators (H) | The agent writes pages directly from the patterns. Slower builds, same result |
| Recommendations (P) | Show the listing in the Marketplace without the scored row |
| Per-restaurant query login | Use the single login with role switch and the parser. Say so in the demo notes |
| Sandbox quota runs out | Start the Pro trial on the personal Vercel team |

---

## 7. Guardrails

- Vercel: every command must target `team_RM4toarAtl8vljERLdxRvfeh`. The id is stored in `.rms/vercel-team`. The preflight script stops on anything else, and on any name containing "tradeengage" or "te-team".
- Supabase: project ref stored in `.rms/supabase-project`. Same check.
- No real restaurant data anywhere. Everything is seeded.
- Keys live in Vercel and Supabase settings, never in the repo.

## 8. What Rahul does by hand

1. Create the Supabase project (or run `supabase login` so Claude Code can).
2. Run `vercel login` on the personal account in the terminal Claude Code uses.
3. Provide an OpenAI API key. It covers the build agent, the Ask agent and embeddings.
4. Pick the look at C0, and sign off at C1 to C4.
