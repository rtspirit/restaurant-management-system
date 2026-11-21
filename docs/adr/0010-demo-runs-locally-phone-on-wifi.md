# 0010: The demo runs on the laptop. The phone joins over Wi-Fi

Date: 2026-11-21. Status: decided by Rahul.

## Decision

Nothing is deployed for the demo. Everything runs on Rahul's laptop. The phone part of the demo uses a phone on the same Wi-Fi, opening RMS by the laptop's network address. One command starts it, `scripts/demo-phone.sh`, and `scripts/demo-phone.sh stop` puts things back.

## What phone mode changes

- **Addresses.** The web app is rebuilt with the API and sign-in addresses set to the laptop's network name (`<mac>.local`, which an iPhone opens), or its network address with `PHONE_ADDRESS=ip`. The web build bakes these in, so phone mode builds its own copy and `stop` rebuilds the normal one.
- **Where the settings live.** In `.env.phone` (git-ignored, nothing secret): `RMS_LOCAL_DEMO=1`, `WEB_URL` (the phone's shell on the `.local` name), `APPS_URL` (the mini-app host on the IP address), `RMS_LOCAL_DEMO_ORIGINS` (exactly those two). `.env.local` is not touched. The API alone keeps `WEB_URL` on the laptop address, so the build preview stays on the laptop.
- **Allowed origins.** The API accepts browser calls from `WEB_URL` and from a short list in `WEB_EXTRA_ORIGINS` (at most four). Exact match only, no wildcard, the request's origin is never echoed unless listed (`apps/api/src/lib/origins.ts`). Phone mode puts the phone address there. Nothing else in the API changes.
- **Sign-out** answers with a relative address. It used to build an absolute one from the server's own idea of its address, which is `0.0.0.0` or `localhost`, and a phone cannot open either.
- **Listening.** The API and web app listen on every address. The console listens on the laptop only: it is not needed on the phone.
- **Mini-apps (Wave 3).** A mini-app must never share the web app's host, because cookies ignore the port. So the mini-app host gets the laptop's *other* name: the IP address when the web app is on the `.local` name, and the reverse. If the laptop has only one usable name, the mini-app host is not started. For a published mini-app to open inside RMS on the phone, `Origin` in `packages/contracts/src/frame.ts` (today: https, or http on `localhost`/`127.0.0.1` only) must also accept the phone-mode shell and frame origins. That is the lead's call; see `docs/briefs/phone-mode.md`.

## Not a secure context

`http://<laptop>` is not a secure context in a browser. Checked: nothing RMS needs breaks. Sign-in with a password, the session cookies (`SameSite=Lax`, not `Secure`) and `crypto.getRandomValues` all work there. Nothing in the web app, console, `@rms/ui` or the mini-app SDK uses `crypto.subtle`, `crypto.randomUUID`, service workers or the clipboard in the browser. So no local HTTPS and no certificate on the phone.

## The risk

While phone mode runs, **anyone on the same Wi-Fi can reach the demo**: the web app, the API and the local sign-in service. The script says so in one line every time it starts.

Separately, and true with or without phone mode: the local Supabase containers already listen on every address, including the database (port 54322) with the standard local development password, and the laptop's firewall is off. Anyone on the same network can reach that database whenever Supabase is running. Changing it means restarting the containers, which nine agents are using today, so it is not changed now.

**Advice:** run the demo on a trusted network, or better, on the phone's own hotspot with the laptop joined to it. Do not run it on venue or hotel Wi-Fi.

## Deliberately not done

- No deploy, and no public address (no tunnel, no port forwarding). The script refuses to start if the laptop's address is not a private one (10.x, 172.16-31.x, 192.168.x).
- No local HTTPS and no certificates: not needed (see above).
- The build preview (ADR 0008) is unchanged and stays on `127.0.0.1`. Building happens on the laptop.
- No change to the Supabase settings or containers.
