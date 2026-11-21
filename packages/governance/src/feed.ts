// Maintainer console reads. Admin connection only: maintainers see every restaurant, and may
// see the restaurant's name. The restaurant is never taken from the client for scoping;
// `orgUuid` is only an optional narrowing filter for a maintainer.
import { type Tier, toUuid } from "@rms/contracts";
import type { Sql } from "@rms/db";
import { type ChangeRow, type Decision, type RecordedChange, toChangeSet } from "./changes.js";

export type FeedItem = RecordedChange & { restaurantName: string };

export type FeedFilter = {
  tier?: Tier | undefined;
  decision?: Decision | undefined;
  /** Optional maintainer filter, raw uuid or `org_` id. */
  orgUuid?: string | undefined;
  /** Change set id (`chg_` or uuid) to page after. */
  before?: string | undefined;
  limit?: number | undefined;
};

type FeedRow = ChangeRow & { restaurant_name: string };

const COLUMNS = `c.id, c.org_id, c.app_id, c.origin, c.actor, c.signals, c.tier, c.summary, c.owner_summary,
                 c.decision, c.decided_at, c.created_at, o.name as restaurant_name`;

const asUuid = (id: string, prefix: string): string => (id.startsWith(`${prefix}_`) ? toUuid(id) : id);

const toItem = (r: FeedRow): FeedItem => ({ ...toChangeSet(r), restaurantName: r.restaurant_name });

/** Newest first. Returns one page and the cursor for the next. */
export const listFeed = async (adminSql: Sql, filter: FeedFilter = {}): Promise<{ items: FeedItem[]; nextBefore: string | null }> => {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (filter.tier) where.push(`c.tier = ${bind(filter.tier)}`);
  if (filter.decision) where.push(`c.decision = ${bind(filter.decision)}`);
  if (filter.orgUuid) where.push(`c.org_id = ${bind(asUuid(filter.orgUuid, "org"))}::uuid`);
  if (filter.before) {
    const b = bind(asUuid(filter.before, "chg"));
    where.push(`(c.created_at, c.id) < (select created_at, id from platform.change_sets where id = ${b}::uuid)`);
  }
  const rows = await adminSql.unsafe<FeedRow[]>(
    `select ${COLUMNS}
       from platform.change_sets c join platform.organizations o on o.id = c.org_id
      ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
      order by c.created_at desc, c.id desc
      limit ${bind(limit + 1)}`,
    params as never[],
  );
  const page = rows.slice(0, limit).map(toItem);
  return { items: page, nextBefore: rows.length > limit && page.length > 0 ? (page[page.length - 1] as FeedItem).id : null };
};

/** Changes held for a maintainer, oldest first. */
export const listQueue = async (adminSql: Sql, limit = 100): Promise<FeedItem[]> => {
  const rows = await adminSql.unsafe<FeedRow[]>(
    `select ${COLUMNS}
       from platform.change_sets c join platform.organizations o on o.id = c.org_id
      where c.decision = 'pending_maintainer'
      order by c.created_at asc, c.id asc
      limit $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(toItem);
};
