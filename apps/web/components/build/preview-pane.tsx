"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Button, Frame, Heading, Notice, Text } from "@rms/ui";
import type { AgentApi } from "@/lib/agent/client";
import { createPreview, type PreviewInput, type PreviewSnapshot } from "@/lib/agent/preview";

export type PreviewPaneProps = {
  api: AgentApi;
  sessionId: string;
  /** The latest preview, from the events. Null until one has been built. */
  preview: { appName: string; version: number } | null;
  /** How many runs have started. A preview token dies with its run, so each new run needs a new one. */
  runCount: number;
  /** Where the latest run stands: see `PreviewInput` in lib/agent/preview.ts. */
  run: PreviewInput["run"];
  /** A plan has been agreed and the build is under way. */
  building: boolean;
  /** The stored conversation has been replayed: what `preview` says is current. */
  settled: boolean;
  brandColour: string | null;
};

const SERVER: PreviewSnapshot = { phase: "none", shown: null };

/**
 * The live preview. It draws what `lib/agent/preview.ts` decides (that is where the rules are,
 * and where they are tested) and hands it the frame element. The frame never holds a token.
 */
export function PreviewPane({ api, sessionId, preview, runCount, run, building, settled, brandColour }: PreviewPaneProps) {
  const controller = useMemo(
    () => (typeof window === "undefined" ? null : createPreview({ api, sessionId, shellOrigin: window.location.origin, messages: window })),
    [api, sessionId],
  );
  const { phase, shown } = useSyncExternalStore(
    controller ? controller.subscribe : () => () => undefined,
    controller ? controller.getSnapshot : () => SERVER,
    () => SERVER,
  );
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const version = preview?.version ?? 0;
  const mount = shown?.mount;

  useEffect(() => () => controller?.dispose(), [controller]);

  // One host for one frame element and one grant. Made as soon as the element exists.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!controller || mount === undefined || !frame) return;
    return controller.attach(frame);
  }, [controller, mount]);

  useEffect(() => {
    controller?.update({ version, runCount, run, settled });
  }, [controller, version, runCount, run, settled]);

  useEffect(() => {
    controller?.setTheme(brandColour);
  }, [controller, brandColour]);

  const title = preview ? `Preview of ${preview.appName}` : "Preview";

  if ((phase === "ready" || phase === "loading") && shown) {
    return <Frame key={shown.mount} title={title} src={shown.url} state={phase} loadingLabel="Getting your preview ready" frameRef={frameRef} />;
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
          {phase === "slow" ? "Nothing is lost. Try it again, or tell RMS what to change and it will bring it back." : "Nothing is lost. Tell RMS what to change and it will bring it back."}
        </Text>
        {run === "alive" ? <Button onClick={() => controller?.again()}>Try again</Button> : null}
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
