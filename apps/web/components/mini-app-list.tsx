import Link from "next/link";
import { Button, Card, Columns, Row, Stack, Text } from "@rms/ui";
import type { MiniAppSummary } from "./shell-data";

/** The restaurant's own mini-apps, one card each. */
export function MiniAppList({ miniApps }: { miniApps: MiniAppSummary[] }) {
  return (
    <Columns>
      {miniApps.map((app) => (
        <Card key={app.id} title={app.name} titleLevel={3} as="article">
          <Stack gap="m">
            <Text tone="muted">{app.summary}</Text>
            <Row justify="end">
              <Button href={app.href} linkAs={Link} aria-label={`Open ${app.name}`}>
                Open
              </Button>
            </Row>
          </Stack>
        </Card>
      ))}
    </Columns>
  );
}
