# 0008: A framed mini-app never holds a token. The shell makes its data calls

Date: 2026-11-21. Status: decided by the lead after the architect review of the Wave 2 preparation ("accepted with changes": judged stronger than the plan's design).

## Context

The plan (section 4.6) said: a mini-app shows in a frame inside RMS, and the shell hands it a short-lived token. The mini-app then calls the Data API itself.

That does not work for build previews, and it is weaker than it needs to be.

## Decision

A mini-app in a frame never holds a token and never calls the network. It asks the RMS shell, with a browser message, to make a Data API call for it. The shell holds the token in memory (a run token for a build preview, an app token for a published mini-app), makes the call, and passes the answer back. The shapes are in `packages/contracts/src/frame.ts`. The same hand-off serves previews today and published mini-apps in Wave 3.

## Why

1. **Sandbox previews could not reach a local API.** A preview is served from the build sandbox's public address. A browser will not let a page from a public address call an API on the developer's own machine without a permission prompt. With the relay, the shell and the API are on the same side, so previews work the same against a local API and a deployed one. The sandbox itself never calls RMS at all: its only open address is the model provider, and no RMS credential of any kind is inside it.
2. **No token in agent-written code.** Mini-app code is written by an agent and runs in the owner's browser. A token it never sees cannot be leaked by it, whatever the code does.
3. **The shell cannot be tricked into using the owner's own session.** The Data API accepts only RMS app and run tokens. It refuses a sign-in session token. So even a shell bug that attached the wrong credential to a frame's request would be refused, not obeyed.
4. **One browser origin for the Data API.** It now answers browser calls from the web app's origin only, never from a sandbox or mini-app address.

## What it costs

- **A mini-app cannot be opened on its own, outside the RMS shell, today.** Opened that way it shows "Open this from RMS". Beat 4 on a phone works through the shell: the owner opens RMS on the phone and the mini-app shows inside it. A home-screen icon that opens a mini-app directly needs its own sign-in step later.
- Every data call makes one extra hop inside the browser.
- The shell's frame code becomes a security boundary. It is small, and it is covered by the rules below and their tests.

## What must hold

- **Origin and frame binding.** The shell acts on a message only when it comes from the one frame it made the grant for (that frame's own window) and from the one origin the server named in the grant. It answers only to that origin, never to "any". The mini-app accepts messages only from its parent window and only from the shell origin it was built with. One grant serves one frame. Its token is never used for another frame.
- **Separate sites.** A frame is never served from the web app's own host, or a parent or child of it, because cookies ignore the port. In local development the web app is on `localhost` and previews are opened from `127.0.0.1`. A grant whose frame host is `localhost` is refused.
- **Routes by name.** A frame can ask for one of the five Data API routes by name from a fixed list. It can never name an address or a path.
- **Body cap.** A relayed request body over the limit in `FRAME_LIMITS` is refused by the shell and never sent on.
- **No identity in a message.** No message shape has a field for a restaurant, a user, a role, a store or a token. Unknown message types and extra fields are dropped.
- **The token stays put.** In the shell's memory only: never in the frame's address, a message to the frame, a cookie, browser storage or a log.
- **The Data API keeps refusing session tokens**, and keeps taking the restaurant from the token alone.

## Also changed

`AgentDriver` in contracts is now `start`, `read`, `stop` instead of one long call, and no longer reports per-file changes. The sandbox tests showed a turn outlives the function that started it, and that the agent edits through shell commands. ADR 0007 said the interface was unchanged. This replaces that line.
