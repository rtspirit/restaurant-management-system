"use client";

import { useEffect } from "react";
import { BuildSession } from "@/components/build/build-session";
import type { PracticeProfile } from "@/lib/agent/client";
import { practiceAgentApi, practiceControls } from "@/lib/agent/mock";
import { MARIGOLD_KITCHEN } from "../../seeded";

const PROFILE: PracticeProfile = {
  restaurantName: MARIGOLD_KITCHEN.restaurantName,
  brandColour: MARIGOLD_KITCHEN.brandColour,
  userName: MARIGOLD_KITCHEN.userName,
  role: MARIGOLD_KITCHEN.role,
  locations: MARIGOLD_KITCHEN.locations.map((location) => ({ name: location.name })),
};

/** The build screen on the practice stand-in, always: the gallery never talks to the real API. */
export function LiveBuild({ sessionId }: { sessionId: string }) {
  // For looking at hard-to-reach moments by hand, and for the screenshot run:
  // window.rmsPractice.offline = true cuts the connection, failNextBuild makes a build stop short.
  useEffect(() => {
    (window as unknown as { rmsPractice?: typeof practiceControls }).rmsPractice = practiceControls;
  }, []);
  return <BuildSession sessionId={sessionId} profile={PROFILE} api={practiceAgentApi} homeHref="/gallery/build/live" sessionPath={(id) => `/gallery/build/live?session=${id}`} />;
}
