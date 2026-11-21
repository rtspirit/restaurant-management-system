# Wave 2, task J: build conversation screen with live preview

Branch `worktree-agent-a6c593cd8ec3b5e1e`, with `main` merged in (task M included). Nothing pushed. No model call, no Vercel command, no sign-in, no demo reset. No new dependency.

This file covers the first build and the fixes after the code review and the security review.

## What is not done, not proven, or looks wrong

- **It has never talked to the real stream.** Task I is not merged. The signed-in Build tab now uses the real API always, so until I's routes exist a first message there answers "Building is not switched on yet. Nothing was made or changed." The real client (`realAgentApi` in `apps/web/lib/agent/client.ts`) is typechecked and its Data API call is tested. Expect small mismatches when I merges.
- **"Try again" has no call to make on the real API** (below, "Needed from task I"). Until it exists the button is not shown on the signed-in screen: the owner types what to do next. It works on the practice routes.
- **A real sandbox preview will be refused by the new `frame-src` rule.** The rule takes exact origins only, and a real sandbox gets a new address each time. It works for the local preview (`PREVIEW_URL=http://127.0.0.1:5173`). The lead has to decide what goes in the list for real sandboxes (one fixed preview host in front of them, or their parent domain as a pattern).
- **`PREVIEW_URL` must be set when the web app is BUILT**, or it frames nothing (`frame-src 'none'`) and the preview pane ends on "The preview is taking longer than it should".
- **The preview frame in the gallery is a stand-in page, not the real app template** (task H). It does not take the restaurant's brand colour.
- **A step that did not finish still has no shape of its own.** It is drawn as the hollow ring with the words "Did not finish". One function (`stepperProps` in `components/build/build-thread.tsx`) holds that: when `Stepper` gains `stopped`, it becomes `return { steps };`.
- **"Open it" on "You already have this" only sends the reply.** There is no mini-app page to go to until Wave 3.
- **Detector:** one finding on the live pages, `clipped-overflow-container` on `main.rms-shell__main`, from the existing `Workbench` styles. `impeccable shot` does not exist in 4.3.1, so screenshots are from Playwright.
- **`@rms/seed` `books.test.ts`** failed in two of three full `pnpm test` runs in the first round and passed alone. Lead-owned, shared database. Not touched.

## Which routes are used, and where

- `apps/web/lib/agent/api.ts`: `agentApi` is the real API. There is no switch, no setting, nothing a page can set.
- The practice stand-in (`apps/web/lib/agent/mock.ts`) is used in two places, each by name: pages under `/gallery`, and tests. `buildApiFor(pathname)` in `components/build-home.tsx` gives a `/gallery` page the practice routes whatever the rest of the app uses, so a message typed in the gallery can never start a real build.
- The practice preview is served by `node apps/web/lib/agent/stand-in/serve.mjs` on `http://127.0.0.1:5673`.

## What was built

| Piece | Where |
|---|---|
| Events to screen, a pure reducer | `apps/web/lib/agent/reducer.ts` |
| Server-sent events read by hand | `apps/web/lib/agent/sse.ts` |
| Stream client: reconnect with `?after=<seq>`, back-off, at once on `run.paused`, steps over an event it cannot read | `apps/web/lib/agent/stream.ts` |
| One build session with no React in it: load, replay, follow, send, retry, stop | `apps/web/lib/agent/session.ts` |
| The preview's rules with no React in them: when to ask, reload or swap the token | `apps/web/lib/agent/preview.ts` |
| Shell side of the frame hand-off | `apps/web/lib/agent/frame-host.ts` |
| The routes as one interface, and the real one | `apps/web/lib/agent/client.ts`, `api.ts` |
| The practice routes, recorded sessions | `apps/web/lib/agent/mock.ts`, `fixtures.ts` |
| The screen (thin: it draws what the two modules above say) | `apps/web/components/build/*`, `app/(shell)/mini-apps/build/[sessionId]/page.tsx` |
| Build tab starts a run | `apps/web/components/build-home.tsx` |
| `Frame` component | `packages/ui/src/components/frame.tsx` |
| Which sites the app may frame | `apps/web/next.config.ts` (`frameSources`) |
| Gallery | `/gallery/build?state=...`, `/gallery/build/live` |
| Attack tests from the security review | `tests/security/web/frame-relay.test.ts` |

## Fixed after the reviews

