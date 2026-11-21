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

The only refusal is the `Origin` rule itself (https, or http on `localhost`/`127.0.0.1` only). The contracts change is being designed by the Wave 3 preparation agent as a local-demo mode: an exact-match list of http origins from `RMS_LOCAL_DEMO_ORIGINS`, active only when `RMS_LOCAL_DEMO=1`, hosts still different.

**Two names, proven from this laptop** (2026-11-21, laptop at 192.168.1.232):
- The Mac advertises `rahuls-macbook-pro-2.local` by multicast DNS on its Wi-Fi interface (en0, index 15) as `192.168.1.232`, which is the answer another device on the network gets (`dns-sd -G v4`).
- Playwright Chromium (390x844) and WebKit (iPhone 13) both open the shell at `http://<mac>.local:<port>`, sign in, reach home and Menu, and sign out. The API answers the shell page cross-origin.
- The sign-in cookie set on the `.local` shell (1 cookie) is not readable and not sent on `192.168.1.232` (0 and 0), the apps host's name. Hosts differ, so the cookie jars differ.
- Nothing on the shell needs a secure context (`isSecureContext` is false and everything works).
- Not provable from here: that a given phone resolves `.local`. iPhones do (Bonjour). Some Android phones do not. On those, `PHONE_ADDRESS=ip` puts the shell on the IP and the apps host on the `.local` name, which that phone cannot open, so published mini-apps would not open on it. RMS itself still works. Use an iPhone for beat 4. HTTPS would not help here: the problem is a second name, not a secure context.

## For the lead: what the Wave 3 publish task (N) must read

Paste into N's brief:

> - Phone mode (`scripts/demo-phone.sh`, ADR 0010) writes `.env.phone` and exports to every server it starts: `RMS_LOCAL_DEMO=1`, `WEB_URL` (the phone's shell, e.g. `http://mac.local:3000`), `APPS_URL` (the apps host as the phone reaches it, always a different host, e.g. `http://192.168.1.5:3002`) and `RMS_LOCAL_DEMO_ORIGINS` (exactly those two, comma separated). The apps host listens on `0.0.0.0:${PORT}` (`PORT`, default 3002); publish grants use `APPS_URL` as the frame address, and the published app's `frame-ancestors` and SDK shell origin are `origin(WEB_URL)`.
> - Exception: the API process keeps `WEB_URL` on the laptop address (`http://127.0.0.1:3000`) and gets the phone shell in `WEB_EXTRA_ORIGINS`, so the build preview stays on the laptop. If N's publish route runs in the API, read the phone shell origin from `RMS_LOCAL_DEMO_ORIGINS` (the entry that is not `APPS_URL`), not from `WEB_URL`.
> - Nothing about the mini-app host may relax the rule that the shell and the frame are different hosts.
