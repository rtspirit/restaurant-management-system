"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FRAME_LIMITS, type FrameGrant } from "@rms/contracts";
import { Button, Frame, Heading, Notice, Text } from "@rms/ui";
import type { AgentApi } from "@/lib/agent/client";
import { canLoadGrant, createFrameHost, grantNeedsRefresh, type FrameHost } from "@/lib/agent/frame-host";

export type PreviewPaneProps = {
  api: AgentApi;
  sessionId: string;
  /** The latest preview, from the events. Null until one has been built. */
  preview: { appName: string; version: number } | null;
  /** How many runs have started. A preview token dies with its run, so each new run needs a new one. */
  runCount: number;
  /** The latest run is working or waiting, so its preview can be asked for. */
  alive: boolean;
  /** A plan has been agreed and the build is under way. */
  building: boolean;
  /** The stored conversation has been replayed: what `preview` says is current. */
  settled: boolean;
  brandColour: string | null;
};

type Phase =
  /** Nothing to show yet. */
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

/** What may be rendered about a grant. The token is not in here, and never in state. */
type Shown = { url: string; mount: number };

const HELLO_TIMEOUT_MS = FRAME_LIMITS.readyRetries * FRAME_LIMITS.readyEveryMs + 2_000;

/**
 * The live preview: asks RMS for a grant, loads the mini-app in a frame from another site, and
 * makes its data calls for it (ADR 0008). The frame never holds a token. The token goes from
 * the grant straight into the frame host and stays there.
 */
export function PreviewPane({ api, sessionId, preview, runCount, alive, building, settled, brandColour }: PreviewPaneProps) {
  const [phase, setPhase] = useState<Phase>("none");
  const [shown, setShown] = useState<Shown | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<FrameHost | null>(null);
  /** A grant on its way to a frame that is about to be drawn. Never in state. Forgotten once the frame is up. */
  const handover = useRef<FrameGrant | null>(null);
  const ticket = useRef(0);
  const mounts = useRef(0);
  const refresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef<{ version: number; run: number } | null>(null);

  const drop = useCallback(() => {
    hostRef.current?.dispose();
    hostRef.current = null;
    handover.current = null;
    if (refresh.current) clearTimeout(refresh.current);
    refresh.current = null;
  }, []);

  /** Asks for a grant. `reload` draws a fresh frame. Otherwise the token is swapped under the frame that is showing. */
  const ask = useCallback(
    async (reload: boolean): Promise<boolean> => {
      const mine = (ticket.current += 1);
      const fresh = reload || hostRef.current === null;
      if (fresh) setPhase("asking");
      let grant: FrameGrant;
      try {
        grant = await api.preview(sessionId);
      } catch {
        if (mine === ticket.current && fresh) {
          drop();
          setShown(null);
          setPhase("unavailable");
        }
        return false;
      }
      if (mine !== ticket.current) return false;
      // Never load a frame that would share a site, and so cookies, with RMS itself.
      if (!canLoadGrant(grant, window.location.origin)) {
        drop();
        setShown(null);
        setPhase("blocked");
        return false;
      }
      if (refresh.current) clearTimeout(refresh.current);
      const wait = grantNeedsRefresh(grant, Date.now()) ? 30_000 : Date.parse(grant.expiresAt) - Date.now() - 120_000;
      refresh.current = setTimeout(() => void ask(false), Math.max(5_000, wait));

      if (!fresh && hostRef.current?.replaceGrant(grant)) return true;
      // A new frame element, or another origin: the old host goes, with its token.
      hostRef.current?.dispose();
      hostRef.current = null;
      handover.current = grant;
      mounts.current += 1;
      setShown({ url: grant.url, mount: mounts.current });
      setPhase("loading");
      return true;
    },
    [api, sessionId, drop],
  );

  // One host for one frame element and one grant. Made as soon as the element exists.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const grant = handover.current;
    if (!shown || !frame || !grant) return;
    const host = createFrameHost({
      frame,
      grant,
      shellOrigin: window.location.origin,
      messages: window,
      call: api.data,
      onReady: () => {
        // The host has the token now. Nothing else needs to keep the grant.
        handover.current = null;
        setPhase("ready");
      },
      onUnauthenticated: () => ask(false),
    });
    if (!host) {
      setPhase("blocked");
      return;
    }
    hostRef.current = host;
    const hello = setTimeout(() => setPhase((now) => (now === "loading" ? "slow" : now)), HELLO_TIMEOUT_MS);
    return () => {
      clearTimeout(hello);
      host.dispose();
      if (hostRef.current === host) hostRef.current = null;
    };
  }, [shown, api, ask]);

  // When to ask: a preview was (re)built, a new run started, or the session came back to life.
  const version = preview?.version ?? 0;
  useEffect(() => {
    if (!settled) return;
    if (version === 0 || !alive) {
      ticket.current += 1;
      drop();
      seen.current = null;
      setShown(null);
      setPhase(version === 0 ? "none" : "unavailable");
      return;
    }
    const before = seen.current;
    if (before && before.version === version && before.run === runCount) return;
    seen.current = { version, run: runCount };
    void ask(!before || before.version !== version);
  }, [settled, version, runCount, alive, ask, drop]);

  useEffect(() => {
    hostRef.current?.setTheme(brandColour);
  }, [brandColour]);

  useEffect(() => () => drop(), [drop]);

  const again = () => void ask(true);
  const title = preview ? `Preview of ${preview.appName}` : "Preview";

  if (phase === "ready" || phase === "loading") {
    return <Frame key={shown?.mount} title={title} src={shown?.url ?? ""} state={phase} loadingLabel="Getting your preview ready" frameRef={frameRef} />;
  }
  if (phase === "asking" || (phase === "none" && building)) {
    return <Frame title={title} state="loading" loadingLabel={phase === "asking" ? "Getting your preview ready" : "Building your preview"} />;
  }
  if (phase === "blocked") {
    return (
      <Frame title={title} state="empty">
        <Notice kind="problem">The preview can’t be shown here.</Notice>
      </Frame>
    );
  }
  if (phase === "slow" || phase === "unavailable") {
    return (
      <Frame title={title} state="empty">
        <Heading level={3} size="card">
          {phase === "slow" ? "The preview is taking longer than it should" : "The preview is resting"}
        </Heading>
        <Text tone="muted">
          {phase === "slow" ? "Nothing is lost. Try it again, or tell RMS what to change and it will bring it back." : "Nothing is lost. Tell RMS what to change, or say “carry on”, and it will bring it back."}
        </Text>
        {alive ? <Button onClick={again}>Try again</Button> : null}
      </Frame>
    );
  }
  return (
    <Frame title={title} state="empty">
      <Heading level={3} size="card">
        Your preview shows here
      </Heading>
      <Text tone="muted">Agree a plan with RMS and it builds your mini-app in this space. You can try it before anyone else sees it.</Text>
    </Frame>
  );
}