1. **An event the screen cannot read no longer stalls the stream.** The stream client steps over an unreadable message whose `id` is the very next number, and tells the reducer (`skipEvent`). When that event was the stop event, the stream asks the session how the run ended and the screen follows it (`settleRun`), so it never stays on Stop.
2. **The gallery always uses the practice routes** (`buildApiFor`).
3. `apps/web/.vitest/` removed and git-ignored.
4. **The real API is the default** for the signed-in app, with no switch.
5. **Retry is its own call**, never the words "Try again" as a message. `AgentApi.retry` is optional: the real one is a marked stub.
6. **`run.done` then `run.started` does not reload the frame.** A closed run is "between": the frame stays and the next run swaps the token under it. Only a failed or stopped run takes its preview away.
7. **Calls refused at the same moment share one new grant**, and each is tried once more.
8. **A `busy` answer reopens the stream**, so the run it was busy with is watched.
9. Tests for 5 to 8 on the two React-free modules (`session.test.ts`, `preview.test.ts`).
10. "Did not finish" sits behind `stepperProps`.

Security list: C. `frame-src` from `PREVIEW_URL` (one or several, comma-separated) and `APPS_URL`, exact origins, wildcards and anything that is not an http or https address left out. D. A body JSON cannot hold (a big integer, a value that contains itself) is answered with a plain 400 and never throws. The two known-gap attack tests are now plain passing tests.

## Needed from task I

One call, so "Try again" can be offered on the signed-in screen:

```
retryRun(tenant: TenantContext, runId: string): Promise<StartRunResponse>
POST /agent/v1/runs/:runId/retry   (no body)  ->  StartRunResponse
```

A new run in the same session that repeats the failed run's own input. It stores `run.started` and no `user.message`. `not_found` for someone else's run, `invalid_request` when that run did not fail. Then set `RETRY_ROUTE` in `apps/web/lib/agent/client.ts` (one line). I's own failure words say "Say 'try again'": typed, those words are stored as an answer or a plan change today.

Also from I: the grant route must answer while a run is `running` (the screen asks right after `run.started`), and the event stream must let the web origin send `authorization`.

## Needed from the lead

1. What `frame-src` should list for real sandbox previews (above).
2. `PREVIEW_URL` and `APPS_URL` in the settings files, present at build time.
3. `Stepper`: the `stopped` status.
4. `MiniAppSummary` has no `kind`. `BuildHome` drops `kind === "system"`, but the loader must filter it when it is wired to data.

## The origin rule, for published mini-apps on a phone (Wave 3)

- **Where:** `Origin` and `isSeparateSite` in `packages/contracts/src/frame.ts` (the grant shapes use them too). The web app applies them in `canLoadGrant`, `apps/web/lib/agent/frame-host.ts`.
- **What it requires, on BOTH the shell's origin and the frame's:** `https` on any host, or `http` only on `localhost` or `127.0.0.1`. The frame may never be on `localhost`. And the two hosts must differ, with neither a parent domain of the other (the port does not count).
- **For a shell at `http://<lan-address>:3000` framing apps at `http://<lan-address>:3002`:** an allow list would need both of those exact origins (the rule checks both sides, in the browser and where the server makes the grant). That is still not enough: they are the same host, so the "different hosts" half refuses them, and lifting it gives up the cookie wall. Two different host names (or https) is the safe way.

## Checks

| Command | Result |
|---|---|
| `pnpm install` | up to date |
| `pnpm typecheck` | 36 of 36 tasks |
| `pnpm build` | 20 of 20 tasks |
| `pnpm --filter @rms/web test` | 113 tests in 7 files: reducer 22, stream 17, session 12, preview 13, frame host 29, frame policy 5, practice run 15 |
| `pnpm --filter @rms/web build` | passes |
| `vitest --config vitest.security.config.ts tests/security/web/frame-relay.test.ts` | 19 of 19 |
| Browser walkthrough | 182 checks, 0 failed, at 1440x900 and 390x844 |

Deliberate breaks tried and put back: dropping the "same window" half of the origin check (2 tests fail), allowing a data call before the hello (1), not sharing the token swap (2), not reopening the stream on `busy` (1). Not stepping over an unreadable event made the tests reconnect without end, which is the fault it fixes.

To run the walkthrough again (three terminals, from the repo root; the values are placeholders, the gallery needs no real settings):

```
cd apps/web && PREVIEW_URL=http://127.0.0.1:5673 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=gallery-only-placeholder NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 pnpm exec next build && PREVIEW_URL=http://127.0.0.1:5673 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=gallery-only-placeholder NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 pnpm exec next start --port 3060
RMS_SHELL_ORIGIN=http://localhost:3060 node apps/web/lib/agent/stand-in/serve.mjs
RMS_WEB=http://localhost:3060 node apps/web/lib/agent/stand-in/walkthrough.mjs
```

## Screenshots

`docs/design/wave2/task-j/`, 39 files, each at `-desktop` (1440x900) and `-phone` (390x844).

- `recorded-*`: first message, question, duplicate, plan, progress, preview, changed (undo offered), confirm, failure, dropped.
- `live-1` to `live-9`: one practice build through the real stream client and a real frame on another site.
