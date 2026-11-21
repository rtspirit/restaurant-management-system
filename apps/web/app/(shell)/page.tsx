import type { Metadata } from "next";
import Link from "next/link";
import { Button, EmptyState, Narrow, Page, Row, Section } from "@rms/ui";
import { MiniAppList } from "@/components/mini-app-list";
import { loadShellData } from "@/components/shell-data";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage() {
  const data = await loadShellData();
  if (!data) return null; // The layout is showing something else (signing out, or not answering).

  // Never "Hello, " with nothing after it.
  const firstName = data.userName.split(" ")[0];
  const greeting = firstName ? `Hello, ${firstName}` : "Hello";

  return (
    <Page title={greeting}>
      <Section title="Your mini-apps">
        {data.miniApps.length > 0 ? (
          <MiniAppList miniApps={data.miniApps} />
        ) : (
          <Narrow>
            <EmptyState
              title="No mini-apps yet"
              titleLevel={3}
              action={
                <Row>
                  <Button variant="primary" href="/mini-apps" linkAs={Link}>
                    Build a mini-app
                  </Button>
                  <Button href="/mini-apps/marketplace" linkAs={Link}>
                    Look in the Marketplace
                  </Button>
                </Row>
              }
            >
              A mini-app is a small tool made for {data.restaurantName}. Tell RMS what you need in your own words and it builds one, or pick one
              that is already made.
            </EmptyState>
          </Narrow>
        )}
      </Section>
    </Page>
  );
}
