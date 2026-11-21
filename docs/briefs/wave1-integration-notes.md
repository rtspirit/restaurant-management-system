# Wave 1 integration notes

Branch `worktree-agent-a365074a322420ba9`. Written by the Wave 1 integration engineer on 2026-11-21.

## Read this first

- **C1 passes on the local stack.** Both owners sign in and see their own menu, staff and locations. A new owner signs up and gets a new Slice Yard. The console works for the maintainer and refuses an owner. Every check command is green.
- **My worktree was cut from an old commit** (`607dcf4`, before the Data API merged). I fast-forwarded it to local `main` (`31e69b7`) before starting. Nothing else was merged.
- **No library template or action needed a fix.** All 8 reports and 6 actions ran on the real compiler and the real checker first time, and the numbers match the sketches to the cent.
- **No new migration.**
- **Someone else ran tests against the shared database while I was finishing** (two "Ask Test" restaurants appeared and went). `pnpm reset-demo` wipes every restaurant, so do not run it while tests are running elsewhere.
- **I changed four lead-owned files.** They are small. Please review them: see "Lead-owned files I touched".
- **Not done, on purpose:** see "Left for the lead".

## Check results

| Command | Result |
|---|---|
| `pnpm typecheck` | 21 of 21 tasks pass |
| `pnpm build` | 12 of 12 tasks pass |
| `pnpm test` | 875 tests pass (contracts 19, ui 199, auth 9, parent 8, governance 16, models 249, data 132, seed 106, db 23, api 114) |
| `pnpm test:security` | 879 pass, 4 skipped (the hosted-only tests) |
| `RMS_ENV_FILE=<main checkout>/.env.local bash tests/security/db-walls.smoke.sh` | 63 pass, `FAILS=0` |
| `pnpm c1-walkthrough` | 64 checks pass, 42 screenshots |
| impeccable detector on the new UI files | no findings |

The local database is in the state right after a fresh `pnpm reset-demo`.

## What changed, by item

### 1. The Data API reads the right definition

`packages/data/src/platform.ts`: `loadDefinitions` now calls the compiler's `effectiveDefinition(tx, orgUuid, key, env)` for each model. A live request is checked against the shape the live tables really have. A stored definition that does not parse is still answered as `internal`, with nothing leaked.

Test: `apps/api/src/routes/data.definitions.test.ts`. A real seeded restaurant, the `vendor` table made by the compiler, a field added to draft with `applyChange`. The live mini-app still reads and writes, does not see the field, and is told `invalid_request` (not `internal`) when it names it. The build token sees and uses it. After `publishModelChanges` the live mini-app has it.

### 2. Installing the library checks every template

`packages/seed/src/library.ts`: `installPlatformLibrary(adminSql, library = LIBRARY)` and `checkLibraryTemplates`. Every named query and action goes through `checkNamedQuery` / `checkNamedAction`. If any is refused it throws and nothing is written. `@rms/seed` now depends on `@rms/data`.

Test: `packages/seed/src/library.test.ts`. All real templates pass. A doctored report (reads `pg_catalog.pg_roles`) and a doctored action (an `update` slipped in) are named and refused, and a good extra report placed before the bad one is not installed either.

### 3. Real tables, end to end

`packages/seed/src/books.ts`:

- `loadDemoBooks(client, { template })`: the one loader. It goes through the Data API only. Rows are written with `upsert_by_source`. The ledger is written only by the named actions.
- `ensureBooksApp(adminSql, orgUuid)`: a hidden, published mini-app of kind `system` called "Demo data", whose manifest lists every library model, report and action. The loader acts as it.
- `seedDemoBooks(adminSql, { orgUuid, template, ownerUserId, withSales })`: what the reset calls. It makes the library tables, and with `withSales` loads and posts the numbers, then reads the last week back through the prime cost report.

Test: `apps/api/src/routes/data.books.test.ts` (19 tests, about 30 seconds). Library installed through the checker, Marigold and Slice Yard seeded, tables from the installed library, eight weeks loaded through the HTTP routes with real tokens. It asserts, for Marigold week of 2026-11-09: net sales $84,310.00, food and drink $25,460.00, staff cost $26,220.00, prime cost 61.3%, Downtown $51,870 and Riverside $32,440, the seven daily totals, all eight weekly totals, the dip week at $61,480, `stock_counted` true, usage = opening + purchases - closing, every day adds up, delivery payouts match the till, and the ledger balances in total and entry by entry. Loading and posting twice changes nothing. A staff token cannot see staff cost in rows, filters, sorts, totals or reports. Slice Yard, loaded the same way, sees none of Marigold's rows (canary strings, both ways, across every model and report).

