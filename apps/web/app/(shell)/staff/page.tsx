import type { Metadata } from "next";
import { EmptyState, Page, ReportTable, Text } from "@rms/ui";
import { ListUnavailable } from "@/components/list-unavailable";
import { count, day, loadParentLists, money, text, whole } from "@/lib/parent-server";

export const metadata: Metadata = { title: "Staff" };

const HOUSE_WORDS: Record<string, string> = { front: "Front of house", back: "Back of house", management: "Management" };

// Read-only: the team as RMS holds it. The API leaves pay and contact details out for
// anyone who is not the owner, so this page shows those columns only when they arrive.
export default async function StaffPage() {
  const load = await loadParentLists(["staff", "jobs", "locations"]);
  if (load.status === "signed-out") return null; // The layout is showing something else.
  if (load.status === "unavailable") {
    return (
      <Page title="Staff" narrow>
        <ListUnavailable title="The team list is not loading just now" href="/staff" />
      </Page>
    );
  }

  const { staff, jobs, locations } = load.lists;
  const job = new Map(jobs.rows.map((j) => [text(j, "id"), j]));
  const has = (key: string) => staff.columns.some((c) => c.key === key);
  const showPay = has("hourly_rate_minor");
  const showContact = has("email") && has("phone");

  if (staff.rows.length === 0) {
    return (
      <Page title="Staff" narrow>
        <EmptyState title="Nobody on the team list yet">Everyone who works with you, the job each person does and where they work will show here.</EmptyState>
      </Page>
    );
  }

  const columns = [
    { key: "name", label: "Name" },
    { key: "job", label: "Job" },
    { key: "house", label: "Works in" },
    { key: "started", label: "Started" },
    ...(showContact ? [{ key: "email", label: "Email" }, { key: "phone", label: "Phone" }] : []),
    ...(showPay ? [{ key: "rate", label: "Hourly rate", align: "end" as const, strong: true }] : []),
  ];

  // One table per place, then anyone not tied to a place.
  const groups = [
    ...locations.rows.map((place) => ({ id: text(place, "id"), title: text(place, "name"), people: staff.rows.filter((s) => text(s, "location_id") === text(place, "id")) })),
    { id: "everywhere", title: "All locations", people: staff.rows.filter((s) => !text(s, "location_id")) },
  ].filter((g) => g.people.length > 0);

  return (
    <Page title="Staff">
      <Text tone="muted">
        {count(staff.rows.length, "person", "people")} at {count(groups.length, "location", "locations")}.
        {showPay ? " Pay and contact details are shown to you as the owner. Staff do not see them." : " Pay and contact details are for the owner only, so they are not shown here."}
      </Text>
      {groups.map((group) => (
        <ReportTable
          key={group.id}
          title={group.title}
          columns={columns}
          rows={group.people.map((person) => {
            const theirJob = job.get(text(person, "job_id"));
            return {
              id: text(person, "id"),
              cells: {
                name: text(person, "full_name"),
                job: theirJob ? text(theirJob, "name") : "",
                house: theirJob ? (HOUSE_WORDS[text(theirJob, "house")] ?? "") : "",
                started: day(person.started_on),
                email: text(person, "email"),
                phone: text(person, "phone"),
                rate: money(whole(person, "hourly_rate_minor"), text(person, "currency") || "USD"),
              },
            };
          })}
          source={count(group.people.length, "person", "people")}
        />
      ))}
    </Page>
  );
}
