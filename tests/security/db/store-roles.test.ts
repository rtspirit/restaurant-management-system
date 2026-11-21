// A restaurant's Data API roles (o_<id>_rw for live, o_<id>_draft_rw for draft).
// Ports the second section of db-walls.smoke.sh with exact error codes, then adds:
//   - an exact list of everything each role holds, anywhere in the database (so a stray grant fails the suite),
//   - parent data read-only against every kind of write and structure change, in every parent table,
//   - location scoping, append-only tables, and the draft/live wall.
import { describe, expect, it } from "vitest";
import { DENIED, type Row, type StoreOpts, asPlatform, outcome, platform, refusal, storeSql } from "../helpers/actors.js";
import { PARENT_ATTACKS } from "../helpers/attacks.js";
import { CANARY, MODEL_KEYS, type OrgKey, PARENT_TABLES, ids, roles, schemas } from "../helpers/world.js";

const A = schemas("a");
const B = schemas("b");
const a = ids("a");
const PARENT = PARENT_TABLES.map(([t]) => t);
const live: StoreOpts = { env: "live" };
const draft: StoreOpts = { env: "draft" };

// ---------------------------------------------------------------- the exact list of what each role holds
/** Every table, view and sequence a role holds any right on, outside the system catalogs. */
const holdings = async (role: string): Promise<Record<string, string>> => {
  const rows = await platform().unsafe(
    `select n.nspname || '.' || c.relname as obj,
            concat_ws('',
              case when has_table_privilege($1, c.oid, 'select') then 'r' when has_any_column_privilege($1, c.oid, 'select') then '(r)' end,
              case when has_table_privilege($1, c.oid, 'insert') then 'a' when has_any_column_privilege($1, c.oid, 'insert') then '(a)' end,
              case when has_table_privilege($1, c.oid, 'update') then 'w' when has_any_column_privilege($1, c.oid, 'update') then '(w)' end,
              case when has_table_privilege($1, c.oid, 'delete') then 'd' end,
              case when has_table_privilege($1, c.oid, 'truncate') then 'D' end,
              case when has_table_privilege($1, c.oid, 'references') then 'x' when has_any_column_privilege($1, c.oid, 'references') then '(x)' end,
              case when has_table_privilege($1, c.oid, 'trigger') then 't' end) as held
     from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'v', 'm', 'f', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
     union all
     select n.nspname || '.' || c.relname, 'sequence'
     from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'S' and n.nspname not in ('pg_catalog', 'information_schema') and has_sequence_privilege($1, c.oid, 'usage,select,update')`,
    [role],
  );
  return Object.fromEntries((rows as Row[]).filter((r) => r.held !== "").map((r) => [String(r.obj), String(r.held)]));
};

/** Two statistics views every role can read (granted to everyone by the extension). They hide other roles' query text: see ask-login.test.ts. */
const EVERYONE = { "extensions.pg_stat_statements": "r", "extensions.pg_stat_statements_info": "r" };
const parentRead = (k: OrgKey) => Object.fromEntries(PARENT.map((t) => [`${schemas(k).parent}.${t}`, "r"]));

