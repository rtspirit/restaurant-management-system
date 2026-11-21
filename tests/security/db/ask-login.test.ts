// The Ask login: the one place model-written SQL runs.
//
// MODE IN USE: one database login per restaurant (ADR 0003, decision 4). There is no parser yet
// (wall 1 is Wave 2, task K), so these tests attack walls 2 and 3 directly: the read-only envelope
// in @rms/db and the login's own rights.
//
// packages/db/src/ask.test.ts already covers the basics. This file ports the Ask section of
// db-walls.smoke.sh with exact error codes and adds the attacks the security review asked for.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASK_QUERY_LIMITS } from "@rms/contracts";
import { type Sql, adminDb, mintAskLogin, openAsk } from "@rms/db";
import { type AskHandle, DENIED, READ_ONLY, type Row, askAs, forgetAsk, holds, outcome, platform, refusal } from "../helpers/actors.js";
import { PARENT_ATTACKS } from "../helpers/attacks.js";
import { CANARY, MODEL_KEYS, ORG, PARENT_TABLES, ids, roles, schemas } from "../helpers/world.js";

const A = schemas("a");
const B = schemas("b");
const PARENT = PARENT_TABLES.map(([t]) => t);
const SYNTAX = "42601";
const TIMEOUT = "57014";

let ask: AskHandle;
let askB: AskHandle;

beforeAll(async () => {
  ask = await askAs("a");
  askB = await askAs("b");
});

describe("control: the Ask login answers questions about its own restaurant", () => {
  it("reads its own parent data and live tables without naming a schema", async () => {
    for (const table of PARENT) {
      const r = await ask.query(`select * from ${table}`);
      expect(holds(r, CANARY.a), table).toBe(true);
    }
    expect((await ask.query("select body from sec_note")).rows).toEqual([{ body: `note ${CANARY.a} live` }]);
    expect((await ask.query("select body from sec_ledger")).rows).toHaveLength(2);
  });
});

