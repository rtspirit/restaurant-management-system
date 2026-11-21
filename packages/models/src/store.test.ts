// Against the real local database (Postgres 17). Three test restaurants in task C's id range.
// Everything the fixture pack compiles to is applied for real, in live and in draft.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ModelDefinition, SYSTEM_COLUMNS, type TenantContext, columnsForField, toPublicId } from "@rms/contracts";
import { type Tx, adminDb, apiDb, closeAll, newStorePrefix, newUuid, provisionStore, withOrg, withStore } from "@rms/db";
import { fixtureModel, fixtureModels } from "./compiler/__fixtures__/pack.js";
import { compileModel, objectName, ruleConstraintName, targetsFor } from "./compiler/index.js";
import { buildLibrary, installLibrary } from "./library.js";
import { STORE_LIMITS, applyChange, discardPendingChange, effectiveDefinition, ensureModels, publishModelChanges } from "./store.js";

// The worktree has no .env.local. Walk up to the main checkout's file. Its values are never printed.
const findEnv = (): string | undefined => {
  let dir = import.meta.dirname;
  for (let i = 0; i < 12; i++) {
    const file = resolve(dir, ".env.local");
    if (existsSync(file)) return file;
    dir = dirname(dir);
  }
  return undefined;
};
const envFile = findEnv();
if (envFile) process.loadEnvFile(envFile);
// These tests are the proof that the compiled SQL is safe on a real database. Without one they must fail, not skip.
if (!process.env.DATABASE_URL || !process.env.DATABASE_ADMIN_URL) {
  throw new Error("The model store tests need the local database: DATABASE_URL and DATABASE_ADMIN_URL are not set (no .env.local found)");
}

// Fresh ids, store prefixes and platform template keys on every run, so parallel runs on the
// shared local database never create, use or drop each other's rows. newUuid is time-ordered, so A < B < C.
const RUN = newStorePrefix().slice(2);
const A = newUuid();
const B = newUuid();
const C = newUuid();
const PA = newStorePrefix();
const PB = newStorePrefix();
const PC = newStorePrefix();
const L1 = newUuid();
const L2 = newUuid();
const USER_UUID = newUuid();
const USER = toPublicId("usr", USER_UUID);
const ORGS = [
  { id: A, prefix: PA, slug: `c-test-a-${RUN}` },
  { id: B, prefix: PB, slug: `c-test-b-${RUN}` },
  { id: C, prefix: PC, slug: `c-test-c-${RUN}` },
];
const T = `c1t${RUN}`;
const ITEM = `${T}_item`;
const NOTE = `${T}_note`;
const REPORT = `${T}_report`;
const TOUCH = `${T}_touch`;
const TEST_TEMPLATES = [ITEM, NOTE];

const library = { models: fixtureModels };
const allKeys = fixtureModels.map((m) => m.key);

const ctx = (org: string, prefix: string, env: "live" | "draft" = "live", locations: "all" | string[] = "all"): TenantContext => ({
  orgId: toPublicId("org", org),
  storePrefix: prefix,
  actor: { type: "user", id: USER },
  role: "owner",
  locations: locations === "all" ? "all" : locations.map((l) => toPublicId("loc", l)),
  env,
});

/** Runs raw SQL as a restaurant's Data API role, the way the Data API will. `$T` is the store's schema. */
const asStore = <T>(c: TenantContext, fn: (q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>, tx: Tx) => Promise<T>): Promise<T> =>
  withStore(apiDb(), c, (tx, store) => fn(async (text, params = []) => [...(await tx.unsafe(text.replaceAll("$T", store.schema), params as never[]))], tx));

const one = (c: TenantContext, text: string, params: unknown[] = []) => asStore(c, (q) => q(text, params));

const SYS = `id, source, created_by, updated_by`;
const sys = (n = 1) => `$${n}, 'manual', 'user:test', 'user:test'`;

const cleanup = async () => {
  const sql = adminDb();
  for (const o of ORGS) {
    await sql`select platform.drop_store(${o.id})`.catch(() => {});
    await sql`delete from platform.org_model_changes where org_id = ${o.id}`;
    await sql`delete from platform.org_models where org_id = ${o.id}`;
    await sql`delete from platform.organizations where id = ${o.id}`;
  }
  await sql`delete from platform.named_queries where key = ${REPORT}`;
  await sql`delete from platform.named_actions where key = ${TOUCH}`;
  await sql`delete from platform.model_template_versions where template_key in ${sql(TEST_TEMPLATES)}`;
  await sql`delete from platform.model_templates where key in ${sql(TEST_TEMPLATES)}`;
};

const catalogType = (t: string) => (t === "timestamptz" ? "timestamp with time zone" : t === "char(3)" ? "character(3)" : t);

/** What the storage contract says the table must look like, worked out here without the compiler. */
const expectedColumns = (def: ModelDefinition) => {
  const money = def.fields.some((f) => f.type === "money");
  const soft = def.softDelete && !def.appendOnly;
  const system = SYSTEM_COLUMNS.filter(
    (c) => c.when === "always" || (c.when === "locationScoped" && def.locationScoped) || (c.when === "hasMoney" && money) || (c.when === "softDelete" && soft),
  );
  return [...system, ...def.fields.flatMap(columnsForField)].map((c) => ({ name: c.name, type: catalogType(c.sqlType), notnull: !c.nullable }));
};

