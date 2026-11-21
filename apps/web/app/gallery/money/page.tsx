import type { Metadata } from "next";
import { Button } from "@rms/ui";
import { BackToRms, RmsShell } from "@/components/rms-shell";
import { MoneyApp } from "../money-app";
import { MARIGOLD_KITCHEN } from "../seeded";

export const metadata: Metadata = { title: "Gallery: Money on a phone" };

// The approved phone sketch: a finished mini-app, rebuilt from @rms/ui with seeded content.
// "Ask" has one way in: the button under the numbers. It is not repeated in the bottom bar.
export default function GalleryMoneyPage() {
  return (
    <RmsShell data={MARIGOLD_KITCHEN} currentHref="/mini-apps" phoneStart={<BackToRms href="/gallery" />}>
      <MoneyApp
        show="days"
        foot={
          <Button variant="primary" size="l" block icon="ask">
            Ask about your numbers
          </Button>
        }
      />
    </RmsShell>
  );
}