describe("the Ask login cannot read anything else", () => {
  it.each(PARENT)("B's parent table %s", async (table) => {
    expect(await outcome(ask.query(`select * from ${B.parent}.${table}`))).toBe(DENIED);
  });

  it.each(MODEL_KEYS)("B's live and draft table %s", async (table) => {
    expect(await outcome(ask.query(`select * from ${B.live}.${table}`))).toBe(DENIED);
    expect(await outcome(ask.query(`select * from ${B.draft}.${table}`))).toBe(DENIED);
  });

  it("control: B's own Ask login reads those tables and finds B's canary", async () => {
    expect(holds(await askB.query(`select * from ${B.parent}.jobs`), CANARY.b)).toBe(true);
    for (const table of MODEL_KEYS) {
      expect(holds(await askB.query(`select * from ${B.live}.${table}`), CANARY.b), table).toBe(true);
    }
  });

  it("its own restaurant's draft tables", async () => {
    for (const table of MODEL_KEYS) expect((await refusal(ask.query(`select * from ${A.draft}.${table}`))).message, table).toBe(`permission denied for schema ${A.draft}`);
  });

  it("the platform, sign-in data, the secrets vault, file storage", async () => {
    for (const t of ["platform.organizations", "platform.secrets", "platform.org_memory", "platform.public_listings", "platform.staff_users", "auth.users", "auth.identities", "vault.secrets", "vault.decrypted_secrets", "storage.objects"]) {
      expect(await outcome(ask.query(`select * from ${t}`)), t).toBe(DENIED);
    }
    expect(await outcome(ask.query("select * from platform.memberships_for(gen_random_uuid())"))).toBe(DENIED);
    expect(await outcome(ask.query(`select platform.drop_store('${ORG.b.uuid}')`))).toBe(DENIED);
  });

  it("another restaurant's rows through a function that runs a query from text", async () => {
    expect(await outcome(ask.query(`select query_to_xml('select * from ${B.live}.sec_note', true, false, '')`))).toBe(DENIED);
    expect(await outcome(ask.query(`select schema_to_xml('${B.live}', true, false, '')`))).toBe(DENIED);
    expect(await outcome(ask.query(`select table_to_xml('${B.live}.sec_note'::regclass, true, false, '')`))).toBe(DENIED);
  });

  it("a dump of everything it can read holds its own data and none of B's", async () => {
    // database_to_xml walks every table the login may read. The sweep in the helper checks the result.
    const dump = await ask.query("select schema_to_xml(n.nspname, true, false, '')::text as x from pg_namespace n where has_schema_privilege(n.oid, 'usage') and n.nspname like 'o\\_%'");
    expect(holds(dump, CANARY.a)).toBe(true);
    expect(holds(dump, CANARY.b)).toBe(false);
  });

  it("stored passwords, server files and server settings", async () => {
    for (const sql of [
      "select rolpassword from pg_authid",
      "select * from pg_shadow",
      "select * from pg_statistic",
      "select * from pg_largeobject",
      "select pg_read_file('/etc/passwd')",
      "select pg_read_binary_file('/etc/passwd')",
      "select pg_ls_dir('.')",
      "select pg_stat_file('/etc/passwd')",
      "select lo_import('/etc/passwd')",
      "select lo_export(1, '/tmp/x')",
      "select * from pg_hba_file_rules",
      "select * from pg_file_settings",
      "select current_setting('data_directory')",
      "select current_setting('config_file')",
      "select extensions.pg_stat_statements_reset()",
      "select pg_reload_conf()",
      "select pg_switch_wal()",
    ]) {
      expect(await outcome(ask.query(sql)), sql).toBe(DENIED);
    }
  });

  it("the standard information schema shows it nothing of another restaurant", async () => {
    for (const view of ["tables", "columns", "table_privileges", "column_privileges", "role_table_grants", "views", "constraint_column_usage", "key_column_usage"]) {
      const rows = (await ask.query(`select * from information_schema.${view} where table_schema like 'o\\_%'`, 500)).rows;
      for (const r of rows) expect(String(r.table_schema).startsWith(A.live), `${view}: ${String(r.table_schema)}`).toBe(true);
    }
    const schemata = (await ask.query("select schema_name from information_schema.schemata")).rows.map((r) => String(r.schema_name));
    expect(schemata.filter((s) => s.startsWith("o_")).sort()).toEqual([A.live, A.parent].sort());
    expect(schemata).not.toContain("platform");
  });

  it("control: the information schema does show it its own tables (so the check above can see)", async () => {
    const own = (await ask.query(`select table_name from information_schema.tables where table_schema = '${A.live}'`)).rows.map((r) => r.table_name);
    expect(own.sort()).toEqual([...MODEL_KEYS].sort());
  });

  it("column statistics (which hold real values) are hidden for B's tables", async () => {
    expect((await ask.query(`select * from pg_stats where schemaname like '${B.live}%'`)).rows).toHaveLength(0);
  });

  it("control: column statistics do hold real values, and B's own login can see its own", async () => {
    // sec_ledger: statistics of tables with row security are hidden from everyone but the owner.
    const own = await askB.query(`select * from pg_stats where schemaname = '${B.live}' and tablename = 'sec_ledger'`);
    expect(own.rows.length).toBeGreaterThan(0);
    expect(holds(own, CANARY.b)).toBe(true);
  });

  it("cannot see what another login is running", async () => {
    // A platform job is busy with a query that has B's canary in its text.
    // (postgres.js starts a query only when it is awaited, hence the `then`.)
    const busy = platform().unsafe(`select '${CANARY.b}' as marker, pg_sleep(1.2)`).then((r) => r);
    await new Promise((r) => setTimeout(r, 250));
    const seenByPlatform = await platform().unsafe("select query from pg_stat_activity where query like '%pg_sleep(1.2)%' and pid <> pg_backend_pid()");
    const seenByAsk = await ask.query("select * from pg_stat_activity");
    await busy;
    // Control: the query really was visible to its own login while the Ask login looked.
    expect(holds(seenByPlatform, CANARY.b)).toBe(true);
    expect(holds(seenByAsk, CANARY.b)).toBe(false);
    expect(seenByAsk.rows.length).toBeGreaterThan(1);
  });

  it("cannot read another login's query history", async () => {
    // Put B's canary where query statistics keep it: in a column name (values are replaced by placeholders).
    await platform().unsafe(`select 1 as "${CANARY.b}"`);
    const history = await ask.query("select * from extensions.pg_stat_statements", 500);
    expect(holds(history, CANARY.b)).toBe(false);
    const hidden = await ask.query("select count(*)::int as n from extensions.pg_stat_statements s join pg_roles r on r.oid = s.userid where r.rolname <> current_user and s.query <> '<insufficient privilege>'");
    expect(hidden.rows[0]?.n).toBe(0);
  });

  it("cannot stop or cancel another login's connection", async () => {
    const [other] = await platform().unsafe("select pid from pg_stat_activity where usename = 'rms_admin' and pid <> pg_backend_pid() limit 1");
    const pid = Number((other as Row | undefined)?.pid ?? (await platform().unsafe("select pg_backend_pid() as pid"))[0]?.pid);
    expect(await outcome(ask.query(`select pg_terminate_backend(${pid})`))).toBe(DENIED);
    expect(await outcome(ask.query(`select pg_cancel_backend(${pid})`))).toBe(DENIED);
  });
});