describe("model tables in a restaurant's store", () => {
  let first: Awaited<ReturnType<typeof ensureModels>>;

  beforeAll(async () => {
    await cleanup();
    const sql = adminDb();
    for (const o of ORGS) {
      await sql`insert into platform.organizations (id, slug, name, store_prefix) values (${o.id}, ${o.slug}, ${o.slug}, ${o.prefix})`;
      expect(await provisionStore(sql, o.id)).toBe(o.prefix);
    }
    first = await ensureModels(sql, A, allKeys, { library });
    await ensureModels(sql, B, allKeys, { library });
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  // ---------------------------------------------------------------- structure

  it("creates every fixture table in live and draft with the contract's columns", async () => {
    expect([...first.created].sort()).toEqual([...allKeys].sort());
    const sql = adminDb();
    for (const schema of [PA, `${PA}_draft`]) {
      for (const def of fixtureModels) {
        const cols = await sql<{ name: string; type: string; notnull: boolean }[]>`
          select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull
          from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = ${schema} and c.relname = ${def.key} and a.attnum > 0 and not a.attisdropped order by a.attnum`;
        expect(cols.map((c) => ({ ...c })), `${schema}.${def.key}`).toEqual(expectedColumns(def));
      }
    }
  });

  it("runs every statement the compiler emits for the fixture pack, in both schemas", async () => {
    const t = targetsFor(PA);
    const expected = fixtureModels.flatMap((m) => compileModel(m, t.draft, library).statements.length + compileModel(m, t.live, library).statements.length).reduce((a, b) => a + b, 0);
    const rows = await adminDb()<{ key: string; compiled_sql: string; draft: boolean; live: boolean }[]>`
      select m.key, c.compiled_sql, c.applied_draft_at is not null as draft, c.applied_live_at is not null as live
      from platform.org_model_changes c join platform.org_models m on m.id = c.org_model_id where c.org_id = ${A}`;
    expect(rows).toHaveLength(fixtureModels.length);
    let recorded = 0;
    for (const r of rows) {
      expect(r.draft && r.live).toBe(true);
      expect(r.compiled_sql).toContain(`-- ${PA}_draft\n`);
      expect(r.compiled_sql).toContain(`-- ${PA}\n`);
      const def = fixtureModel(r.key);
      const both = [...compileModel(def, t.draft, library).statements, ...compileModel(def, t.live, library).statements];
      for (const s of both) expect(r.compiled_sql).toContain(`${s};`);
      recorded += both.length;
    }
    expect(recorded).toBe(expected);
  });

  it("records each model as live with its definition", async () => {
    const rows = await adminDb()<{ key: string; kind: string; status: string; template_key: string | null; template_version: number; definition: ModelDefinition }[]>`
      select key, kind, status, template_key, template_version, definition from platform.org_models where org_id = ${A}`;
    expect(rows.map((r) => r.key).sort()).toEqual([...allKeys].sort());
    for (const r of rows) {
      expect(r.status).toBe("live");
      expect(r.kind).toBe("standard");
      expect(r.template_version).toBe(1);
      expect(r.definition).toEqual(fixtureModel(r.key));
    }
  });

  it("is a no-op the second time", async () => {
    const sql = adminDb();
    const count = async () => (await sql`select (select count(*) from platform.org_models where org_id = ${A})::int as m, (select count(*) from platform.org_model_changes where org_id = ${A})::int as c, (select max(created_at) from platform.org_model_changes where org_id = ${A}) as at`)[0];
    const before = await count();
    const again = await ensureModels(sql, A, allKeys, { library });
    expect(again).toEqual({ created: [], madeLive: [], unchanged: allKeys });
    expect(await count()).toEqual(before);
  });

  it("tables are owned by the migrator, with row-level security on and not forced", async () => {
    const rows = await adminDb()<{ schema: string; name: string; owner: string; rls: boolean; forced: boolean }[]>`
      select n.nspname as schema, c.relname as name, r.rolname as owner, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner
      where n.nspname in ${adminDb()([PA, `${PA}_draft`])} and c.relkind = 'r'`;
    expect(rows).toHaveLength(fixtureModels.length * 2);
    for (const r of rows) expect({ ...r }).toEqual({ schema: r.schema, name: r.name, owner: "rms_tenant_migrator", rls: true, forced: false });
    const roles = await adminDb()<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolname, rolbypassrls, rolsuper from pg_roles where rolname in ${adminDb()([`${PA}_rw`, `${PA}_draft_rw`, `${PA}_ask`])}`;
    expect(roles).toHaveLength(3);
    for (const r of roles) expect(r.rolbypassrls || r.rolsuper).toBe(false);
  });

  it("grants exactly what the contract says, and nothing to anyone else", async () => {
    const sql = adminDb();
    const grants = async (schema: string) => {
      const rows = await sql<{ name: string; grantee: string; privilege: string }[]>`
        select c.relname as name, coalesce(r.rolname, 'PUBLIC') as grantee, a.privilege_type as privilege
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join lateral aclexplode(c.relacl) a left join pg_roles r on r.oid = a.grantee
        where n.nspname = ${schema} and c.relkind = 'r' and a.grantee <> c.relowner`;
      const out: Record<string, string[]> = {};
      for (const r of rows) (out[`${r.name} ${r.grantee}`] ??= []).push(r.privilege);
      for (const k of Object.keys(out)) out[k]?.sort();
      return out;
    };
    const live: Record<string, string[]> = {};
    const draft: Record<string, string[]> = {};
    for (const m of fixtureModels) {
      const write = m.appendOnly ? ["INSERT", "SELECT"] : ["DELETE", "INSERT", "SELECT", "UPDATE"];
      live[`${m.key} ${PA}_rw`] = write;
      live[`${m.key} ${PA}_ask`] = ["SELECT"];
      draft[`${m.key} ${PA}_draft_rw`] = write;
    }
    expect(await grants(PA)).toEqual(live);
    expect(await grants(`${PA}_draft`)).toEqual(draft);
  });

  it("trigger functions: in the restaurant's schema, migrator-owned, empty search path, nobody else may call them", async () => {
    const sql = adminDb();
    const fns = await sql<{ schema: string; name: string; owner: string; definer: boolean; config: string[] | null; grantees: string[] }[]>`
      select n.nspname as schema, p.proname as name, r.rolname as owner, p.prosecdef as definer, p.proconfig::text[] as config,
             array(select coalesce(g.rolname, 'PUBLIC')::text from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   left join pg_roles g on g.oid = a.grantee where a.grantee <> p.proowner)::text[] as grantees
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
      where n.nspname in ${sql([PA, `${PA}_draft`])}`;
    expect(fns).toHaveLength(14);
    for (const f of fns) {
      expect(f.owner).toBe("rms_tenant_migrator");
      expect(f.config).toEqual(['search_path=""']);
      expect(f.grantees).toEqual([]);
      // Definer rights only where the check must see rows at every location.
      expect(f.definer, f.name).toBe([objectName("fn", "journal_entry", "entry_balances"), objectName("fnh", "journal_entry", "entry_balances"), objectName("fnr", "paid_out", "paid_from_an_expense")].includes(f.name));
    }
  });

  it("links: a foreign key for each ref, none for a parent link", async () => {
    const rows = await adminDb()<{ name: string; col: string; target: string; action: string }[]>`
      select c.relname as name, a.attname as col, t.relname as target, k.confdeltype as action
      from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_class t on t.oid = k.confrelid join pg_attribute a on a.attrelid = c.oid and a.attnum = k.conkey[1]
      where n.nspname = ${PA} and k.contype = 'f' order by 1, 2`;
    expect(rows.map((r) => `${r.name}.${r.col} -> ${r.target} ${r.action}`)).toEqual([
      "journal_entry.reverses -> journal_entry r",
      "journal_line.account -> account r",
      "journal_line.entry -> journal_entry r",
      "paid_out.account -> account r",
      "posting_rule.account -> account r",
      "prep_item.vendor -> vendor n",
    ]);
  });

  // ---------------------------------------------------------------- isolation

  it("a restaurant's role reads and writes its own live table, and cannot touch another restaurant's", async () => {
    const v = newUuid();
    await one(ctx(A, PA), `insert into $T.vendor (${SYS}, name) values (${sys()}, 'Harbour Produce')`, [v]);
    await one(ctx(A, PA), `update $T.vendor set name = 'Harbour Produce Co' where id = $1`, [v]);
    expect(await one(ctx(A, PA), `select name from $T.vendor where id = $1`, [v])).toEqual([{ name: "Harbour Produce Co" }]);
    expect(await one(ctx(B, PB), `select count(*)::int as n from $T.vendor`)).toEqual([{ n: 0 }]);

    for (const other of [PB, `${PB}_draft`]) {
      await expect(one(ctx(A, PA), `select * from "${other}".vendor`)).rejects.toThrow(/permission denied/);
      await expect(one(ctx(A, PA), `insert into "${other}".vendor (${SYS}, name) values (${sys()}, 'x')`, [newUuid()])).rejects.toThrow(/permission denied/);
      await expect(one(ctx(A, PA), `update "${other}".vendor set name = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(one(ctx(A, PA), `delete from "${other}".vendor`)).rejects.toThrow(/permission denied/);
    }
    await one(ctx(A, PA), `delete from $T.vendor where id = $1`, [v]);
  });

  it("the draft role works in draft and cannot touch live. The live role cannot touch draft", async () => {
    const v = newUuid();
    await one(ctx(A, PA, "draft"), `insert into $T.vendor (${SYS}, name) values (${sys()}, 'Sample Vendor')`, [v]);
    expect(await one(ctx(A, PA, "draft"), `select count(*)::int as n from $T.vendor`)).toEqual([{ n: 1 }]);
    expect(await one(ctx(A, PA), `select count(*)::int as n from $T.vendor where id = $1`, [v])).toEqual([{ n: 0 }]);
    for (const text of [`select * from "${PA}".vendor`, `insert into "${PA}".vendor (${SYS}, name) values (gen_random_uuid(), 'manual', 'u', 'u', 'x')`, `update "${PA}".vendor set name = 'x'`, `delete from "${PA}".vendor`]) {
      await expect(one(ctx(A, PA, "draft"), text)).rejects.toThrow(/permission denied/);
    }
    await expect(one(ctx(A, PA), `select * from "${PA}_draft".vendor`)).rejects.toThrow(/permission denied/);
    await one(ctx(A, PA, "draft"), `delete from $T.vendor where id = $1`, [v]);
  });

  it("no restaurant role can change a table, a rule or a policy", async () => {
    for (const env of ["live", "draft"] as const) {
      for (const text of [
        `alter table $T.journal_line disable trigger all`,
        `alter table $T.sales_day disable row level security`,
        `drop policy "${objectName("rls", "sales_day")}" on $T.sales_day`,
        `create policy p on $T.sales_day using (true)`,
        `alter table $T.vendor add column x int`,
        `drop table $T.vendor`,
        `create table $T.x (id int)`,
        `create function $T.f() returns int language sql as 'select 1'`,
        `truncate $T.vendor`,
      ]) {
        await expect(one(ctx(A, PA, env), text), text).rejects.toThrow(/permission denied|must be owner/);
      }
      // Postgres answers a grant by a role with nothing to give with a warning. It must grant nothing.
      await one(ctx(A, PA, env), `grant select on $T.vendor to public`).catch(() => undefined);
      await one(ctx(A, PA, env), `grant select on $T.vendor to "${PB}_rw"`).catch(() => undefined);
    }
    const leaked = await adminDb()`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
      where n.nspname in ${adminDb()([PA, `${PA}_draft`])} and c.relname = 'vendor'
        and a.grantee not in (select oid from pg_roles where rolname in ${adminDb()(["rms_tenant_migrator", `${PA}_rw`, `${PA}_ask`, `${PA}_draft_rw`])})`;
    expect(leaked).toHaveLength(0);
  });

  it("an append-only table refuses update, delete and truncate, in live and draft", async () => {
    for (const env of ["live", "draft"] as const) {
      const c = ctx(A, PA, env);
      const e = newUuid();
      const [debit, credit] = [newUuid(), newUuid()];
      await asStore(c, async (q) => {
        await q(`insert into $T.account (${SYS}, code, name, type) values (${sys(1)}, '9001', 'Test debit', 'asset'), ($2, 'manual', 'u', 'u', '9002', 'Test credit', 'revenue')`, [debit, credit]);
        await q(`insert into $T.journal_entry (${SYS}, location_id, entry_date) values (${sys()}, $2, '2026-11-02')`, [e, L1]);
        await q(`insert into $T.journal_line (${SYS}, location_id, currency, entry, account, debit, credit) values (${sys(1)}, $3, 'USD', $4, $5, 100, 0), ($2, 'manual', 'u', 'u', $3, 'USD', $4, $6, 0, 100)`, [newUuid(), newUuid(), L1, e, debit, credit]);
      });
      await expect(one(c, `update $T.journal_entry set memo = 'edited' where id = $1`, [e])).rejects.toThrow(/permission denied/);
      await expect(one(c, `delete from $T.journal_entry where id = $1`, [e])).rejects.toThrow(/permission denied/);
      await expect(one(c, `truncate $T.journal_entry`)).rejects.toThrow(/permission denied/);
      await expect(one(c, `update $T.journal_line set debit = 0`)).rejects.toThrow(/permission denied/);
      await expect(one(c, `delete from $T.journal_line`)).rejects.toThrow(/permission denied/);
      expect(await one(c, `select (select count(*) from $T.journal_entry where id = $1)::int as entries, (select count(*) from $T.journal_line where entry = $1)::int as lines`, [e])).toEqual([{ entries: 1, lines: 2 }]);
    }
  });

  it("a location-scoped row outside the caller's locations is invisible and cannot be written", async () => {
    const all = ctx(A, PA);
    const onlyL1 = ctx(A, PA, "live", [L1]);
    const row = (loc: string, channel: string) => [newUuid(), loc, channel];
    const insert = `insert into $T.sales_day (${SYS}, location_id, currency, business_date, channel, net_sales) values (${sys()}, $2, 'USD', '2026-11-09', $3, 100000)`;
    const mine = row(L1, "dine_in");
    const theirs = row(L2, "dine_in");
    await one(onlyL1, insert, mine);
    await one(all, insert, theirs);

    // The restaurant's own role is under the policy: it sees only its locations.
    expect((await one(onlyL1, `select location_id from $T.sales_day`)).map((r) => r.location_id)).toEqual([L1]);
    expect(await one(ctx(A, PA, "live", [L2]), `select id from $T.sales_day`)).toEqual([{ id: theirs[0] }]);
    expect((await one(all, `select id from $T.sales_day order by location_id`)).map((r) => r.id)).toEqual([mine[0], theirs[0]]);
    expect(await one(ctx(A, PA, "live", [L1, L2]), `select count(*)::int as n from $T.sales_day`)).toEqual([{ n: 2 }]);

    // Cannot insert, move, change or delete a row at a location it does not have.
    await expect(one(onlyL1, insert, row(L2, "takeout"))).rejects.toThrow(/row-level security/);
    await expect(one(onlyL1, `update $T.sales_day set location_id = $2 where id = $1`, [mine[0], L2])).rejects.toThrow(/row-level security/);
    expect(await one(onlyL1, `update $T.sales_day set guests = 1 where id = $1 returning id`, [theirs[0]])).toEqual([]);
    expect(await one(onlyL1, `delete from $T.sales_day where id = $1 returning id`, [theirs[0]])).toEqual([]);
    expect(await one(all, `select guests from $T.sales_day where id = $1`, [theirs[0]])).toEqual([{ guests: null }]);

    // With no locations set at all, nothing is visible and nothing can be inserted.
    const none = await withStore(apiDb(), all, async (tx, store) => {
      await tx`select set_config('rms.locations', '', true)`;
      return [...(await tx.unsafe(`select count(*)::int as n from ${store.table("sales_day")}`))];
    });
    expect(none).toEqual([{ n: 0 }]);

    // The same wall holds in draft.
    const draftL1 = ctx(A, PA, "draft", [L1]);
    await expect(one(draftL1, insert, row(L2, "takeout"))).rejects.toThrow(/row-level security/);
    await one(draftL1, insert, row(L1, "takeout"));
    expect(await one(ctx(A, PA, "draft", [L2]), `select count(*)::int as n from $T.sales_day`)).toEqual([{ n: 0 }]);
  });

  // ---------------------------------------------------------------- the ledger

  const accounts = { cash: newUuid(), sales: newUuid(), tips: newUuid() };
  const line = (entry: string, account: string, debit: number, credit: number, loc = L1, currency = "USD") => ({
    text: `insert into $T.journal_line (${SYS}, location_id, currency, entry, account, debit, credit) values (${sys()}, $2, $3, $4, $5, $6, $7)`,
    params: [newUuid(), loc, currency, entry, account, debit, credit],
  });
  const post = (c: TenantContext, entry: string, date: string, lines: ReturnType<typeof line>[], opts: { header?: boolean; reverses?: string } = {}) =>
    asStore(c, async (q) => {
      if (opts.header !== false) {
        await q(`insert into $T.journal_entry (${SYS}, location_id, entry_date, reverses) values (${sys()}, $2, $3, $4)`, [entry, L1, date, opts.reverses ?? null]);
      }
      for (const l of lines) await q(l.text, l.params);
      // Still inside the transaction: the check has not run yet.
      return (await q(`select count(*)::int as n from $T.journal_line where entry = $1`, [entry]))[0]?.n;
    });
  const lineCount = async (entry: string) => (await one(ctx(A, PA), `select count(*)::int as n from $T.journal_line where entry = $1`, [entry]))[0]?.n;

  it("sets up accounts", async () => {
    await asStore(ctx(A, PA), async (q) => {
      await q(`insert into $T.account (${SYS}, code, name, type) values (${sys(1)}, '1000', 'Cash', 'asset'), ($2, 'manual', 'u', 'u', '4000', 'Food sales', 'revenue'), ($3, 'manual', 'u', 'u', '2100', 'Tips owed', 'liability')`, [
        accounts.cash,
        accounts.sales,
        accounts.tips,
      ]);
    });
    expect(await one(ctx(A, PA), `select count(*)::int as n from $T.account where code in ('1000', '4000', '2100')`)).toEqual([{ n: 3 }]);
  });

  it("an unbalanced batch fails at commit and leaves nothing behind", async () => {
    const e = newUuid();
    await expect(post(ctx(A, PA), e, "2026-11-10", [line(e, accounts.cash, 10000, 0), line(e, accounts.sales, 0, 9999)])).rejects.toThrow(/does not balance/);
    expect(await lineCount(e)).toBe(0);
    expect(await one(ctx(A, PA), `select count(*)::int as n from $T.journal_entry where id = $1`, [e])).toEqual([{ n: 0 }]);

    const lonely = newUuid();
    await expect(post(ctx(A, PA), lonely, "2026-11-10", [line(lonely, accounts.cash, 500, 0)])).rejects.toMatchObject({ code: "23514", constraint_name: ruleConstraintName("journal_entry", "entry_balances") });
  });

  it("a balanced batch passes, in any line order, and the check waits for commit", async () => {
    const e = newUuid();
    const seen = await post(ctx(A, PA), e, "2026-11-10", [line(e, accounts.sales, 0, 9000), line(e, accounts.tips, 0, 1000), line(e, accounts.cash, 10000, 0)]);
    expect(seen).toBe(3);
    expect(await lineCount(e)).toBe(3);
  });

  it("lines in two currencies fail even when the numbers match", async () => {
    const e = newUuid();
    await expect(post(ctx(A, PA), e, "2026-11-10", [line(e, accounts.cash, 5000, 0, L1, "USD"), line(e, accounts.sales, 0, 5000, L1, "CAD")])).rejects.toThrow(/does not balance/);
    expect(await lineCount(e)).toBe(0);
  });

  it("a posted entry can never be changed: no later lines, balanced or not, by anyone", async () => {
    const e = newUuid();
    await post(ctx(A, PA), e, "2026-11-11", [line(e, accounts.cash, 700, 0), line(e, accounts.sales, 0, 700)]);
    const later = (c: TenantContext, lines: ReturnType<typeof line>[]) => post(c, e, "2026-11-11", lines, { header: false });
    const posted = { code: "23514", message: "The entry is already posted and cannot be changed", constraint_name: ruleConstraintName("journal_entry", "entry_balances") };
    await expect(later(ctx(A, PA), [line(e, accounts.cash, 1, 0)])).rejects.toMatchObject(posted);
    // A balanced addition is still a change to a posted entry.
    await expect(later(ctx(A, PA), [line(e, accounts.cash, 50, 0), line(e, accounts.sales, 0, 50)])).rejects.toMatchObject(posted);
    // So is one from a caller at the same location, or limited to another one.
    await expect(later(ctx(A, PA, "live", [L1]), [line(e, accounts.cash, 50, 0), line(e, accounts.sales, 0, 50)])).rejects.toMatchObject(posted);
    await expect(later(ctx(A, PA, "live", [L2]), [line(e, accounts.cash, 50, 0, L2), line(e, accounts.sales, 0, 50, L2)])).rejects.toMatchObject(posted);
    expect(await lineCount(e)).toBe(2);
  });

  it("an entry with no lines does not commit", async () => {
    const e = newUuid();
    await expect(post(ctx(A, PA), e, "2026-11-11", [])).rejects.toMatchObject({ code: "23514", message: "The entry has no lines", constraint_name: ruleConstraintName("journal_entry", "entry_balances") });
    expect(await one(ctx(A, PA), `select count(*)::int as n from $T.journal_entry where id = $1`, [e])).toEqual([{ n: 0 }]);
  });

  it("a header and its lines written inside savepoints still count as one transaction", async () => {
    const write = (plan: (tx: Tx, header: () => Promise<unknown>, lines: () => Promise<unknown>) => Promise<unknown>) => {
      const e = newUuid();
      const done = withStore(apiDb(), ctx(A, PA), (tx, store) => {
        const header = () => tx.unsafe(`insert into ${store.table("journal_entry")} (${SYS}, location_id, entry_date) values ($1, 'manual', 'u', 'u', $2, '2026-11-11')`, [e, L1]);
        const lines = () =>
          tx.unsafe(
            `insert into ${store.table("journal_line")} (${SYS}, location_id, currency, entry, account, debit, credit) values ($1, 'manual', 'u', 'u', $3, 'USD', $4, $5, 90, 0), ($2, 'manual', 'u', 'u', $3, 'USD', $4, $6, 0, 90)`,
            [newUuid(), newUuid(), L1, e, accounts.cash, accounts.sales],
          );
        return plan(tx, header, lines);
      });
      return { e, done };
    };
    // Both inside one savepoint.
    const both = write((tx, header, lines) => tx.savepoint(async () => { await header(); await lines(); }));
    await both.done;
    expect(await lineCount(both.e)).toBe(2);
    // Header in the main transaction, lines in a savepoint. And the other way round.
    const split = write(async (tx, header, lines) => { await header(); await tx.savepoint(() => lines()); });
    await split.done;
    const other = write(async (tx, header, lines) => { await tx.savepoint(() => header()); await lines(); });
    await other.done;
    expect(await lineCount(split.e)).toBe(2);
    expect(await lineCount(other.e)).toBe(2);
    // Lines in a savepoint that is rolled back are gone, so the entry has no lines and does not commit.
    const undone = write(async (tx, header, lines) => {
      await header();
      await tx.savepoint(async () => { await lines(); throw new Error("undo the lines"); }).catch(() => undefined);
    });
    await expect(undone.done).rejects.toThrow(/has no lines/);
  });

  it("the balance check counts every line, whatever the caller's locations are at commit", async () => {
    // One entry with its debit at location 1 and its credit at location 2. Balanced as a whole.
    const e = newUuid();
    await post(ctx(A, PA), e, "2026-11-12", [line(e, accounts.cash, 4000, 0, L1), line(e, accounts.sales, 0, 4000, L2)]);
    expect(await one(ctx(A, PA, "live", [L1]), `select count(*)::int as n from $T.journal_line where entry = $1`, [e])).toEqual([{ n: 1 }]);

    // A debit at location 2, then the transaction narrows to location 1 and adds a balanced pair there.
    // At commit only the pair is visible to the caller. A check that ran as the caller would pass it.
    const bad = newUuid();
    const sneaky = withStore(apiDb(), ctx(A, PA), async (tx, store) => {
      const insertLine = (loc: string, account: string, debit: number, credit: number) =>
        tx.unsafe(`insert into ${store.table("journal_line")} (${SYS}, location_id, currency, entry, account, debit, credit) values ($1, 'manual', 'u', 'u', $2, 'USD', $3, $4, $5, $6)`, [newUuid(), loc, bad, account, debit, credit]);
      await tx.unsafe(`insert into ${store.table("journal_entry")} (${SYS}, location_id, entry_date) values ($1, 'manual', 'u', 'u', $2, '2026-11-12')`, [bad, L1]);
      await insertLine(L2, accounts.cash, 4000, 0);
      await tx`select set_config('rms.locations', ${L1}, true)`;
      await insertLine(L1, accounts.cash, 25, 0);
      await insertLine(L1, accounts.sales, 0, 25);
      return [...(await tx.unsafe(`select count(*)::int as n from ${store.table("journal_line")} where entry = $1`, [bad]))];
    });
    await expect(sneaky).rejects.toThrow(/does not balance/);
    expect(await lineCount(bad)).toBe(0);
  });

  it("line rules: one side only, never negative, and a real entry and account", async () => {
    const e = newUuid();
    await expect(post(ctx(A, PA), e, "2026-11-12", [line(e, accounts.cash, 10, 10)])).rejects.toMatchObject({ code: "23514", constraint_name: ruleConstraintName("journal_line", "one_side_only") });
    await expect(post(ctx(A, PA), e, "2026-11-12", [line(e, accounts.cash, -10, 0), line(e, accounts.sales, 0, -10)])).rejects.toThrow(/violates check constraint/);
    await expect(post(ctx(A, PA), e, "2026-11-12", [line(e, newUuid(), 10, 0), line(e, accounts.sales, 0, 10)])).rejects.toThrow(/foreign key/);
    await expect(post(ctx(A, PA), e, "2026-11-12", [line(newUuid(), accounts.cash, 10, 0)])).rejects.toThrow(/foreign key/);
  });

  it("a model can point at itself: an entry that reverses an earlier one", async () => {
    const original = newUuid();
    const reversal = newUuid();
    await post(ctx(A, PA), original, "2026-11-13", [line(original, accounts.cash, 300, 0), line(original, accounts.sales, 0, 300)]);
    await post(ctx(A, PA), reversal, "2026-11-13", [line(reversal, accounts.cash, 0, 300), line(reversal, accounts.sales, 300, 0)], { reverses: original });
    expect(await one(ctx(A, PA), `select reverses from $T.journal_entry where id = $1`, [reversal])).toEqual([{ reverses: original }]);
    await expect(post(ctx(A, PA), newUuid(), "2026-11-13", [], { reverses: newUuid() })).rejects.toThrow(/foreign key/);
    await expect(post(ctx(A, PA), newUuid(), "2026-11-13", [], { reverses: original })).rejects.toThrow(/unique/);
  });

  it("a closed period accepts nothing new, an open one does", async () => {
    await asStore(ctx(A, PA), (q) =>
      q(`insert into $T.fiscal_period (${SYS}, name, start_date, end_date, status) values (${sys(1)}, 'October 2026', '2026-10-01', '2026-10-31', 'closed'), ($2, 'manual', 'u', 'u', 'December 2026', '2026-12-01', '2026-12-31', 'open')`, [newUuid(), newUuid()]),
    );
    const closed = newUuid();
    for (const day of ["2026-10-01", "2026-10-15", "2026-10-31"]) {
      await expect(post(ctx(A, PA), closed, day, [line(closed, accounts.cash, 100, 0), line(closed, accounts.sales, 0, 100)])).rejects.toMatchObject({
        code: "23514",
        message: "The period is closed",
        constraint_name: ruleConstraintName("journal_entry", "period_is_open"),
      });
    }
    expect(await lineCount(closed)).toBe(0);
    for (const day of ["2026-09-30", "2026-11-01", "2026-12-15"]) {
      const e = newUuid();
      await post(ctx(A, PA), e, day, [line(e, accounts.cash, 100, 0), line(e, accounts.sales, 0, 100)]);
    }
    // Closing a period later shuts it for new entries.
    const december = (await one(ctx(A, PA), `select id from $T.journal_entry where entry_date = '2026-12-15'`))[0]?.id as string;
    await one(ctx(A, PA), `update $T.fiscal_period set status = 'closed' where name = 'December 2026'`);
    await expect(post(ctx(A, PA), newUuid(), "2026-12-16", [])).rejects.toThrow(/period is closed/);
    // And the entry posted there before it closed takes no more lines.
    await expect(post(ctx(A, PA), december, "2026-12-15", [line(december, accounts.cash, 5, 0), line(december, accounts.sales, 0, 5)], { header: false })).rejects.toMatchObject({
      code: "23514",
      constraint_name: ruleConstraintName("journal_entry", "entry_balances"),
    });
    expect(await lineCount(december)).toBe(2);
    // The header's period rule is checked again for its lines: a period that closes after the
    // header is written, in the same transaction, still stops them.
    const late = newUuid();
    const closing = asStore(ctx(A, PA), async (q) => {
      await q(`insert into $T.journal_entry (${SYS}, location_id, entry_date) values (${sys()}, $2, '2027-03-10')`, [late, L1]);
      await q(`insert into $T.fiscal_period (${SYS}, name, start_date, end_date, status) values (${sys()}, 'March 2027', '2027-03-01', '2027-03-31', 'closed')`, [newUuid()]);
      for (const l of [line(late, accounts.cash, 100, 0), line(late, accounts.sales, 0, 100)]) await q(l.text, l.params);
    });
    await expect(closing).rejects.toMatchObject({ code: "23514", message: "The period is closed", constraint_name: ruleConstraintName("journal_entry", "period_is_open") });
    expect(await lineCount(late)).toBe(0);
    await expect(one(ctx(A, PA), `insert into $T.fiscal_period (${SYS}, name, start_date, end_date, status) values (${sys()}, 'Backwards', '2027-02-01', '2027-01-01', 'open')`, [newUuid()])).rejects.toThrow(/violates check constraint/);
  });

  it("money owed can only be posted to a liability account, now or later", async () => {
    const rule = (part: string, account: string) => one(ctx(A, PA), `insert into $T.posting_rule (${SYS}, part, account) values (${sys()}, $2, $3)`, [newUuid(), part, account]);
    await expect(rule("tips", accounts.sales)).rejects.toMatchObject({ code: "23514", constraint_name: ruleConstraintName("posting_rule", "owed_money_is_a_liability") });
    await expect(rule("sales_tax", accounts.cash)).rejects.toThrow(/not allowed here/);
    await rule("tips", accounts.tips);
    await rule("net_sales", accounts.sales); // the rule only applies to money owed
    // Pointing an existing rule at a revenue account is refused.
    await expect(one(ctx(A, PA), `update $T.posting_rule set account = $1 where part = 'tips'`, [accounts.sales])).rejects.toThrow(/not allowed here/);
    // Turning the liability account into revenue under the rule is refused too.
    await expect(one(ctx(A, PA), `update $T.account set type = 'revenue' where id = $1`, [accounts.tips])).rejects.toThrow(/not allowed here/);
    await one(ctx(A, PA), `update $T.account set name = 'Tips owed to staff' where id = $1`, [accounts.tips]);
    // An account no money-owed rule points at may change type.
    await one(ctx(A, PA), `update $T.account set type = 'equity' where id = $1`, [accounts.cash]);
    await one(ctx(A, PA), `update $T.account set type = 'asset' where id = $1`, [accounts.cash]);
  });

  it("a linked row cannot change under rows at locations the caller cannot see", async () => {
    const supplies = newUuid();
    await one(ctx(A, PA), `insert into $T.account (${SYS}, code, name, type) values (${sys()}, '6100', 'Kitchen supplies', 'expense')`, [supplies]);
    const paid = (c: TenantContext, loc: string, account: string) => one(c, `insert into $T.paid_out (${SYS}, location_id, currency, amount, account) values (${sys()}, $2, 'USD', 1500, $3)`, [newUuid(), loc, account]);
    await expect(paid(ctx(A, PA), L2, accounts.cash)).rejects.toMatchObject({ constraint_name: ruleConstraintName("paid_out", "paid_from_an_expense") });
    await paid(ctx(A, PA), L2, supplies);
    // This caller sees no paid-out rows at all. The account still cannot stop being an expense.
    const onlyL1 = ctx(A, PA, "live", [L1]);
    expect(await one(onlyL1, `select count(*)::int as n from $T.paid_out`)).toEqual([{ n: 0 }]);
    await expect(one(onlyL1, `update $T.account set type = 'asset' where id = $1`, [supplies])).rejects.toThrow(/not allowed here/);
    await one(onlyL1, `update $T.account set name = 'Kitchen and bar supplies' where id = $1`, [supplies]);
  });

  // ---------------------------------------------------------------- column rules

  it("fills created_at and updated_at itself, to the millisecond, when a row gives only the other columns", async () => {
    // What a named action does: its own id, the actor from the session, nothing for the timestamps.
    const v = newUuid();
    const [row] = await one(
      ctx(A, PA),
      `insert into $T.vendor (id, name, source, source_id, created_by, updated_by)
       select $1::uuid, 'River Dairy', 'app', 'vendor/river', rms.current_actor(), rms.current_actor()
       on conflict do nothing
       returning created_by, source, deleted_at, created_at::text as created_at, updated_at::text as updated_at`,
      [v],
    );
    expect(row).toMatchObject({ created_by: `user:${USER_UUID}`, source: "app", deleted_at: null });
    for (const at of [row?.created_at, row?.updated_at]) expect(String(at)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,3})?[+-]\d\d/);

    // The same source record again changes nothing (a bare "on conflict do nothing" uses the source index).
    const again = await one(
      ctx(A, PA),
      `insert into $T.vendor (id, name, source, source_id, created_by, updated_by) values ($1, 'River Dairy', 'app', 'vendor/river', 'u', 'u') on conflict do nothing returning id`,
      [newUuid()],
    );
    expect(again).toEqual([]);
    await expect(one(ctx(A, PA), `insert into $T.vendor (id, name, source, source_id, created_by, updated_by) values ($1, 'x', 'app', 'vendor/river', 'u', 'u')`, [newUuid()])).rejects.toThrow(/unique/);
    // Rows with no source id never collide.
    await one(ctx(A, PA), `insert into $T.vendor (${SYS}, name) values (${sys(1)}, 'One'), ($2, 'manual', 'u', 'u', 'Two')`, [newUuid(), newUuid()]);

    // An update moves updated_at forward, still to the millisecond, whatever the caller sends.
    const [after] = await one(ctx(A, PA), `update $T.vendor set name = 'River Dairy Co', updated_at = '2001-01-01 00:00:00.123456+00' where id = $1 returning updated_at::text as updated_at, (updated_at > created_at) as later`, [v]);
    expect(String(after?.updated_at)).not.toMatch(/^2001-/);
    expect(String(after?.updated_at)).toMatch(/\d\d:\d\d:\d\d(\.\d{1,3})?[+-]/);
    expect(after?.later).toBe(true);
    await expect(one(ctx(A, PA), `insert into $T.vendor (id, name, source, created_by, updated_by) values ($1, 'x', 'made_up', 'u', 'u')`, [newUuid()])).rejects.toThrow(/violates check constraint/);
    await expect(one(ctx(A, PA), `insert into $T.vendor (name, source, created_by, updated_by) values ('no id', 'manual', 'u', 'u')`)).rejects.toThrow(/null value in column "id"/);
  });

  it("enforces list values, text length, units, unique rules, currency shape and link clean-up", async () => {
    const c = ctx(A, PA);
    const vendor = newUuid();
    await one(c, `insert into $T.vendor (${SYS}, name) values (${sys()}, 'Northside Meats')`, [vendor]);
    const prep = (cols: string, vals: string, params: unknown[] = []) => one(c, `insert into $T.prep_item (${SYS}, location_id, name, active${cols}) values (${sys()}, $2, 'Brisket', true${vals}) returning id`, [newUuid(), L1, ...params]);

    const item = (await prep(", category, vendor, menu_item, menu_item_label, on_hand, on_hand_unit, unit_cost, counted_at, details", `, 'meat', $3, $4, 'Smoked brisket plate', 12.5, 'kg', 8.1234, now(), '{"shelf": 2}'`, [vendor, newUuid()]))[0]?.id;
    expect(item).toBeTruthy();
    await expect(prep(", category", ", 'fish'")).rejects.toThrow(/violates check constraint/);
    await expect(prep(", on_hand", ", 3")).rejects.toThrow(/violates check constraint/);
    await expect(prep(", on_hand_unit", ", 'kg'")).rejects.toThrow(/violates check constraint/);
    await expect(prep(", vendor", ", $3", [newUuid()])).rejects.toThrow(/foreign key/);

    // Deleting the vendor clears the link (set_null). The parent link never had a foreign key.
    await one(c, `delete from $T.vendor where id = $1`, [vendor]);
    expect(await one(c, `select vendor, menu_item is not null as has_menu_item, unit_cost::text as unit_cost from $T.prep_item where id = $1`, [item])).toEqual([{ vendor: null, has_menu_item: true, unit_cost: "8.1234" }]);

    const day = (channel: string, currency: string, net: number, notes: string | null = null) =>
      one(c, `insert into $T.sales_day (${SYS}, location_id, currency, business_date, channel, net_sales, notes) values (${sys()}, $2, $3, '2026-11-14', $4, $5, $6)`, [newUuid(), L1, currency, channel, net, notes]);
    await day("delivery", "USD", 5000);
    await expect(day("delivery", "USD", 6000)).rejects.toThrow(/unique/);
    await expect(day("takeout", "usd", 6000)).rejects.toThrow(/violates check constraint/);
    await expect(day("takeout", "USD", -1)).rejects.toMatchObject({ constraint_name: ruleConstraintName("sales_day", "net_sales_not_negative") });
    await expect(day("takeout", "USD", 1, "x".repeat(501))).rejects.toThrow(/violates check constraint/);
    await expect(one(c, `insert into $T.account (${SYS}, code, name, type) values (${sys()}, '1000', 'Cash again', 'asset')`, [newUuid()])).rejects.toThrow(/unique/);
    // A deleted row does not hold on to its code: the same code can be used again, once.
    const petty = async () => (await one(c, `insert into $T.account (${SYS}, code, name, type) values (${sys()}, '1900', 'Petty cash', 'asset') returning id`, [newUuid()]))[0]?.id;
    const first = await petty();
    await expect(petty()).rejects.toThrow(/unique/);
    await one(c, `update $T.account set deleted_at = now() where id = $1`, [first]);
    const second = await petty();
    expect(second).not.toBe(first);
    await expect(petty()).rejects.toThrow(/unique/);
    expect(await one(c, `select count(*)::int as n from $T.account where code = '1900'`)).toEqual([{ n: 2 }]);
    await expect(one(c, `insert into $T.labour_day (${SYS}, location_id, currency, business_date, hours) values (${sys()}, $2, 'USD', '2026-11-14', 8)`, [newUuid(), L1])).rejects.toThrow(/null value in column "job"/);
    await one(c, `insert into $T.labour_day (${SYS}, location_id, currency, business_date, job, job_label, hours, wages) values (${sys()}, $2, 'USD', '2026-11-14', $3, 'Line cook', 7.5, 13500)`, [newUuid(), L1, newUuid()]);
  });

  // ---------------------------------------------------------------- dependencies

  it("fails clearly, and creates nothing, when a needed model is not in the library", async () => {
    const sql = adminDb();
    const left = async () => ({
      models: (await sql`select count(*)::int as n from platform.org_models where org_id = ${C}`)[0]?.n,
      tables: (await sql`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ${sql([PC, `${PC}_draft`])}`)[0]?.n,
    });
    // journal_entry has no link to fiscal_period. Its open-period rule needs it anyway.
    const noPeriod = { models: fixtureModels.filter((m) => m.key !== "fiscal_period") };
    await expect(ensureModels(sql, C, ["vendor", "journal_entry"], { library: noPeriod })).rejects.toThrow('Model "fiscal_period" is not in the library. Model "journal_entry" needs it');
    await expect(ensureModels(sql, C, ["vendor", "no_such_model"], { library })).rejects.toThrow('Model "no_such_model" is not in the library');
    expect(await left()).toEqual({ models: 0, tables: 0 });
    await expect(ensureModels(sql, newUuid(), ["vendor"], { library })).rejects.toThrow(/store is not ready/);

    // A record that says the restaurant has its OWN model under a library name. The library model's
    // rules (and their trigger functions) must never be put on such a table, asked for by name or pulled in.
    for (const key of ["labour_day", "fiscal_period", "journal_line"]) {
      const planted = newUuid();
      const shaped = { ...fixtureModel("vendor"), key, pack: "custom" };
      await sql`insert into platform.org_models (id, org_id, key, kind, definition, status) values (${planted}, ${C}, ${key}, 'custom', ${JSON.stringify(shaped)}::text::jsonb, 'live')`;
      const ask = key === "labour_day" ? ["labour_day"] : ["vendor", "journal_entry"];
      await expect(ensureModels(sql, C, ask, { library })).rejects.toThrow(`This restaurant has its own model called "${key}". It cannot be used in place of the library model`);
      await expect(applyChange(sql, C, { op: "use_template", template: key }, { library })).rejects.toThrow(/cannot be used in place of the library model/);
      await sql`delete from platform.org_models where id = ${planted}`;
      expect(await left()).toEqual({ models: 0, tables: 0 });
    }

    // A statement that fails rolls back every table and every record of that call.
    // This model's check compares text with a number: it compiles, and Postgres refuses it.
    const broken = { ...fixtureModel("vendor"), key: "broken_model", rules: [{ kind: "check", name: "bad_types", expr: { op: "gt", args: [{ field: "name" }, { lit: 5 }] }, message: "m" }] } as unknown as ModelDefinition;
    await expect(ensureModels(sql, C, ["vendor", "broken_model"], { library: { models: [fixtureModel("vendor"), broken] } })).rejects.toThrow(/operator does not exist/);
    expect(await left()).toEqual({ models: 0, tables: 0 });
  });

  it("pulls in what a model needs, even when no link field says so, in dependency order", async () => {
    const sql = adminDb();
    const r = await ensureModels(sql, C, ["journal_entry"], { library });
    expect([...r.created].sort()).toEqual(["account", "fiscal_period", "journal_entry", "journal_line"]);
    expect(r.created.indexOf("fiscal_period")).toBeLessThan(r.created.indexOf("journal_entry"));
    expect(r.created.indexOf("account")).toBeLessThan(r.created.indexOf("journal_line"));
    await expect(one(ctx(C, PC), `insert into $T.journal_line (${SYS}, location_id, currency, entry, account, debit, credit) values (${sys()}, $2, 'USD', $3, $4, 1, 0)`, [newUuid(), L1, newUuid(), newUuid()])).rejects.toThrow(/foreign key/);
    await expect(one(ctx(C, PC), `insert into $T.fiscal_period (${SYS}, name, start_date, end_date, status) values (${sys()}, 'P1', '2026-01-01', '2026-01-28', 'closed')`, [newUuid()])).resolves.toEqual([]);
    await expect(one(ctx(C, PC), `insert into $T.journal_entry (${SYS}, location_id, entry_date) values (${sys()}, $2, '2026-01-05')`, [newUuid(), L1])).rejects.toThrow(/period is closed/);
    expect(await ensureModels(sql, C, ["journal_line", "account"], { library })).toEqual({ created: [], madeLive: [], unchanged: ["journal_line", "account"] });
  });

  // ---------------------------------------------------------------- changes

  const columnsIn = async (schema: string, table: string) =>
    (await adminDb()<{ name: string }[]>`
      select a.attname as name from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schema} and c.relname = ${table} and a.attnum > 0 and not a.attisdropped`).map((r) => r.name);

  it("applies a change to draft first and to live only on request", async () => {
    const sql = adminDb();
    await ensureModels(sql, C, ["vendor", "account"], { library });

    const r = await applyChange(sql, C, { op: "add_field", model: "vendor", field: { key: "phone", label: "Phone", type: "text", maxLength: 30, required: false } }, { library });
    expect(r).toMatchObject({ model: "vendor", appliedDraft: true, appliedLive: false });
    expect(await columnsIn(`${PC}_draft`, "vendor")).toContain("phone");
    expect(await columnsIn(PC, "vendor")).not.toContain("phone");
    expect((await effectiveDefinition(sql, C, "vendor", "draft"))?.fields.map((f) => f.key)).toEqual(["name", "phone"]);
    expect((await effectiveDefinition(sql, C, "vendor", "live"))?.fields.map((f) => f.key)).toEqual(["name"]);
    // The restaurant-facing login can ask the same question for its own org, and gets nothing for another.
    expect((await withOrg(apiDb(), C, (tx) => effectiveDefinition(tx, C, "vendor", "live")))?.fields.map((f) => f.key)).toEqual(["name"]);
    expect((await withOrg(apiDb(), C, (tx) => effectiveDefinition(tx, C, "vendor", "draft")))?.fields.map((f) => f.key)).toEqual(["name", "phone"]);
    expect(await withOrg(apiDb(), C, (tx) => effectiveDefinition(tx, A, "vendor", "live"))).toBeUndefined();
    const [change] = await sql`select change, compiled_sql, applied_draft_at, applied_live_at from platform.org_model_changes where id = ${r.changeId}`;
    expect(change?.change).toMatchObject({ op: "add_field", model: "vendor" });
    expect(change?.applied_draft_at).toBeTruthy();
    expect(change?.applied_live_at).toBeNull();
    expect(change?.compiled_sql).toContain(`alter table "${PC}_draft"."vendor" add column "phone" text;`);
    expect(change?.compiled_sql).not.toContain(`"${PC}"."vendor"`);

    // A second waiting change, then both go live together, in order.
    await expect(applyChange(sql, C, { op: "add_unique", model: "vendor", fields: ["name", "phone"] }, { library })).rejects.toThrow(/needs the owner to confirm/);
    await expect(applyChange(sql, C, { op: "add_unique", model: "vendor", fields: ["name", "phone"] }, { library, ownerConfirmed: "yes" as never })).rejects.toThrow(/needs the owner to confirm/);
    await applyChange(sql, C, { op: "add_unique", model: "vendor", fields: ["name", "phone"] }, { library, ownerConfirmed: true });
    await applyChange(sql, C, { op: "add_index", model: "vendor", fields: ["phone"] }, { library });
    expect(await publishModelChanges(sql, C, ["vendor"], { library })).toEqual(["vendor"]);
    expect(await columnsIn(PC, "vendor")).toContain("phone");
    expect((await effectiveDefinition(sql, C, "vendor", "live"))?.unique).toEqual([["name", "phone"]]);
    const waiting = await sql`select count(*)::int as n from platform.org_model_changes where org_id = ${C} and applied_live_at is null`;
    expect(waiting[0]?.n).toBe(0);
    expect((await sql`select compiled_sql from platform.org_model_changes where id = ${r.changeId}`)[0]?.compiled_sql).toContain(`alter table "${PC}"."vendor" add column "phone" text;`);
    expect(await publishModelChanges(sql, C, undefined, { library })).toEqual([]);

    // The new unique rule is real in both places.
    for (const env of ["live", "draft"] as const) {
      const ins = () => one(ctx(C, PC, env), `insert into $T.vendor (${SYS}, name, phone) values (${sys()}, 'Twin', '555-0100')`, [newUuid()]);
      await ins();
      await expect(ins()).rejects.toThrow(/unique/);
    }

    // Straight to live when asked.
    const both = await applyChange(sql, C, { op: "add_field", model: "vendor", field: { key: "pays_into", label: "Account", type: "ref", model: "account", required: false, onDelete: "restrict" } }, { library, live: true });
    expect(both).toMatchObject({ appliedDraft: true, appliedLive: true });
    expect(await columnsIn(PC, "vendor")).toContain("pays_into");
    await expect(one(ctx(C, PC), `update $T.vendor set pays_into = $1`, [newUuid()])).rejects.toThrow(/foreign key/);
  });

  it("refuses changes it must not make, and leaves the store as it was", async () => {
    const sql = adminDb();
    const before = await columnsIn(`${PC}_draft`, "vendor");
    const changes = (await sql`select count(*)::int as n from platform.org_model_changes where org_id = ${C}`)[0]?.n;
    const bad: unknown[] = [
      { op: "add_field", model: "vendor", field: { key: "must_have", label: "Required", type: "text", required: true } },
      { op: "add_field", model: "vendor", field: { key: "phone", label: "Again", type: "text" } },
      { op: "add_field", model: "vendor", field: { key: 'x"; drop schema platform cascade; --', label: "x", type: "text" } },
      { op: "add_field", model: "vendor", field: { key: "ghost", label: "x", type: "ref", model: "prep_item" } },
      { op: "add_field", model: "not_here", field: { key: "x", label: "x", type: "text" } },
      { op: "add_unique", model: "vendor", fields: ["nope"] },
      { op: "add_field", model: "vendor", field: { key: "x", label: "x", type: "text" }, schema: PB },
      { op: "drop_model", model: "vendor" },
      { op: "create_custom_model", definition: { ...fixtureModel("vendor"), key: "vendor", pack: "custom" } },
      { op: "create_custom_model", definition: { ...fixtureModel("sales_day"), pack: "custom" } },
      { op: "create_custom_model", definition: { ...fixtureModel("journal_entry"), key: "my_ledger", pack: "custom" } },
      { op: "use_template", template: "no_such_template" },
      // A custom model's key must start with x_. A library model's key never does.
      { op: "create_custom_model", definition: { ...fixtureModel("vendor"), key: "plain_note", pack: "custom" } },
      { op: "create_custom_model", definition: { ...fixtureModel("vendor"), key: "x_note", pack: "inventory" } },
      // Too many links, and a definition that is too large.
      { op: "create_custom_model", definition: { ...fixtureModel("vendor"), key: "x_many_links", pack: "custom", fields: Array.from({ length: 13 }, (_, i) => ({ key: `link_${i}`, label: "Link", type: "ref", model: "vendor" })) } },
      { op: "create_custom_model", definition: { ...fixtureModel("vendor"), key: "x_huge", pack: "custom", fields: Array.from({ length: 80 }, (_, i) => ({ key: `pick_${i}`, label: "Pick", type: "enum", values: Array.from({ length: 60 }, (_, v) => `value_${String(v).padStart(2, "0")}_${"a".repeat(38)}`) })) } },
      // A field named after a column the database keeps for itself.
      { op: "add_field", model: "vendor", field: { key: "xmin", label: "x", type: "text" } },
      { op: "create_custom_model", definition: { ...fixtureModel("vendor"), key: "x_ctid", pack: "custom", fields: [{ key: "ctid", label: "x", type: "text" }] } },
    ];
    for (const change of bad) await expect(applyChange(sql, C, change as never, { library }), JSON.stringify(change).slice(0, 80)).rejects.toThrow();
    expect(await columnsIn(`${PC}_draft`, "vendor")).toEqual(before);
    expect((await sql`select count(*)::int as n from platform.org_model_changes where org_id = ${C}`)[0]?.n).toBe(changes);
    expect((await sql`select count(*)::int as n from platform.organizations`)[0]?.n).toBeGreaterThan(0);
  });

  const HOSTILE = `x'; drop schema platform cascade; -- $rms$ \\ /* E'\\x24 "`;

  it("a custom model starts in draft only, with hostile text kept as plain data", async () => {
    const sql = adminDb();
    const definition = {
      key: "x_team_note",
      version: 1,
      pack: "custom",
      name: "Team note",
      description: `Notes for the team. ${HOSTILE}`,
      fields: [
        { key: "body", label: HOSTILE.slice(0, 60), type: "text", description: HOSTILE },
        { key: "vendor", label: "Vendor", type: "ref", model: "vendor" },
      ],
      rules: [
        { kind: "check", name: "not_the_bad_word", expr: { op: "and", args: [{ op: "ne", args: [{ field: "body" }, { lit: HOSTILE }] }, { op: "not", arg: { op: "in", arg: { field: "body" }, values: [`${HOSTILE}2`, "banned"] } }] }, message: HOSTILE },
      ],
      defaultAccess: { owner: "write", staff: "write" },
    };
    const r = await applyChange(sql, C, { op: "create_custom_model", definition } as never, { library });
    expect(r).toMatchObject({ model: "x_team_note", appliedDraft: true, appliedLive: false });
    const [row] = await sql`select kind, status, template_key from platform.org_models where org_id = ${C} and key = 'x_team_note'`;
    expect({ ...row }).toEqual({ kind: "custom", status: "draft", template_key: null });
    expect(await effectiveDefinition(sql, C, "x_team_note", "live")).toBeUndefined();
    expect((await effectiveDefinition(sql, C, "x_team_note", "draft"))?.key).toBe("x_team_note");

    // In draft the table works, and the hostile text is just a value the check compares with.
    const note = (body: string) => one(ctx(C, PC, "draft"), `insert into $T.x_team_note (${SYS}, location_id, body) values (${sys()}, $2, $3)`, [newUuid(), L1, body]);
    await note("Order more limes");
    await note(`${HOSTILE} `);
    await expect(note(HOSTILE)).rejects.toMatchObject({ constraint_name: ruleConstraintName("x_team_note", "not_the_bad_word") });
    await expect(note(`${HOSTILE}2`)).rejects.toThrow(/violates check constraint/);
    await expect(note("banned")).rejects.toThrow(/violates check constraint/);
    // Not in live yet.
    await expect(one(ctx(C, PC), `select * from $T.x_team_note`)).rejects.toThrow(/does not exist/);

    // A live model gets a link to the draft-only model. Publishing that change brings the custom model live first.
    await applyChange(sql, C, { op: "add_field", model: "account", field: { key: "note", label: "Note", type: "ref", model: "x_team_note", required: false, onDelete: "set_null" } }, { library });
    expect((await publishModelChanges(sql, C, ["account"], { library })).sort()).toEqual(["account", "x_team_note"]);
    expect(await one(ctx(C, PC), `select count(*)::int as n from $T.x_team_note`)).toEqual([{ n: 0 }]);
    await expect(one(ctx(C, PC), `insert into $T.x_team_note (${SYS}, location_id, body) values (${sys()}, $2, $3)`, [newUuid(), L1, HOSTILE])).rejects.toThrow(/violates check constraint/);
    expect((await sql`select status from platform.org_models where org_id = ${C} and key = 'x_team_note'`)[0]?.status).toBe("live");
    expect((await sql`select count(*)::int as n from platform.org_model_changes where org_id = ${C} and applied_live_at is null`)[0]?.n).toBe(0);
    // And the platform is still there.
    expect((await sql`select count(*)::int as n from platform.organizations where id = ${C}`)[0]?.n).toBe(1);
  });

  it("a unique rule is only added when no rows already break it, and the error names no values", async () => {
    const sql = adminDb();
    const vendorRow = (env: "live" | "draft", name: string, phone: string) =>
      one(ctx(C, PC, env), `insert into $T.vendor (${SYS}, name, phone) values (${sys()}, $2, $3) returning id`, [newUuid(), name, phone]).then((r) => r[0]?.id as string);
    const add = () => applyChange(sql, C, { op: "add_unique", model: "vendor", fields: ["phone"] }, { library, ownerConfirmed: true });
    const waiting = async () => (await sql`select count(*)::int as n from platform.org_model_changes where org_id = ${C} and applied_live_at is null`)[0]?.n;

    // Two draft rows share a phone number.
    const d1 = await vendorRow("draft", "Draft One", "555-0199");
    await vendorRow("draft", "Draft Two", "555-0199");
    const refusal = await add().then(() => undefined, (e: Error) => e);
    expect(refusal?.message).toBe("Some rows already share the same values. Change or remove them first, then add the rule.");
    expect(refusal?.message).not.toContain("555");
    expect(await waiting()).toBe(0);
    await one(ctx(C, PC, "draft"), `delete from $T.vendor where id = $1`, [d1]);

    // Draft is clean now, but two live rows share one. The change is still refused, before publish day.
    const l1 = await vendorRow("live", "Live One", "555-0142");
    await vendorRow("live", "Live Two", "555-0142");
    await expect(add()).rejects.toThrow(/already share the same values/);
    expect(await waiting()).toBe(0);

    // A deleted row does not count. With one of the two deleted, the rule goes in, and then holds.
    await one(ctx(C, PC), `update $T.vendor set deleted_at = now() where id = $1`, [l1]);
    expect(await add()).toMatchObject({ appliedDraft: true, appliedLive: false });
    await expect(vendorRow("draft", "Draft Three", "555-0199")).rejects.toThrow(/unique/);
    // Rows that break it appear in live before it is published: publishing is refused, and nothing goes live.
    await vendorRow("live", "Live Three", "555-0142");
    await expect(publishModelChanges(sql, C, ["vendor"], { library })).rejects.toThrow(/already share the same values/);
    expect(await waiting()).toBe(1);
    await one(ctx(C, PC), `delete from $T.vendor where name = 'Live Three'`);
    expect(await publishModelChanges(sql, C, ["vendor"], { library })).toEqual(["vendor"]);
    await expect(vendorRow("live", "Live Four", "555-0142")).rejects.toThrow(/unique/);
  });

  it("discards a change that is in draft and not yet live", async () => {
    const sql = adminDb();
    const fax = await applyChange(sql, C, { op: "add_field", model: "vendor", field: { key: "fax", label: "Fax", type: "quantity", required: false } }, { library });
    const faxIndex = await applyChange(sql, C, { op: "add_index", model: "vendor", fields: ["fax"] }, { library });
    expect(await columnsIn(`${PC}_draft`, "vendor")).toEqual(expect.arrayContaining(["fax", "fax_unit"]));

    // Newest first: the index uses the field.
    await expect(discardPendingChange(sql, C, fax.changeId as string)).rejects.toThrow(/Discard the newer changes/);
    expect(await discardPendingChange(sql, C, faxIndex.changeId as string, { library })).toEqual({ model: "vendor" });
    expect(await discardPendingChange(sql, C, fax.changeId as string)).toEqual({ model: "vendor" });
    const draftColumns = await columnsIn(`${PC}_draft`, "vendor");
    expect(draftColumns).not.toContain("fax");
    expect(draftColumns).not.toContain("fax_unit");
    expect((await effectiveDefinition(sql, C, "vendor", "draft"))?.fields.map((f) => f.key)).not.toContain("fax");
    expect((await effectiveDefinition(sql, C, "vendor", "draft"))?.indexes).toEqual((await effectiveDefinition(sql, C, "vendor", "live"))?.indexes);
    expect((await sql`select count(*)::int as n from platform.org_model_changes where id in ${sql([fax.changeId as string, faxIndex.changeId as string])}`)[0]?.n).toBe(0);
    // The table still works, and the field can be added again.
    await one(ctx(C, PC, "draft"), `insert into $T.vendor (${SYS}, name) values (${sys()}, 'After discard')`, [newUuid()]);

    // What is live, gone, or someone else's cannot be discarded.
    const liveChange = (await sql`select id from platform.org_model_changes where org_id = ${C} and applied_live_at is not null limit 1`)[0]?.id as string;
    const foreign = (await sql`select id from platform.org_model_changes where org_id = ${A} limit 1`)[0]?.id as string;
    for (const idOf of [liveChange, foreign, fax.changeId as string, newUuid()]) await expect(discardPendingChange(sql, C, idOf)).rejects.toThrow(/not waiting/);
    await expect(discardPendingChange(sql, C, "x'; drop schema platform cascade; --")).rejects.toThrow();

    // A new model that is still only in draft goes away completely, unless something points at it.
    const scratch = { key: "x_scratch", version: 1, pack: "custom", name: "Scratch", description: "A model made only to be thrown away.", fields: [{ key: "body", label: "Body", type: "text" }], defaultAccess: { owner: "write", staff: "none" } };
    const made = await applyChange(sql, C, { op: "create_custom_model", definition: scratch } as never, { library });
    const link = await applyChange(sql, C, { op: "add_field", model: "vendor", field: { key: "scratch", label: "Scratch", type: "ref", model: "x_scratch", required: false, onDelete: "set_null" } }, { library });
    await expect(discardPendingChange(sql, C, made.changeId as string)).rejects.toThrow('Model "vendor" still points at this one');
    await discardPendingChange(sql, C, link.changeId as string);
    expect(await discardPendingChange(sql, C, made.changeId as string)).toEqual({ model: "x_scratch" });
    expect(await columnsIn(`${PC}_draft`, "x_scratch")).toEqual([]);
    expect((await sql`select count(*)::int as n from platform.org_models where org_id = ${C} and key = 'x_scratch'`)[0]?.n).toBe(0);
    expect(await effectiveDefinition(sql, C, "x_scratch", "draft")).toBeUndefined();
    expect((await sql`select count(*)::int as n from platform.org_model_changes where org_id = ${C} and applied_live_at is null`)[0]?.n).toBe(0);
  });

  it("stops at sixty models for one restaurant", async () => {
    const sql = adminDb();
    const have = (await sql`select count(*)::int as n from platform.org_models where org_id = ${C}`)[0]?.n as number;
    const filler = (i: number) => ({ key: `x_filler_${i}`, version: 1, pack: "custom", name: "Filler", description: "A record made only to fill the list.", fields: [{ key: "body", label: "Body", type: "text" }], defaultAccess: { owner: "write", staff: "none" } });
    for (let i = have; i < STORE_LIMITS.modelsPerRestaurant; i++) {
      await sql`insert into platform.org_models (id, org_id, key, kind, definition, status) values (${newUuid()}, ${C}, ${`x_filler_${i}`}, 'custom', ${JSON.stringify(filler(i))}::text::jsonb, 'draft')`;
    }
    await expect(applyChange(sql, C, { op: "create_custom_model", definition: filler(999) } as never, { library })).rejects.toThrow("A restaurant can have at most 60 models");
    await expect(ensureModels(sql, C, ["prep_item"], { library })).rejects.toThrow("A restaurant can have at most 60 models");
    await sql`delete from platform.org_models where org_id = ${C} and key like 'x_filler_%'`;
    expect(await columnsIn(`${PC}_draft`, "x_filler_999")).toEqual([]);
    expect(await columnsIn(`${PC}_draft`, "prep_item")).toEqual([]);
  });

  it("use_template creates a library model in draft, and ensureModels then brings it live", async () => {
    const sql = adminDb();
    const r = await applyChange(sql, C, { op: "use_template", template: "sales_day" }, { library });
    expect(r).toMatchObject({ model: "sales_day", appliedDraft: true, appliedLive: false });
    expect(await columnsIn(PC, "sales_day")).toEqual([]);
    expect(await applyChange(sql, C, { op: "use_template", template: "sales_day" }, { library })).toMatchObject({ changeId: null, appliedDraft: false });
    expect(await ensureModels(sql, C, ["sales_day"], { library })).toEqual({ created: [], madeLive: ["sales_day"], unchanged: [] });
    expect((await columnsIn(PC, "sales_day")).length).toBeGreaterThan(5);
    expect(await ensureModels(sql, C, ["sales_day"], { library })).toEqual({ created: [], madeLive: [], unchanged: ["sales_day"] });
  });

  // ---------------------------------------------------------------- the installed library

  it("installs a library, and ensureModels reads it from there", async () => {
    const sql = adminDb();
    const model = (key: string, fields: unknown[]) => ({
      key,
      version: 1,
      pack: "inventory",
      name: `Test ${key}`,
      description: "A model made only for the task C library test.",
      locationScoped: false,
      fields,
      defaultAccess: { owner: "write", staff: "read" },
    });
    const lib = buildLibrary({
      models: [model(ITEM, [{ key: "name", label: "Name", type: "text", required: true }]), model(NOTE, [{ key: "item", label: "Item", type: "ref", model: ITEM, required: true }])],
      namedQueries: [{ key: REPORT, pack: "inventory", name: "Test report", description: "A report made only for this test.", reads: [ITEM], sql: `select name from {{${ITEM}}} as i`, columns: [{ key: "name", label: "Name", type: "text" }] }],
      namedActions: [{ key: TOUCH, pack: "inventory", name: "Test action", description: "An action made only for this test.", reads: [ITEM], writes: [NOTE], sql: `insert into {{${NOTE}}} (id) select gen_random_uuid()`, idempotent: true }],
    });
    expect(await installLibrary(sql, lib)).toEqual({ models: 2, namedQueries: 1, namedActions: 1 });
    expect(await installLibrary(sql, lib)).toEqual({ models: 2, namedQueries: 1, namedActions: 1 });
    const stored = await sql`select t.key, t.pack, t.current_version, t.status, v.definition from platform.model_templates t join platform.model_template_versions v on v.template_key = t.key and v.version = t.current_version where t.key in ${sql(TEST_TEMPLATES)} order by t.key`;
    expect(stored.map((s) => s.key)).toEqual(TEST_TEMPLATES);
    expect(stored[0]?.definition).toEqual(lib.models[0]);
    expect((await sql`select definition from platform.named_queries where key = ${REPORT}`)[0]?.definition).toEqual(lib.namedQueries[0]);
    expect((await sql`select definition from platform.named_actions where key = ${TOUCH}`)[0]?.definition).toEqual(lib.namedActions[0]);

    // No library passed in: definitions come from the installed templates, and the template is recorded.
    expect(await ensureModels(sql, C, [NOTE])).toEqual({ created: [ITEM, NOTE], madeLive: [], unchanged: [] });
    const rows = await sql`select key, kind, template_key, template_version, status from platform.org_models where org_id = ${C} and key like ${`${T}%`} order by key`;
    expect(rows.map((r) => ({ ...r }))).toEqual(TEST_TEMPLATES.map((key) => ({ key, kind: "standard", template_key: key, template_version: 1, status: "live" })));
    // A custom model may not take a library model's name, even in a restaurant that does not use that model.
    await expect(applyChange(sql, A, { op: "create_custom_model", definition: { ...model(ITEM, [{ key: "name", label: "Name", type: "text" }]), pack: "custom" } } as never)).rejects.toThrow(/must start with "x_"/);

    // A stored version is never changed in place.
    const edited = (version: number) => buildLibrary({ models: [{ ...lib.models[0], version, description: "The same model with different words in it." }, lib.models[1]], namedQueries: [], namedActions: [] });
    await expect(installLibrary(sql, edited(1))).rejects.toThrow(`Library model "${ITEM}" changed but is still version 1. Give it a new version number`);
    expect((await sql`select definition from platform.model_template_versions where template_key = ${ITEM} and version = 1`)[0]?.definition).toEqual(lib.models[0]);
    expect(await installLibrary(sql, edited(2))).toMatchObject({ models: 2 });
    const versions = await sql`select v.version, t.current_version, v.definition from platform.model_template_versions v join platform.model_templates t on t.key = v.template_key where v.template_key = ${ITEM} order by v.version`;
    expect(versions.map((v) => [v.version, v.current_version])).toEqual([[1, 2], [2, 2]]);
    expect(versions[0]?.definition).toEqual(lib.models[0]);
    // Installing the older library again is harmless: version 1 is unchanged and stays stored.
    expect(await installLibrary(sql, lib)).toMatchObject({ models: 2 });
  });
});
