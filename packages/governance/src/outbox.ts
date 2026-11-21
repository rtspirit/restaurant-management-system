// Outbox delivery. A job, admin connection only: `rms_api` can neither update the outbox nor
// create notifications. Today's only channel is the notifications table (console feed and the
// owner's notices). Slack, email and digests come later.
//
// Each notification describes the EVENT (the outbox row's payload: tier and decision at the time
// it was written), not the change set's current state. So a T2 change confirmed before the next
// drain still yields "please confirm" followed by "now live".
import { ChangeDecision, Tier as TierSchema, type Tier } from "@rms/contracts";
import { type Sql, type Tx, newUuid } from "@rms/db";
import { type ChangeRow, type Decision, OWNER_STATUS, ownerNotice, toChangeSet } from "./changes.js";

const MAX_ATTEMPTS = 5;

type OutboxRow = {
  id: string;
  topic: string;
  org_id: string;
  change_set_id: string | null;
  attempts: number;
  payload: Record<string, unknown>;
};
type Severity = "info" | "attention" | "urgent";

const MAINTAINER_SEVERITY: Record<Tier, Severity> = { T0: "info", T1: "info", T2: "attention", T3: "urgent" };

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

export type DrainResult = { sent: number; failed: number; notifications: number };

const insertNote = (
  sp: Tx,
  n: { audience: "owner" | "maintainer"; orgId: string; changeSetId: string | null; kind: string; title: string; body: string; severity: Severity },
) => sp`
  insert into platform.notifications (id, audience, org_id, change_set_id, kind, title, body, severity)
  values (${newUuid()}, ${n.audience}, ${n.orgId}, ${n.changeSetId}, ${n.kind}, ${n.title.slice(0, 200)}, ${n.body}, ${n.severity})`;

/**
 * Delivers pending outbox rows: maintainer notification always, owner notification for T2 and
 * T3 changes. Each row is handled in its own savepoint so one bad row cannot block the rest.
 * A change set row that fails the contract (for example tier and signals disagree) is not
 * retried: it gets ONE urgent maintainer notification saying it needs a look, and no owner notice.
 * `orgUuids` narrows the drain (tests, and later per-cell workers).
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
          let count = 0;
          const [org] = await sp<{ name: string }[]>`select name from platform.organizations where id = ${row.org_id}`;
          const orgName = org?.name ?? "Unknown restaurant";
          const [cs] = row.change_set_id
            ? await sp<ChangeRow[]>`
                select id, org_id, app_id, origin, actor, signals, tier, summary, owner_summary, decision, decided_at, created_at
                from platform.change_sets where id = ${row.change_set_id} and org_id = ${row.org_id}`
            : [];

          if (!cs) {
            await insertNote(sp, {
              audience: "maintainer", orgId: row.org_id, changeSetId: null, kind: row.topic,
              title: `${orgName}: ${row.topic}`, body: "", severity: "info",
            });
            count += 1;
          } else {
            const change = toChangeSet(cs);
            if (change.mismatch) {
              await insertNote(sp, {
                audience: "maintainer", orgId: row.org_id, changeSetId: cs.id, kind: "change_set.needs_a_look",
                title: `${orgName}: a recorded change needs a look`,
                body: `Stored tier ${String(cs.tier)} does not match its signals (${(cs.signals ?? []).join(", ")}). No owner notice was sent.`,
                severity: "urgent",
              });
              count += 1;
            } else {
              // The event's own tier and decision; fall back to the row for older payloads.
              const tierP = TierSchema.safeParse(row.payload?.tier);
              const decisionP = ChangeDecision.safeParse(row.payload?.decision);
              const tier = tierP.success ? tierP.data : change.tier;
              const decision = decisionP.success ? decisionP.data : change.decision;
              const decided = row.topic === "change_set.decided";
              await insertNote(sp, {
                audience: "maintainer", orgId: row.org_id, changeSetId: cs.id, kind: row.topic,
                title: `${orgName}: ${change.summary}`,
                body: `${tier}, ${decided ? "decided" : "recorded"} as ${decision}`,
                severity: MAINTAINER_SEVERITY[tier],
              });
              count += 1;
              if (tier === "T2" || tier === "T3") {
                const status = OWNER_STATUS[decision];
                await insertNote(sp, {
                  audience: "owner", orgId: row.org_id, changeSetId: cs.id, kind: row.topic,
                  title: ownerNotice(change).summary, body: ownerBody(decision),
                  severity: status === "needs_your_ok" ? "attention" : "info",
                });
                count += 1;
              }
            }
          }
          await sp`update platform.outbox set status = 'sent', sent_at = now(), attempts = attempts + 1 where id = ${row.id}`;
          return count;
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
