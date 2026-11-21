# Phone mode (section for docs/runbook.md)

*For the lead to merge into the run-book. Decision: ADR 0010.*

## Phone mode: the phone part of the demo, over Wi-Fi

Nothing is deployed. RMS runs on the laptop, and the phone opens it over the same Wi-Fi.

**Caveats first**
- While phone mode runs, **anyone on the same Wi-Fi can reach the demo.** Use a trusted network, or best, turn on the phone's hotspot and join the laptop to it.
- The local database is reachable on the network whenever Supabase runs, phone mode or not (ADR 0010). Same advice.
- Phone mode replaces the normal servers. Stop the normal API, web app and console first (in Claude, stop the `rms-api`, `rms-web`, `rms-admin` previews). The script refuses to start while they run.
- The console works on the laptop only. It is not needed on the phone.
- Published mini-apps on the phone need Wave 3 (task N) and one contracts change by the lead. Until then, beat 4 on the phone shows RMS itself, not the mini-app.

**Before the demo (once, about 3 minutes)**
1. Supabase is running as usual.
2. Join the laptop and the phone to the same network (the phone's hotspot is best).
3. Stop the normal servers.
4. Run `scripts/demo-phone.sh`. It builds the web app for the phone (about a minute) and starts everything. It prints the address to type on the phone, for example `http://rahuls-macbook-pro-2.local:3000`.
5. On the phone, open that address in Safari and sign in as `owner@marigold.test`. Nothing to install on the phone, no certificate to trust.
6. If the phone cannot open the `.local` address (some Android phones), run `scripts/demo-phone.sh stop`, then `PHONE_ADDRESS=ip scripts/demo-phone.sh`, and use the number address it prints.
7. On the laptop, keep using `http://127.0.0.1:3000` for building (the build preview stays on this laptop) and `http://127.0.0.1:3001` for the console.

**Check it from the laptop (optional, 1 minute):** `node scripts/demo-phone-check.mjs`. It opens the phone address as a phone-sized Chrome and as iPhone Safari, signs in as the Marigold owner, opens Menu and signs out. Both lines must say PASS.

**If the laptop changes network** (new Wi-Fi, hotspot dropped): `scripts/demo-phone.sh stop` then `scripts/demo-phone.sh` again. With the `.local` name the address on the phone stays the same.

**After the demo:** `scripts/demo-phone.sh stop`. It stops the servers, deletes `.env.phone`, and rebuilds the normal laptop-only web app and console (about a minute). Then start the normal servers again. `scripts/demo-phone.sh status` says what is running.

**What it changes, in short:** the web app is built with the laptop's network address instead of `127.0.0.1`; the API also accepts that one extra address (exact match only); the API and web app listen on the network; the console stays on the laptop. `.env.local` is never edited. Logs are in `.phone-mode/`.

---

## For the lead: plain http is enough for a framed mini-app on the phone

Checked by reading task J's `apps/web/lib/agent/frame-host.ts` and contracts `frame.ts`, and by a test: a shell page at `http://192.168.1.232:3190` framed a page at `http://rahuls-macbook-pro-2.local:3192` (served with `frame-ancestors` set to the shell), and the two exchanged ready, init, a data call and its answer with `postMessage`, exact `targetOrigin` and exact `event.origin` and `event.source` checks, in Chromium and WebKit. `isSecureContext` was false on both sides. The frame host uses only `postMessage`, message events, `TextEncoder`, `AbortController` and `fetch`; the SDK uses `crypto.getRandomValues`. None needs a secure context. (The one secure-context API in J's code is `navigator.clipboard` in `build-workbench.tsx`, on the build screen, which stays on `127.0.0.1`, a secure context; it is also in a try/catch.)

The only refusal is the `Origin` rule itself. Patch for the lead (contracts, `packages/contracts/src/frame.ts`, the `.refine` on `Origin`, about line 102), then the same rule in `shellOriginFrom` in `packages/app-template/vite.config.ts`:

> Accept `https://` (unchanged), or `http://` whose host is exactly `localhost` or `127.0.0.1` (unchanged), or a private IPv4 address (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, each part 0-255), or a single-label `.local` name (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.local$`). Optional port as today. Nothing else: no other http host, no wildcard, no path.

Every check that uses `Origin` then works for phone mode unchanged: `FrameGrant.frameOrigin`, `isSeparateSite` (the `.local` name and the IP are different hosts, neither a parent of the other), `fromExpectedOrigin`, and `canLoadGrant` in J's frame host. The "separate sites" rule still holds because phone mode always serves the apps host on the laptop's other name. The BUILD preview is not loosened by this: its grant still requires the frame origin the server computes from the sandbox or `127.0.0.1`, and the server-side preview rule stays as it is. If the lead wants it tighter, accept the extra http hosts only in the published-app grant schema and in `isSeparateSite`, not in the preview grant.

## For the lead: what the Wave 3 publish task (N) must read

Paste into N's brief:

> - Phone mode (ADR 0010) sets `RMS_PHONE_WEB_ORIGIN` (the phone's shell origin, e.g. `http://mac.local:3000`) and `RMS_APPS_PUBLIC_URL` (the apps host's address as the phone reaches it, always a different host from the shell) in `.env.phone`, and exports both to every server it starts. When `RMS_APPS_PUBLIC_URL` is set, publish grants use it as the frame `url`, and the apps host listens on `0.0.0.0:${PORT}` (`PORT`, default 3002).
> - A published mini-app must accept the shell at `origin(WEB_URL)` AND, when set, `RMS_PHONE_WEB_ORIGIN`: in its `frame-ancestors` header, in the SDK's parent-origin check (build with both, or serve the one matching the requesting shell), and in the server's `isSeparateSite` check for the publish grant.
> - Blocked on the lead first: `Origin` in `packages/contracts/src/frame.ts` and `shellOriginFrom` in `packages/app-template/vite.config.ts` accept only https or http on `localhost`/`127.0.0.1`, so they refuse `http://mac.local:3000` and `http://192.168.x.y:3002`. They must also accept http on `.local` names and private IPv4 addresses (10/8, 172.16/12, 192.168/16), exactly, with no other widening.