describe("the Ask login cannot write, even outside the envelope", () => {
  it("left to its defaults, a transaction is read-only", async () => {
    expect(await outcome(ask.plain(`insert into ${A.parent}.jobs select * from ${A.parent}.jobs`))).toBe(READ_ONLY);
    expect(await outcome(ask.plain(`delete from ${A.live}.sec_note`))).toBe(READ_ONLY);
  });

  it.each(PARENT)("in a read-write transaction it still has no right to change parent table %s", async (table) => {
    const t = `${A.parent}.${table}`;
    for (const [what, sql] of PARENT_ATTACKS) expect(await outcome(ask.readWrite(sql(t))), `${what} on ${table}`).toBe(DENIED);
  });

  it.each(MODEL_KEYS)("in a read-write transaction it has no right to change live table %s", async (table) => {
    const t = `${A.live}.${table}`;
    for (const [what, sql] of PARENT_ATTACKS) expect(await outcome(ask.readWrite(sql(t))), `${what} on ${table}`).toBe(DENIED);
    expect(await outcome(ask.readWrite(`select * from ${t} for update`)), "lock rows").toBe(DENIED);
  });

  it("temp tables: refused for lack of the temp-table right, in a transaction that may write (replaces a smoke check that passed for the wrong reason)", async () => {
    const r = await refusal(ask.readWrite("create temp table x_sec_probe (id int)"));
    expect(r.code).toBe(DENIED);
    expect(r.message).toMatch(/permission denied to create temporary tables/);
    // The other ways to make a temp object are the same right.
    expect(await outcome(ask.readWrite("create temp view x_sec_probe as select 1"))).toBe(DENIED);
    expect(await outcome(ask.readWrite("create function pg_temp.x_sec_probe() returns int language sql as 'select 1'"))).toBe(DENIED);
    expect(await outcome(ask.readWrite("select 1 into temp x_sec_probe"))).toBe(DENIED);
  });

  it("cannot create a schema, a table, a view or a function anywhere", async () => {
    for (const sql of [
      "create schema x_sec_probe",
      `create table ${A.live}.x_sec_probe (id int)`,
      `create view ${A.live}.x_sec_probe as select 1`,
      `create function ${A.live}.x_sec_probe() returns int language sql as 'select 1'`,
      "create table public.x_sec_probe (id int)",
      "create function public.x_sec_probe() returns int language sql as 'select 1'",
    ]) {
      expect(await outcome(ask.readWrite(sql)), sql).toBe(DENIED);
    }
  });

  it("granting its own read right to another restaurant gives that restaurant nothing", async () => {
    const rows = await ask.readWrite(
      `grant select on ${A.live}.sec_note to ${roles("b").rw}; grant select on ${A.live}.sec_note to public;
       select has_table_privilege('${roles("b").rw}', '${A.live}.sec_note', 'select') as other, has_schema_privilege('${roles("b").rw}', '${A.live}', 'usage') as other_schema`,
    );
    expect((rows as unknown as Row[][]).at(-1)?.[0]).toEqual({ other: false, other_schema: false });
  });
});

