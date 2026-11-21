// @rms/parent: one-way copy of parent data into each restaurant's parent schema. Task B.
//
// The platform tables are the source of truth. Each restaurant reads a copy in `o_<id>_parent`,
// same columns minus `org_id`. Restaurant roles can only read that copy (the database enforces it).
//
// The parent sync role can write the parent schemas but cannot read `platform`, so the copy is
// done in two steps: read the org's rows as JSON text with the admin connection, then write them
// as the sync role in ONE transaction. Rows travel as JSON text and are rebuilt by Postgres
// (`jsonb_populate_recordset`), so no SQL is ever built from data values, and bigints, dates,
// arrays and jsonb keep their exact types.
import { StorePrefix, storeSchemas, type ParentModelKey } from "@rms/contracts";
import { type Sql, type Tx, asParentSync, ident } from "@rms/db";

/** Parent table in `o_<id>_parent` and its source table in `platform`. Same list as `platform.provision_store`. */
export const PARENT_TABLES = [
  { key: "profile", source: "restaurant_profiles" },
  { key: "locations", source: "locations" },
  { key: "jobs", source: "parent_jobs" },
  { key: "staff", source: "parent_staff" },
  { key: "menu_categories", source: "parent_menu_categories" },
  { key: "menu_items", source: "parent_menu_items" },
  { key: "menu_modifiers", source: "parent_menu_modifiers" },
  { key: "tax_rates", source: "parent_tax_rates" },
  { key: "licences", source: "parent_licences" },
  { key: "equipment", source: "parent_equipment" },
] as const satisfies readonly { key: ParentModelKey; source: string }[];

export type ParentTableResult = { key: ParentModelKey; rows: number; changed: boolean };
export type SyncResult = { orgUuid: string; tables: ParentTableResult[] };

const columnsOf = async (sql: Sql | Tx, schema: string, table: string): Promise<string[]> => {
  // pg_attribute is readable by every role, unlike information_schema, which hides tables
  // the current role has no grant on.
  const rows = await sql<{ name: string }[]>`
    select a.attname as name
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relname = ${table} and a.attnum > 0 and not a.attisdropped
    order by a.attnum`;
  return rows.map((r) => r.name);
};

/**
 * Replaces the contents of all ten tables in the org's parent schema with the org's rows from
 * the platform source tables, in one transaction, then records `platform.parent_sync_state`.
 * A table whose copy already matches the source is left untouched, so a second run changes nothing.
 * Admin connection only. `orgUuid` comes from the platform, never from a request.
 */
export const syncParent = async (adminSql: Sql, orgUuid: string): Promise<SyncResult> => {
  const [org] = await adminSql<{ prefix: string; ready: boolean }[]>`
    select store_prefix as prefix, store_ready as ready from platform.organizations where id = ${orgUuid}`;
  if (!org) throw new Error("Unknown restaurant");
  if (!org.ready) throw new Error("The restaurant's store is not set up yet");
  const parentSchema = storeSchemas(StorePrefix.parse(org.prefix)).parent;

  // 1. Read, as the admin login, in one snapshot.
  const sources = await adminSql.begin("isolation level repeatable read read only", async (tx) => {
    const out: { key: ParentModelKey; columns: string[]; json: string }[] = [];
    for (const t of PARENT_TABLES) {
      const dest = await columnsOf(tx, parentSchema, t.key);
      const src = await columnsOf(tx, "platform", t.source);
      if (dest.length === 0) throw new Error(`Parent table ${t.key} is missing`);
      const missing = dest.filter((c) => !src.includes(c));
      if (missing.length > 0) throw new Error(`Parent table ${t.key} has columns its source does not have`);
      const cols = dest.map(ident).join(", ");
      // Only the destination's columns, in a stable order, as JSON text (no number rounding in JS).
      const [row] = await tx.unsafe<{ json: string }[]>(
        `select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb)::text as json
         from (select ${cols} from platform.${ident(t.source)} where org_id = $1) r`,
        [orgUuid],
      );
      out.push({ key: t.key, columns: dest, json: row?.json ?? "[]" });
    }
    return out;
  });

  // 2. Write, as the parent sync role, in one transaction.
  const tables = await asParentSync(adminSql, async (tx) => {
    const results: ParentTableResult[] = [];
    for (const s of sources) {
      const target = `${ident(parentSchema)}.${ident(s.key)}`;
      const cols = s.columns.map(ident).join(", ");
      const [cmp] = await tx.unsafe<{ same: boolean; n: number }[]>(
        `select (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb)
                 from (select ${cols} from ${target}) r) = $1::text::jsonb as same,
                jsonb_array_length($1::text::jsonb) as n`,
        [s.json],
      );
      const n = cmp?.n ?? 0;
      if (cmp?.same) {
        results.push({ key: s.key, rows: n, changed: false });
        continue;
      }
      await tx.unsafe(`delete from ${target}`);
      await tx.unsafe(
        `insert into ${target} (${cols}) select ${cols} from jsonb_populate_recordset(null::${target}, $1::text::jsonb)`,
        [s.json],
      );
      results.push({ key: s.key, rows: n, changed: true });
    }
    return results;
  });

  // 3. Record what was copied. The sync role cannot write platform, so this is the admin login,
  //    after the copy has committed.
  await adminSql.begin(async (tx) => {
    for (const t of tables) {
      await tx`
        insert into platform.parent_sync_state (org_id, model_key, row_count, synced_at)
        values (${orgUuid}, ${t.key}, ${t.rows}, now())
        on conflict (org_id, model_key) do update set row_count = excluded.row_count, synced_at = excluded.synced_at`;
    }
  });

  return { orgUuid, tables };
};
