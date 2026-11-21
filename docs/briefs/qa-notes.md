# QA notes: the browser suite and the rehearsal check

Written by QA on 2026-11-21 (demo day). Test files only; no product code changed.

## Read this first

- **Beat 1 and beat 9 run end to end today.** Beats 2 to 8 have a live check on today's stub ("coming soon") screen, so we notice when it changes, and fixme tests with the run-book's steps and expected words.
- **Beat 1 can fail when other tests fill the shared database.** Sign-up stops at 25 restaurants. When that happens the test says so (`at_capacity`). It is not a product failure. See "Flaky spots".
- **The suite signs in only about 4 to 9 times a run.** The local sign-in service allows 30 sign-ins per five minutes from this computer, shared with every agent.
- **No owner route returns sales yet,** so the rehearsal check says "NOT CHECKED" for $84,310.00 and 61.3%. The suite still checks those numbers against the seed itself.

## How to run

The local stack and the three servers must be running (`docs/runbook.md` section 2), and `pnpm build` done (the suite loads `@rms/db` and `@rms/seed` from their built output).

| Command | What it does |
|---|---|
| `scripts/rehearse.sh` | Servers answer, the two seeded restaurants exist with their seeded owners, the numbers line, then the whole browser suite, then one PASS/FAIL line per beat. Exit code is non-zero on any failure. Never prints a secret. Retries a failed test once (a server restarted after a merge); a pass on the retry shows as "PASS (flaky)". |
| `pnpm test:e2e` | The browser suite alone. Not part of `pnpm test`. |
| `pnpm test:e2e tests/e2e/beats/beat-1-sign-up-and-onboarding.spec.ts --project=desktop` | One file, one screen size. |

- Settings come from `.env.local` through `loadTestEnv()` (`RMS_ENV_FILE` to point elsewhere). The suite refuses any address that is not this computer, and always uses `127.0.0.1`.
- `E2E_KEEP_SESSIONS=1 scripts/rehearse.sh` keeps the saved sign-ins (`tests/e2e/.auth/`, git-ignored, reused for 20 minutes). Without it the rehearsal deletes them at the end.
- Tracing, video and the HTML report are off, so the password is never written to disk. Screenshots are kept only for failed tests, in `tests/e2e/test-results/` (git-ignored).
- It never resets or re-seeds. The only thing it makes is one new owner per run (`e2e-<random>@rms.test`, beat 1). It removes that owner and their restaurant afterwards with `removeRestaurants` (which calls `platform.drop_store`) and the sign-in service's admin API, and sweeps any leftovers before and after each run.

## What is covered

Two projects: desktop (1280x800) and phone (390x844, touch). Every screen checked is also checked for: no "undefined", "null", "NaN", raw error text, database messages, error codes; on owner and staff screens no table or schema names, snake_case code words, tier codes, public ids or model names; no console errors; on the phone, no sideways scroll.

