# Wave 3 preparation: notes for the lead

Branch `worktree-agent-a816ebbc60e581024`, on top of `main`. Contracts 0.5.0, one migration, the object store, the apps host, package and page shells, the briefs, ADR 0009 and ADR 0012. Nothing pushed. No model call, no Vercel command, no hosted database, no demo reset.

## What is not finished or not proven

- **Nothing has been published end to end.** The apps host serves files and has tests, the store has tests, the contracts have tests. `publishApp`, `openApp`, the scrub, install and `decideAndResume` are stubs for N, O and P.
- **Publish cannot run on `main` today.** `runCheck` answers "not built yet" until task H merges.
- **The template builds with absolute addresses** (`/assets/...`). Served under `/a/<app>/<version>/` they would not load. Question 1.
- **The phone pair is designed and tested as a rule, not run on a phone.** It needs two small changes in task H's and task J's files after they merge (ADR 0012). The laptop pair needs none.
- **A published mini-app is built for one RMS address.** Published in laptop mode, it will not open in phone mode until it is published again. Run the demo in one mode.
- **The publish build compiles agent-written source on the API's own machine** (a temporary folder, never run, only compiled). Acceptable on the demo laptop. It must move into a sandbox before anything is deployed.
- **The apps host reads with the platform login** (your decision). Only through one database function, and only while it is never deployed. ADR 0009 says what to do first when that changes.
- I applied a first version of the migration locally, then changed it (below). I took the first version back out by hand on the local database (as the local `postgres` user, `127.0.0.1` only) and applied the edited file fresh. The file and the local database agree.
- `@rms/parent`'s test "copies one restaurant only" timed out once at 5 seconds during a full `pnpm test` while other agents were using the database. It passes alone and passed on the next full run.

## What I cut for today, said plainly

- Source is a JSON list of files, not a git bundle. Files live in Postgres, not a bucket (ADR 0009).
- Publish progress is not an event stream. The request answers once and the page reads a status every two seconds.
- A held publish (`publish_app`) is a shape only. Nothing creates one. A maintainer cannot publish past a failed check.
- Sharing a mini-app that keeps its own kind of record (a custom `x_` model) is refused. So a listing only ever names standard tables, and an install never copies a table shape.
- Recommendations are worked out when the tab opens. No nightly job, no embeddings. "Popular with places like yours" needs three different restaurants before it is ever said.
- Rollback is a function with a test, and a button only if there is time.
- No dashboard-widget slot, no jobs, no updates from the original to installers, no build-time Marketplace match.
- The "Deploying" section is ten lines, marked later.

## Decisions, and why

1. **The serving design.** Built files are rows in `platform.objects` under the plan's keys. `apps/apps-host` is a small Hono server (the same stack as the API: nothing new to learn or install, runs locally with one command, deployable as functions later). An address is `/a/<app id>/<version id>/<path>`. It finds the file by (mini-app, published version, path) through one database function and never takes a key. Every answer carries `connect-src 'none'` and `frame-ancestors <the RMS web app>`. No cookie is read or set.
2. **Publish builds again from clean source.** Only the files the agent may write are stored. RMS's own template, the manifest from the version row and the checks do the rest. Nothing from the build sandbox's installed packages or built files is trusted.
3. **Nothing is live until the last step.** Tables go live first, then one transaction flips the version, the app, the menu row and the next draft version.
4. **Rollback is one transaction, three row updates, not literally one row.** The Data API (lead-owned, not changed) insists the pinned version's status is `published`, so the two versions swap status as the app's pointer moves. Nothing is rebuilt.
5. **A first publish records the change and confirms it in the same request.** The confirm the owner pressed is the yes. N does not depend on O's routes for the demo-critical path.
6. **Held actions live in two new columns on `change_sets` that only the platform login can write or read.** The handler for each kind is passed in by the route file, so `@rms/governance` does not import `@rms/marketplace`. A handler re-checks what it is told to act on: the ids are a pointer, not a permission.
7. **`platform.objects` differs from your message in two places, on purpose:**
   - `org_id` is never null. A listing's object is filed under the restaurant that shared it (read from the listing's own row), exactly like `listings.publisher_org_id`: for our records, and so the reset and the security suite's clean-up remove it. With a null owner those rows would be left behind by every reset, and a link to `listings` instead tripped the suite's rule that every link between restaurant-owned tables is checked on (restaurant, id). The sharing restaurant's own login cannot read the row (the read policy is `orgs/` keys only).
   - There are no helper functions for the restaurant-facing login. The suite checks that login can call exactly two platform functions. The key rules are written out in the policies and constraints instead.
