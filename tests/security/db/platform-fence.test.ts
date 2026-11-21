// The restaurant-facing server login (rms_api): platform rows are fenced to one restaurant by the database.
// Ports the first section of db-walls.smoke.sh, with exact error codes, and widens each check from
// one table to every table (read from the catalog, so a new table is covered the day it is added).
import { beforeAll, describe, expect, it } from "vitest";
import { apiDb, withOrg } from "@rms/db";
import { DENIED, type Row, asNoOrg, asOrg, asPlatform, noOrgSql, orgSql, outcome, platform, refusal } from "../helpers/actors.js";
import { TEMPLATES, insertRow } from "../helpers/rows.js";
import { CANARY, ORG, ids, orgScopedTables, roles, schemas } from "../helpers/world.js";

type TableInfo = { table: string; orgColumn: string | null; canSelect: boolean; canInsert: boolean; canDelete: boolean; updatableColumn: string | null };
let tables: TableInfo[] = [];

beforeAll(async () => {
  const scoped = new Map((await orgScopedTables(platform())).map((t) => [t.table, t.column]));
  const rows = await platform()<{ table: string; can_select: boolean; can_insert: boolean; can_delete: boolean; updatable: string | null }[]>`
    select c.relname as table,
           has_table_privilege('rms_api', c.oid, 'select') as can_select,
           has_table_privilege('rms_api', c.oid, 'insert') or has_any_column_privilege('rms_api', c.oid, 'insert') as can_insert,
           has_table_privilege('rms_api', c.oid, 'delete') as can_delete,
           (select a.attname from pg_catalog.pg_attribute a
             where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and has_column_privilege('rms_api', c.oid, a.attnum, 'update')
             order by a.attnum limit 1) as updatable
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'platform' and c.relkind = 'r' order by c.relname`;
  tables = rows.map((r) => ({ table: r.table, orgColumn: scoped.get(r.table) ?? null, canSelect: r.can_select, canInsert: r.can_insert, canDelete: r.can_delete, updatableColumn: r.updatable }));
});

const SHARED_READ = ["mcp_catalog", "model_template_versions", "model_templates", "named_actions", "named_queries"];
const ADMIN_ONLY = ["change_reviews", "listing_versions", "secrets", "staff_users"];