| File | Covers |
|---|---|
| `specs/sign-in.spec.ts` | Sign-in page; signed-out visitor sent to sign-in; wrong password shows "That email and password do not match. Please try again."; owner signs in, sees Slice Yard, signs out, `/staff` sends them back to sign-in |
| `specs/restaurants.spec.ts` | Both owners: Home, Menu (40 items in 6 groups / 20 in 4, dishes and prices), Staff (24 / 9 people, pay and email shown), Locations (addresses, seats, hours, day ends), the switcher; never a word of the other restaurant; different brand colours |
| `specs/staff-user.spec.ts` | `staff@marigold.test`: 14 people at Downtown only, no pay, no email, no Riverside anywhere; no pay field in any API answer the browser receives |
| `specs/mini-apps.spec.ts` | Build and Marketplace tabs, the three idea buttons fill the box, Settings, a 404 page in plain words |
| `specs/console.spec.ts` | Maintainer: feed with both restaurants, tier filter, review queue. An owner in the console: "This account is not a maintainer.", no rows, every console request a 403. Signed out: sent to sign-in |
| `specs/seed-numbers.spec.ts` | The run-book's numbers, worked out from the seed's raw records (days, stock counts, bills), not from the app: Marigold week of 9 Nov $84,310.00, food and drink $25,460.00, staff $26,220.00, prime cost 61.3%, the seven daily totals; 19 Oct $61,480.00 and 64.1%; Slice Yard $28,750.00 and 55.3%. All match |
| `beats/beat-1-...` | Sign up, five questions ("Table service"), Home ("Hello", Marigold Kitchen, "No mini-apps yet", both buttons), Menu, Staff, Locations of the new restaurant, Build tab (beat 2's first screen), the new restaurant's row in the console feed. Then cleanup |
| `beats/beat-4-...` | Every RMS screen on the phone with no sideways scroll |
| `beats/beat-9-...` | Each seeded restaurant's "Standard records" row (T1 minor, Applied), newest first, every tier filter gives only that tier or "No changes match these filters." |

## Fixme, and what each waits for

| Beat | Live check today (fails when the feature lands: then switch on the fixmes) | Fixme tests | Waits for |
|---|---|---|---|
| 2 | Build replies "Thanks. Building is not switched on yet, so nothing has been made or changed." | Opening prompt to plan and preview with $84,310.00 and 61.3%; daily follow-up ($8,140.00 to $12,140.00) and the 62% target (19 Oct 64.1%); vendor list (four suppliers); menu price change refused | Wave 2 build conversation and preview; Wave 4 accounts mini-app |
| 3 | Settings shows only "Your colour and logo will be set here", no "Connected systems" | Connect Demo POS, Allow, Bring in my sales: $84,310.00 and 61.3%, then "nothing new"; changed tools message | Wave 2 task L. Needs a restaurant with no sales (sign one up in the test; never reset) |
| 4 | Home says "No mini-apps yet" on both sizes | Publish to the RMS menu; open on the phone inside RMS; "Open this from RMS" outside it | Wave 3 |
| 5 | Home has no "Ask a question" | 61.3% for 9 to 15 Nov with its source; $84,310.00; Slice Yard sees nothing of Marigold and gets 55.3%; staff not offered Ask | Wave 2 task K (costs model calls when on) |
| 6 | Build lists "No mini-apps yet" | Same words again: "You already have this" and three choices | Wave 2 task M, after beat 2 |
| 7 | Review queue renders in plain words | Owner shares publicly; queue shows T3 platform, "Waiting for us"; Approve; "Approved: Marigold Kitchen, ..." | Wave 3 |
| 8 | Marketplace says "Nothing to recommend yet" | Recommended with a reason, install, Slice Yard's $28,750.00 and 55.3% only; listing never names Marigold | Wave 3, after beat 7 |
| 9 | (runs today) | After a full run: three T2 rows for Marigold, the T3 share Approved | Waves 2 and 3, beats 2 to 8 in the same run |
| Staff | (runs today) | Staff not offered Build, Ask or Connected systems | Wave 2 (owner-only routes) |

## Product bugs found

1. **Onboarding hides why it failed.** Page: `/onboarding`, last question, Finish. Steps: with 25 restaurants on the database (other tests running), sign up and answer the five questions. Saw: "We could not set up your restaurant just now. Please try again." Expected (run-book 3.1): "We are not taking new restaurants right now." The API sends that message with its 503, but `apps/web/app/onboarding/page.tsx` replaces every non-400 answer with the generic line, so the owner keeps retrying something that cannot work. Seen twice in a full run; both times the API answered 503.
2. **An owner in the console still sees the console's filters and menu.** Page: `http://127.0.0.1:3001/` signed in as `owner@marigold.test`. Saw: "This account is not a maintainer." under the Change feed heading, the Tier filter (T0 cosmetic to T3 platform), the Status filter and Apply filters. Expected (run-book 3.13): the message "and nothing else". No data leaks (every request is a 403); it is wording and tier codes shown to an owner.
3. **A busy sign-in service is reported as a wrong password (from reading the code, not seen).** Page: `/sign-in`. `apps/web/app/(auth)/sign-in/page.tsx` shows "That email and password do not match" for any sign-in error, including the sign-in limit (30 per five minutes). If the limit is hit during the demo, a correct password looks wrong. Expected: a plain "Too many tries, wait a few minutes".

No isolation failure: neither owner ever saw a word of the other restaurant, staff never received pay or contact details, and an owner got nothing from the console.

## Flaky spots

- **The 25-restaurant limit on the shared database.** Other agents' tests sign restaurants up and leave copies (at one point 22 restaurants, eleven of them named Slice Yard). When the count reaches 25, beat 1 fails with `at_capacity`. The test names the cause. On the demo machine, with nobody else testing, a reset clears it.
- **Servers restarting after a merge.** The API runs with `tsx watch` and restarts on every change to a package's build output; the web app is restarted by the lead. Mid-run this shows as `ERR_CONNECTION_REFUSED` or "RMS is not answering just now". The rehearsal retries once; a rerun passes.
- **Other agents' rows in the console.** The feed and queue may hold other tests' restaurants ("Admin Test Pizza"). The console tests check for the seeded rows and the filters, not exact counts.
