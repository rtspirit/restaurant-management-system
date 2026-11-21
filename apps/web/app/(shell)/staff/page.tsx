import type { Metadata } from "next";
import { EmptyState, Page } from "@rms/ui";

export const metadata: Metadata = { title: "Staff" };

export default function StaffPage() {
  return (
    <Page title="Staff" narrow>
      <EmptyState title="Your team will show here">
        Everyone who works with you, the job each person does and where they work. Mini-apps use this list to show each person only what is
        theirs to see.
      </EmptyState>
    </Page>
  );
}
