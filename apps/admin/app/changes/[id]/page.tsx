import { Heading, Text } from "@rms/ui";

// Task O owns this page. Brief: docs/briefs/wave3.md, task O.
// One change, opened from the feed or the review queue: ChangeDetail from ADMIN_ROUTES.detail.
// Enough to decide without leaving the page: the facts the detectors found, what Approve and
// Reject will do right now, and for a Marketplace share the scrub findings and the file list.
export default async function ChangePage({ params }: { params: Promise<{ id: string }> }) {
  await params;
  return (
    <>
      <Heading level={1} size="page">
        Change
      </Heading>
      <Text>The detail of a change will show here.</Text>
    </>
  );
}
