import type { Metadata } from "next";
import MarketplacePage from "@/app/(shell)/mini-apps/marketplace/page";
import { MiniAppsPage } from "@/components/mini-apps-page";
import { RmsShell } from "@/components/rms-shell";
import { MARIGOLD_KITCHEN } from "../../seeded";

export const metadata: Metadata = { title: "Gallery: Mini-apps, Marketplace tab" };

// The real Marketplace tab as it is today (nothing listed yet), in the shell with seeded content.
// For review without signing in.
export default function GalleryMarketplacePage() {
  return (
    <RmsShell data={MARIGOLD_KITCHEN} currentHref="/mini-apps">
      <MiniAppsPage current="/mini-apps/marketplace">
        <MarketplacePage />
      </MiniAppsPage>
    </RmsShell>
  );
}
