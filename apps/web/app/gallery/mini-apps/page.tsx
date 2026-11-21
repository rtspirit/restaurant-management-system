import type { Metadata } from "next";
import { BuildHome } from "@/components/build-home";
import { MiniAppsPage } from "@/components/mini-apps-page";
import { RmsShell } from "@/components/rms-shell";
import { MARIGOLD_KITCHEN } from "../seeded";

export const metadata: Metadata = { title: "Gallery: Mini-apps, Build tab" };

// The real Build tab as a new restaurant sees it, in the shell with seeded content.
// For review without signing in.
export default function GalleryMiniAppsPage() {
  return (
    <RmsShell data={MARIGOLD_KITCHEN} currentHref="/mini-apps">
      <MiniAppsPage current="/mini-apps">
        <BuildHome miniApps={MARIGOLD_KITCHEN.miniApps} />
      </MiniAppsPage>
    </RmsShell>
  );
}
