# 0012: Showing a published mini-app on the laptop and on a phone

Date: 2026-11-21. Status: drafted with the Wave 3 preparation at the lead's request. The architect and security reviewers should read this one first.

## The gap

Rahul decided: nothing is deployed today. The demo runs on his laptop, and on a phone on the same Wi‑Fi.

ADR 0008's rule, as the contracts had it: a frame's origin and the shell's origin must both be `https`, or plain `http` on `localhost` or `127.0.0.1`; a frame is never on `localhost`; and the two HOSTS must differ. So a published mini-app could not be shown at all:

- on the laptop, the web app is on `http://127.0.0.1:3000` and the apps host would be on `http://127.0.0.1:3002`: same host.
- on the phone, both are reached at the laptop's network address over plain `http`: not an allowed origin, and the same host again.

## What must not change

**The frame and the shell are on different hosts.** Cookies ignore the port, and the sign-in cookies can be read by page script. A mini-app served from the same host on another port could read the owner's session. That property stays, in every mode. A different port is never enough.

## Decision

One machine has more than one name. A cookie set for one name is never sent to, or readable from, another. So the two servers use two different names for the same laptop.

| Where | RMS web app (the shell) | Apps host (the frame) |
|---|---|---|
| On the laptop | `http://127.0.0.1:3000` | `http://localhost:3002` |
| On a phone | `http://<laptop-name>.local:3000` | `http://<network address>:3002` |

Either way round is as safe. What counts is that the hosts differ.

The rule, in `packages/contracts/src/frame.ts`:

1. **`LocalOrigin`**: plain `http` on this machine or this network only. The host must be `localhost`, `127.0.0.1`, a private IPv4 address (`10.x`, `172.16` to `172.31`, `192.168.x`) or a one-label `.local` name, written exactly as a browser reports it. It can never be a public host, whatever a settings file says.
2. **Local demo mode** (`originMode`): on only when `RMS_LOCAL_DEMO` is exactly `1` and the server is not a deployed one (the hosting platform's own marker settings switch it off). The web app is built with `NEXT_PUBLIC_RMS_LOCAL_DEMO=1` for the demo and without it otherwise. Outside this mode a network address is not an origin at all.
3. **`canFrameApp`**, the one rule for PUBLISHED mini-apps, checked by the server before it makes a grant and by the shell before it loads the frame. All of: both origins are well-formed for the mode; the frame origin is exactly one of the configured apps-host origins (`APPS_URL`, an exact-match list); the hosts differ and neither is a parent domain of the other; a shell on `https` never frames plain `http`.
4. **`AppGrant`** accepts any well-formed frame origin. Whether it may be loaded is `canFrameApp`.

`scripts/demo-phone.sh` (another agent's) sets the switch and the two address lists.

## Why "a frame is never on `localhost`" existed, and what happens to it

It was a shortcut. A grant's shape is checked without knowing the shell's address, and when it was written the web app was assumed to be on `localhost`. Banning `localhost` for frames was a cheap way to say "not the web app's host". The real rule was always "different hosts". In practice the web app runs on `127.0.0.1` (the run-book, the local settings script and the API's cross-origin rule all say so), so on the laptop the OTHER name, `localhost`, is exactly what the apps host must use.

- For **published mini-apps** the shortcut is gone. `canFrameApp` knows both origins and checks the real rule.
- For **build previews** nothing changed. `PreviewGrant` still refuses a `localhost` frame, and `isSeparateSite` still accepts only `https` and loopback. A preview is a sandbox address over `https` with the shell on `127.0.0.1`. A local preview on `127.0.0.1:5173` with the shell on `127.0.0.1:3000` is still refused, as before.

## The cookie reasoning, pair by pair

- **`127.0.0.1` (shell) and `localhost` (frame).** The web app's sign-in cookies are set with no domain, so they belong to the exact host `127.0.0.1`, on any port. A page on `localhost` is a different host: the browser does not send them to it and `document.cookie` there does not show them. A cookie for an IP address cannot be widened to cover a name. The apps host sets no cookie and reads none.
- **`<laptop-name>.local` (shell) and the network address (frame).** The shell's cookies belong to the name. The frame is on an IP address, which never matches a name's cookies, and a name can never be a parent domain of an IP address. Same in reverse.
- **What would break it:** the same name or the same address for both servers. `canFrameApp` refuses that in every mode, and a test tries each pair.
- Browser storage (local storage and the like) is kept per origin, port included, so it was never shared.

## What does not need a "secure context" on the phone

Plain `http` on a network address is not a secure context. Checked for the published path:

- the apps host serves static files with response headers. Nothing there needs one.
- the frame hand-off is `postMessage`, and the SDK makes its ids with `crypto.getRandomValues`, which works everywhere (checked in task H's SDK).
- the shell's data calls are plain `fetch` with a bearer header.
- **Rule for Wave 3 browser code** (in the briefs): no `crypto.subtle`, no `crypto.randomUUID`, no service worker, no `Secure`-only cookie.

Not checked here, and not this ADR's: whether sign-in itself works on the phone over plain `http`. That belongs to the phone-address work.

## What this needs from files outside the Wave 3 preparation

- **The laptop pair needs nothing.** Both are loopback origins, which the strict rule already accepts. Task J's `canLoadGrant` (`isSeparateSite` plus the grant's shape) passes for `http://localhost:3002` framed by `http://127.0.0.1:3000`. Settings: `APPS_URL=http://localhost:3002`, `NEXT_PUBLIC_APPS_URL` the same.
- **The phone pair needs two small changes, after tasks H and J merge:**
  1. Task J's `canLoadGrant` (`apps/web/lib/agent/frame-host.ts`): for a grant of kind `app`, decide with `canFrameApp({ frameOrigin, shellOrigin: window.location.origin, appsOrigins: exactOrigins(NEXT_PUBLIC_APPS_URL, mode), mode })` instead of `isSeparateSite`. Previews keep `isSeparateSite`.
  2. Task H's SDK `connect` (`packages/sdk`) checks the shell origin it was built with against `Origin`. For a mini-app published in local demo mode that origin is a network address, so it must check `AnyOrigin` (well-formed) instead. The origin is baked in by the publish step, which already applied the mode's rule.
- The API's own cross-origin rule (`webCors`) and the sign-in service's address are the phone-address agent's.

## Limits, said plainly

- **A published mini-app is built for ONE RMS address** (the first entry of `WEB_URL` when it was published). Opened under another address it shows "Open this from RMS", and the open route refuses to make a grant. So run the whole demo in one mode: start phone mode before publishing, and use the phone-mode address on the laptop too. Publishing again fixes a mini-app published under the other address.
- **Build previews do not work on the phone.** Their rule did not loosen.
- **`.local` names need the phone to resolve them** (iPhones do; recent Android does). If a phone cannot, show the phone layout in the browser's phone-sized view.
- Local demo mode trusts everyone on the same Wi‑Fi no more than before: the only new thing they can reach is static files of published mini-apps, by an address that holds two long ids.

## Checked

`packages/contracts/src/wave3.test.ts`, "local and phone demo origins": the laptop pair and the phone pair are allowed, either way round; the same host on another port is refused in every mode; the phone pair is refused in strict mode; a public `http` host is never an origin; a deployed server never enters the mode; previews did not loosen.
