import type { Metadata } from "next";
import { EmptyState, Page } from "@rms/ui";

export const metadata: Metadata = { title: "Menu" };

export default function MenuPage() {
  return (
    <Page title="Menu" narrow>
      <EmptyState title="Your menu will show here">
        Dishes, drinks, prices and the groups they belong to. RMS keeps this list, and your mini-apps read from it so every number uses the same
        menu.
      </EmptyState>
    </Page>
  );
}
