# Wave 2, task H: notes for the lead

Branch `worktree-agent-ad1af4bad6e6afa6e`. Fast-forwarded to `main` at `965830d` first (the worktree had been cut before the Wave 2 preparation). Nothing pushed. No model calls, no sandbox, no Vercel, no database.

## Not finished, stubbed, or worth knowing first

- **Not tested inside a real sandbox.** Step 1 is proven on this machine (shell on `localhost`, preview on `127.0.0.1`). Task I proves the sandbox address. The dev server allows hosts `.vercel.run` and `127.0.0.1` (I removed `localhost`: a preview must never be opened from there). If the HMR websocket does not connect through the sandbox's public address, edits still show after a reload; the fix would be `server.hmr.clientPort: 443` in `vite.config.ts` (mine).
- **The shell side is played by a test page** (`packages/app-template/test/shell-page.ts`) until task J merges. It follows the same origin rules and answers from an in-memory store.
- **The bundle test needs the npm registry**, so it is skipped in `pnpm test`. Run it by hand (below). It passed.
- **Dashboard figures read the LAST row** of the report; the chart shows every row. For `prime_cost_by_week` the last row is the latest week's last location row, not the all-locations row. The agent (or a later tweak) picks the row. Said in the generated code and the note the generator returns.
- **Required report dates start a week ago** (`dateFromToday(-7)`) with a week pager. A required report parameter that is not a date is refused.
- **Report totals** are left out when the report's rows are already a mix of lines and totals (it has a `line_kind` or `scope` column: `weekly_pnl`, `prime_cost_by_week`).
- **A ref field is left off a form** when the mini-app cannot read the model it points at (the vendor's "Usual cost account" today). The generator says so in its notes.
- **`rms check` inside the sandbox proves nothing on its own** (as `build.ts` says): the runner's comparison against its trusted copy is the one that counts. `writeLockedHashes` and `rms lock` are for tests and trying the template by hand.

## What I built

- `packages/app-template/vite.config.ts`: the dev policy as a response header (`server.headers`, also `preview.headers`), `frame-ancestors` from `VITE_RMS_SHELL_ORIGIN` read with `loadEnv`, `'none'` when missing or not a valid origin. The built files' intended header is in a comment.
- `packages/sdk`: `connect()` (frame side of ADR 0008), `DataClient` (`query`, `batch`, `named`, `action`, `catalog`; queue, time limit, body cap, request checked before sending), `RmsDataError`, hooks `useRms`, `useRmsClient`, `useQuery`, `useNamedQuery`, `useMutation`, and value helpers (`showValue`, `fromInput`, `toInput`, `formatAs`, money, dates). No network, storage or cookies: a test reads the source. `connect` takes the shell origin as an argument; the locked frame passes `import.meta.env.VITE_RMS_SHELL_ORIGIN` (the SDK lives in `node_modules` in the bundle, where `import.meta.env` is not reliably replaced).
- `packages/app-template/src/rms/` (locked): connect once, theme (also on `rms.theme`), hash navigation from `src/screens/index.ts`, "Open this from RMS", an error boundary, and `notices.tsx` (`NoNumbers`: "No numbers yet / They show once the mini-app is published." in a draft; `Problem`: a failed call in RMS's own words). A "Preview" tag shows in a draft.
- `packages/generators`: `list_detail`, `form`, `dashboard`, `report_table`; the screen list kept with the TypeScript compiler; `rms check` (all seven checks, in order); `rms lock` / `writeLockedHashes`; `lookupCatalog` and `uiCatalog` (hand-written entries in `src/catalog/ui.ts`); the `rms` command per `BUILD_TOOL_CLI` (exit 0/1/2, one JSON object). Every value goes into generated code as JSON text; JSX attributes use `{"..."}` when the value has a quote, brace or similar (a quoted JSX attribute does not read backslash escapes). Keys from the catalog file must be plain names before they become variable names. The generator refuses to write through a link.
- `packages/app-template/scripts/bundle.mjs` and `pnpm --filter @rms/app-template bundle`: `bundle/template.tgz` (git-ignored) with `vendor/` holding our four packages packed by npm, a `package.json` with exactly the allowed dependencies, and an npm `package-lock.json`. None of the runner's four files, no tests.
- `AGENTS.md`: the rule lines unchanged; added the real generators, the SDK hooks and what `rms check` checks.

## How to run it

```
pnpm --filter @rms/app-template dev                        # dev server on 5173 (needs .env.local with VITE_RMS_SHELL_ORIGIN for framing)
pnpm --filter @rms/app-template test                       # frame proof, generated app checks, preview with screenshots
pnpm --filter @rms/generators test                         # golden files (packages/generators/golden/), refusals, the command
pnpm --filter @rms/app-template bundle                     # writes bundle/template.tgz
RMS_BUNDLE_TEST=1 pnpm --filter @rms/app-template exec vitest run test/bundle.slow.test.ts
```

Inside an app folder (the runner's order): write `rms.config.ts` (`renderManifestFile`), `.rms/catalog.json`, `.env.local`; then `npx --no-install rms lock` (by hand only; the runner writes `locked.json` itself); then `rms gen ...`, `npm run build`, `npx --no-install rms check`.

Screenshots (git-ignored, made by the tests): `packages/app-template/test-output/` — `frame-1440.png`, `vendors-1440.png`, `vendors-390.png`, `vendors-390-detail.png`, `vendors-form-error.png`, `money-draft-1440.png`, `not-connected.png`.

## Checks

| Command | Result |
|---|---|
| `pnpm typecheck` | 36 of 36 tasks |
| `pnpm build` | 20 of 20 tasks |
| `RMS_ENV_FILE=... pnpm test` | 36 of 36 tasks |
| `@rms/sdk` tests | 39 passed |
| `@rms/generators` tests | 28 passed (9 golden files plus the screen list) |
| `@rms/app-template` tests | 67 passed, 2 skipped (the bundle test, run separately) |
| bundle test (`RMS_BUNDLE_TEST=1`) | 2 passed: `npm ci` outside the repo, `rms lock`, `rms gen`, `npm run build`, `rms check` all pass |

`pnpm test:security` not run: nothing here touches data, tokens or queries.

## What I need from the lead

- **Added a dev dependency**: `@rms/models` (`workspace:*`) in `packages/generators/package.json`, for the golden tests against the real `LIBRARY` column lists the brief asks for. Test-only (`src/testing/`, not built). `pnpm-lock.yaml` changed by that one line.
- **Template `tsconfig.json` no longer includes `vite.config.ts`**: it needs Node's types, which the bundle does not install. Vite loads it itself.

## Noticed, out of scope

- The template's `package.json` (workspace version) and the bundled one differ on purpose: the bundled one is the one `rms check` sees in a build.
- On a phone the navigation tabs scroll sideways when there are four or more screens (`TabLinks` behaviour).
