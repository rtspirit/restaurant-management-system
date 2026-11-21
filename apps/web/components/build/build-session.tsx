"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button, EmptyState, Narrow, Skeleton, Stack } from "@rms/ui";
import { signOutAndGoToSignIn } from "@/lib/api";
import { agentApi } from "@/lib/agent/api";
import type { AgentApi, PracticeProfile } from "@/lib/agent/client";
import { BuildWorkbench } from "./build-workbench";
import { PreviewPane } from "./preview-pane";
import { useBuildSession } from "./use-build-session";

export type BuildSessionProps = {
  sessionId: string;
  /** The restaurant and person, for display inside the preview. Nothing here grants access. */
  profile: PracticeProfile;
  /** Where "back to Build" goes. */
  homeHref?: string;
  /** Where this build lives on the web app, for "Try it on my phone". */
  sessionPath?: (sessionId: string) => string;
  /** The build routes to use. Left out everywhere except tests and the gallery. */
  api?: AgentApi;
};

/** The build conversation with its live preview, for one session. */
export function BuildSession({ sessionId, profile, homeHref = "/mini-apps", sessionPath = (id) => `/mini-apps/build/${id}`, api = agentApi }: BuildSessionProps) {
  const session = useBuildSession(api, sessionId);
  const { view, load } = session;

  // A practice run has no server to ask who this is, so it is told. The real API knows from the session.
  useEffect(() => {
    api.describe?.(profile);
  }, [api, profile]);

  useEffect(() => {
    if (load === "signed-out") void signOutAndGoToSignIn();
  }, [load]);

  if (load === "loading" || load === "signed-out") {
    return (
      <Narrow>
        <Stack gap="m">
          <Skeleton shape="text" width="m" label="Opening your build" />
          <Skeleton shape="block" />
          <Skeleton shape="text" width="l" />
        </Stack>
      </Narrow>
    );
  }

  if (load === "not-found") {
    return (
      <Narrow>
        <EmptyState
          title="This build can’t be found"
          action={
            <Button variant="primary" href={homeHref} linkAs={Link}>
              Back to Build
            </Button>
          }
        >
          It may have been started on another account, or the link may be cut short. Nothing has been lost.
        </EmptyState>
      </Narrow>
    );
  }

  if (load === "unavailable") {
    return (
      <Narrow>
        <EmptyState title="RMS is not answering just now" action={<Button onClick={session.reload}>Try again</Button>}>
          Nothing has been lost. Give it a moment, then try again.
        </EmptyState>
      </Narrow>
    );
  }

  // `run.done` means the owner sent the next thing and its run is about to start: the preview
  // stays as it is. Only a run that failed or was stopped takes its preview with it.
  const run = view.phase === "working" || view.phase === "your-turn" ? "alive" : view.phase === "done" ? "between" : "ended";
  const building = view.phase === "working" && view.items.some((item) => item.kind === "plan" && item.confirmed);

  return (
    <BuildWorkbench
      view={view}
      connection={session.connection}
      problem={session.problem}
      sending={session.sending}
      busy={session.busy}
      stopping={session.stopping}
      canRetry={session.canRetry}
      practice={api.practice}
      phoneLink={() => `${window.location.origin}${sessionPath(sessionId)}`}
      actions={session.actions}
      preview={
        <PreviewPane
          api={api}
          sessionId={sessionId}
          preview={view.preview}
          runCount={view.runCount}
          run={run}
          building={building}
          settled={session.settled}
          brandColour={profile.brandColour}
        />
      }
    />
  );
}
