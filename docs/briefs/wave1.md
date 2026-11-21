# Wave 1 briefs

Read `CLAUDE.md` first, then your task below. This file is the contract between tasks. If your task needs something another task owns, code against the interface written here. Do not edit their files.

## Shared rules for every Wave 1 task

- You work in your own git worktree on your own branch. Run `pnpm install` first. Commit to your branch. Do not push, do not merge, do not touch `main`.
- **Environment:** your worktree has no `.env.local`. Load the main checkout's file in every command that needs it: `set -a; . /Users/rahultiwari/github/restaurant-management-system/.env.local; set +a`. In vitest: `process.loadEnvFile("/Users/rahultiwari/github/restaurant-management-system/.env.local")`. Never print its values. Never copy it into your worktree.
- **Database:** one shared local Supabase stack is already running (127.0.0.1:54322 database, :54321 sign-in API). Do NOT run `supabase start`, `stop`, `db reset` or `migration up`. Do NOT add or edit files in `supabase/migrations/`: if you need a schema change, stop and report it to the lead. Connect only through `@rms/db` (`apiDb`, `adminDb`, `withOrg`, `withStore`, `asMigrator`, `asParentSync`). Never as `postgres`.
- **Test data:** all tasks share that database. Use only your task's id range and store prefixes (given per task) and delete what you create (`platform.drop_store(org)` then delete the rows). Never delete rows you did not create.
- **Lead-owned, read-only for you:** `packages/contracts`, `packages/db`, `packages/auth/src/{tokens,session,hono,index}.ts`, `supabase/**`, `apps/api/src/index.ts`, `apps/api/src/dev.ts`, root config files (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`), `CLAUDE.md`, `docs/plan/**`, `docs/adr/**`.
- **Dependencies:** your package's `package.json` already lists what you should need. You may add a dependency to YOUR OWN package only if you must: say so in your report with the exact version (check the current version on npm, do not guess). Never add a UI library.
- **Check library facts** in `docs/reference/verified-apis.md` before using Supabase, Next.js 16, Hono, the AI SDK or MCP. If it is not there, check the current official docs. Do not code these from memory.
- **Which database login:** request handlers for a signed-in restaurant use `apiDb()` with `withOrg` / `withStore`. The platform login `adminDb()` is for: sign-up and provisioning, the seed, jobs, publishing, installing, deploying, maintainer decisions, owner confirmations, and creating notifications. The database enforces this: `rms_api` can only write the columns a restaurant may change, new apps, versions and listings must start as `draft`, and a change set must carry the decision its tier allows. Read `docs/adr/0003` and `0004`.
- **Rows only point at rows of the same restaurant.** Child rows carry `org_id` and the database checks (org, id) on every link, so always set `org_id` on inserts.
- **Outside services:** none. No Vercel command, no hosted Supabase, no MCP connector, no OpenAI call in Wave 1. Nothing related to TradeEngage.
- **Finish:** run `pnpm typecheck`, `pnpm build` and your package's tests. All must pass. Report in this order: what failed or was skipped, what you built, exact check commands and results, anything you need from the lead, anything out of scope you noticed.

Id ranges for test data (uuid prefix `0193a3c0-0000-7000-8000-0000000000`, then two hex chars):

| Task | Uuid suffix range | Store prefixes |
|---|---|---|
| A | `a0` to `af` | `o_a1a1a1a1a1xx` |
| B | `b0` to `bf` | `o_b1b1b1b1b1xx` |
| C | `c0` to `cf` | `o_c1c1c1c1c1xx` |
| D | `e0` to `ef` | `o_e1e1e1e1e1xx` |
| F | `f0` to `ff` | `o_f1f1f1f1f1xx` |
| G | `90` to `9f` | `o_919191919xxx` |

---

## Task A: sign-up, restaurants, roles, onboarding

**Goal:** two owners can sign up, answer five onboarding questions, and land in RMS with their restaurant already set up.

**You own:** `apps/api/src/routes/auth.ts`, `apps/web/app/(auth)/**`, `apps/web/app/onboarding/**`, `apps/web/lib/**`, `apps/web/proxy.ts`, and new files in `packages/auth/src/` other than the four lead-owned ones (do not change `index.ts`: tell the lead what to export).

**Contracts:** `OnboardingAnswers`, `RestaurantProfile`, `TenantContext` from `@rms/contracts`. Middleware `requireUser` and `requireSession` from `@rms/auth`.

**Build:**
1. Web: sign-up and sign-in with email and password through Supabase Auth, using `@supabase/ssr` the current way (section 5 of the verified reference; Next 16 uses `proxy.ts`, not `middleware.ts`). Email confirmation is off locally. Sign-out.
2. Web: onboarding, five questions (`OnboardingAnswers`), one per step, plain words. On submit call the API. Then send the owner to `/` (task E builds what is there).
3. API `POST /auth/onboarding` (behind `requireUser`): if the user already has a restaurant, return it. Otherwise, with the admin connection, call `createDemoRestaurant` from `@rms/seed` (task B, interface below) and add the user as `owner` in `platform.members`. The template is `marigold` when `serviceStyle` is `full_service`, `slice_yard` when `counter_service`, else `marigold`. The restaurant name the owner typed is NOT used for the demo: say so in a code comment (the seeded restaurant keeps its fictional name).
4. API `GET /auth/me` (behind `requireUser`): the user, and their restaurant (name, role, locations, brand colour) or `null` if they have not onboarded.
5. API `POST /auth/staff-invite` is NOT needed. Staff role users are created by the seed.

**UI rule:** `@rms/ui` does not exist yet (task E is building it in parallel). Write these pages as plain semantic HTML with no CSS, no class names for styling and no UI library: correct labels, `autocomplete` attributes, error text in plain words, visible focus by browser default. The designer skins them after both tasks merge. Keep each page's markup small and obvious.

**Until task B merges:** code against this interface and stub it in your tests only.
```ts
// @rms/seed
export type DemoTemplate = "marigold" | "slice_yard";
export function createDemoRestaurant(adminSql: Sql, opts: { template: DemoTemplate }): Promise<{ orgUuid: string; storePrefix: string; name: string }>;
```

**Checks:** an API test that signs up two users against the local sign-in service, onboards one as each template (with `createDemoRestaurant` replaced by a small stub that inserts an org row and calls `provisionStore`), and shows: `GET /auth/me` returns the right restaurant for each, onboarding twice does not create a second restaurant, a request with no token or a forged token gets 401, and user A can never get user B's restaurant back from any route. Clean up the users and orgs.

**Out of scope:** styling, the shell and navigation, invitations, password reset, staff sign-up.

---

## Task B: parent data, seed, one-way copy

**Goal:** both demo restaurants exist with believable parent data, a reset command rebuilds everything, and parent data is copied one way into each restaurant's parent schema.

**You own:** `packages/parent/**`, `packages/seed/**`, `scripts/reset-demo.ts`.

**Read:** `docs/plan/03-demo-build.md` section 4, `docs/plan/01-data-model.md` section 1, the parent tables in `supabase/migrations/20261121120000_platform_schema.sql`, and `platform.provision_store` in the second migration.

**Build:**
1. `@rms/parent`: `syncParent(adminSql, orgUuid)`. In ONE transaction, as the parent sync role (`asParentSync`), replace the contents of all ten tables in `o_<id>_parent` with that org's rows from the platform source tables (`restaurant_profiles` to `profile`, `locations` to `locations`, `parent_jobs` to `jobs`, and so on: same columns minus `org_id`). Update `platform.parent_sync_state`. Note: the sync role can write the parent schemas but cannot read `platform`, so read the source rows with the admin connection first, then write.
2. `@rms/seed`: deterministic generators (fixed seed, no `Math.random` without a seed) for **Marigold Kitchen** (full service, dinner-led, 2 locations Downtown and Riverside, 24 staff, about 40 menu items in 6 categories including a bar, brand colour marigold orange `#E8892B`) and **Slice Yard** (counter-service pizza, 1 location, 9 staff, about 20 items in 4 categories, brand colour tomato `#C8372D`). For each: profile, locations with hours and a 04:00 day cutoff, jobs, staff with jobs and hourly rates, menu categories, items, modifiers, prices, tax rates, licences with expiry dates (one expiring within 30 days), equipment. All fictional. Staff names must not be real public figures. Emails end in `.test`.
3. `createDemoRestaurant(adminSql, { template })`: insert the org (new uuid, `newStorePrefix()`, brand colour), seed the platform parent rows, `provisionStore`, `syncParent`. Return `{ orgUuid, storePrefix, name }`. Exactly the interface in task A's section.
4. `generateSales(template, { weeks: 8, endingOn })`: a PURE function (no database) returning eight weeks of daily sales per location, in the shapes file 02 section 1.4 and 1.5 describe: gross by category, discounts and comps with reasons, voids, net, sales tax, tips, gift cards sold and redeemed, payments by type, delivery payouts with commission lines, labour hours and cost by job group, and a few vendor bills. Money in whole cents. Rules that MUST hold and be tested: every day balances (net sales + tax + tips + gift cards sold = payments by type + gift cards redeemed, to the cent); cost of goods near 30% of net sales and labour near 31% for Marigold, so prime cost is near 61%; Slice Yard runs leaner (prime cost near 55%); weekends are busier; exactly one week has an obvious dip (about 25 to 30% lower). For the week of Monday 2026-11-09 to Sunday 2026-11-15, Marigold's net sales must total exactly $84,310.00 across both locations (Downtown $51,870.00, Riverside $32,440.00), with these daily totals: Mon $8,140, Tue $8,960, Wed $9,870, Thu $11,420, Fri $15,830, Sat $17,950, Sun $12,140; cost of goods $25,460 and labour $26,220 for that week; and the dip week is the week starting 2026-10-19 at $61,480. The eight weekly net totals, by week start: Sep 21 $81,940, Sep 28 $83,120, Oct 5 $82,560, Oct 12 $84,870, Oct 19 $61,480, Oct 26 $80,230, Nov 2 $83,790, Nov 9 $84,310. (These are the numbers on the approved design sketches.) This function is used in Wave 2 by the Demo POS server.
5. `scripts/reset-demo.ts` (run with `pnpm exec tsx --env-file=.env.local scripts/reset-demo.ts`): refuse to run unless the database host is 127.0.0.1 or localhost, or `RMS_ALLOW_RESET=1` is set. Drop every store, delete every platform row for every org, delete all Supabase Auth users (admin API with `SUPABASE_SECRET_KEY`), then create both restaurants and two owners (`owner@marigold.test`, `owner@sliceyard.test`), one staff-role user per restaurant, and one maintainer in `platform.staff_users` (`maintainer@rms.test`). Passwords come from env var `DEMO_PASSWORD`, never hard-coded. Print a short summary without the password.

**Checks:** tests that (a) both restaurants are created and the row counts match the brief, (b) `syncParent` makes the parent schema match the source and running it twice changes nothing, (c) a write to a parent schema as the restaurant's role fails at the database, (d) every `generateSales` rule above holds, including the exact figures.

**Out of scope:** child-data tables (task C makes them), writing sales into a store (Wave 2), the Demo POS server.

---

## Task C: model compiler and store provisioning (most capable model)

**Goal:** a restaurant's live and draft tables can be created from model definitions, safely and repeatably.

**You own:** `packages/models/src/compiler/**`, `packages/models/src/store.ts`, `packages/models/src/library.ts`, `packages/models/src/index.ts`. NOT `packages/models/src/packs/**` (the domain modeller writes those in parallel).

**Contracts:** `ModelDefinition`, `CustomModelDefinition`, `ModelChange`, `ModelRule`, `Expr` (`models.ts`), `columnsForField`, `SYSTEM_COLUMNS`, `LOCATION_POLICY_FN` (`storage.ts`), and the compiler contract in the header of `supabase/migrations/20261121120100_store_provisioning.sql`. Read `docs/adr/0002` and `0003`.

**Build:**
1. `compileModel(def, target)`: SQL statements that create one model's table in one schema. `target = { schema, env: "live" | "draft", roles: { rw, draftRw, ask } }`. Columns from `columnsForField` and `SYSTEM_COLUMNS`. Primary key `id`. `created_at`/`updated_at` default to now at millisecond precision, with the `rms.touch_updated_at()` trigger. Unique rules, indexes, unique `(source, source_id)` where `source_id` is not null. Foreign keys for `ref` fields inside the same schema. Enum values as check constraints. Row-level security with `rms.location_ok(location_id)` for USING and WITH CHECK on location-scoped models. Grants exactly as the provisioning header says, including append-only (select and insert only). Rules: `check` from the `Expr` tree, `balanced` as a DEFERRED constraint trigger checked at commit (lines share one currency and debits equal credits per header), `open_period_only`, `ref_value_in`.
2. **No free text reaches SQL.** Every identifier goes through one quoting function that rejects anything but a plain name. Every literal goes through one escaping function. `Expr` compiles by walking the tree. Write tests that feed hostile definitions (quotes, semicolons, comment markers, very long names, unknown fields in rules) and prove the output is either rejected or inert.
3. `compileChange(change, currentDefinition, target)` for `add_field` (optional fields only), `add_unique`, `add_index`.
4. `library.ts`: `LIBRARY = { models, namedQueries, namedActions }` assembled from `./packs/index.js`, which exports `{ models: ModelDefinition[]; namedQueries: NamedQueryDefinition[]; namedActions: NamedActionDefinition[] }`. Until the packs land, keep a tiny fixture pack in your tests (not in `src/packs`). `installLibrary(adminSql)` upserts the library into `platform.model_templates`, `model_template_versions`, `named_queries`, `named_actions`.
5. `store.ts`: `ensureModels(adminSql, orgUuid, keys)`: for each key not yet in `platform.org_models`, in dependency order (a model's `ref` targets first), compile and apply to the draft AND live schemas as the migrator (`asMigrator`), record `org_models` and `org_model_changes` (with the compiled SQL). Idempotent. `applyChange(adminSql, orgUuid, change)`: draft first, live on request.

**Checks:** against the local database, with two test orgs: tables exist in both schemas with the right columns; a restaurant's role can read and write its live table but not the other restaurant's; the draft role cannot touch live; an append-only table refuses update and delete; a location-scoped row outside the caller's `rms.locations` is invisible and cannot be inserted; an unbalanced ledger batch fails at commit and a balanced one passes; `ensureModels` twice is a no-op; the hostile-definition tests pass. `bash tests/security/db-walls.smoke.sh` from the main checkout still prints `FAILS=0`.

**Out of scope:** the model definitions themselves, named query and action execution (task D), reuse-first search, destructive changes.

---

## Task C2: library packs (domain modeller)

**Goal:** the Foundation, Sales and Finance packs, plus the four cost-side models the accounts mini-app needs.

**You own:** `packages/models/src/packs/**` only.

Follow your agent definition and `docs/plan/02-restaurant-domain.md`. Export `{ models, namedQueries, namedActions }` from `packs/index.ts`. Every definition must parse with the zod schemas in `@rms/contracts` (`ModelDefinition`, `NamedQueryDefinition`, `NamedActionDefinition`): write a test that parses all of them. Money fields use type `money` (currency is one row-level column added by the compiler). Read the template rules in the comments above `NamedQueryDefinition` and `NamedActionDefinition`.

Models needed today: Foundation (`unit`, `tax_rate`, `fiscal_calendar`, `fiscal_period`, `fiscal_week`, `day_part`, `revenue_centre`, `sales_category`, `payment_type`, `reason_code`); Sales (`sales_day`, `sales_category_day`, `payment_day`, `adjustment_day`, `gift_card_activity`, `delivery_payout`, `delivery_payout_line`, `cash_count`, `paid_in_out`, `deposit`); Finance (`account`, `journal_entry`, `journal_line`, `posting_rule`, `budget`); cost side (`vendor`, `vendor_bill`, `vendor_bill_line`, `labour_day`). Skip `order`, `order_line`, `payment`, bank and invoice models today.

Named queries: `daily_sales_summary`, `weekly_pnl`, `prime_cost_by_week` (per location and all locations, by fiscal week), `sales_by_day` (one week, day by day), `sales_by_location`, `delivery_payout_reconciliation`. Named actions: `post_sales_day` (turns one `sales_day` and its breakdown rows into one balanced `journal_entry` using `posting_rule`, idempotent by source id), `post_vendor_bill`, `post_labour_day`, `seed_chart_of_accounts` (restaurant chart of accounts and default posting rules, idempotent).

You cannot run the SQL templates until tasks C and D merge. Write them carefully against the storage contract (`packages/contracts/src/storage.ts`) and list in your report any template you are unsure of. The lead tests them at integration.

---

## Task D: Data API (most capable model)

**Goal:** reads and writes work only with a valid token, only for models in the manifest, only for the user's role and locations.

**You own:** `packages/data/**`, `apps/api/src/routes/data.ts`.

**Contracts:** everything in `packages/contracts/src/data-api.ts` (wire shapes, the field format table, error codes and statuses, routes), `manifest.ts`, `models.ts` (definitions, template rules for named queries and actions), `storage.ts`, `platform.ts` (`AuditEntry`). `requireDataToken` from `@rms/auth` gives you `c.var.tenant` (a `TenantContext`) and `c.var.claims`. Enter the store only with `withStore` from `@rms/db`.

**Build the five routes** in `DATA_ROUTES` (mounted under `/data`, so the full paths match). For every request:
1. The restaurant, user, role, locations, environment and mini-app come from `c.var.tenant` ONLY. Parse the body with the strict zod schema. Never read an org, schema, role or environment from the body, query, path or any header.
2. Load the manifest: for an app token, `platform.app_versions.manifest` for `ver` (it must belong to that app and org, and be `published`); for a run token, the manifest of the app's `current_version_id`. Check the model, named query or action is listed with enough access. Then the role check from the model's `defaultAccess`.
3. Load the model definition from `platform.org_models` for that org (status `live` or `draft` as fits the environment). Validate fields, filters, sorts, totals and write values against it: unknown field, wrong type, or a field the role cannot read gives the right error code. A role that cannot read a field cannot write, filter, sort or total on it.
4. Build the SQL yourself: identifiers through `ident()`/`store.table()`, values always as bound parameters. Soft-deleted rows hidden unless `includeDeleted`. Keyset pagination with a signed opaque cursor (HMAC with `RMS_TOKEN_SECRET`) bound to the org, model, filter and sort.
5. Writes: set `id` (client value or `newUuid()`), `source`, `created_by`, `updated_by` from the actor, `location_id` checked against the token (default: the caller's only location, else required), `currency` default from the location. `ifUpdatedAt` conflicts give `conflict`. Batches are one transaction, in order. Idempotency keys in `platform.idempotency_keys`, scoped as that table's key says. Parent refs: check the id exists in the parent schema and store the label snapshot.
6. Named queries and actions: load the definition from `platform.named_queries` / `named_actions`, expand `{{model_ref}}` exactly as the template rules say (a subquery over the caller's own schema with only readable columns, soft-deleted rows hidden; row-level security already applies the location scope), bind `:params`, refuse any reference not in `reads`/`writes`. Queries run in a `READ ONLY` transaction.
7. Audit: one `platform.audit_log` row per request that writes (and per named action), in the same transaction, with counts and keys only, never field values.
8. Errors use `DataError` and `DATA_ERROR_STATUS`. Messages are plain words. Database error text never leaves the server.

**Until task C merges:** create your test tables with a small test helper that issues hand-written DDL as the migrator (`asMigrator`), following the storage contract and the compiler contract, and registers `org_models` rows. Keep that helper in your tests.

**Checks:** tests against the local database with two orgs covering: happy paths for all five routes; every error code; app token for org A can never read or write org B (try the other org's ids, prefixes and model names everywhere); run token cannot reach live and app token cannot reach draft; a model not in the manifest; read-only manifest access refusing a write; staff role refused a payroll-tagged field in fields, filter, sort, totals and writes; location scoping on read and write; parent writes impossible; cursor from one query refused on another; idempotent batch replays; a failing op rolls back the whole batch; no database error text in any response.

**Out of scope:** the SDK, publishing, the Ask agent, model compilation (task C).

---

## Task E: design system and RMS shell (designer)

**Goal:** `@rms/ui` v0 and the RMS shell, in the approved "Front of House" look.

**You own:** `packages/ui/**`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/(shell)/**`, `apps/web/components/**`, `apps/web/postcss.config.mjs`, `apps/web/app/gallery/**`, `DESIGN.md`, `.impeccable/**`, `apps/web/.impeccable/**`.

**Read:** `PRODUCT.md`, the direction contract in `apps/web/.impeccable/surfaces/app-layout-tsx.md` (it is the approved direction: do not re-run the direction round or `concept-seed`), the approved sketches `docs/design/c0/4-front-of-house-desktop.html` and `-phone.html`, the quality references in `.impeccable/reference/`, and the impeccable skill's `reference/craft-floor.md` and `reference/mode-operate.md`.

**Build:**
1. Tokens as CSS custom properties in `packages/ui/src/styles.css` (Tailwind v4 is installed if you want it for utilities inside `@rms/ui` only): colour, type (Nunito Sans), spacing, radius, density (comfortable and compact). **Brand colour safety:** the action colour is replaced per restaurant. Derive, in code, a darkened action step so white text on a filled button and coloured text on white both pass AA for ANY brand colour (test with `#12804A`, `#E8892B`, `#C8372D`, `#F2C230`, `#1F6FD0`). Export `themeFromBrand(hex)`.
2. About fifteen components, touch-first (44px targets), accessible: Button, IconButton, TextField, Select, Tabs, Card, Tag, Stat (label, big figure, note), DataTable (with a compact density), BarChart (same-scale bars with a labelled state such as "Slow week", not colour alone), Stepper (done, in progress as shape plus words), Message (conversation), Composer, Dialog, NavItem, BottomBar, Skeleton, EmptyState.
3. Four patterns: list with detail, form, dashboard, report table.
4. The shell in `apps/web`: side rail on desktop, bottom bar on phone, restaurant name, location switcher, the six nav items, the Mini-apps area with **Build** and **Marketplace** tabs (empty states in plain words for now). It gets its data from props or a small typed loader stub, clearly marked, that task A's `GET /auth/me` will replace: `{ restaurantName, locations, brandColour, userName, userInitials, role, miniApps: [] }`.
5. A gallery page at `/gallery` showing every component and pattern with the seeded content from the sketches, so the look can be reviewed without signing in.
6. The RMS logo: a simple wordmark in this language.
7. Fix the known gaps listed at the bottom of the direction contract.

**Rule:** colour means press. Nothing coloured that cannot be pressed. States are words and ink shapes.

**Checks:** `pnpm --filter @rms/web build` passes. Screenshots of `/gallery` and the shell at 1440x900 and 390x844 with the impeccable `shot` command, looked at by you, nothing clipped. The impeccable detector run once on the changed files; fix what is real and list the rest. Contrast test for `themeFromBrand` passes for the five colours.

**Out of scope:** sign-in pages (task A writes them unstyled, you skin them after merge), data fetching, the build conversation logic, the maintainer console.

---

## Task F: change sets, outbox, audit, console skeleton

**Goal:** every change shows in the maintainer console feed, with the right tier.

**You own:** `packages/governance/**`, `apps/api/src/routes/admin.ts`, `apps/admin/**`.

**Contracts:** `governance.ts` (`ChangeSignal`, `tierForSignals`, `TIER_POLICY`, `ChangeSet`, `OwnerChangeNotice`) and `platform.ts` (`AuditEntry`, `OutboxMessage`) in `@rms/contracts`. `requireStaff` from `@rms/auth`. Tables `change_sets`, `change_reviews`, `audit_log`, `outbox`, `notifications`, `staff_users`.

**Build:**
1. `@rms/governance`: `recordChange(tx, { orgUuid, appUuid?, origin, actor, signals, summary, ownerSummary, diff })` which computes the tier with `tierForSignals`, sets the decision from `TIER_POLICY` (T0/T1 `applied`, T2 `pending_owner`, T3 `pending_maintainer`), inserts the change set AND an outbox row AND an audit row in the caller's transaction, and returns the change set. `confirmByOwner`, `decideByStaff(approve | reject, note)`. `writeAudit(tx, entry)`. `ownerNotice(changeSet)` returning plain words with no tier codes. Rule-based summaries only. Note the grants: `rms_api` may insert change sets but not update them, so owner confirmation and staff decisions go through the admin connection.
2. `drainOutbox(adminSql)`: marks pending rows sent and creates `notifications` rows (maintainer feed always; owner for T2 and T3).
3. API under `/admin` (all behind `requireStaff`): `GET /admin/feed` (newest first, filter by tier and decision, with the restaurant's name: maintainers may see it), `GET /admin/queue` (pending maintainer decisions), `POST /admin/changes/:id/decision`.
4. `apps/admin`: sign-in, the change feed, the review queue with approve and reject. Plain semantic HTML with no CSS and no UI library (the designer skins it later, same rule as task A). It talks to the API with the staff user's Supabase access token.

**Checks:** tests against the local database: one change of each tier does what the policy table says; the outbox row is written in the same transaction (roll back and it is gone); a restaurant member (not staff) gets 403 on every `/admin` route; staff decisions are recorded in `change_reviews`; the feed never needs the restaurant to be passed in by the client.

**Out of scope:** detectors that read real diffs (later waves call `recordChange` with signals), Slack, email, digests.

---

## Task G: isolation and attack tests (most capable model, security reviewer)

**Goal:** a suite that runs in CI and fails on any cross-restaurant read.

**You own:** `tests/security/**`, `vitest.security.config.ts` at the repo root, and the CI job (send the lead the exact YAML to add: `.github/workflows/ci.yml` is lead-owned).

**Build**, as vitest tests driven by `pnpm test:security`:
1. Database level: port every check in `tests/security/db-walls.smoke.sh` to vitest, then add the attack ideas from your agent definition and every proposed test in the security review (the lead pastes it into your prompt; `docs/adr/0004-database-hardening.md` lists what was closed and what stays open). The Ask path already has tests in `packages/db/src/ask.test.ts`: do not duplicate them, extend them from `tests/security` with new attacks. Two restaurants created fresh per run through `@rms/db`.
2. Token level: forged, expired, replayed, swapped-kind and cross-restaurant tokens against `requireDataToken` and `requireSession` (a tiny Hono app in the test).
3. Contract level: every request schema in `@rms/contracts` rejects org, schema, role and environment fields, at every nesting level.
4. Data API level: written against `DATA_ROUTES` and the wire shapes, importing the route app from `apps/api`. Task D is building it in parallel, so wrap these in a check that skips them with a loud message when the routes are still the empty stub. The lead re-runs them at integration.
5. A "canary": each restaurant gets a row with a unique secret string. A helper sweeps every response body and every query result made as the OTHER restaurant for that string. Any hit fails the suite.

Each test tries one thing and asserts refusal. Where you can, prove the test can fail (for example by showing it fails when run with the right credentials instead of the wrong ones).

**Out of scope:** fixing product code. Report holes to the lead.
