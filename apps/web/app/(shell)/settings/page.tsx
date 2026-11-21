import type { Metadata } from "next";
import Link from "next/link";
import { Button, EmptyState, Page, Section, Stack, Text } from "@rms/ui";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <Page title="Settings" narrow>
      <Stack gap="xl">
        <Section title="Connected systems">
          <Stack gap="m">
            <Text tone="muted">Connect your point of sale so your sales, staff hours and supplier bills come into RMS by themselves.</Text>
            <Button variant="secondary" href="/settings/connections" linkAs={Link} icon="next">
              See connected systems
            </Button>
          </Stack>
        </Section>
        <EmptyState title="Your colour and logo will be set here">
          You will be able to pick the colour of your buttons and add your logo. Whatever colour you choose, RMS keeps every button easy to read.
        </EmptyState>
      </Stack>
    </Page>
  );
}