### 4. The skipped attack tests now run

The 103 Data API tests in `tests/security/data-api` run against the real routes. Fixes were to fixtures only, never to an assertion about refusal:

- `tests/security/helpers/world.ts`: the fixture models claimed pack `custom` with plain keys, which the compiler refuses. They now sit in a library pack. The fixture's one model-change row was not a valid change and was marked as not yet live. It is now valid and live.
- `restoreStoreRows` in the same file, called after the Data API tests: those tests really write now, and the database tests after them expect an untouched world.
- A stubbed Data API is now a failure by default. `RMS_REQUIRE_DATA_API=0` turns it back into a loud skip.

No test failed for a real reason. No finding.

### 5. The reset, end to end

`pnpm reset-demo` now: removes everything, creates both restaurants and the five users, installs the checked library, makes each restaurant's 32 tables, loads and posts eight weeks of numbers, records one change set per restaurant, and prints the last week's net sales and prime cost. About 16 seconds. Run many times in a row, each time from whatever the last run left. `pnpm reset-demo --no-sales` makes the restaurants and tables only.

- `packages/seed/src/reset.ts`: `resetDemo(adminSql, env, { withSales })`, default true. New guard `checkSameDatabase`: the numbers go in through `DATABASE_URL`, so it must be the same server and database as the admin connection.
- `packages/seed/src/reset-cli.ts` and `scripts/reset-demo.ts`: see bug 2 below.

### 6. C1 walkthrough and the parent data screens

- `GET /auth/parent/:model` (`apps/api/src/routes/parent.ts`, `packages/data/src/parent-read.ts`). Behind `requireSession`. The restaurant, role and locations come from the session only. The address carries only which of the ten lists to read, checked against `ParentModelKey`. It reuses the Data API's own parent shapes, so staff pay and contact details are left out for staff and a member tied to one location sees only that location. Read-only transaction. Test: `apps/api/src/routes/parent.test.ts` (7 tests, real sign-in users).
- Screens: `apps/web/app/(shell)/menu`, `staff`, `locations`, with `apps/web/lib/parent-server.ts` and `apps/web/components/list-unavailable.tsx`. Only `@rms/ui` components. Read-only.
- `scripts/c1-walkthrough.mts` (run with `pnpm c1-walkthrough`): Playwright, headless Chromium, 64 checks, screenshots in `docs/design/c1/`.

## Bugs found and fixed outside my own new code

| # | Where | Cause | Fix |
|---|---|---|---|
| 1 | `packages/data/src/platform.ts` | Live requests were checked against the draft definition, so a field that existed only in draft made a published mini-app fail with `internal` | Use `effectiveDefinition`. Regression test in `data.definitions.test.ts` |
| 2 | `scripts/reset-demo.ts`, `packages/seed/package.json` | The script loaded `@rms/db` twice (once from source, once built), so the Data API's connections would never be closed, and `--env-file=../../.env.local` fails in a worktree | The command moved into `packages/seed/src/reset-cli.ts`. The script is three lines. Settings are found the way tests find them |
| 3 | `packages/data/src/testing/fixtures.ts` | Test models claimed pack `custom` with keys and a rule the compiler refuses. Harmless until fix 1 made the Data API use the compiler | The fixtures claim a library pack |
| 4 | `tests/security/helpers/world.ts` | Same as 3, plus an invalid pending change row | See item 4 |
| 5 | `tests/security/data-api/data-api.test.ts` | Once the tests really ran, the rows they wrote broke five database tests that run after them | `restoreStoreRows` after the file |

Two product or tooling bugs (1, 2) and three fixture problems (3 to 5). No bug in the packs, the compiler or the template checker.

One mistake of my own, fixed: my first test ids (`d0` to `df`) collided with the `@rms/db` tests. Integration tests now use uuid suffix `70` to `7f` and store prefixes `o_7171717171xx`. Please add that row to the table in `wave1.md`.

## Lead-owned files I touched

