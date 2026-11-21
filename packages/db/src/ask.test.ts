import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, adminDb, asMigrator, asParentSync, askQuery, closeAll, ident, inAskEnvelope, mintAskLogin, openAsk, provisionStore, scramVerifier } from "./index.js";
import { loadTestEnv } from "./testing.js";

loadTestEnv();
const hasDb = Boolean(process.env.DATABASE_ADMIN_URL && process.env.ASK_DATABASE_HOST);

const A = "0193a3c0-0000-7000-8000-0000000000d3";
const B = "0193a3c0-0000-7000-8000-0000000000d4";
const PA = "o_dddddddddd03";
const PB = "o_dddddddddd04";
const code = (c: string) => expect.objectContaining({ code: c });

const cleanup = async () => {
  const sql = adminDb();
  for (const id of [A, B]) {
    await sql`select platform.drop_store(${id})`.catch(() => {});
    await sql`delete from platform.organizations where id = ${id}`;
  }
};

describe.skipIf(!hasDb)("the Ask login and its envelope", () => {
  let ask: Sql;

  beforeAll(async () => {
    await cleanup();
    const sql = adminDb();
    await sql`insert into platform.organizations (id, slug, name, store_prefix) values (${A}, 'asktest-a', 'Ask Test A', ${PA}), (${B}, 'asktest-b', 'Ask Test B', ${PB})`;
    await provisionStore(sql, A);
    await provisionStore(sql, B);
    await asParentSync(sql, async (tx) => {
      await tx.unsafe(`insert into ${ident(`${PA}_parent`)}.jobs (id, name, house) values (gen_random_uuid(), 'Server', 'front'), (gen_random_uuid(), 'Host', 'front')`);
      await tx.unsafe(`insert into ${ident(`${PB}_parent`)}.jobs (id, name, house) values (gen_random_uuid(), 'CANARY-B-SECRET', 'back')`);
    });
    for (const p of [PA, PB]) {
      await asMigrator(sql, async (tx) => {
        await tx.unsafe(`create table ${ident(p)}.notes (id uuid primary key default gen_random_uuid(), body text)`);
        await tx.unsafe(`grant select on ${ident(p)}.notes to ${ident(`${p}_ask`)}`);
        await tx.unsafe(`grant select, insert, update, delete on ${ident(p)}.notes to ${ident(`${p}_rw`)}`);
        await tx.unsafe(`insert into ${ident(p)}.notes (body) values ('note for ${p}')`);
      });
    }
    ask = openAsk(await mintAskLogin(sql, A));
  });

  afterAll(async () => {
    await ask?.end({ timeout: 2 });
    await cleanup();
    await closeAll();
  });

  it("answers a plain question about its own restaurant", async () => {
    const r = await askQuery(ask, "select name from jobs order by name");
    expect(r.rows.map((x) => x.name)).toEqual(["Host", "Server"]);
    expect(r.columns).toEqual(["name"]);
    expect((await askQuery(ask, "select body from notes")).rows[0]?.body).toBe(`note for ${PA}`);
  });

  it("caps the rows", async () => {
    const r = await askQuery(ask, "select generate_series(1, 5000) as n", 10);
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it("cannot read another restaurant, the platform or sign-in data", async () => {
    await expect(askQuery(ask, `select * from ${PB}_parent.jobs`)).rejects.toEqual(code("42501"));
    await expect(askQuery(ask, `select * from ${PB}.notes`)).rejects.toEqual(code("42501"));
    await expect(askQuery(ask, "select * from platform.organizations")).rejects.toEqual(code("42501"));
    await expect(askQuery(ask, "select * from platform.secrets")).rejects.toEqual(code("42501"));
    await expect(askQuery(ask, "select * from auth.users")).rejects.toEqual(code("42501"));
  });

  it("refuses a second statement, a write and a setting change hidden in the text", async () => {
    await expect(askQuery(ask, "select 1) as x; drop table notes; select * from (select 1")).rejects.toEqual(code("42601"));
    await expect(askQuery(ask, "select 1; select 2")).rejects.toEqual(code("42601"));
    await expect(askQuery(ask, "insert into notes (body) values ('x') returning *")).rejects.toThrow();
    await expect(askQuery(ask, "with w as (insert into notes (body) values ('x') returning *) select * from w")).rejects.toThrow();
    await expect(askQuery(ask, "set statement_timeout = 0")).rejects.toEqual(code("42601"));
    await expect(askQuery(ask, "select 1 --")).resolves.toBeDefined();
    await expect(askQuery(ask, "select 1 /* never closed")).rejects.toThrow();
  });

  it("stops a slow query at the time limit, even if the query tries to lift it", async () => {
    const started = Date.now();
    await expect(askQuery(ask, "select set_config('statement_timeout', '0', false), pg_sleep(20)")).rejects.toEqual(code("57014"));
    expect(Date.now() - started).toBeLessThan(9000);
  }, 15000);

  it("starts every query clean, whatever an earlier one left behind", async () => {
    await askQuery(ask, "select set_config('statement_timeout', '0', false), set_config('search_path', 'pg_catalog', false), pg_advisory_lock(99)").catch(() => {});
    const r = await askQuery(ask, "select current_setting('statement_timeout') as t, (select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()) as locks, (select count(*) from jobs) as jobs");
    expect(r.rows[0]?.t).toBe("5s");
    expect(Number(r.rows[0]?.locks)).toBe(0);
    expect(Number(r.rows[0]?.jobs)).toBe(2);
  });

  it("inside the envelope the database itself refuses anything that is not a read", async () => {
    const refused = (sqlText: string) => expect(inAskEnvelope(ask, (tx) => tx.unsafe(sqlText))).rejects.toEqual(code("25006"));
    await refused("create extension if not exists http with schema extensions");
    await refused('drop extension if exists "uuid-ossp"');
    await refused("alter role current_user password 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x'");
    await refused("alter role current_user set default_transaction_read_only = off");
    await refused("create temp table t (id int)");
    await refused("select lo_from_bytea(0, 'x')");
    await refused("insert into notes (body) values ('x')");
    await expect(inAskEnvelope(ask, (tx) => tx.unsafe("set transaction read write"))).rejects.toEqual(code("25001"));
    await expect(inAskEnvelope(ask, (tx) => tx.unsafe("do $$ begin set transaction read write; end $$"))).rejects.toThrow();
  });

  it("cannot become any other role or lengthen its own life", async () => {
    for (const role of [`${PA}_rw`, `${PB}_ask`, "rms_api", "rms_admin", "rms_tenant_migrator", "postgres"]) {
      await expect(inAskEnvelope(ask, (tx) => tx.unsafe(`set local role ${ident(role)}`))).rejects.toEqual(code("42501"));
    }
    await expect(ask.unsafe("begin read write; alter role current_user valid until 'infinity'")).rejects.toThrow();
    await ask.unsafe("rollback").catch(() => {});
  });

  it("has no temp-table right even outside the envelope", async () => {
    await expect(ask.unsafe("begin read write; create temp table t (id int)")).rejects.toEqual(code("42501"));
    await ask.unsafe("rollback").catch(() => {});
  });

  it("a restaurant with no minted login cannot be logged into", async () => {
    const none = openAsk({ role: `${PB}_ask`, password: "wrong-wrong-wrong-wrong-wrong-wrong" });
    await expect(none`select 1`).rejects.toThrow();
    await none.end({ timeout: 1 });
  });

  it("only accepts a SCRAM verifier, never a clear password", async () => {
    await expect(adminDb()`select platform.set_ask_login(${A}, ${"plain-password-plain-password-plain-pass"})`).rejects.toThrow(/SCRAM/);
    expect(scramVerifier("x")).toMatch(/^SCRAM-SHA-256\$4096:/);
  });
});
