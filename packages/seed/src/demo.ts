// Creates a demo restaurant in the database: org row, platform parent rows, store, parent copy.
import { StorePrefix } from "@rms/contracts";
import { type Sql, type Tx, ident, newStorePrefix, newUuid, provisionStore } from "@rms/db";
import { syncParent } from "@rms/parent";
import { PARENT_SOURCE_TABLES, type ParentRows, buildParentRows } from "./parent-data.js";
import { type DemoTemplate, templateSpec } from "./templates.js";

export type CreatedRestaurant = { orgUuid: string; storePrefix: string; name: string };

export type CreateDemoOptions = {
  template: DemoTemplate;
  /** Tests only: a fixed org id. Default: a new uuid v7. */
  orgUuid?: string;
  /** Tests only: a fixed store prefix. Default: newStorePrefix(). */
  storePrefix?: string;
  /** YYYY-MM-DD used for licence expiry dates. Default: today (UTC). */
  today?: string;
};

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/**
 * Inserts rows into one platform table. Rows go to Postgres as JSON text and are rebuilt with
 * `jsonb_populate_recordset`, so values are never spliced into SQL. Table and column names come
 * from our own fixed lists and still go through ident().
 */
export const insertRows = async (tx: Tx | Sql, table: string, rows: readonly Record<string, unknown>[]): Promise<void> => {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0] as Record<string, unknown>);
  const cols = columns.map(ident).join(", ");
  const target = `platform.${ident(table)}`;
  await tx.unsafe(`insert into ${target} (${cols}) select ${cols} from jsonb_populate_recordset(null::${target}, $1::text::jsonb)`, [JSON.stringify(rows)]);
};

/**
 * Creates one fictional demo restaurant: the org (new id, new store prefix, brand colour), its
 * parent data, its store, and the one-way copy into its parent schema.
 * The restaurant keeps its fictional name. Owners and staff users are NOT created here.
 * Admin connection only.
 */
export const createDemoRestaurant = async (adminSql: Sql, opts: CreateDemoOptions): Promise<CreatedRestaurant> => {
  const spec = templateSpec(opts.template);
  const orgUuid = opts.orgUuid ?? newUuid();
  const storePrefix = StorePrefix.parse(opts.storePrefix ?? newStorePrefix());
  const rows: ParentRows = buildParentRows(opts.template, { orgUuid, today: opts.today ?? todayUtc() });
  const slug = `${spec.slugBase}-${storePrefix.slice(2)}`;

  await adminSql.begin(async (tx) => {
    await tx`insert into platform.organizations (id, slug, name, kind, store_prefix, brand_colour)
             values (${orgUuid}, ${slug}, ${spec.name}, 'independent', ${storePrefix}, ${spec.brandColour})`;
    for (const table of PARENT_SOURCE_TABLES) await insertRows(tx, table, rows[table]);
  });

  try {
    await provisionStore(adminSql, orgUuid);
    await syncParent(adminSql, orgUuid);
  } catch (err) {
    // Leave nothing half-built behind.
    await removeRestaurants(adminSql, [orgUuid]).catch(() => {});
    throw err;
  }
  return { orgUuid, storePrefix, name: spec.name };
};

// ------------------------------------------------------------------ removing restaurants

type TableInfo = { name: string; orgColumn: "id" | "org_id" | "publisher_org_id" | null };
type ForeignKey = { child: string; parent: string; column: string | null; parentColumn: string | null };

/**
 * Deletes every platform row that belongs to the given restaurants, children before parents,
 * worked out from the database's own foreign keys so new tables are covered without code changes.
 * Tables without an org column are cleared through their link to a table that has one.
 */
const deleteOrgRows = async (tx: Tx, orgUuids: readonly string[]): Promise<void> => {
  const tables = await tx<{ name: string; org_col: TableInfo["orgColumn"] }[]>`
    select c.relname as name,
           case when c.relname = 'organizations' then 'id'
                when exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped) then 'org_id'
                when exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'publisher_org_id' and not a.attisdropped) then 'publisher_org_id'
           end as org_col
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'platform' and c.relkind = 'r'`;
  const fks = await tx<{ child: string; parent: string; column: string | null; parent_column: string | null }[]>`
    select cl.relname as child, pl.relname as parent,
           case when array_length(con.conkey, 1) = 1 then (select attname from pg_catalog.pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) end as column,
           case when array_length(con.confkey, 1) = 1 then (select attname from pg_catalog.pg_attribute where attrelid = con.confrelid and attnum = con.confkey[1]) end as parent_column
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class cl on cl.oid = con.conrelid
    join pg_catalog.pg_class pl on pl.oid = con.confrelid
    join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
    where con.contype = 'f' and n.nspname = 'platform' and pl.relnamespace = n.oid`;
  const info = new Map<string, TableInfo>(tables.map((t) => [t.name, { name: t.name, orgColumn: t.org_col }]));
  const links: ForeignKey[] = fks.map((f) => ({ child: f.child, parent: f.parent, column: f.column, parentColumn: f.parent_column }));

  // Which tables to clear, and how to find the rows: directly by org column, or through a link.
  const via = new Map<string, ForeignKey>();
  const targets = new Set([...info.values()].filter((t) => t.orgColumn).map((t) => t.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of links) {
      if (targets.has(f.child) || !targets.has(f.parent) || !f.column || f.parentColumn !== "id") continue;
      if (!info.get(f.parent)?.orgColumn) continue;
      via.set(f.child, f);
      targets.add(f.child);
      grew = true;
    }
  }

  // Children first: a table is cleared only after every target table that points at it.
  const order: string[] = [];
  const pending = new Set(targets);
  while (pending.size > 0) {
    const ready = [...pending].filter((t) => !links.some((f) => f.parent === t && f.child !== t && pending.has(f.child)));
    if (ready.length === 0) throw new Error("Cannot work out a safe delete order for platform tables");
    ready.sort();
    for (const t of ready) {
      order.push(t);
      pending.delete(t);
    }
  }

  for (const t of order) {
    const col = info.get(t)?.orgColumn;
    if (col) {
      await tx.unsafe(`delete from platform.${ident(t)} where ${ident(col)} = any($1::uuid[])`, [orgUuids as string[]]);
      continue;
    }
    const f = via.get(t);
    const parentCol = f ? info.get(f.parent)?.orgColumn : null;
    if (!f || !f.column || !parentCol) throw new Error(`No way to find restaurant rows in ${t}`);
    await tx.unsafe(
      `delete from platform.${ident(t)} where ${ident(f.column)} in (select id from platform.${ident(f.parent)} where ${ident(parentCol)} = any($1::uuid[]))`,
      [orgUuids as string[]],
    );
  }
};

/**
 * Drops the stores of the given restaurants and deletes all their platform rows.
 * Admin connection only. Used by the reset command and by tests to clean up their own restaurants.
 */
export const removeRestaurants = async (adminSql: Sql, orgUuids: readonly string[]): Promise<void> => {
  if (orgUuids.length === 0) return;
  const existing = await adminSql<{ id: string }[]>`select id from platform.organizations where id = any(${orgUuids as string[]}::uuid[])`;
  for (const { id } of existing) await adminSql`select platform.drop_store(${id})`;
  await adminSql.begin((tx) => deleteOrgRows(tx, orgUuids));
};
