import type { Metadata } from "next";
import { SessionId } from "@rms/contracts";
import { BuildHome } from "@/components/build-home";
import { MiniAppsPage } from "@/components/mini-apps-page";
import { RmsShell } from "@/components/rms-shell";
import { MARIGOLD_KITCHEN } from "../../seeded";
import { LiveBuild } from "./live-build";

export const metadata: Metadata = { title: "Gallery: a practice build" };

// The real build screen on the practice stand-in, start to finish, without signing in:
// the same stream client, reducer, frame and data hand-off the signed-in screen uses.
// With no ?session= it shows the Build tab. Sending a message there comes back here.
export default async function GalleryLiveBuildPage({ searchParams }: { searchParams: Promise<{ session?: string | string[] }> }) {
  const asked = (await searchParams).session;
  const sessionId = typeof asked === "string" && SessionId.safeParse(asked).success ? asked : null;
  return (
    <RmsShell data={MARIGOLD_KITCHEN} currentHref="/mini-apps">
      <MiniAppsPage current="/mini-apps" flush={sessionId !== null}>
        {sessionId === null ? <BuildHome miniApps={MARIGOLD_KITCHEN.miniApps} /> : <LiveBuild sessionId={sessionId} />}
      </MiniAppsPage>
    </RmsShell>
  );
}
