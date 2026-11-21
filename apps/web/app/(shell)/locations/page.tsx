import type { Metadata } from "next";
import { Card, EmptyState, Page, Section, Text } from "@rms/ui";
import { loadShellData } from "@/components/shell-data";

export const metadata: Metadata = { title: "Locations" };

export default async function LocationsPage() {
  const data = await loadShellData();
  if (!data) return null; // The layout is showing something else (signing out, or not answering).
  const count = data.locations.length;

  return (
    <Page title="Locations" narrow>
      {count === 0 ? (
        <EmptyState title="No locations yet">Each place you serve from shows here, with its opening hours and when its day ends.</EmptyState>
      ) : (
        <Section title={count === 1 ? "1 location" : `${count} locations`}>
          {data.locations.map((place) => (
            <Card key={place.id} title={place.name} titleLevel={3} as="article">
              <Text tone="muted">Opening hours and the time the day ends will show here.</Text>
            </Card>
          ))}
        </Section>
      )}
    </Page>
  );
}
