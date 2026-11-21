// Outbox delivery. A job, admin connection only: `rms_api` can neither update the outbox nor
// create notifications. Today's only channel is the notifications table (console feed and the
// owner's notices). Slack, email and digests come later.
import { type Sql, newUuid } from "@rms/db";
import type { Tier } from "@rms/contracts";
import { type ChangeRow, type Decision, ownerNotice, toChangeSet } from "./changes.js";

const MAX_ATTEMPTS = 5;

type OutboxRow = { id: string; topic: string; org_id: string; change_set_id: string | null; attempts: number };
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

/**
 * Delivers pending outbox rows: maintainer notification always, owner notification for T2 and
 * T3 changes. Each row is handled in its own savepoint so one bad row cannot block the rest.
 * `orgUuids` narrows the drain (tests, and later per-cell workers).
 */
export const drainOutbox = async (adminSql: Sql, opts: { orgUuids?: string[]; limit?: number } = {}): Promise<DrainResult> => {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const result: DrainResult = { sent: 0, failed: 0, notifications: 0 };
  await adminSql.begin(async (tx) => {
    const rows = opts.orgUuids
      ? await tx<OutboxRow[]>`
          select id, topic, org_id, change_set_id, attempts from platform.outbox
          where status = 'pending' and org_id = any(${opts.orgUuids}::uuid[])
          order by id limit ${limit} for update skip locked`
      : await tx<OutboxRow[]>`
          select id, topic, org_id, change_set_id, attempts from platform.outbox
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
            await sp`
              insert into platform.notifications (id, audience, org_id, change_set_id, kind, title, body, severity)
              values (${newUuid()}, 'maintainer', ${row.org_id}, null, ${row.topic}, ${`${orgName}: ${row.topic}`}, '', 'info')`;
            count += 1;
          } else {
            const change = toChangeSet(cs);
            const decided = row.topic === "change_set.decided";
            const title = `${orgName}: ${change.summary}`.slice(0, 200);
            const body = `${change.tier}, ${decided ? "decided" : "recorded"} as ${change.decision}`;
            await sp`
              insert into platform.notifications (id, audience, org_id, change_set_id, kind, title, body, severity)
              values (${newUuid()}, 'maintainer', ${row.org_id}, ${cs.id}, ${row.topic}, ${title}, ${body},
                      ${MAINTAINER_SEVERITY[change.tier]})`;
            count += 1;
            if (change.tier === "T2" || change.tier === "T3") {
              const notice = ownerNotice(change);
              const severity: Severity = notice.status === "needs_your_ok" ? "attention" : "info";
              await sp`
                insert into platform.notifications (id, audience, org_id, change_set_id, kind, title, body, severity)
                values (${newUuid()}, 'owner', ${row.org_id}, ${cs.id}, ${row.topic}, ${notice.summary},
                        ${ownerBody(change.decision)}, ${severity})`;
              count += 1;
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
