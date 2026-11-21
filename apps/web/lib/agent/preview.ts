// When to ask RMS for a preview grant, when to draw a fresh frame, and when to only swap the
// token under the frame that is showing (ADR 0008, contracts frame.ts).
//
// No React in here, so each rule can be tested by itself. `preview-pane.tsx` draws what
// `getSnapshot()` says and hands this the frame element.
//
// The token is never in the snapshot. It goes from the grant into the frame host and stays there.
import { FRAME_LIMITS, type FrameGrant } from "@rms/contracts";
import type { AgentApi } from "./client";
import { canLoadGrant, createFrameHost, grantNeedsRefresh, type FrameElement, type FrameHost, type MessageSource } from "./frame-host";

export type PreviewPhase =
  /** Nothing has been built yet. */
  | "none"
  /** Asking RMS for the preview. */
  | "asking"
  /** The frame is loading and has not said hello yet. */
  | "loading"
  | "ready"
  /** The preview would share a site with RMS itself. It is never loaded. */
  | "blocked"
  /** The frame never said hello. */
  | "slow"
  /** RMS would not hand out a preview just now. */
  | "unavailable";

/** What may be drawn. `mount` goes up each time a fresh frame element is needed. */
export type PreviewSnapshot = { phase: PreviewPhase; shown: { url: string; mount: number } | null };

/** What the conversation says about the preview, from the events. */
export type PreviewInput = {
  /** Goes up each time the preview is rebuilt (`preview.ready`). 0 before the first. */
  version: number;
  /** How many runs have started. A preview token dies with its run. */
  runCount: number;
  /**
   * alive: the latest run is working or waiting, so its preview can be asked for.
   * between: that run was closed because the owner sent the next thing (`run.done`). The next
   *          `run.started` is on its way: keep what is showing and ask for nothing.
   * ended: the run failed or was stopped. Its preview is gone.
   */
  run: "alive" | "between" | "ended";
  /** The stored conversation has been replayed, so the rest of this is current. */
  settled: boolean;
};

export type PreviewDeps = {
  api: Pick<AgentApi, "preview" | "data">;
  sessionId: string;
  /** The shell's own origin: `window.location.origin`. */
  shellOrigin: string;
  /** Where frame messages arrive: `window`. */
  messages: MessageSource;
};

export type PreviewController = {
  getSnapshot: () => PreviewSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Tell it what the conversation now says. Safe to call with the same values again. */
  update: (input: PreviewInput) => void;
  /** The frame element for the current `shown.mount` exists. Returns what to call when it goes away. */
  attach: (frame: FrameElement) => () => void;
  /** The owner pressed "Try again" on a preview that did not come up. */
  again: () => void;
  setTheme: (brandColour: string | null) => void;
  /** Forget the token and stop. `update` starts it again. */
  dispose: () => void;
};

export const HELLO_TIMEOUT_MS = FRAME_LIMITS.readyRetries * FRAME_LIMITS.readyEveryMs + 2_000;
const NOTHING: PreviewSnapshot = { phase: "none", shown: null };