- `packages/contracts/src/platform.ts`: added `ParentListResponse` (the wire shape of the new route). `CONTRACTS_VERSION` 0.3.0 to 0.3.1.
- `apps/api/src/index.ts`: mounted `parentRoutes` under `/auth`, after `authRoutes` so its cross-origin rule covers it.
- `package.json` and `pnpm-lock.yaml`: dev dependency `@playwright/test` 1.65.1 (current on npm, the browser it needs was already on this machine), and the script `c1-walkthrough`.
- `vitest.security.config.ts`: one comment line.
- `packages/seed/package.json`: now depends on `@rms/data` and `@rms/governance`.

## Left for the lead

1. **Security review.** `GET /auth/parent/:model` and `readParent` read data on a session, with no manifest. They should go to `security-reviewer`, with the reset's in-process use of `handleData`.
2. **The hidden "Demo data" mini-app.** Each seeded restaurant has one row in `platform.apps` with kind `system`. Nothing lists an owner's mini-apps yet. When something does, it must leave out kind `system`.
3. **A new sign-up gets no tables and no numbers.** Onboarding still calls only `createDemoRestaurant`. If a new owner should start with the library tables, call `seedDemoBooks(..., { withSales: false })` there. It also records no change set, so sign-ups do not show in the console feed.
4. **The Data API allows four requests at once per restaurant.** A screen that fires five reports together gets a 429 for one of them. My test hit this. The SDK or the accounts mini-app must queue its calls or the cap needs a second look.
5. **Reports that carry staff cost are refused to staff outright** (403), because the ledger models are owner-only. Staff get no reduced version. That is safe. Say if staff should see sales-only reports.
6. **`installLibrary` refuses a changed model that keeps its version number.** After editing a pack model, bump its version or the reset stops. Reports and actions are simply replaced.
7. **Phone tables.** `DataTable` pins the first column and the strong column. With a long name in the first column and only two columns, the name is cut off and cannot be scrolled into view. I moved the Menu screen to cards with `DetailList`, which wrap. The component itself needs the designer.
8. **The location switcher is still a stub.** It lists the right locations and changes its own label. It filters nothing.
9. **The walls smoke script needs `RMS_ENV_FILE` in a worktree.** It reads `./.env.local` by default.
10. **The console feed after a reset** shows two rows ("system change to the settings "Standard records": new_model"). That wording comes from the governance rules. Change the subject if you want other words.

## How to run the C1 walkthrough by hand