describe("server login: what it can see", () => {
  it("the catalog lists the platform tables this suite expects (so the generated checks below are not empty)", () => {
    expect(tables.length).toBeGreaterThanOrEqual(49);
    expect(tables.filter((t) => t.orgColumn).length).toBeGreaterThanOrEqual(40);
  });

  it("every platform table has row-level security switched on", async () => {
    const off = await platform()`select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'platform' and c.relkind = 'r' and not c.relrowsecurity`;
    expect(off.map((r) => r.relname)).toEqual([]);
  });

  it("with no restaurant set it sees zero rows in every restaurant-owned table", async () => {
    for (const t of tables.filter((x) => x.orgColumn && x.canSelect)) {
      const rows = await noOrgSql(`select * from platform.${t.table}`);
      expect(rows.length, t.table).toBe(0);
    }
  });

  it("fenced to A it sees A's rows only, in every restaurant-owned table", async () => {
    let tablesWithRows = 0;
    for (const t of tables.filter((x) => x.orgColumn && x.canSelect)) {
      const rows = await orgSql("a", `select * from platform.${t.table}`);
      for (const r of rows) expect(r[t.orgColumn as string], t.table).toBe(ORG.a.uuid);
      if (rows.length > 0) tablesWithRows++;
    }
    // The fixture puts a row for A in almost every table. If this drops, the check above went blind.
    expect(tablesWithRows).toBeGreaterThanOrEqual(35);
  });

  it("control: fenced to B the same reads return B's rows, canary included", async () => {
    const rows = await orgSql("b", "select name from platform.organizations");
    expect(rows.map((r) => r.name)).toEqual([ORG.b.name]);
    expect(String(rows[0]?.name)).toContain(CANARY.b);
  });

  it("fenced to A, naming B's rows by id finds nothing", async () => {
    const b = ids("b");
    expect(await orgSql("a", `select * from platform.organizations where id = '${ORG.b.uuid}'`)).toHaveLength(0);
    expect(await orgSql("a", `select * from platform.apps where id = '${b.app}'`)).toHaveLength(0);
    expect(await orgSql("a", `select * from platform.app_versions where id = '${b.appVersion}'`)).toHaveLength(0);
    expect(await orgSql("a", `select * from platform.org_memory where id = '${b.memory}'`)).toHaveLength(0);
    expect(await orgSql("a", `select * from platform.mcp_connections where id = '${b.connection}'`)).toHaveLength(0);
    expect(await orgSql("a", `select * from platform.listings where id = '${b.listingDraft}'`)).toHaveLength(0);
  });

  it("the tables only the platform may read are refused outright", async () => {
    for (const t of ADMIN_ONLY) {
      expect(await outcome(orgSql("a", `select * from platform.${t}`)), t).toBe(DENIED);
      expect(await outcome(noOrgSql(`select * from platform.${t}`)), t).toBe(DENIED);
    }
  });

  it("control: the platform login can read those tables", async () => {
    for (const t of ADMIN_ONLY) expect((await platform().unsafe(`select count(*)::int as n from platform.${t}`))[0]?.n, t).toBeGreaterThan(0);
  });

  it("a restaurant id that is empty or malformed fails closed", async () => {
    expect(await withOrg(apiDb(), "", (tx) => tx`select * from platform.organizations`)).toHaveLength(0);
    // Not a uuid: the fence function raises, nothing is returned.
    expect(await outcome(withOrg(apiDb(), "00000000-0000-0000-0000-000000000000' or '1'='1", (tx) => tx`select * from platform.organizations`))).toBe("22P02");
    expect(await withOrg(apiDb(), "00000000-0000-0000-0000-000000000000", (tx) => tx`select * from platform.organizations`)).toHaveLength(0);
  });

  it("the fence ends with the transaction: the next query on the pool sees nothing", async () => {
    await orgSql("a", "select 1");
    for (let i = 0; i < 6; i++) expect((await apiDb()`select count(*)::int as n from platform.organizations`)[0]?.n).toBe(0);
  });
});