describe("exactly what each restaurant role holds, across the whole database", () => {
  it("the live role: read on parent, write on its live tables (append-only: read and insert), nothing else", async () => {
    expect(await holdings(roles("a").rw)).toEqual({
      ...EVERYONE,
      ...parentRead("a"),
      [`${A.live}.sec_note`]: "rawd",
      [`${A.live}.sec_visit`]: "rawd",
      [`${A.live}.sec_ledger`]: "ra",
    });
  });

  it("the draft role: the same on draft tables, and only some columns of parent staff", async () => {
    expect(await holdings(roles("a").draftRw)).toEqual({
      ...EVERYONE,
      ...parentRead("a"),
      [`${A.parent}.staff`]: "(r)",
      [`${A.draft}.sec_note`]: "rawd",
      [`${A.draft}.sec_visit`]: "rawd",
      [`${A.draft}.sec_ledger`]: "ra",
    });
  });

  it("the Ask role: read on parent and live, and not one write anywhere", async () => {
    const held = await holdings(roles("a").ask);
    expect(held).toEqual({ ...EVERYONE, ...parentRead("a"), [`${A.live}.sec_note`]: "r", [`${A.live}.sec_visit`]: "r", [`${A.live}.sec_ledger`]: "r" });
    expect(Object.values(held).every((v) => v === "r")).toBe(true);
  });

  it("the shared group role holds nothing but those two views", async () => {
    expect(await holdings("rms_tenant")).toEqual(EVERYONE);
  });

  it("each role can enter only its own schemas", async () => {
    const usage = async (role: string) =>
      (await platform().unsafe(`select nspname from pg_catalog.pg_namespace where has_schema_privilege($1, oid, 'usage') and nspname !~ '^pg_(temp|toast)'`, [role])).map((r) => String((r as Row).nspname)).sort();
    const common = ["extensions", "information_schema", "pg_catalog", "public", "rms"];
    expect(await usage(roles("a").rw)).toEqual([...common, A.live, A.parent].sort());
    expect(await usage(roles("a").draftRw)).toEqual([...common, A.draft, A.parent].sort());
    expect(await usage(roles("a").ask)).toEqual([...common, A.live, A.parent].sort());
  });

  it("no restaurant role may create anything, anywhere: no schema, no table, no temp table, no database object", async () => {
    for (const role of Object.values(roles("a"))) {
      const [row] = await platform().unsafe(
        `select (select count(*)::int from pg_catalog.pg_namespace where has_schema_privilege($1, oid, 'create')) as schemas,
                has_database_privilege($1, current_database(), 'create') as db_create,
                has_database_privilege($1, current_database(), 'temp') as db_temp`,
        [role],
      );
      expect(row, role).toEqual({ schemas: 0, db_create: false, db_temp: false });
    }
  });

  it("outside the built-in and extension functions, a restaurant role can call only the four rms helpers", async () => {
    const rows = await platform().unsafe(
      `select n.nspname || '.' || p.proname as fn from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where has_function_privilege($1, p.oid, 'execute') and has_schema_privilege($1, n.oid, 'usage') and n.nspname not in ('pg_catalog', 'information_schema', 'extensions') order by 1`,
      [roles("a").ask],
    );
    expect(rows.map((r) => (r as Row).fn).sort()).toEqual(["rms.current_actor", "rms.current_org", "rms.location_ok", "rms.touch_updated_at"]);
  });

  it("role membership is exactly as designed: the Ask role belongs to the shared group only, and nobody can switch into it", async () => {
    const rows = await platform().unsafe(
      `select r.rolname as role, m.rolname as member, am.inherit_option as inherit, am.set_option as set
       from pg_catalog.pg_auth_members am join pg_catalog.pg_roles r on r.oid = am.roleid join pg_catalog.pg_roles m on m.oid = am.member
       where r.rolname like $1 or m.rolname like $1 order by 1, 2`,
      [`${A.live}\\_%`],
    );
    const r = roles("a");
    const usable = (rows as Row[]).filter((x) => x.set === true || x.inherit === true).map((x) => `${x.member} -> ${x.role}${x.set ? " (switch)" : ""}${x.inherit ? " (inherit)" : ""}`);
    expect(usable.sort()).toEqual(
      [
        `${r.ask} -> rms_tenant (switch) (inherit)`,
        `${r.draftRw} -> rms_tenant (switch) (inherit)`,
        `${r.rw} -> rms_tenant (switch) (inherit)`,
        `rms_admin -> ${r.draftRw} (switch)`,
        `rms_admin -> ${r.rw} (switch)`,
        `rms_api -> ${r.draftRw} (switch)`,
        `rms_api -> ${r.rw} (switch)`,
      ].sort(),
    );
  });

  it("no restaurant role has a dangerous attribute, and only the Ask role can log in", async () => {
    const rows = await platform().unsafe(`select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin from pg_catalog.pg_roles where rolname like $1 order by 1`, [`${A.live}\\_%`]);
    expect(rows).toHaveLength(3);
    for (const r of rows as Row[]) {
      expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
      if (r.rolname !== roles("a").ask) expect(r.rolcanlogin, String(r.rolname)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- parent data is read-only, enforced by Postgres
describe.each([
  ["live", live],
  ["draft", draft],
] as const)("parent data is read-only to the %s role", (_env, opts) => {
  it.each(PARENT)("cannot change %s in any way", async (table) => {
    const t = `${A.parent}.${table}`;
    for (const [what, sql] of PARENT_ATTACKS) expect(await outcome(storeSql("a", sql(t), opts)), `${what} on ${table}`).toBe(DENIED);
  });

  it("cannot drop or alter the parent schema itself", async () => {
    expect(await outcome(storeSql("a", `drop schema ${A.parent} cascade`, opts))).toBe(DENIED);
    expect(await outcome(storeSql("a", `alter schema ${A.parent} rename to x_sec_probe`, opts))).toBe(DENIED);
    expect(await outcome(storeSql("a", `create table ${A.parent}.x_sec_probe (id int)`, opts))).toBe(DENIED);
  });

  it("granting itself more does nothing: a grant by a role with no grant right gives no rights", async () => {
    // Postgres answers this with a warning, not an error. So check the effect, not the reply.
    const rows = await storeSql(
      "a",
      `grant insert, update, delete on ${A.parent}.jobs to current_user;
       grant select on ${A.parent}.jobs to ${roles("b").rw};
       select has_table_privilege(current_user, '${A.parent}.jobs', 'insert') as self_write, has_table_privilege('${roles("b").rw}', '${A.parent}.jobs', 'select') as other_read`,
      opts,
    );
    expect((rows as unknown as Row[][]).at(-1)?.[0]).toEqual({ self_write: false, other_read: false });
  });
});

describe("control: the parent tables are real, hold data, and the right role can write them", () => {
  it("the live role reads every parent table and finds its own canary", async () => {
    for (const table of PARENT) {
      const rows = await storeSql("a", `select * from ${A.parent}.${table}`);
      expect(rows.length, table).toBeGreaterThan(0);
      expect(JSON.stringify(rows), table).toContain(CANARY.a);
    }
  });

  it("the parent sync role can do what the restaurant roles cannot", async () => {
    const r = await asPlatform(async (tx) => {
      await tx.unsafe("set local role rms_parent_sync");
      return tx.unsafe(`update ${A.parent}.jobs set name = name returning id`);
    });
    expect((r as Row[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------- nothing of another restaurant, nothing of the platform
describe("the live role of A reaching outside its own store", () => {
  it.each(PARENT)("cannot read B's parent table %s", async (table) => {
    expect(await outcome(storeSql("a", `select * from ${B.parent}.${table}`))).toBe(DENIED);
  });

  it.each(MODEL_KEYS)("cannot read or write B's live or draft table %s", async (table) => {
    for (const schema of [B.live, B.draft]) {
      expect(await outcome(storeSql("a", `select * from ${schema}.${table}`)), `read ${schema}`).toBe(DENIED);
      expect(await outcome(storeSql("a", `insert into ${schema}.${table} select * from ${schema}.${table}`)), `insert ${schema}`).toBe(DENIED);
      expect(await outcome(storeSql("a", `delete from ${schema}.${table}`)), `delete ${schema}`).toBe(DENIED);
    }
  });

  it("control: B's own live role reads those tables and finds B's canary", async () => {
    for (const table of MODEL_KEYS) {
      const rows = await storeSql("b", `select * from ${B.live}.${table}`);
      expect(JSON.stringify(rows), table).toContain(CANARY.b);
    }
    expect(JSON.stringify(await storeSql("b", `select * from ${B.parent}.jobs`))).toContain(CANARY.b);
  });

  it("cannot read the platform schema, call its functions, or read sign-in data", async () => {
    for (const sql of [
      "select count(*) from platform.organizations",
      "select count(*) from platform.secrets",
      "select count(*) from platform.public_listings",
      "select * from platform.memberships_for(gen_random_uuid())",
      `select platform.drop_store('${a.app}')`,
      "select count(*) from auth.users",
      "select count(*) from vault.decrypted_secrets",
      "select count(*) from storage.objects",
    ]) {
      expect(await outcome(storeSql("a", sql)), sql).toBe(DENIED);
    }
  });

  it("setting the platform's restaurant setting from inside a store opens nothing", async () => {
    const sql = `select set_config('rms.org', '${schemas("b").live}', true); select count(*) from platform.organizations`;
    expect(await outcome(storeSql("a", sql))).toBe(DENIED);
  });

  it("cannot create a table, view, function, sequence or type, in its own schema or in public", async () => {
    for (const s of [A.live, A.parent, "public", "rms", "extensions"]) {
      expect(await outcome(storeSql("a", `create table ${s}.x_sec_probe (id int)`)), `table in ${s}`).toBe(DENIED);
      expect(await outcome(storeSql("a", `create view ${s}.x_sec_probe as select 1`)), `view in ${s}`).toBe(DENIED);
      expect(await outcome(storeSql("a", `create function ${s}.x_sec_probe() returns int language sql as 'select 1'`)), `function in ${s}`).toBe(DENIED);
      expect(await outcome(storeSql("a", `create sequence ${s}.x_sec_probe`)), `sequence in ${s}`).toBe(DENIED);
    }
    expect(await outcome(storeSql("a", "create schema x_sec_probe"))).toBe(DENIED);
  });

  it("cannot change the structure of its own live tables", async () => {
    for (const sql of [
      `alter table ${A.live}.sec_note add column x_sec_probe int`,
      `alter table ${A.live}.sec_visit disable row level security`,
      `alter table ${A.live}.sec_visit disable trigger all`,
      `drop policy location_scope on ${A.live}.sec_visit`,
      `create policy x_sec_probe on ${A.live}.sec_visit using (true)`,
      `drop table ${A.live}.sec_note`,
      `create index x_sec_probe on ${A.live}.sec_note (body)`,
      `alter table ${A.live}.sec_ledger owner to current_user`,
    ]) {
      expect(await outcome(storeSql("a", sql)), sql).toBe(DENIED);
    }
  });

  it("cannot switch to the table-creating role, the parent writer, the platform login, an Ask role or a built-in role", async () => {
    for (const r of ["rms_tenant_migrator", "rms_parent_sync", "rms_admin", "postgres", "supabase_admin", "service_role", roles("a").ask, roles("b").ask]) {
      expect(await outcome(storeSql("a", `set local role ${r}`)), r).toBe(DENIED);
    }
  });
});

// ---------------------------------------------------------------- temp tables (replaces a smoke check that passed for the wrong reason)
describe("temp tables", () => {
  // The old shell check counted ANY error as "blocked". Here the refusal must be the missing right to
  // make temp tables, in a transaction that is allowed to write, and the same statement must work for the platform login.
  it("the live and draft roles are refused for lack of the temp-table right", async () => {
    for (const opts of [live, draft]) {
      const r = await refusal(storeSql("a", "create temp table x_sec_probe (id int)", opts));
      expect(r.code).toBe(DENIED);
      expect(r.message).toMatch(/permission denied to create temporary tables/);
    }
  });

  it("control: the same statement works for the platform login", async () => {
    expect(await outcome(asPlatform((tx) => tx.unsafe("create temp table x_sec_probe (id int) on commit drop")))).toBe("allowed");
  });
});

// ---------------------------------------------------------------- draft and live are separate (replaces a smoke check that passed for the wrong reason)
describe("the draft role and the live store", () => {
  it("the draft role is refused at the live SCHEMA, before any table grant is looked at", async () => {
    for (const table of MODEL_KEYS) {
      const r = await refusal(storeSql("a", `select count(*) from ${A.live}.${table}`, draft));
      expect(r.code, table).toBe(DENIED);
      expect(r.message, table).toBe(`permission denied for schema ${A.live}`);
    }
  });

  it("control: the live role reads the same tables", async () => {
    for (const table of MODEL_KEYS) expect(await outcome(storeSql("a", `select count(*) from ${A.live}.${table}`, live)), table).toBe("allowed");
  });

  it("even a live table wrongly granted to the draft role stays out of reach", async () => {
    // Simulates a compiler bug. The schema wall must hold by itself. Rolled back.
    const r = await refusal(
      asPlatform(async (tx) => {
        await tx.unsafe("set local role rms_tenant_migrator");
        await tx.unsafe(`grant select on ${A.live}.sec_note to ${roles("a").draftRw}`);
        await tx.unsafe("reset role");
        await tx.unsafe(`set local role ${roles("a").draftRw}`);
        return tx.unsafe(`select count(*) from ${A.live}.sec_note`);
      }),
    );
    expect(r).toMatchObject({ code: DENIED, message: `permission denied for schema ${A.live}` });
  });

  it("the live role cannot reach the draft schema either", async () => {
    for (const table of MODEL_KEYS) expect((await refusal(storeSql("a", `select count(*) from ${A.draft}.${table}`, live))).message, table).toBe(`permission denied for schema ${A.draft}`);
  });

  it("each role sees its own copy of the data: draft rows in draft, live rows in live", async () => {
    const liveRows = await storeSql("a", `select body from ${A.live}.sec_note`, live);
    const draftRows = await storeSql("a", `select body from ${A.draft}.sec_note`, draft);
    expect(liveRows.map((r) => r.body)).toEqual([`note ${CANARY.a} live`]);
    expect(draftRows.map((r) => r.body)).toEqual([`note ${CANARY.a} draft`]);
  });

  it("the draft role cannot read real pay or contact details from parent staff", async () => {
    for (const column of ["hourly_rate_minor", "email", "phone", "*"]) {
      expect(await outcome(storeSql("a", `select ${column} from ${A.parent}.staff`, draft)), column).toBe(DENIED);
    }
    // Not through a filter, a sort or a total either.
    expect(await outcome(storeSql("a", `select full_name from ${A.parent}.staff where hourly_rate_minor > 1000`, draft))).toBe(DENIED);
    expect(await outcome(storeSql("a", `select full_name from ${A.parent}.staff order by hourly_rate_minor`, draft))).toBe(DENIED);
    expect(await outcome(storeSql("a", `select sum(hourly_rate_minor) from ${A.parent}.staff`, draft))).toBe(DENIED);
    expect(await outcome(storeSql("a", `select s::text from ${A.parent}.staff s`, draft))).toBe(DENIED);
  });

  it("the draft role reads exactly the staff columns it was given", async () => {
    const rows = await platform().unsafe(
      `select a.attname from pg_catalog.pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped and has_column_privilege($2, a.attrelid, a.attnum, 'select') order by a.attnum`,
      [`${A.parent}.staff`, roles("a").draftRw],
    );
    expect(rows.map((r) => (r as Row).attname).sort()).toEqual(["currency", "full_name", "id", "job_id", "location_id", "started_on", "status", "updated_at"]);
    const names = await storeSql("a", `select full_name from ${A.parent}.staff`, draft);
    expect(names).toHaveLength(1);
  });

  it("control: the live role reads staff pay (it is the owner's own data)", async () => {
    expect((await storeSql("a", `select hourly_rate_minor from ${A.parent}.staff`, live))[0]?.hourly_rate_minor).toBe("1875");
  });
});

// ---------------------------------------------------------------- append-only tables
describe("append-only tables", () => {
  const t = `${A.live}.sec_ledger`;
  it.each([
    ["update", `update ${t} set body = 'changed'`],
    ["delete", `delete from ${t}`],
    ["truncate", `truncate ${t}`],
    ["update through an upsert", `insert into ${t} (id, source, created_by, updated_by, body) values ('${a.ledgerRow}', 'manual', 'user:x', 'user:x', 'changed') on conflict (id) do update set body = excluded.body`],
    ["delete through a CTE", `with gone as (delete from ${t} returning 1) select count(*) from gone`],
    ["lock for update", `select * from ${t} for update`],
  ])("the live role cannot %s", async (_what, sql) => {
    expect(await outcome(storeSql("a", sql))).toBe(DENIED);
  });

  it("control: it can add a row", async () => {
    expect(await storeSql("a", `insert into ${t} (id, source, created_by, updated_by, body) values (gen_random_uuid(), 'manual', 'user:x', 'user:x', 'new') returning id`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- location scope
describe("rows are scoped to the caller's locations by the database", () => {
  const t = `${A.live}.sec_visit`;
  const loc1: StoreOpts = { locations: [a.loc1] };
  const row = (loc: string) => `(gen_random_uuid(), '${loc}', 'manual', 'user:x', 'user:x', 'x')`;

  it("a caller with one location sees only that location's rows", async () => {
    expect((await storeSql("a", `select body from ${t}`, loc1)).map((r) => r.body)).toEqual([`visit loc1 ${CANARY.a} live`]);
  });

  it("control: a caller with every location sees both rows", async () => {
    expect(await storeSql("a", `select body from ${t} order by body`, { locations: "all" })).toHaveLength(2);
  });

  it("cannot insert a row for a location it does not have", async () => {
    const r = await refusal(storeSql("a", `insert into ${t} (id, location_id, source, created_by, updated_by, body) values ${row(a.loc2)}`, loc1));
    expect(r.code).toBe(DENIED);
    expect(r.message).toMatch(/row-level security/);
  });

  it("control: it can insert a row for its own location", async () => {
    expect(await outcome(storeSql("a", `insert into ${t} (id, location_id, source, created_by, updated_by, body) values ${row(a.loc1)}`, loc1))).toBe("allowed");
  });

  it("cannot move its own row to another location", async () => {
    expect((await refusal(storeSql("a", `update ${t} set location_id = '${a.loc2}' where location_id = '${a.loc1}'`, loc1))).message).toMatch(/row-level security/);
  });

  it("an update or delete aimed at another location's row touches nothing", async () => {
    expect(await storeSql("a", `update ${t} set body = 'x' where id = '${a.visitRow2}' returning id`, loc1)).toHaveLength(0);
    expect(await storeSql("a", `delete from ${t} where id = '${a.visitRow2}' returning id`, loc1)).toHaveLength(0);
    expect(await storeSql("a", `select wage from ${t} where location_id = '${a.loc2}'`, loc1)).toHaveLength(0);
  });

  it("a location from another restaurant gives nothing", async () => {
    expect(await storeSql("a", `select * from ${t}`, { locations: [ids("b").loc1] })).toHaveLength(0);
  });

  it("the scope fails closed: unset, empty or malformed means no rows, never all rows", async () => {
    const withScope = (value: string | null) =>
      asPlatform(async (tx) => {
        await tx.unsafe(`set local role ${roles("a").rw}`);
        if (value !== null) await tx`select set_config('rms.locations', ${value}, true)`;
        return tx.unsafe(`select count(*)::int as n from ${t}`);
      });
    expect(((await withScope(null)) as Row[])[0]?.n).toBe(0);
    expect(((await withScope("")) as Row[])[0]?.n).toBe(0);
    for (const bad of ["ALL", " all", "all,", "*", "true", `${a.loc1};all`]) expect(await outcome(withScope(bad)), bad).toBe("22P02");
    expect(((await withScope("all")) as Row[])[0]?.n).toBe(2);
  });

  it("cannot turn row security off for itself", async () => {
    const r = await refusal(storeSql("a", `set local row_security = off; select count(*) from ${t}`, loc1));
    expect(r.code).toBe(DENIED);
    expect(await outcome(storeSql("a", `alter table ${t} disable row level security`, loc1))).toBe(DENIED);
    expect(await outcome(storeSql("a", `alter table ${t} no force row level security`, loc1))).toBe(DENIED);
  });

  it("the draft copy is scoped the same way", async () => {
    expect(await storeSql("a", `select body from ${A.draft}.sec_visit`, { env: "draft", locations: [a.loc1] })).toHaveLength(1);
  });
});
