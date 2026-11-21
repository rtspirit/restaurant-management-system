import type { Metadata } from "next";
import { EmptyState, Page } from "@rms/ui";

export const metadata: Metadata = { title: "Changes" };

// Task O owns this page. Brief: docs/briefs/wave3.md, task O.
// The owner's list of changes: what is waiting for their OK (with one plain sentence and a
// confirm each), and what happened lately. Plain words only: no tier, no code, no table names.
export default function ChangesPage() {
  return (
    <Page title="Changes">
      <EmptyState title="Nothing is waiting for you" titleLevel={2}>
        When something needs your OK before it happens, it will show here.
      </EmptyState>
    </Page>
  );
}
