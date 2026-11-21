import type { Metadata } from "next";
import { RmsShell } from "@/components/rms-shell";
import { MiniAppsPage } from "@/components/mini-apps-page";
import { MARIGOLD_KITCHEN } from "@/components/shell-data";
import { BuildScreen } from "./build-screen";

export const metadata: Metadata = { title: "Gallery: build conversation" };

// The approved desktop sketch, rebuilt from @rms/ui with seeded content. For review only.
export default function GalleryBuildPage() {
  return (
    <RmsShell data={MARIGOLD_KITCHEN} currentHref="/mini-apps">
      <MiniAppsPage current="/mini-apps" flush>
        <BuildScreen />
      </MiniAppsPage>
    </RmsShell>
  );
}
