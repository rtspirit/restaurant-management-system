import type { Metadata } from "next";
import { RmsShell } from "@/components/rms-shell";
import { MiniAppsPage } from "@/components/mini-apps-page";
import { RECORDED_STATES, type RecordedState } from "@/lib/agent/fixtures";
import { MARIGOLD_KITCHEN } from "../seeded";
import { BuildScreen } from "./build-screen";

export const metadata: Metadata = { title: "Gallery: build conversation" };

// The build screen, drawn by the real components from a recorded list of events. For review
// without a run. Pick a state with ?state=: first, question, duplicate, plan, progress, preview,
// changed, confirm, failure, dropped. A full practice run is at /gallery/build/live.
export default async function GalleryBuildPage({ searchParams }: { searchParams: Promise<{ state?: string | string[] }> }) {
  const asked = (await searchParams).state;
  const state: RecordedState = typeof asked === "string" && (RECORDED_STATES as string[]).includes(asked) ? (asked as RecordedState) : "preview";
  return (
    <RmsShell data={MARIGOLD_KITCHEN} currentHref="/mini-apps">
      <MiniAppsPage current="/mini-apps" flush>
        <BuildScreen key={state} state={state} />
      </MiniAppsPage>
    </RmsShell>
  );
}
