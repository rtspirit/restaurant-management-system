// KNOWN LIMITS: things that are open today, on purpose, and written down in the ADRs.
//
// Each test here DOCUMENTS today's behaviour: it asserts that the weak spot is still there.
// The day one is fixed, its test fails. That is the signal to delete the test, add the opposite
// test to the real suite, and update the ADR. Do not "fix" a failing test here by loosening it.
//
// Nothing in this file may leave a change behind: every attack runs in a transaction that is rolled back.
import { beforeAll, describe, expect, it } from "vitest";
import { apiDb } from "@rms/db";
import { type AskHandle, type Row, askAs, holds, orgSql, outcome, rolledBack, storeSql } from "../helpers/actors.js";
import { CANARY, ORG, roles, schemas } from "../helpers/world.js";

const A = schemas("a");
const B = schemas("b");
let ask: AskHandle;

beforeAll(async () => {
  ask = await askAs("a");
});

/**
 * Raw statements on the restaurant-facing server login, as hostile SQL running inside A's store would issue them.
 * NOT swept for canaries: these tests expect to see B's data, and say so.
 */
const hostileInsideStoreOfA = (statements: string[]): Promise<Row[]> =>
  rolledBack<Row[]>((keep) =>
    apiDb().begin(async (tx) => {
      await tx.unsafe(`set local role ${roles("a").rw}`);
      let last: Row[] = [];
      for (const s of statements) last = (await tx.unsafe(s)) as Row[];
      return keep(last);
    }),
  );

describe("KNOWN LIMIT (ADR 0003, ADR 0004): the shared server login", () => {
  it("KNOWN LIMIT: SQL running as A's write role can switch to B's write role and read B's rows", async () => {
    const rows = await hostileInsideStoreOfA([`set local role ${roles("b").rw}`, `select body from ${B.live}.sec_note`]);
    // Today this works, and B's canary comes back. The wall is that the Data API never runs caller-written SQL.
    expect(holds(rows, CANARY.b)).toBe(true);
  });

  it("KNOWN LIMIT: it can also write B's rows and read B's parent data", async () => {
    const written = await hostileInsideStoreOfA([`set local role ${roles("b").rw}`, `update ${B.live}.sec_note set body = 'changed by A' returning id`]);
    expect(written).toHaveLength(1);
    const parent = await hostileInsideStoreOfA([`set local role ${roles("b").rw}`, `select hourly_rate_minor, email from ${B.parent}.staff`]);
    expect(holds(parent, CANARY.b)).toBe(true);
  });

  it("KNOWN LIMIT: it can drop back to the server login, name any restaurant and read that restaurant's platform rows", async () => {
    const rows = await hostileInsideStoreOfA(["reset role", `select set_config('rms.org', '${ORG.b.uuid}', true)`, "select name from platform.organizations"]);
    expect(rows.map((r) => r.name)).toEqual([ORG.b.name]);
    const memory = await hostileInsideStoreOfA(["reset role", `select set_config('rms.org', '${ORG.b.uuid}', true)`, "select text from platform.org_memory"]);
    expect(holds(memory, CANARY.b)).toBe(true);
  });

  it("the rest of the suite is why this limit is tolerable: the same statements are refused where the caller cannot issue raw SQL", async () => {
    // Not a limit: the opposite check, kept next to it. Through the one entry point (withStore), A's role reads none of B.
    expect(await outcome(storeSql("a", `select body from ${B.live}.sec_note`))).toBe("42501");
  });
});

describe("KNOWN LIMIT (ADR 0004): extensions and large objects outside the Ask envelope", () => {
  it("KNOWN LIMIT: the server login can install an extension that makes web requests from inside the database", async () => {
    expect(await outcome(orgSql("a", "create extension if not exists http with schema extensions"))).toBe("allowed");
  });

  it("KNOWN LIMIT: so can a restaurant's Data API role", async () => {
    expect(await outcome(storeSql("a", "create extension if not exists http with schema extensions"))).toBe("allowed");
  });

  it("KNOWN LIMIT: so can the Ask login, when it is not inside the envelope", async () => {
    expect(await outcome(ask.readWrite("create extension if not exists http with schema extensions"))).toBe("allowed");
  });

  it("the wall that does hold: inside the envelope the same statement is refused", async () => {
    expect(await outcome(ask.envelope("create extension if not exists http with schema extensions"))).toBe("25006");
  });
});

describe("KNOWN LIMIT (ADR 0004): the Ask login outside the envelope can change itself", () => {
  it("KNOWN LIMIT: it can change its own password and its own defaults (so the envelope, not the role settings, is the wall)", async () => {
    expect(await outcome(ask.readWrite("alter role current_user password 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x'"))).toBe("allowed");
    expect(await outcome(ask.readWrite("alter role current_user set statement_timeout = 0"))).toBe("allowed");
    expect(await outcome(ask.readWrite("alter role current_user set default_transaction_read_only = off"))).toBe("allowed");
  });
});