describe("the Ask login cannot become anyone else", () => {
  const targets = [roles("a").rw, roles("a").draftRw, roles("b").ask, roles("b").rw, "rms_api", "rms_admin", "rms_tenant_migrator", "rms_parent_sync", "postgres", "supabase_admin", "service_role", "authenticator", "pg_read_all_data"];

  it.each(targets)("cannot switch to %s, inside or outside the envelope", async (role) => {
    expect(await outcome(ask.envelope(`set local role ${role}`))).toBe(DENIED);
    expect(await outcome(ask.readWrite(`set local role ${role}`))).toBe(DENIED);
    expect(await outcome(ask.query(`select set_config('role', '${role}', true)`))).toBe(DENIED);
  });

  it("cannot change the session's login identity", async () => {
    expect(await outcome(ask.envelope(`set session authorization ${roles("b").ask}`))).toBe(DENIED);
    expect(await outcome(ask.envelope("set session authorization postgres"))).toBe(DENIED);
    expect(await outcome(ask.query("select set_config('session_authorization', 'postgres', true)"))).toBe(DENIED);
  });

  it("stays itself after every attempt", async () => {
    expect((await ask.query("select current_user as u, session_user as s")).rows).toEqual([{ u: roles("a").ask, s: roles("a").ask }]);
  });

  it("naming another restaurant in the request settings changes nothing it can read", async () => {
    const r = await ask.query(`select (select set_config('rms.org', '${ORG.b.uuid}', true)) as org, (select count(*)::int from jobs) as jobs`);
    expect(r.rows[0]?.jobs).toBe(1);
    expect(await outcome(ask.query(`select set_config('rms.org', '${ORG.b.uuid}', true), (select count(*) from platform.organizations)`))).toBe(DENIED);
    expect(await outcome(ask.query(`select set_config('search_path', '${B.live}, ${B.parent}', true), (select count(*) from ${B.live}.sec_note)`))).toBe(DENIED);
  });
});

describe("ask_wrapper_refuses_extension: inside the envelope the database refuses everything that is not a read", () => {
  it.each([
    ["install an extension", "create extension if not exists http with schema extensions"],
    ["remove an extension", 'drop extension if exists "uuid-ossp"'],
    ["change its own password", "alter role current_user password 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x'"],
    ["change its own defaults", "alter role current_user set statement_timeout = 0"],
    ["create a temp table", "create temp table x_sec_probe (id int)"],
    ["create a large object", "select lo_from_bytea(0, 'x')"],
    ["create a large object the old way", "select lo_create(0)"],
    ["insert into a live table", `insert into ${A.live}.sec_note select * from ${A.live}.sec_note`],
    ["delete from a live table", `delete from ${A.live}.sec_note`],
    ["create a schema", "create schema x_sec_probe"],
    ["comment on a table", `comment on table ${A.live}.sec_note is 'x'`],
    ["grant a right", `grant select on ${A.live}.sec_note to public`],
  ])("cannot %s (25006)", async (_what, sql) => {
    expect(await outcome(ask.envelope(sql))).toBe(READ_ONLY);
  });

  it("cannot turn the transaction read-write once a query has run (25001)", async () => {
    expect(await outcome(ask.envelope("set transaction read write"))).toBe("25001");
    expect(await outcome(ask.envelope("set local transaction_read_only = off"))).toBe("25001");
    expect(await outcome(ask.query("select set_config('transaction_read_only', 'off', true)"))).toBe("25001");
  });

  it("a session told to start read-write transactions still gets a read-only envelope", async () => {
    await ask.raw("set session characteristics as transaction read write");
    await ask.raw("set default_transaction_read_only = off");
    expect(await outcome(ask.envelope(`delete from ${A.live}.sec_note`))).toBe(READ_ONLY);
    expect((await ask.query("select current_setting('transaction_read_only') as ro")).rows[0]?.ro).toBe("on");
    // Leave a clean connection for the tests that follow.
    await forgetAsk("a");
    ask = await askAs("a");
  });
});

