import type { Metadata } from "next";
import { Page } from "@rms/ui";
import { ConnectionsScreen } from "@/components/connections/connections-screen";

export const metadata: Metadata = { title: "Connected systems" };

export default function ConnectionsPage() {
  return (
    <Page title="Connected systems" narrow>
      <ConnectionsScreen />
    </Page>
  );
}
