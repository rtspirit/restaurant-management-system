import type { Metadata } from "next";
import { EmptyState, Page } from "@rms/ui";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <Page title="Settings" narrow>
      <EmptyState title="Your colour and logo will be set here">
        You will be able to pick the colour of your buttons and add your logo. Whatever colour you choose, RMS keeps every button easy to read.
      </EmptyState>
    </Page>
  );
}
