# Wave 2, task J: build conversation screen with live preview

Branch `worktree-agent-a6c593cd8ec3b5e1e` (fast-forwarded to `main` at `965830d` first: the worktree was cut before the Wave 2 briefs landed). Nothing pushed. No model call, no Vercel command, no sign-in, no database, no demo reset. No new dependency.

## What is not done, not proven, or looks wrong

- **It has never talked to the real stream.** Task I is not merged, so the screen runs on a practice stand-in by default (below). The real client (`realAgentApi` in `apps/web/lib/agent/client.ts`) is typechecked, and its Data API call is tested, but `start`, `session`, `events`, `preview` and `cancel` have not met a real server. Expect small mismatches when I merges.
- **The preview frame is a stand-in page, not the real app template** (task H is not merged). It plays the frame side of the hand-off faithfully and is drawn with the real `@rms/ui` stylesheet, but it does not take the restaurant's brand colour.
- **`impeccable shot` does not exist** in the installed version (4.3.1). Screenshots were taken with Playwright instead.
- **Detector:** one finding on the live pages, `clipped-overflow-container` on `main.rms-shell__main`. It comes from the existing `Workbench` styles (`overflow: hidden` so each side scrolls on its own), not from this task. Scanning the stand-in `frame.html` as a file gives one false finding (it cannot load the stylesheet the stand-in server serves).
- **A step that did not finish has no shape of its own.** `Stepper` only knows done, in progress and not started. A halted card shows the hollow ring with the words "Did not finish" (through `Stepper`'s `words`). A fourth state in `Stepper` would be better: needs the lead.
- **"Open it" on "You already have this" only sends the reply.** There is no mini-app page to go to until Wave 3.
- **`marketplace.match`** is drawn as a plain card with one choice ("Build my own"). Installing is out of scope.
- **On a phone** the disabled Publish and its note stay pinned above the bottom bar (that is how `Workbench` works) and take about 100px. "Try it on my phone" is left out on a phone, as on the approved sketch.
- **`@rms/seed` `books.test.ts` failed in two of three full `pnpm test` runs** and passed alone and in the third. It is a database test in a lead-owned package, on a database shared with the other tasks. Not touched here.

## What is mocked, and how to switch it off

`apps/web/lib/agent/api.ts` is the one place that picks the build routes:

```ts
const DEFAULT_SOURCE: "practice" | "real" = "practice";   // change to "real", or set NEXT_PUBLIC_RMS_AGENT=real
```

- `practice` is `apps/web/lib/agent/mock.ts`: a stand-in for `/agent/v1/*` and `/data/v1/*` that runs in the browser. It keeps the real stream's habits: one run per message, events numbered across the session, the request that reads the stream moves the run along, `run.paused` part-way through every build, `busy` while working, a preview token that dies with its run. The screen shows a "Practice run: nothing is saved" label while it is in use.
- The practice preview is served by `node apps/web/lib/agent/stand-in/serve.mjs` on `http://127.0.0.1:5673` (never 5173, which is the real template's). `NEXT_PUBLIC_RMS_PRACTICE_PREVIEW_URL` points it elsewhere, for example at H's dev server.
- With `real`, nothing in `components/build` or the reducer changes.

## What was built

| Piece | Where |
|---|---|
| Events to screen, a pure reducer | `apps/web/lib/agent/reducer.ts` |
| Server-sent events read by hand | `apps/web/lib/agent/sse.ts` |
| Stream client: reconnect with `?after=<seq>`, 0.5 to 5 second back-off, at once on `run.paused` | `apps/web/lib/agent/stream.ts` |
| The routes as one interface, and the real one | `apps/web/lib/agent/client.ts`, `api.ts` |
| The practice routes | `apps/web/lib/agent/mock.ts` |
| Recorded sessions (one per state) | `apps/web/lib/agent/fixtures.ts` |
| Shell side of the frame hand-off | `apps/web/lib/agent/frame-host.ts` |
| The screen | `apps/web/components/build/*`, `apps/web/app/(shell)/mini-apps/build/[sessionId]/page.tsx` |
| Build tab starts a real run | `apps/web/components/build-home.tsx` |
| Build screen draws edge to edge | `apps/web/app/(shell)/mini-apps/layout.tsx`, `components/build/mini-apps-frame.tsx` |
| `Frame` component | `packages/ui/src/components/frame.tsx`, one export line, styles at the end of `styles.css` |
| Gallery, recorded | `/gallery/build?state=first|question|duplicate|plan|progress|preview|changed|confirm|failure|dropped` |
| Gallery, a whole practice run with no sign-in | `/gallery/build/live` (also reached by sending a message at `/gallery/mini-apps`) |
| Stand-in frame and the browser walkthrough | `apps/web/lib/agent/stand-in/` |

Choices worth knowing:

- **Only the one thing waiting for the owner has buttons.** Everything older is read-only, so nothing can be answered twice.
- **"Change something" on a plan puts the owner in the box.** What they type is sent as a message. No `confirm: false` is sent for a plan.
- **A "this will happen" dialog (`needs.confirm`) closed without an answer counts as "No, leave it"**, and the conversation shows that.
- **"Try again" sends the words "Try again". "Undo that" sends "Undo that last change".** Undo is offered after a change lands on a preview the owner had already seen.
- **The preview asks for a grant** when `preview.ready` arrives (a fresh frame), after every `run.started` (the token is swapped under the frame that is showing), under two minutes before it runs out, and when the Data API answers `unauthenticated` (then the call is tried once more). The token goes from the grant into the frame host and is never in React state, storage, the address or a message.
- **The grant route must answer while a run is `running`.** After `run.started` the screen asks at once, so the frame keeps working during a change.
- **The web app must be opened on `localhost`** in local development. Opened on `127.0.0.1` it shares a site with a local preview, and the screen says "The preview can't be shown here."

## Needed from the lead or other tasks

1. `Stepper`: a state for a step that did not finish (above).
2. `MiniAppSummary` in `components/shell-data.ts` has no `kind`, and the loader still returns no mini-apps. `BuildHome` drops any entry whose `kind` is `system`, but the loader must filter `kind <> 'system'` itself when it is wired to data.
3. `apps/web/next.config.ts` sets no `frame-src`. Limiting which sites the shell may frame (the sandbox and apps hosts) would be a second wall. Not changed here.
4. Task I: the event stream route must let the web origin send the `authorization` header and read a streamed body. Not checked here.

## Checks

| Command | Result |
|---|---|
| `pnpm install` | up to date |
| `pnpm typecheck` | 36 of 36 tasks |
| `pnpm build` | 20 of 20 tasks |
| `pnpm test` | third run: 36 of 36 tasks, 1,071 tests. First two runs: only `@rms/seed` `books.test.ts` failed (above) |
| `pnpm --filter @rms/web test` | 77 tests in 4 files: reducer 20, stream 14, frame host 28, practice run 15 |
| `pnpm --filter @rms/web build` | passes. New routes: `/mini-apps/build/[sessionId]`, `/gallery/build/live` |
| Browser walkthrough | 180 checks, 0 failed, at 1440x900 and 390x844 |
| Detector | one run on the changed files and on three live pages (above) |

Two deliberate breaks in `frame-host.ts` were tried and put back: dropping the "same window" half of the origin check failed two tests, and allowing a data call before the hello failed one.

To run the walkthrough again (three terminals, from the repo root; the values are placeholders, the gallery needs no real settings):

```
cd apps/web && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=gallery-only-placeholder NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 pnpm exec next build && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=gallery-only-placeholder NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 pnpm exec next start --port 3060
RMS_SHELL_ORIGIN=http://localhost:3060 node apps/web/lib/agent/stand-in/serve.mjs
RMS_WEB=http://localhost:3060 node apps/web/lib/agent/stand-in/walkthrough.mjs
```

## Screenshots

`docs/design/wave2/task-j/`, 39 files, each at `-desktop` (1440x900) and `-phone` (390x844, one screen's worth with the newest thing in view).

- `recorded-*`: first message, question, duplicate, plan, progress, preview (and `preview-below` on a phone), changed (undo offered), confirm, failure, dropped.
- `live-1` to `live-9`: one practice build through the real stream client and a real frame on another site: question, plan, building, preview with a row typed in and read back through the shell, the phone link, reconnecting, recovered, a plain-words failure, "you already have this".