describe("server login: what it can change", () => {
  it("fenced to A, an update or delete aimed at B's rows touches nothing, in every table", async () => {
    let attempts = 0;
    for (const t of tables.filter((x) => x.orgColumn)) {
      const where = `where ${t.orgColumn} = '${ORG.b.uuid}'`;
      if (t.updatableColumn) {
        const rows = await orgSql("a", `update platform.${t.table} set ${t.updatableColumn} = ${t.updatableColumn} ${where} returning 1`);
        expect(rows.length, `update ${t.table}`).toBe(0);
        attempts++;
      } else {
        expect(await outcome(orgSql("a", `update platform.${t.table} set ${t.orgColumn} = ${t.orgColumn} ${where}`)), `update ${t.table}`).toBe(DENIED);
      }
      if (t.canDelete) {
        const rows = await orgSql("a", `delete from platform.${t.table} ${where} returning 1`);
        expect(rows.length, `delete ${t.table}`).toBe(0);
        attempts++;
      } else {
        expect(await outcome(orgSql("a", `delete from platform.${t.table} ${where}`)), `delete ${t.table}`).toBe(DENIED);
      }
    }
    expect(attempts).toBeGreaterThanOrEqual(20);
  });

  it("control: the same update aimed at B's rows works for the platform login", async () => {
    const rows = await asPlatform((tx) => tx.unsafe(`update platform.org_memory set text = text where org_id = '${ORG.b.uuid}' returning 1`));
    expect((rows as Row[]).length).toBeGreaterThan(0);
  });

  it("fenced to A, it cannot insert a row that belongs to B, in any table it may insert into", async () => {
    let attempts = 0;
    for (const t of tables.filter((x) => x.orgColumn && x.canInsert)) {
      const template = TEMPLATES[t.table];
      expect(template, `tests/security/helpers/rows.ts needs a row template for platform.${t.table}`).toBeDefined();
      if (!template) continue;
      const r = await refusal(asOrg("a", (tx) => insertRow(tx, t.table, template("b"))));
      expect(r.code, `insert into ${t.table}`).toBe(DENIED);
      expect(r.message, `insert into ${t.table}`).toMatch(/row-level security/);
      attempts++;
    }
    expect(attempts).toBeGreaterThanOrEqual(15);
  });

  it("control: the same rows are accepted when the fence matches the row", async () => {
    for (const table of ["org_memory", "mcp_connections", "audit_log", "app_slots"]) {
      const template = TEMPLATES[table] as (k: "a" | "b") => Record<string, unknown>;
      expect(await outcome(asOrg("b", (tx) => insertRow(tx, table, template("b")))), table).toBe("allowed");
    }
  });

  it("with no restaurant set it cannot insert at all", async () => {
    const template = TEMPLATES.org_memory as (k: "a" | "b") => Record<string, unknown>;
    expect(await outcome(asNoOrg((tx) => insertRow(tx, "org_memory", template("a"))))).toBe(DENIED);
  });

  it("cannot add a member, a location or a member's locations", async () => {
    const a = ids("a");
    expect(await outcome(orgSql("a", `insert into platform.members (id, org_id, user_id, role) values (gen_random_uuid(), '${ORG.a.uuid}', gen_random_uuid(), 'owner')`))).toBe(DENIED);
    expect(await outcome(orgSql("a", `update platform.members set role = 'owner' where id = '${a.staffMember}'`))).toBe(DENIED);
    expect(await outcome(orgSql("a", `delete from platform.member_locations where member_id = '${a.staffMember}'`))).toBe(DENIED);
    expect(await outcome(orgSql("a", `insert into platform.locations (id, org_id, name) values (gen_random_uuid(), '${ORG.a.uuid}', 'East')`))).toBe(DENIED);
  });

  it("cannot write the parent data source of truth, in any of its tables", async () => {
    const parentSource = ["restaurant_profiles", "locations", "parent_jobs", "parent_staff", "parent_menu_categories", "parent_menu_items", "parent_menu_modifiers", "parent_tax_rates", "parent_licences", "parent_equipment", "parent_sync_state"];
    for (const t of parentSource) {
      expect(await outcome(orgSql("a", `insert into platform.${t} select * from platform.${t} limit 1`)), `insert ${t}`).toBe(DENIED);
      expect(await outcome(orgSql("a", `update platform.${t} set org_id = org_id`)), `update ${t}`).toBe(DENIED);
      expect(await outcome(orgSql("a", `delete from platform.${t}`)), `delete ${t}`).toBe(DENIED);
    }
  });

  it("cannot change the shared model library, named queries, named actions or the connection catalog", async () => {
    for (const t of SHARED_READ) {
      expect(await outcome(orgSql("a", `delete from platform.${t}`)), `delete ${t}`).toBe(DENIED);
      expect(await outcome(orgSql("a", `insert into platform.${t} select * from platform.${t} limit 1`)), `insert ${t}`).toBe(DENIED);
    }
    expect(await outcome(orgSql("a", `update platform.named_queries set definition = '{}'::jsonb`))).toBe(DENIED);
    expect(await outcome(orgSql("a", `update platform.named_actions set definition = '{}'::jsonb`))).toBe(DENIED);
  });

  it("cannot rewrite or erase the append-only records", async () => {
    for (const t of ["audit_log", "agent_events", "outbox", "usage_events", "mcp_calls"]) {
      expect(await outcome(orgSql("a", `update platform.${t} set org_id = org_id`)), `update ${t}`).toBe(DENIED);
      expect(await outcome(orgSql("a", `delete from platform.${t}`)), `delete ${t}`).toBe(DENIED);
    }
  });

  it("cannot empty any platform table", async () => {
    for (const t of tables) expect(await outcome(orgSql("a", `truncate platform.${t.table} cascade`)), t.table).toBe(DENIED);
  });
});

