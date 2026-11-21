import type { Metadata } from "next";
import { Card, Columns, DetailList, EmptyState, Page, ReportTable, Section, Tag, Text } from "@rms/ui";
import { ListUnavailable } from "@/components/list-unavailable";
import { type ParentRow, clock, count, loadParentLists, text, whole } from "@/lib/parent-server";

export const metadata: Metadata = { title: "Locations" };

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;

const STATUS_WORDS: Record<string, string> = { open: "Open", closed: "Closed", opening_soon: "Opening soon" };

/**
 * A time zone the way people say it: "Eastern Time", not "America/New_York".
 * Falls back to the place name with spaces when the zone is not one the platform knows.
 */
function zoneWords(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" }).formatToParts(new Date(0)).find((p) => p.type === "timeZoneName");
    if (part?.value && !/^GMT/.test(part.value)) return part.value;
  } catch {
    // Not a zone this platform knows: say it as written.
  }
  return zone.replaceAll("_", " ");
}

const hourColumns = [
  { key: "day", label: "Day" },
  { key: "opens", label: "Opens", align: "end" as const },
  { key: "closes", label: "Closes", align: "end" as const },
];

/** One row per day of the week. A day with no hours is a day the place is closed. */
function hoursRows(place: ParentRow) {
  const hours = (place.hours && typeof place.hours === "object" ? place.hours : {}) as Record<string, { open?: unknown; close?: unknown } | null>;
  return DAYS.map(([key, label]) => {
    const today = hours[key];
    return { id: key, cells: today ? { day: label, opens: clock(today.open), closes: clock(today.close) } : { day: label, opens: "Closed", closes: "" } };
  });
}

// Read-only: each place the restaurant serves from, as RMS holds it. A member tied to one
// location is sent only that location by the API.
export default async function LocationsPage() {
  const load = await loadParentLists(["locations"]);
  if (load.status === "signed-out") return null; // The layout is showing something else.
  if (load.status === "unavailable") {
    return (
      <Page title="Locations" narrow>
        <ListUnavailable title="Your locations are not loading just now" href="/locations" />
      </Page>
    );
  }

  const places = load.lists.locations.rows;
  if (places.length === 0) {
    return (
      <Page title="Locations" narrow>
        <EmptyState title="No locations yet">Each place you serve from shows here, with its opening hours and when its day ends.</EmptyState>
      </Page>
    );
  }

  return (
    <Page title="Locations">
      {places.map((place) => {
        const seats = whole(place, "seats");
        const dayEnds = clock(place.day_cutoff);
        const status = STATUS_WORDS[text(place, "status")];
        return (
          <Section key={text(place, "id")} title={text(place, "name")} aside={status ? <Tag>{status}</Tag> : undefined}>
            <Columns>
              <Card title="About this place" titleLevel={3} as="article">
                <DetailList
                  rows={[
                    { label: "Address", value: text(place, "address") },
                    ...(seats !== null ? [{ label: "Seats", value: count(seats, "seat", "seats") }] : []),
                    ...(dayEnds ? [{ label: "Day ends at", value: dayEnds }] : []),
                    ...(text(place, "timezone") ? [{ label: "Time zone", value: zoneWords(text(place, "timezone")) }] : []),
                  ]}
                />
                {dayEnds ? (
                  <Text tone="muted" size="s">
                    Sales rung up after midnight count toward the day before, until the day ends.
                  </Text>
                ) : null}
              </Card>
              <ReportTable title="Opening hours" titleLevel={3} columns={hourColumns} rows={hoursRows(place)} />
            </Columns>
          </Section>
        );
      })}
    </Page>
  );
}