From the main checkout (or a worktree: the reset and the tests find the main checkout's `.env.local` themselves; for the two Next apps a worktree needs `apps/web/.env.local` and `apps/admin/.env.local` linked to it, not committed).

```
pnpm install
pnpm build
pnpm reset-demo
pnpm --filter @rms/api dev          # API, port 8787 (in a worktree: load the settings first, then `pnpm --filter @rms/api exec tsx src/dev.ts`)
pnpm --filter @rms/web start        # web app, port 3000
pnpm --filter @rms/admin start      # console, port 3001
pnpm c1-walkthrough                 # the automated run: 64 checks, screenshots in docs/design/c1/
pnpm reset-demo                     # the walkthrough signs a new owner up, so reset afterwards
```

By hand, in a browser. The password for every demo user is the value of `DEMO_PASSWORD` in `.env.local`.

1. Open `http://localhost:3000/sign-in`. Sign in as `owner@marigold.test`. Home says Marigold Kitchen. The switcher lists All locations, Downtown, Riverside.
2. Open `/menu`, `/staff`, `/locations`, `/mini-apps`, `/mini-apps/marketplace`. Staff shows 24 people with pay and contact details.
3. Sign out. Sign in as `owner@sliceyard.test`. Slice Yard, tomato buttons, one location (Mill Street), no switcher, 9 people, nothing of Marigold.
4. Sign out. Sign in as `staff@marigold.test`. `/staff` shows the Downtown team only, with no pay and no contact details.
5. Sign out. Open `/sign-up`. Use an email ending `@c1.rms.test` and any password of 8 or more characters. Answer the five questions, choosing "Counter service". You land in a new Slice Yard of your own.
6. Open `http://localhost:3001/sign-in`. Sign in as `maintainer@rms.test`. The change feed shows one row per restaurant. Open Review queue: nothing waiting.
7. Sign out of the console. Sign in there as `owner@marigold.test`. It says "This account is not a maintainer." and shows nothing.

## Demo sign-ins (emails only)

- `owner@marigold.test` (owner, Marigold Kitchen)
- `staff@marigold.test` (staff, Marigold Kitchen, Downtown only)
- `owner@sliceyard.test` (owner, Slice Yard)
- `staff@sliceyard.test` (staff, Slice Yard)
- `maintainer@rms.test` (maintainer, console)

## Screenshots

`docs/design/c1/`, named `<who>-<screen>-<desktop|phone>.png`. Desktop is 1440x900, phone is 390x844. `marigold-*` and `sliceyard-*` cover Home, the location switcher, Mini-apps Build and Marketplace, Menu, Staff and Locations. `marigold-staff-as-staff-desktop.png` is the staff user's view. `newowner-*` is sign-up, the five questions and the landing. `console-*` is the feed, the queue and the owner being refused. Menu, Staff and Locations on a desktop are whole-page pictures. Phone pictures are one screen.

## Follow-up after the code and security reviews (2026-11-21)

Done in the same worktree after merging `main`. The demo data on the shared database was left alone: no reset, no walkthrough. Everything was proved on throwaway restaurants (uuid suffix `70` to `7f`), which were removed again.

| # | Asked | Done |
|---|---|---|
| 1 | The walkthrough could print the demo password inside a browser error | `safeMessage` in `scripts/c1-walkthrough.mts`: first line only, nothing after "Call log", every password the run knows replaced, anything quoted after `fill` dropped. It is the only place an error is printed |
| 2 | `GET /auth/parent/:model` had no limiter and answered when the store was not ready | It shares the Data API's count of requests in flight per restaurant (`packages/data/src/limit.ts`, `handleParentRead`). A store that is not ready gets a plain 409. The default cap is now 8 (`RMS_DATA_MAX_INFLIGHT`). Tests: Marigold at its cap is refused, Slice Yard still answers in under a second |
| 3 | The hidden "Demo data" mini-app stayed published | `seedDemoBooks` switches it on for the load and always off again (`paused`), also when the load fails. Tests in `packages/seed/src/books.test.ts` |
| 4 | `checkSameDatabase` trusted the text of a connection string | It compares what the two drivers will really connect to. The test found one more way round the old check: `?database=other` wins over the name in the path, because the driver sends its extra settings last |
| 5 | The attack fixtures showed custom rows as library packs | The security world now has a real custom model (`x_sec_memo`), made with `applyChange` and `create_custom_model`, with 7 Data API attack tests of its own. Its compiler-made grants are in the exact-holdings tests |
| 6 | Test results could be replayed from the cache | `turbo.json`: `"cache": false` on `test` |
| 7 | New sign-ups got no tables and did not show in the feed | Onboarding calls `setUpNewRestaurant` after the owner is added: library tables, chart of accounts, fiscal calendar, no sales, and one change set (system, settings, no signals). If it fails, the owner still lands in RMS and it is logged. Tests in `apps/api/src/routes/auth.setup.test.ts` |
| 8 | A CI-safe test of `seedDemoBooks` with sales | `packages/seed/src/books.test.ts` runs the very function the reset calls, on a throwaway Marigold: $84,310.00 and 61.3% |

Things to know:

- **The restaurant-facing pool went from 5 to 10 connections** (`packages/db/src/index.ts`, lead-owned). With a cap of 8 and a pool of 5, one restaurant at its cap would have held every connection. Ten is the most the security suite allows a pool to hold. That leaves two connections for everyone else while one restaurant is at its cap.
- **The two demo restaurants on the shared database still have a published loader.** They were seeded before this change, and I was told not to touch them. The next `pnpm reset-demo` fixes it. Until then: `update platform.apps set status = 'paused' where kind = 'system'`.
- **`seedDemoBooks` now returns `{ setUp, books }`**, and without sales it also adds the chart of accounts and the fiscal calendar (it used to make tables only).
- **Root `package.json`** gained the dev dependency `@rms/models` (workspace link), for the security world's custom model.
- **`apps/api/src/routes/auth.test.ts`**: the "at the restaurant cap" test read the count and then set the cap to it. Other test files make and remove restaurants at the same time, so it failed now and then. It now sets the cap to one.
- Items 2, 4, 5 and 7 from "Left for the lead" above are closed by this. The rest stand.

Checks after the follow-up: `pnpm typecheck` 21 of 21, `pnpm build` 12 of 12, `pnpm test` 892 pass (run twice, nothing replayed), `pnpm test:security` 886 pass and 4 skipped.
