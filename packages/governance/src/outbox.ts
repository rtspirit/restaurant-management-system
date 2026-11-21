// Outbox delivery. A job, admin connection only: `rms_api` can neither read nor update the outbox
// and cannot create notifications. Today's only channel is the notifications table (console feed
// and the owner's notices). Slack, email and digests come later.
//
// Each notification describes the EVENT (the outbox row's payload: tier and decision at the time
// it was written), not the change set's current state. So a T2 change confirmed before the next
// drain still yields "please confirm" followed by "now live".
import { ChangeDecision, type Tier, Tier as TierSchema } from "@rms/contracts";
import { type Sql, type Tx, newUuid } from "@rms/db";
import { type ChangeRow, type Decision, OWNER_STATUS, ownerNotice, toChangeSet } from "./changes.js";

const MAX_ATTEMPTS = 5;

export type OutboxRow = {
  id: string;
  topic: string;
  org_id: string;
  change_set_id: string | null;
  attempts: number;
  payload: Record<string, unknown>;
};
type Severity = "info" | "attention" | "urgent";

export type NotificationSpec = {
  audience: "owner" | "maintainer";
  changeSetId: string | null;
  kind: string;
  title: string;
  body: string;
  severity: Severity;
};

const MAINTAINER_SEVERITY: Record<Tier, Severity> = { T0: "info", T1: "info", T2: "attention", T3: "urgent" };

/** Owner wording per decision. Plain words, no tier codes, no signal names. */
const ownerBody = (decision: Decision): string => {
  switch (decision) {
    case "pending_owner":
      return "Please look at this change and confirm it.";
    case "pending_maintainer":
      return "Our team is checking this change. We will tell you when it is done.";
    case "approved":
      return "Our team approved this change. It is now live.";
    case "rejected":
      return "Our team did not approve this change. Nothing was changed.";
    default:
      return "This change is now live.";
  }
};

/**
 * What one outbox row turns into. Pure, so it can be tested with any row, including ones the
 * database would no longer accept. A change set that fails the contract (for example its tier
 * disagrees with its signals) gets ONE urgent maintainer notification and no owner notice.
 */
export const notificationsFor = (row: OutboxRow, change: ChangeRow | undefined, orgName: string): NotificationSpec[] => {
  if (!change) {
    return [{ audience: "maintainer", changeSetId: null, kind: row.topic, title: `${orgName}: ${row.topic}`, body: "", severity: "info" }];
  }
  const cs = toChangeSet(change);
  if (cs.mismatch) {
    return [
      {
        audience: "maintainer",
        changeSetId: change.id,
        kind: "change_set.needs_a_look",
        title: `${orgName}: a recorded change needs a look`,
        body: `Stored tier ${String(change.tier)} does not match its signals (${(change.signals ?? []).join(", ")}). No owner notice was sent.`,
        severity: "urgent",
      },
    ];
  }
  // The event's own tier and decision; fall back to the row for older payloads.
  const tierP = TierSchema.safeParse(row.payload?.tier);
  const decisionP = ChangeDecision.safeParse(row.payload?.decision);
  const tier = tierP.success ? tierP.data : cs.tier;
  const decision = decisionP.success ? decisionP.data : cs.decision;
  const decided = row.topic === "change_set.decided";
  const out: NotificationSpec[] = [
    {
      audience: "maintainer",
      changeSetId: change.id,
      kind: row.topic,
      title: `${orgName}: ${cs.summary}`.slice(0, 200),
      body: `${tier}, ${decided ? "decided" : "recorded"} as ${decision}`,
      severity: MAINTAINER_SEVERITY[tier],
    },
  ];
  if (tier === "T2" || tier === "T3") {
    out.push({
      audience: "owner",
      changeSetId: change.id,
      kind: row.topic,
      title: ownerNotice({ ...cs, decision }).summary,
      body: ownerBody(decision),
      severity: OWNER_STATUS[decision] === "needs_your_ok" ? "attention" : "info",
    });
  }
  return out;
};

export type DrainResult = { sent: number; failed: number; notifications: number };

const insertNote = (sp: Tx, orgId: string, n: NotificationSpec) => sp`
  insert into platform.notifications (id, audience, org_id, change_set_id, kind, title, body, severity)
  values (${newUuid()}, ${n.audience}, ${orgId}, ${n.changeSetId}, ${n.kind}, ${n.title.slice(0, 200)}, ${n.body}, ${n.severity})`;

/**
 * Delivers pending outbox rows (see `notificationsFor`). Each row is handled in its own savepoint
 * so one bad row cannot block the rest. `orgUuids` narrows the drain (tests, later per-cell workers).
 */
export const drainOutbox = async (adminSql: Sql, opts: { orgUuids?: string[]; limit?: number } = {}): Promise<DrainResult> => {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const result: DrainResult = { sent: 0, failed: 0, notifications: 0 };
  await adminSql.begin(async (tx) => {
    const rows = opts.orgUuids
      ? await tx<OutboxRow[]>`
          select id, topic, org_id, change_set_id, attempts, payload from platform.outbox
          where status = 'pending' and org_id = any(${opts.orgUuids}::uuid[])
          order by id limit ${limit} for update skip locked`
      : await tx<OutboxRow[]>`
          select id, topic, org_id, change_set_id, attempts, payload from platform.outbox
          where status = 'pending' order by id limit ${limit} for update skip locked`;

    for (const row of rows) {
      try {
        const made = await tx.savepoint(async (sp) => {
          const [org] = await sp<{ name: string }[]>`select name from platform.organizations where id = ${row.org_id}`;
          const [cs] = row.change_set_id
            ? await sp<ChangeRow[]>`
                select id, org_id, app_id, origin, actor, signals, tier, summary, owner_summary, decision, decided_at, created_at
                from platform.change_sets where id = ${row.change_set_id} and org_id = ${row.org_id}`
            : [];
          const specs = notificationsFor(row, cs, org?.name ?? "Unknown restaurant");
          for (const n of specs) await insertNote(sp, row.org_id, n);
          await sp`update platform.outbox set status = 'sent', sent_at = now(), attempts = attempts + 1 where id = ${row.id}`;
          return specs.length;
        });
        result.sent += 1;
        result.notifications += made;
      } catch (e) {
        const failed = row.attempts + 1 >= MAX_ATTEMPTS;
        await tx`update platform.outbox set attempts = attempts + 1, status = ${failed ? "failed" : "pending"} where id = ${row.id}`;
        if (failed) result.failed += 1;
        console.error(JSON.stringify({ job: "drainOutbox", outboxId: String(row.id), error: e instanceof Error ? e.message : "unknown" }));
      }
    }
  });
  return result;
};