describe("KNOWN LIMIT (ADR 0004): catalog leaks", () => {
  it("KNOWN LIMIT: a restaurant's Ask login can list other restaurants' schemas and roles", async () => {
    const schemasSeen = (await ask.query("select nspname from pg_namespace where nspname ~ '^o_[0-9a-f]{12}'", 500)).rows.map((r) => r.nspname);
    expect(schemasSeen).toEqual(expect.arrayContaining([B.live, B.parent, B.draft]));
    const rolesSeen = (await ask.query("select rolname from pg_roles where rolname ~ '^o_[0-9a-f]{12}'", 500)).rows.map((r) => r.rolname);
    expect(rolesSeen).toEqual(expect.arrayContaining(Object.values(roles("b"))));
  });

  it("KNOWN LIMIT: it can read B's table names and column names", async () => {
    const tables = (await ask.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '${B.live}' and c.relkind = 'r'`)).rows.map((r) => r.relname);
    expect(tables.sort()).toEqual(["sec_ledger", "sec_note", "sec_visit"]);
    const columns = (await ask.query(`select a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = '${B.live}' and c.relname = 'sec_visit' and a.attnum > 0`)).rows.map((r) => r.attname);
    expect(columns).toEqual(expect.arrayContaining(["body", "wage", "location_id"]));
  });

  it("KNOWN LIMIT: it can read B's rough row counts and table sizes", async () => {
    const rows = (await ask.query(`select c.relname, c.reltuples::int as rows, pg_total_relation_size(c.oid) as bytes from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '${B.live}' and c.relkind = 'r' order by 1`)).rows;
    expect(rows.map((r) => [r.relname, r.rows])).toEqual([["sec_ledger", 2], ["sec_note", 1], ["sec_visit", 2]]);
    for (const r of rows) expect(Number(r.bytes)).toBeGreaterThan(0);
  });

  it("KNOWN LIMIT: it can see when B last started an Ask session (the login's end time) and that B's logins exist", async () => {
    await askAs("b");
    const [row] = (await ask.query(`select rolvaliduntil is not null as has_end, rolcanlogin from pg_roles where rolname = '${roles("b").ask}'`)).rows;
    expect(row).toEqual({ has_end: true, rolcanlogin: true });
  });

  it("KNOWN LIMIT: it can read the platform's table names, policies and function source", async () => {
    const tables = (await ask.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'platform' and c.relkind = 'r'", 500)).rows.map((r) => r.relname);
    expect(tables).toEqual(expect.arrayContaining(["organizations", "secrets", "org_memory"]));
    const source = (await ask.query("select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'platform' and p.proname = 'set_ask_login'")).rows;
    expect(String(source[0]?.prosrc)).toContain("valid until");
    const policies = (await ask.query("select policyname from pg_policies where schemaname = 'platform'", 500)).rows;
    expect(policies.length).toBeGreaterThan(40);
  });

  it("what the catalogs do NOT give away: no row of B's data", async () => {
    // Not a limit: the opposite check. The catalog queries above were swept for B's canary by the helper, and none appeared.
    const everything = await ask.query(`select c.relname, a.attname, pg_get_expr(d.adbin, d.adrelid) as default_value, obj_description(c.oid) as comment
      from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
      where n.nspname like '${B.live}%' and a.attnum > 0`, 500);
    expect(everything.rows.length).toBeGreaterThan(20);
    expect(holds(everything, CANARY.b)).toBe(false);
  });
});

describe("KNOWN LIMIT (ADR 0002): the Ask login is all-or-nothing inside its own restaurant", () => {
  it("KNOWN LIMIT: it reads payroll-tagged columns (so Ask must stay owner-only)", async () => {
    const staff = await ask.query("select hourly_rate_minor, email, phone from staff");
    expect(staff.rows[0]?.hourly_rate_minor).toBe("1875");
  });

  it("KNOWN LIMIT: a location-scoped table shows the Ask login nothing by default, and everything once the query sets the location setting itself", async () => {
    // By default: zero rows. (Worth knowing for the Ask tool: questions about location-scoped data come back empty.)
    expect((await ask.query("select body, wage from sec_visit")).rows).toHaveLength(0);
    // One SELECT that sets the request setting first: every location's rows, payroll field included.
    const all = await ask.query("select v.body, v.wage from (select set_config('rms.locations', 'all', true) as x) s cross join lateral (select body, wage from sec_visit where s.x is not null) v");
    expect(all.rows).toHaveLength(2);
    // So location scope is not a wall for model-written SQL. It holds only where the server builds the SQL.
  });
});

describe("KNOWN LIMIT (ADR 0004): the tier of a change is not re-derived by the database", () => {
  it("KNOWN LIMIT: a change that carries the public-share signal can be recorded as the lowest tier, already applied", async () => {
    const sql = `insert into platform.change_sets (id, org_id, origin, actor, signals, tier, summary, decision) values (gen_random_uuid(), '${ORG.a.uuid}', 'share', 'user:x', '{public_share}', 'T0', 's', 'applied') returning id`;
    expect(await orgSql("a", sql)).toHaveLength(1);
  });
});

// One more known limit lives with the token tests: a captured token can be replayed until it expires
// (tests/security/tokens/data-token.test.ts).