describe("server login: what it can become or call", () => {
  it("cannot provision a store, drop a store or mint an Ask login", async () => {
    expect(await outcome(noOrgSql(`select platform.provision_store('${ORG.a.uuid}')`))).toBe(DENIED);
    expect(await outcome(noOrgSql(`select platform.drop_store('${ORG.b.uuid}')`))).toBe(DENIED);
    expect(await outcome(noOrgSql(`select platform.set_ask_login('${ORG.b.uuid}', 'SCRAM-SHA-256$4096:AAAA$AAAA:AAAA')`))).toBe(DENIED);
  });

  it("may switch only into restaurants' Data API roles (and the empty group they share), never anything stronger", async () => {
    const rows = await platform()<{ rolname: string }[]>`
      select r.rolname from pg_catalog.pg_roles r where pg_has_role('rms_api', r.oid, 'SET') and r.rolname <> 'rms_api' order by 1`;
    const unexpected = rows.map((r) => r.rolname).filter((n) => !/^o_[0-9a-f]{12}(_draft)?_rw$/.test(n) && n !== "rms_tenant");
    expect(unexpected).toEqual([]);
    // And it inherits nothing: every right needs an explicit, transaction-scoped switch.
    const inherited = await platform()<{ rolname: string }[]>`select r.rolname from pg_catalog.pg_roles r where pg_has_role('rms_api', r.oid, 'USAGE') and r.rolname <> 'rms_api'`;
    expect(inherited.map((r) => r.rolname)).toEqual([]);
  });

  it("cannot become the table-creating role, the parent writer, an Ask role, the platform login or any built-in role", async () => {
    const targets = ["rms_tenant_migrator", "rms_parent_sync", roles("a").ask, roles("b").ask, "rms_admin", "postgres", "supabase_admin", "authenticator", "service_role", "authenticated", "anon", "supabase_auth_admin", "pg_read_all_data", "pg_write_all_data", "pg_read_server_files", "pg_execute_server_program"];
    for (const r of targets) expect(await outcome(noOrgSql(`set local role ${r}`)), r).toBe(DENIED);
    expect(await outcome(noOrgSql(`set session authorization postgres`))).toBe(DENIED);
  });

  it("holds no dangerous role attribute", async () => {
    const rows = await platform()`select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit from pg_catalog.pg_roles where rolname in ('rms_api', 'rms_admin') order by 1`;
    for (const r of rows) expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolinherit: false });
    expect(rows).toHaveLength(2);
  });

  it("cannot read or write a restaurant's store without switching role", async () => {
    expect(await outcome(noOrgSql(`select count(*) from ${schemas("a").parent}.jobs`))).toBe(DENIED);
    expect(await outcome(noOrgSql(`select count(*) from ${schemas("a").live}.sec_note`))).toBe(DENIED);
    expect(await outcome(orgSql("a", `select count(*) from ${schemas("a").live}.sec_note`))).toBe(DENIED);
  });

  it("cannot create a table, in a store, in platform, in public or anywhere else", async () => {
    for (const s of [schemas("a").live, schemas("a").draft, schemas("a").parent, "platform", "rms", "public", "extensions"]) {
      expect(await outcome(noOrgSql(`create table ${s}.x_sec_probe (id int)`)), s).toBe(DENIED);
    }
    expect(await outcome(noOrgSql(`create schema x_sec_probe`))).toBe(DENIED);
  });

  it("cannot read sign-in data, the secrets vault or file storage", async () => {
    for (const t of ["auth.users", "auth.sessions", "auth.refresh_tokens", "vault.secrets", "vault.decrypted_secrets", "storage.objects"]) {
      expect(await outcome(noOrgSql(`select count(*) from ${t}`)), t).toBe(DENIED);
    }
  });

  it("cannot read stored passwords or server files", async () => {
    expect(await outcome(noOrgSql("select rolpassword from pg_catalog.pg_authid"))).toBe(DENIED);
    expect(await outcome(noOrgSql("select * from pg_catalog.pg_shadow"))).toBe(DENIED);
    expect(await outcome(noOrgSql("select pg_read_file('/etc/passwd')"))).toBe(DENIED);
    expect(await outcome(noOrgSql("copy (select 1) to program 'id'"))).toBe(DENIED);
  });
});
