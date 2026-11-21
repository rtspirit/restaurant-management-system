# 0013: No phone part in the demo. Desktop web only

Date: 2026-11-21. Decided by Rahul: "Let's scrap the mobile work. Focus on finishing out the web app."

## Decision

- The demo runs in a desktop browser on the laptop. Nothing is shown on a phone.
- Beat 4 becomes: a published mini-app opens inside RMS in the browser.
- No phone-size layout work or checks in Wave 3 and Wave 4. Screens should not break when narrow, but nobody tests or polishes that today.
- Phone mode (`scripts/demo-phone.sh`, ADR 0010) stays in the repo, unused. It costs nothing to keep. Its one lasting effect is good: in normal mode the web app, the console and the API listen on the laptop only.

## What still stands

- A published mini-app is framed from a different host name than RMS, also on the laptop (ADR 0012), because cookies ignore ports.
- Nothing is deployed today (ADR 0010).

## Later

A phone demo needs: the origin list for the phone pair (ADR 0012 had it drafted), a check of every screen at phone size, and an iPhone on a trusted network.
