import type { Metadata } from "next";
import { EmptyState, Section } from "@rms/ui";

export const metadata: Metadata = { title: "Marketplace" };

export default function MarketplacePage() {
  return (
    <Section title="Recommended for you">
      <EmptyState title="Nothing to recommend yet" titleLevel={3}>
        Mini-apps that other restaurants have chosen to share, and that suit a place like yours, will show here. RMS checks each one before it is
        listed.
      </EmptyState>
    </Section>
  );
}
