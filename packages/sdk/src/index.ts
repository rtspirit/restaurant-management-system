// @rms/sdk: the only way a mini-app's screens reach RMS. Task H owns this package.
// Brief: docs/briefs/wave2.md, task H.
//
// What goes here: the frame side of the hand-off in @rms/contracts frame.ts (announce
// `rms.ready`, take `rms.init` from the one allowed parent origin, send `rms.data` and match the
// answers by id), a typed data client over it (query, batch, named query, action, catalog),
// and React hooks for screens.
//
// The SDK never holds a token and never calls the network: no fetch, no XMLHttpRequest, no
// WebSocket. It only posts messages to its parent, and only to the origin it was built with.
import { FRAME_PROTOCOL } from "@rms/contracts";

export { defineApp } from "@rms/contracts";
export type { AppManifestInput, FrameContext } from "@rms/contracts";

/** The hand-off protocol this SDK speaks. */
export const SDK_PROTOCOL = FRAME_PROTOCOL;