export function createPreview(deps: PreviewDeps): PreviewController {
  const { api, sessionId, shellOrigin, messages } = deps;
  let snapshot: PreviewSnapshot = NOTHING;
  const listeners = new Set<() => void>();
  let host: FrameHost | null = null;
  /** A grant on its way to a frame that is about to be drawn. Forgotten once the frame is up. */
  let handover: FrameGrant | null = null;
  let ticket = 0;
  let mounts = 0;
  let refresh: ReturnType<typeof setTimeout> | null = null;
  let seen: { version: number; run: number } | null = null;
  /** The one token swap in flight, shared by everything that is waiting for it. */
  let swapping: Promise<boolean> | null = null;

  const set = (next: PreviewSnapshot) => {
    if (next.phase === snapshot.phase && next.shown === snapshot.shown) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const drop = () => {
    host?.dispose();
    host = null;
    handover = null;
    if (refresh) clearTimeout(refresh);
    refresh = null;
  };

  /** Asks for a grant. `reload` draws a fresh frame. Otherwise the token is swapped under the frame that is showing. */
  const ask = async (reload: boolean): Promise<boolean> => {
    const mine = (ticket += 1);
    const fresh = reload || host === null;
    if (fresh) set({ phase: "asking", shown: snapshot.shown });
    let grant: FrameGrant;
    try {
      grant = await api.preview(sessionId);
    } catch {
      if (mine === ticket && fresh) {
        drop();
        set({ phase: "unavailable", shown: null });
      }
      return false;
    }
    if (mine !== ticket) return false;
    // Never load a frame that would share a site, and so cookies, with RMS itself.
    if (!canLoadGrant(grant, shellOrigin)) {
      drop();
      set({ phase: "blocked", shown: null });
      return false;
    }
    if (refresh) clearTimeout(refresh);
    const wait = grantNeedsRefresh(grant, Date.now()) ? 30_000 : Date.parse(grant.expiresAt) - Date.now() - 120_000;
    refresh = setTimeout(() => void swap(), Math.max(5_000, wait));

    if (!fresh && host?.replaceGrant(grant)) return true;
    // A new frame element, or another origin: the old host goes, with its token.
    host?.dispose();
    host = null;
    handover = grant;
    mounts += 1;
    set({ phase: "loading", shown: { url: grant.url, mount: mounts } });
    return true;
  };

  /**
   * A new token for the frame that is showing. However many callers ask while one swap is on
   * its way (four data calls refused at the same moment, a new run, the timer), there is ONE
   * request, and every caller gets its answer.
   */
  const swap = (): Promise<boolean> => {
    swapping ??= ask(false).finally(() => {
      swapping = null;
    });
    return swapping;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    update(input) {
      if (!input.settled) return;
      if (input.version === 0 || input.run === "ended") {
        ticket += 1;
        drop();
        seen = null;
        set({ phase: input.version === 0 ? "none" : "unavailable", shown: null });
        return;
      }
      if (input.run === "between") {
        // `run.done` and then `run.started`, often in separate pieces. The frame stays as it is:
        // the next run swaps the token under it. Nothing to show at all means there is no run
        // to ask (a session opened after it was closed).
        if (host === null && handover === null && snapshot.phase === "none") set({ phase: "unavailable", shown: null });
        return;
      }
      const before = seen;
      if (before && before.version === input.version && before.run === input.runCount) return;
      seen = { version: input.version, run: input.runCount };
      if (!before || before.version !== input.version || (host === null && handover === null)) void ask(true);
      else void swap();
    },

    attach(frame) {
      const grant = handover;
      if (!grant) return () => undefined;
      const made = createFrameHost({
        frame,
        grant,
        shellOrigin,
        messages,
        call: api.data,
        onReady: () => {
          // The host has the token now. Nothing else needs to keep the grant.
          handover = null;
          set({ phase: "ready", shown: snapshot.shown });
        },
        onUnauthenticated: swap,
      });
      if (!made) {
        set({ phase: "blocked", shown: null });
        return () => undefined;
      }
      host = made;
      const hello = setTimeout(() => {
        if (host === made && snapshot.phase === "loading") set({ phase: "slow", shown: snapshot.shown });
      }, HELLO_TIMEOUT_MS);
      return () => {
        clearTimeout(hello);
        made.dispose();
        if (host === made) host = null;
      };
    },

    again() {
      void ask(true);
    },

    setTheme(brandColour) {
      host?.setTheme(brandColour);
    },

    // Back to nothing: the token is forgotten and any answer still on its way is ignored.
    // `update` brings it back, so a screen that is torn down and set up again just works.
    dispose() {
      ticket += 1;
      drop();
      seen = null;
      set(NOTHING);
    },
  };
}
