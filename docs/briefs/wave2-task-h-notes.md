# Wave 2, task H: notes for the lead

Branch `worktree-agent-ad1af4bad6e6afa6e`. Fast-forwarded to `main` at `965830d` first (the worktree had been cut before the Wave 2 preparation). Nothing pushed. No model calls, no sandbox, no Vercel, no database.

## Not finished, stubbed, or worth knowing first

- **Not tested inside a real sandbox.** Step 1 is proven on this machine (shell on `localhost`, preview on `127.0.0.1`). Task I proves the sandbox address. The dev server allows hosts `.vercel.run` and `127.0.0.1` (I removed `localhost`: a preview must never be opened from there). If the HMR websocket does not connect through the sandbox's public address, edits still show after a reload; the fix would be `server.hmr.clientPort: 443` in `vite.config.ts` (mine).
- **The shell side is played by a test page** (`packages/app-template/test/shell-page.ts`) until task J merges. It follows the same origin rules and answers from an in-memory store.
- **The bundle test runs in `pnpm test`** and rebuilds `bundle/template.tgz` first, so the bundle always matches the code. It needs the npm registry; `RMS_BUNDLE_TEST=0` skips it on a machine with no network.
- **Dashboard figures** (after review): a report with a `scope` column is read for all locations only (`allLocationsRows`), and one with a `week_end` column shows the last FINISHED week (`lastFinishedRow`), so `prime_cost_by_week` shows the week of 9 November on 21 November. Otherwise the last row. The chart uses the same rows.
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
pnpm --filter @rms/app-template exec vitest run test/bundle.slow.test.ts   # also part of pnpm test
```

Inside an app folder (the runner's order): write `rms.config.ts` (`renderManifestFile`), `.rms/catalog.json`, `.env.local`; then `npx --no-install rms lock` (by hand only; the runner writes `locked.json` itself); then `rms gen ...`, `npm run build`, `npx --no-install rms check`.

Screenshots (git-ignored, made by the tests): `packages/app-template/test-output/` — `frame-1440.png`, `vendors-1440.png`, `vendors-390.png`, `vendors-390-detail.png`, `vendors-form-error.png`, `money-draft-1440.png`, `not-connected.png`.

## Checks

| Command | Result |
|---|---|
| `pnpm typecheck` | 36 of 36 tasks |
| `pnpm build` | 20 of 20 tasks |
| `RMS_ENV_FILE=... pnpm test` | 36 of 36 tasks |
| `@rms/sdk` tests | 41 passed |
| `@rms/generators` tests | 28 passed (9 golden files plus the screen list) |
| `@rms/app-template` tests | 163 passed, including the bundle test |
| bundle test (in the 163) | 2 passed: `npm ci` outside the repo, `rms lock`, `rms gen`, `npm run build`, `rms check` all pass |

`pnpm test:security` not run: nothing here touches data, tokens or queries.

## What I need from the lead

- **Added a dev dependency**: `@rms/models` (`workspace:*`) in `packages/generators/package.json`, for the golden tests against the real `LIBRARY` column lists the brief asks for. Test-only (`src/testing/`, not built). `pnpm-lock.yaml` changed by that one line.
- **Template `tsconfig.json` no longer includes `vite.config.ts`**: it needs Node's types, which the bundle does not install. Vite loads it itself.

## Review fixes (second commit set)

- `rms check` safety: names are looked up in a Map (no more `toString` or `valueOf` refusals). Refused now: bare `location`, `open`, `parent`, `top`, `opener`, `frames`, `self`, `window`, `globalThis` (unless the file declares its own, such as `const [open, setOpen]`), `document.defaultView`, `Function` and `eval` as values, `createElement`, `href`/`action`/`formAction`/`httpEquiv`/`srcDoc` on host elements (an in-page `#` link is fine), `<meta>`, `<base>`, `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<style>`, spreads onto host elements, every stylesheet extension, and imports with a query. Still a ban list, not an allow list of globals: `rms check` only warns early, and the runner, the policy header and the relay are the real walls.
- Dev policy: `connect-src 'self'` (no more `ws: wss:`; a test proves hot reload still connects), `form-action 'none'`, `base-uri 'none'`.
- Forms and details leave out fields the Data API reports as `masked`, and never send them.

## Security review fixes (round 2)

- **Lead-owned change, as agreed:** `packages/contracts/src/build.ts` `ALLOWED_APP_IMPORTS` no longer lists `react/jsx-runtime` (the compiler's own automatic use is not an import in source). The matching line in `packages/contracts/src/wave2.test.ts` was updated with it.
- `rms check` safety is now an allow list, using the TypeScript checker: every name must be the mini-app's own (resolved by scope) or one of a short list of safe globals (`Math`, `JSON`, `Array`, `Date`, `Intl`, ..., `Object` with `keys`, `fromEntries`, `freeze`, `is` only). Names that are the page's own (`window`, `location`, `parent`, `open`, `document`, ...) may not be declared. A computed key must have a fixed literal type, checked against the banned member names. No casts but `as const`, no `any`. No `ref`, no spreads in JSX. An event is read only as `target.value` / `target.checked`. Members that reach the page (`ownerDocument`, `defaultView`, `view`, `nativeEvent`, `parentNode`, `call`, `constructor`, ...) are refused. Host elements come from an allow list; `img` only with a relative `src`; no `video`, `audio`, `source`, `iframe`, `object`, `embed`, `link`, `script`, SVG `image`/`use`. Workers, `RTCPeerConnection`, channels, `URL`, `Blob`, `Image`, `Audio` are refused because they are not on the list. No namespace imports, no `export *`, no `import()`.
- Only `.ts` and `.tsx` (exactly, lower case) may be in `src/screens/` and `src/components/`; links are refused; any new root file (`vite.config.js`, `.env.development.local`, `.npmrc`, ...) fails `locked`. The root-file tests passed before this round too: the locked rule already refused them.
- Dev policy adds `object-src`, `frame-src`, `worker-src`, `media-src`, `manifest-src` all `'none'` and `webrtc 'block'`; a test checks there is no `unsafe-eval`. Chromium does not support `webrtc` yet and logs "Unrecognized Content-Security-Policy directive 'webrtc'." once; the browser tests ignore exactly that line. WebRTC is refused by `rms check` anyway.
- Generated `report_table` code now types its `sum` key as a literal union, so it passes the new key rule. Every golden mini-app and the template still pass all checks and build.

**For the publish task (Wave 3):**
1. Publish never trusts the sandbox's `node_modules/` or `dist/`: it does a clean `npm ci` from the locked `package-lock.json`.
2. It runs its own `rms check` (all seven checks) on the server side, against its own trusted hash list, not the app's `.rms/locked.json`.
3. It builds again from that clean install and publishes only that build, with the production policy header.

## Can wait

- `node_modules/` is not hashed by the locked rule (it is an ignored folder). A change there is not caught by `rms check`.
- Vite still accepts a request with `Host: localhost` (the host check allows `127.0.0.1` and `.vercel.run`, and Vite always allows `localhost`). A grant never names `localhost`, so the shell never frames it from there.

## Noticed, out of scope

- The template's `package.json` (workspace version) and the bundled one differ on purpose: the bundled one is the one `rms check` sees in a build.
- On a phone the navigation tabs scroll sideways when there are four or more screens (`TabLinks` behaviour).