describe("the wrapped query must be exactly one SELECT", () => {
  it.each([
    ["end the transaction and start a writable one", "select 1) as x; commit; begin read write; create extension http; select * from (select 1"],
    ["roll back and start again", "select 1) as x; rollback; begin read write; select lo_from_bytea(0, 'x'); select * from (select 1"],
    ["a second statement", "select 1; select 2"],
    ["a trailing semicolon and more", "select 1); drop table sec_note; --"],
    ["a savepoint", "select 1) as x; savepoint s; select * from (select 1"],
    ["a setting change", "set statement_timeout = 0"],
    ["a role change", `set role ${roles("b").rw}`],
    ["a transaction command", "commit"],
    ["a write", "insert into sec_note (id) values (gen_random_uuid()) returning *"],
    ["a delete", "delete from sec_note returning *"],
    ["an update", "update sec_note set body = 'x' returning *"],
    ["DDL", "create table x_sec_probe (id int)"],
    ["a DO block", "do $$ begin perform 1; end $$"],
    ["a call", "call x_sec_probe()"],
    ["a copy", "copy sec_note to stdout"],
    ["an explain analyze of a write", "explain analyze delete from sec_note"],
    ["select into a new table", "select * into x_sec_probe from sec_note"],
    ["an unfinished string", "select 'abc"],
    ["an unfinished dollar quote", "select $x$ abc"],
    ["an unfinished comment", "select 1 /* abc"],
    ["a nested unfinished comment", "select 1 /* a /* b */"],
    ["a prepared statement", "prepare p as delete from sec_note"],
    ["listen", "listen x_sec_probe"],
    ["vacuum", "vacuum"],
  ])("refuses %s as a syntax error, before anything runs", async (_what, text) => {
    expect(await outcome(ask.query(text))).toBe(SYNTAX);
  });

  it("a write hidden in a CTE is refused", async () => {
    expect(await outcome(ask.query("with w as (insert into sec_note select * from sec_note returning *) select * from w"))).toBe("0A000");
    expect(await outcome(ask.query("with w as (delete from sec_note returning *) select * from w"))).toBe("0A000");
  });

  it("row locks are refused", async () => {
    // Two walls, either may answer first: no right to lock rows (42501), and a read-only transaction (25006).
    expect([DENIED, READ_ONLY]).toContain(await outcome(ask.query("select * from sec_note for update")));
    expect([DENIED, READ_ONLY]).toContain(await outcome(ask.query("select * from sec_note for share")));
  });

  it("a comment at the end cannot swallow the wrapper", async () => {
    expect((await ask.query("select 1 as n --")).rows).toEqual([{ n: 1 }]);
    expect((await ask.query("select 1 as n -- ) as x; drop table sec_note")).rows).toEqual([{ n: 1 }]);
  });

  it("closing the wrapper early still leaves one SELECT, with the row cap on the whole of it", async () => {
    const r = await ask.query("select 1 as g) as x union all select g from generate_series(1, 100000) g union all select * from (select 2", 50);
    expect(r.rows).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it("referring to a parameter that does not exist is an error, and the real one cannot be redefined", async () => {
    expect(["42P02", "08P01"]).toContain(await outcome(ask.query("select $2")));
    expect((await ask.query("select 1 as n")).rows).toEqual([{ n: 1 }]); // the connection is still usable
    expect(await outcome(ask.query("select $1::text"))).not.toBe("allowed");
  });

  it("a query longer than the limit never reaches the database", async () => {
    await expect(ask.query(`select '${"x".repeat(8001)}'`)).rejects.toThrow("Query is too long");
  });

  it("nothing above changed the data", async () => {
    expect((await ask.query("select body from sec_note")).rows).toEqual([{ body: `note ${CANARY.a} live` }]);
    const [ext] = await platform().unsafe("select count(*)::int as n from pg_extension where extname = 'http'");
    expect((ext as Row).n).toBe(0);
  });
});

describe("ask_pool_state_reset: a poisoned connection is clean again for the next question", () => {
  it("settings, search path, read-only default and locks left on the connection are gone", async () => {
    // Poison the connection directly, as an earlier session on a pooled connection could have.
    await ask.raw("set statement_timeout = 0");
    await ask.raw("set lock_timeout = 0");
    await ask.raw("set search_path = pg_catalog");
    await ask.raw("set default_transaction_read_only = off");
    await ask.raw("set session characteristics as transaction read write");
    await ask.raw("set rms.locations = 'all'");
    await ask.raw(`set rms.org = '${ORG.b.uuid}'`);
    await ask.raw("set work_mem = '1GB'");
    await ask.raw("select pg_advisory_lock(424242)");
    await ask.raw("select set_config('statement_timeout', '0', false), set_config('search_path', 'pg_catalog', false)");
    const before = await ask.raw("select current_setting('statement_timeout') as t, (select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()) as locks");
    expect(before[0]).toEqual({ t: "0", locks: 1 }); // the poison took

    const r = await ask.query(
      `select current_setting('statement_timeout') as timeout, current_setting('lock_timeout') as lock_timeout, current_setting('search_path') as search_path,
              current_setting('transaction_read_only') as read_only, current_setting('work_mem') as work_mem,
              current_setting('rms.locations', true) as locations, current_setting('rms.org', true) as org,
              (select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()) as locks,
              (select count(*)::int from jobs) as jobs`,
    );
    // `locations` is "all": the envelope sets it for every question (the Ask agent is owner-only). It is the envelope's
    // value, not the "all" the poison left: the next test checks a narrower scope survives a poisoned session too.
    expect(r.rows[0]).toEqual({ timeout: "5s", lock_timeout: "1s", search_path: `${A.live}, ${A.parent}`, read_only: "on", work_mem: "16MB", locations: "all", org: "", locks: 0, jobs: 1 });
    const narrow = await ask.query("select current_setting('rms.locations', true) as locations, (select count(*)::int from sec_visit) as visits", 10, [ids("a").loc1]);
    expect(narrow.rows[0]).toEqual({ locations: ids("a").loc1, visits: 1 });
  });

  it("a query that lifts its own limits and takes a lock leaves nothing for the next one", async () => {
    await ask.query("select set_config('statement_timeout', '0', false), set_config('search_path', 'pg_catalog', false), set_config('rms.locations', 'all', false), pg_advisory_lock(99)").catch(() => {});
    const r = await ask.query("select current_setting('statement_timeout') as timeout, current_setting('rms.locations', true) as locations, (select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()) as locks, (select count(*)::int from sec_note) as notes");
    expect(r.rows[0]).toEqual({ timeout: "5s", locations: "all", locks: 0, notes: 1 });
    await forgetAsk("a");
    ask = await askAs("a");
  });

  it("even after the login removes its own role defaults, a wrapped query is read-only and time-limited", async () => {
    // Outside the envelope a login may change its own defaults (Postgres allows that to any role). The envelope must not depend on them.
    try {
      await ask.sql.unsafe("begin read write; alter role current_user set default_transaction_read_only = off; alter role current_user set statement_timeout = 0; alter role current_user reset search_path; commit");
      await forgetAsk("a");
      const [cfg] = await platform().unsafe(`select rolconfig from pg_roles where rolname = '${roles("a").ask}'`);
      expect(JSON.stringify((cfg as Row).rolconfig)).toContain("statement_timeout=0"); // the defaults really changed
    } finally {
      // Minting sets the defaults again. This also restores the role for the rest of the file.
      await forgetAsk("a");
      ask = await askAs("a");
    }
    const [cfg] = await platform().unsafe(`select rolconfig from pg_roles where rolname = '${roles("a").ask}'`);
    expect((cfg as Row).rolconfig).toEqual(["default_transaction_read_only=on", "statement_timeout=5s", "idle_in_transaction_session_timeout=10s", `search_path=${A.live}, ${A.parent}`]);
    expect(await outcome(ask.envelope(`delete from ${A.live}.sec_note`))).toBe(READ_ONLY);
  });
});

describe("the Ask envelope sets the caller's locations", () => {
  const a = ids("a");

  it("by default the owner's question sees every location's rows", async () => {
    expect((await ask.query("select body from sec_visit order by body")).rows).toHaveLength(2);
  });

  it("a caller given one location sees only that location's rows", async () => {
    expect((await ask.query("select body from sec_visit", 10, [a.loc1])).rows).toEqual([{ body: `visit loc1 ${CANARY.a} live` }]);
    expect((await ask.query("select body from sec_visit", 10, [a.loc1, a.loc2])).rows).toHaveLength(2);
  });

  it("no locations, or another restaurant's location, means no rows", async () => {
    expect((await ask.query("select body from sec_visit", 10, [])).rows).toHaveLength(0);
    expect((await ask.query("select body from sec_visit", 10, [ids("b").loc1])).rows).toHaveLength(0);
  });

  it.each([
    ["the word all inside a list", ["all"]],
    ["a wildcard", ["*"]],
    ["a list hidden in one value", [`${a.loc1},${a.loc2}`]],
    ["SQL", ["' or '1'='1"]],
    ["an empty value", [""]],
    ["a public id instead of a uuid", [`loc_${a.loc1.replaceAll("-", "")}`]],
  ])("refuses %s as a location before anything reaches the database", async (_what, locations) => {
    await expect(ask.query("select body from sec_visit", 10, locations)).rejects.toThrow();
    // And the refusal left the connection usable and unscoped by the bad value.
    expect((await ask.query("select current_setting('rms.locations', true) as l")).rows[0]?.l).toBe("all");
  });
});

describe("limits hold", () => {
  it("the row cap cannot be raised by the caller", async () => {
    const r = await ask.query("select generate_series(1, 100000) as n", 1_000_000);
    expect(r.rows).toHaveLength(ASK_QUERY_LIMITS.maxRows);
    expect(r.truncated).toBe(true);
    expect((await ask.query("select generate_series(1, 10) as n", -5)).rows).toHaveLength(1);
    expect((await ask.query("select generate_series(1, 100000) as n", Number.POSITIVE_INFINITY)).rows).toHaveLength(ASK_QUERY_LIMITS.maxRows);
    // Not a number: the query fails, it does not run uncapped.
    const rows = await ask.query("select generate_series(1, 100000) as n", Number.NaN).then((r) => r.rows.length, () => 0);
    expect(rows).toBeLessThanOrEqual(ASK_QUERY_LIMITS.maxRows);
  });

  it.each([
    ["an endless recursive query", "with recursive r(n) as (select 1 union all select n + 1 from r) select count(*) from r"],
    ["a huge cross join", "select count(*) from generate_series(1, 100000) a, generate_series(1, 100000) b"],
    ["a sleep that lifts its own limit first", "select set_config('statement_timeout', '0', true), pg_sleep(30)"],
    ["a sleep after resetting the limit", "select set_config('statement_timeout', '0', false), set_config('lock_timeout', '0', false), pg_sleep(30)"],
  ])("stops %s at the time limit", async (_what, text) => {
    const started = Date.now();
    expect(await outcome(ask.query(text))).toBe(TIMEOUT);
    expect(Date.now() - started).toBeLessThan(ASK_QUERY_LIMITS.timeoutMs + 3000);
  });

  it("a restaurant's Ask login gets five connections and no more", async () => {
    await forgetAsk("b");
    const login = await mintAskLogin(adminDb(), ORG.b.uuid);
    const conns: Sql[] = [];
    try {
      // Seven connections asked for at once, each busy for a moment. The database lets five in.
      // (The client quietly retries the two that are refused, so count what the database holds, not what the client reports.)
      for (let i = 0; i < 7; i++) conns.push(openAsk(login));
      const all = Promise.all(conns.map((c) => outcome(c`select pg_sleep(2)`)));
      await new Promise((r) => setTimeout(r, 1200));
      const [open] = await platform().unsafe(`select count(*)::int as n from pg_stat_activity where usename = '${roles("b").ask}'`);
      expect((open as Row).n).toBe(5);
      void all;
    } finally {
      await Promise.all(conns.map((c) => c.end({ timeout: 0 })));
      askB = await askAs("b");
    }
  });
});

describe("ask_cannot_extend_validity: the login is short-lived and cannot change that", () => {
  it("the login stops being accepted within 15 minutes of being made", async () => {
    const [row] = await platform().unsafe(`select extract(epoch from (rolvaliduntil - now()))::int as seconds_left, rolconnlimit from pg_roles where rolname = '${roles("a").ask}'`);
    expect((row as Row).seconds_left).toBeGreaterThan(0);
    expect((row as Row).seconds_left).toBeLessThanOrEqual(15 * 60);
    expect((row as Row).rolconnlimit).toBe(5);
  });

  it.each([
    ["extend its own life", "alter role current_user valid until 'infinity'"],
    ["extend its own life by name", `alter role ${roles("a").ask} valid until '2099-01-01'`],
    ["raise its own connection limit", "alter role current_user connection limit 1000"],
    ["give itself an attribute", "alter role current_user createrole"],
    ["give itself row-security bypass", "alter role current_user bypassrls"],
    ["rename another restaurant's Ask login", `alter role ${roles("b").ask} rename to x_sec_probe`],
    ["join another restaurant's role", `grant ${roles("b").rw} to current_user`],
    ["join the server login", "grant rms_api to current_user"],
    ["create a role", "create role x_sec_probe"],
    ["change another restaurant's Ask login", `alter role ${roles("b").ask} password 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x'`],
    ["drop another restaurant's Ask login", `drop role ${roles("b").ask}`],
  ])("cannot %s (42501), even in a transaction that may write", async (_what, sql) => {
    expect(await outcome(ask.readWrite(sql))).toBe(DENIED);
  });
});

describe("who can log in as an Ask role", () => {
  let login: { role: string; password: string };
  beforeAll(async () => {
    await forgetAsk("a");
    login = await mintAskLogin(adminDb(), ORG.a.uuid);
  });
  afterAll(async () => {
    ask = await askAs("a");
  });

  const tryLogin = async (role: string, password: string): Promise<string> => {
    const sql = openAsk({ role, password });
    try {
      return await outcome(sql`select 1`);
    } finally {
      await sql.end({ timeout: 1 });
    }
  };
  const REFUSED = ["28P01", "28000"]; // wrong password, or the role may not log in at all

  it("control: the freshly made login works", async () => {
    expect(await tryLogin(login.role, login.password)).toBe("allowed");
  });

  it("A's password does not open B's Ask role, or any other login", async () => {
    for (const role of [roles("b").ask, roles("c").ask, "rms_api", "rms_admin", "postgres"]) expect(REFUSED, role).toContain(await tryLogin(role, login.password));
  });

  it("the Data API roles cannot be logged into at all", async () => {
    for (const role of [roles("a").rw, roles("a").draftRw]) expect(REFUSED, role).toContain(await tryLogin(role, login.password));
  });

  it("making a new login ends the old password", async () => {
    const fresh = await mintAskLogin(adminDb(), ORG.a.uuid);
    expect(REFUSED).toContain(await tryLogin(login.role, login.password));
    expect(await tryLogin(fresh.role, fresh.password)).toBe("allowed");
  });

  it("no login is made for a suspended restaurant or one with no store", async () => {
    await expect(mintAskLogin(adminDb(), ORG.c.uuid)).rejects.toThrow(/Store is not ready/);
    await expect(mintAskLogin(adminDb(), ORG.d.uuid)).rejects.toThrow(/Store is not ready/);
    await expect(mintAskLogin(adminDb(), "0193a3c0-9191-7fff-8fff-ffffffffffff")).rejects.toThrow(/Store is not ready/);
    const [c] = await platform().unsafe(`select rolcanlogin from pg_roles where rolname = '${roles("c").ask}'`);
    expect((c as Row).rolcanlogin).toBe(false);
  });

  it("only a password verifier is ever sent to the database, never a password", async () => {
    await expect(adminDb()`select platform.set_ask_login(${ORG.a.uuid}, ${"plain-password-plain-password-plain-pass"})`).rejects.toThrow(/SCRAM/);
    await expect(adminDb()`select platform.set_ask_login(${ORG.a.uuid}, ${"md5" + "0".repeat(32)})`).rejects.toThrow(/SCRAM/);
  });
});