8. **The origin rule (ADR 0012).** Two names for one laptop. `LocalOrigin` can only ever be this machine or this network. Local demo mode is a server flag that a deployed server ignores. `canFrameApp` is the one rule for published mini-apps. Previews did not loosen. Improvement on the starting proposal: the laptop pair (`127.0.0.1` and `localhost`) needs no flag at all, because both are loopback origins the strict rule already accepts. Only the phone pair needs the mode.
9. **The security suite and the wall checks were changed to cover the new table**, since a new restaurant-owned table fails them until it is classified: a row template, planted stored code with the canary, the new request shapes in the identity-field test, 19 wall checks.

## Questions for the lead

1. **The template must build with relative addresses.** Recommendation: add `base: "./"` to `packages/app-template/vite.config.ts` when task H merges (one line, H's file). N's brief has a fallback (build once more with `--base ./`), but one build is better than two.
2. **Two hand-offs into Wave 2 files.** (a) Task I saves the draft version's source at the end of each run (`saveSource(dbObjectStore(tx), org, app, number, source)` inside `withOrg`, then `source_key`): you said this is planned, and N's publish reads nothing else. (b) The build screen's disabled Publish button becomes `<PublishButton appId=... />` from `apps/web/components/publish/publish-button.tsx`. Recommendation: you make both changes at integration, not N.
3. **The phone pair needs the two changes listed in ADR 0012** (J's `canLoadGrant` calls `canFrameApp` for a grant of kind `app`; H's SDK `connect` accepts `AnyOrigin` for the shell origin it was built with). Recommendation: get beat 4 working on the laptop pair first (no change needed, only `APPS_URL=http://localhost:3002` and `NEXT_PUBLIC_APPS_URL` in the local settings), then make the two changes yourself. Also tell the phone-address agent: `WEB_URL` and `APPS_URL` must be two different names of the laptop, and sign-in on the phone over plain `http` is theirs to check.

## New dependencies

None new to the repo. `apps/apps-host` uses what `apps/api` already uses, at the same versions: `hono` 4.13.19, `@hono/node-server` 2.1.11, `tsx` 4.23.15. `@rms/publish` and `@rms/marketplace` depend on workspace packages and `zod` 4.6.7 only. pnpm still reports "Agent skills awaiting approval: ai". I did not run `pnpm approve`.

New settings: `APPS_URL`, `NEXT_PUBLIC_APPS_URL`, `RMS_LOCAL_DEMO`, `NEXT_PUBLIC_RMS_LOCAL_DEMO` (in `.env.example`, empty). `scripts/dev-db-roles.sh` does not write them yet: left for the phone-address work.

## What a reviewer should look at first

1. `docs/adr/0012-local-and-phone-origins.md` and the new block in `packages/contracts/src/frame.ts` (`LocalOrigin`, `originMode`, `canFrameApp`, `AppGrant`, `fromExpectedOrigin`).
2. `supabase/migrations/20261121120700_wave3.sql`: the three policies on `platform.objects`, `platform.published_screen`, the insert column list on `change_sets`.
3. `packages/db/src/objects.ts`: keys only from ids, prefixes only of three forms, a listing's owner read from its row.
4. `apps/apps-host/src/app.ts` and `appsHostPolicy` in `packages/contracts/src/publish.ts`.
5. `packages/contracts/src/changes.ts`: `HeldAction`, and the rule list on `DetectedChange`.
6. `packages/contracts/src/marketplace.ts`: no shape another restaurant receives has room for a publisher.
7. `docs/briefs/wave3.md`, task N, step 1 (the clean build) and step 2 (the order of going live).

## Noticed, out of scope

- `Origin` compares the text it is given, while `isSeparateSite` reads the host after the URL parser has tidied it. An `https` origin written in an odd numeric form would be compared as text elsewhere and never match what a browser reports, so it fails closed. `LocalOrigin` insists on the browser's own spelling.
- The run-book says the web app is on `127.0.0.1`. The Wave 2 notes say `localhost`. The local settings script and the API agree with the run-book. ADR 0012 follows the run-book.
- The ban on `document.cookie` in mini-app code is a static check. The real wall is the different host.
- `scripts/dev-db-roles.sh` already links `.env.local` into `apps/apps-host`.
- The scratchpad folder and the security suite's fixed test restaurants are still shared by every agent.
