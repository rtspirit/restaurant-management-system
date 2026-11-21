import type { Metadata } from "next";
import { EmptyState, Section } from "@rms/ui";

export const metadata: Metadata = { title: "Marketplace" };

// Task P owns this page. Brief: docs/briefs/wave3.md, task P.
// One Marketplace listing: what it does, what it needs (and which of those this restaurant
// already has), the one sentence to confirm, and Install. `[listing]` is a listing id: the
// server finds it only if it is listed and public. Nothing here ever says who made it.
export default async function ListingPage({ params }: { params: Promise<{ listing: string }> }) {
  await params;
  return (
    <Section title="Mini-app">
      <EmptyState title="This mini-app is not available" titleLevel={3}>
        It may have been taken down. Go back to the Marketplace to see what is there.
      </EmptyState>
    </Section>
  );
}
