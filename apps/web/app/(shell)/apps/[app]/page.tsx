import type { Metadata } from "next";
import { EmptyState, Page } from "@rms/ui";

export const metadata: Metadata = { title: "Mini-app" };

// Task N owns this page. Brief: docs/briefs/wave3.md, task N.
// A PUBLISHED mini-app opens here, inside RMS, on a laptop or a phone: `[app]` is its short
// address (the slug in NavApp), looked up in the restaurant's own menu, never trusted further.
// The page asks PUBLISH_ROUTES.open for an AppGrant and shows the mini-app in a frame. The
// frame never holds a token: the shell makes its data calls (ADR 0008).
// The owner's Publish action lives in `@/components/publish/publish-button`, and Share in
// `@/components/marketplace/share-button` (task P): this page places both.
export default async function AppPage({ params }: { params: Promise<{ app: string }> }) {
  await params;
  return (
    <Page title="Mini-app">
      <EmptyState title="This mini-app is not ready yet" titleLevel={2}>
        Mini-apps you publish will open here, inside RMS.
      </EmptyState>
    </Page>
  );
}
