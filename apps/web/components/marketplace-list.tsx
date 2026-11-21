import { Button, Card, Columns, Row, Stack, Tag, Text } from "@rms/ui";

export type MarketplaceListing = {
  id: string;
  name: string;
  /** One plain sentence on what it does. */
  summary: string;
  /** Why it is recommended for this restaurant, in a few words. A listing never names who made it. */
  why?: string;
};

export type MarketplaceListProps = {
  listings: MarketplaceListing[];
  /** Called with the listing id when the owner adds one. Wave 2 wires this up. */
  onAdd?: (id: string) => void;
};

/** Mini-apps that can be added, one card each: what it does, why it fits, one action. */
export function MarketplaceList({ listings, onAdd }: MarketplaceListProps) {
  return (
    <Columns>
      {listings.map((listing) => (
        <Card key={listing.id} title={listing.name} titleLevel={3} as="article">
          <Stack gap="m">
            <Text tone="muted">{listing.summary}</Text>
            <Row justify="between">
              {listing.why ? <Tag>{listing.why}</Tag> : <span />}
              <Button icon="plus" aria-label={`Add ${listing.name} to your mini-apps`} {...(onAdd ? { onClick: () => onAdd(listing.id) } : {})}>
                Add
              </Button>
            </Row>
          </Stack>
        </Card>
      ))}
    </Columns>
  );
}
