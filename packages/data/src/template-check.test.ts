// The allow list for named templates: every real library template passes, and every attack
// from the security review (and its relatives) is refused before anything reaches a database.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { NamedActionDefinition, NamedQueryDefinition } from "@rms/contracts";
import { ModelDefinition } from "@rms/contracts";
import { childShape, ruleFields } from "./shape.js";
import { FUNCTIONS, checkNamedAction, checkNamedQuery, checkTemplate } from "./template-check.js";
import { TemplateError } from "./template.js";
import { NAMED_ACTIONS, NAMED_QUERIES, QUERY_KEYS, attackSql } from "./testing/fixtures.js";

// The real library packs, as built. @rms/models does not export them from its entry point yet,
// so they are loaded from its build output. Swap for a plain import once it does.
const packs = (await import(pathToFileURL(resolve(import.meta.dirname, "../node_modules/@rms/models/dist/packs/index.js")).href)) as {
  namedQueries: NamedQueryDefinition[];
  namedActions: NamedActionDefinition[];
};

const B = "o_e1e1e1e1e102";
const q = (sql: string, reads: string[] = ["tip_pool"], params: string[] = []) => checkTemplate({ sql, mode: "query", reads, writes: [], params });
const a = (sql: string, reads: string[] = ["tip_pool"], writes: string[] = ["cash_event"], params: string[] = []) => checkTemplate({ sql, mode: "action", reads, writes, params });
const FROM = "from {{tip_pool}} as tp";

describe("real library templates", () => {
  it("there are some", () => {
    expect(packs.namedQueries.length).toBeGreaterThanOrEqual(6);
    expect(packs.namedActions.length).toBeGreaterThanOrEqual(4);
  });
  for (const def of packs.namedQueries) {
    it(`the report "${def.key}" passes`, async () => {
      const checked = await checkNamedQuery(def);
      expect(checked.pieces.filter((p) => p.t === "read").length).toBeGreaterThan(0);
      expect(checked.pieces.some((p) => p.t === "target")).toBe(false);
    });
  }
  for (const def of packs.namedActions) {
    it(`the action "${def.key}" passes`, async () => {
      const checked = await checkNamedAction(def);
      const targets = checked.pieces.filter((p) => p.t === "target").map((p) => (p as { ref: string }).ref);
      expect(targets.length).toBeGreaterThan(0);
      for (const t of targets) expect(def.writes).toContain(t);
    });
  }
  it("an action's template is refused as a report, and the other way round", async () => {
    const action = packs.namedActions[0] as NamedActionDefinition;
    await expect(checkNamedQuery({ sql: action.sql, reads: [...action.reads, ...action.writes], params: action.params })).rejects.toThrow(TemplateError);
    const query = packs.namedQueries[0] as NamedQueryDefinition;
    await expect(checkNamedAction({ sql: query.sql, reads: query.reads, writes: ["sales_day"], params: query.params })).resolves.toBeTruthy(); // a plain select writes nothing
  });
  it("the test fixtures' own good templates pass and their bad ones do not", async () => {
    const bad = new Set<string>([QUERY_KEYS.writes, QUERY_KEYS.undeclared, QUERY_KEYS.attack]);
    for (const def of NAMED_QUERIES) {
      if (bad.has(def.key)) await expect(checkNamedQuery(def), def.key).rejects.toThrow(TemplateError);
      else await expect(checkNamedQuery(def), def.key).resolves.toBeTruthy();
    }
    for (const def of NAMED_ACTIONS) await expect(checkNamedAction(def), def.key).resolves.toBeTruthy();
  });
});

describe("the security review's attacks", () => {
  const attacks: Array<[string, string]> = [
    ["SQL hidden in a literal, run by ts_stat, after a role switch, read back with table_to_xml", attackSql(B)],
    ["table_to_xml on a name built from text", `select cast(table_to_xml(cast('${B}.tip_pool' as regclass), true, false, '') as text) as x ${FROM}`],
    ["ts_stat running a literal", `select s.word as x from ts_stat('select to_tsvector(set_config(''role'', ''${B}_rw'', true))') as s, {{tip_pool}} as tp`],
    ["set_config for locations inside a literal", `select s.word as x from ts_stat('select to_tsvector(set_config(''rms.locations'', ''all'', true))') as s, {{tip_pool}} as tp`],
    ["set_config('role','none') inside a literal", `select s.word as x from ts_stat('select to_tsvector(set_config(''role'', ''none'', false))') as s, {{tip_pool}} as tp`],
    ["set_config called directly", `select set_config('rms.locations', 'all', true) as x ${FROM}`],
    ["set_config, quoted name", `select "set_config"('role', 'none', true) as x ${FROM}`],
    ["schema_to_xml", `select cast(schema_to_xml('${B}', true, false, '') as text) as x ${FROM}`],
    ["query_to_xmlschema", `select cast(query_to_xmlschema('select 1', true, false, '') as text) as x ${FROM}`],
    ["query_to_xml", `select cast(query_to_xml('select * from platform.secrets', true, false, '') as text) as x ${FROM}`],
    ["database_to_xml", `select cast(database_to_xml(true, false, '') as text) as x ${FROM}`],
    ["ts_rewrite", `select ts_rewrite(to_tsquery('a'), 'select set_config(''role'',''none'',true)::tsquery, ''b''::tsquery') as x ${FROM}`],
    ["to_regclass", `select to_regclass('${B}.tip_pool') as x ${FROM}`],
    ["a cast to regclass", `select cast(tp.label as regclass) as x ${FROM}`],
    ["a :: cast to regclass", `select tp.label::regclass as x ${FROM}`],
    ["a cast to regproc", `select cast('set_config' as regproc) as x ${FROM}`],
    ["a cast to regrole", `select cast(tp.label as regrole) as x ${FROM}`],
    ["a cast to an unlisted type", `select cast(tp.label as json) as x ${FROM}`],
    ["a cast to an array type", `select cast(tp.label as text[]) as x ${FROM}`],
    ["select into", `select tp.id into stolen ${FROM}`],
    ["a bare table name", "select t.id from tip_pool as t"],
    ["a bare table name next to a placeholder", `select t.id ${FROM}, tip_pool as t`],
    ["a bare catalog-like name", `select r.rolname ${FROM}, roles as r`],
    ["a with name used before it is defined", `with a as (select b.n from b), b as (select 1 as n) select a.n from a, {{tip_pool}} as tp`],
    ["a with name used outside its statement", `select (select count(*) from (with hidden as (select 1 as n) select n from hidden) as h) as x ${FROM}, hidden as z`],
    ["a with name inside itself", `with secrets as (select s.id from secrets as s) select count(*) as x from secrets, {{tip_pool}} as tp`],
    ["a recursive query", `with recursive r as (select 1 as n union all select r.n + 1 from r) select count(*) as x from r, {{tip_pool}} as tp`],
    ["current_setting", `select current_setting('rms.org') as x ${FROM}`],
    ["rms.location_ok called by the template", `select rms.location_ok(tp.id) as x ${FROM}`],
    ["rms.current_org", `select rms.current_org() as x ${FROM}`],
    ["a schema-qualified function", `select extensions.gen_random_uuid() as x ${FROM}`],
    ["a schema-qualified column", `select other.tp.id as x ${FROM}`],
    ["a function used as a table", `select s.x from json_each_text('{}') as s(x, y), {{tip_pool}} as tp`],
    ["unnest as a table", `select u.x from unnest(array[1, 2]) as u(x), {{tip_pool}} as tp`],
    ["generate_series with a column definition list", `select g.n from generate_series(1, 2) as g(n int), {{tip_pool}} as tp`],
    ["a regular expression operator", `select tp.id as x ${FROM} where tp.label ~ '(a+)+$'`],
    ["similar to", `select tp.id as x ${FROM} where tp.label similar to '(a|b)*'`],
    ["a schema-qualified operator", `select 1 operator(pg_catalog.+) 1 as x ${FROM}`],
    ["a row lock", `select tp.id as x ${FROM} for update`],
    ["a placeholder where a column goes", `select {{tip_pool}} as x ${FROM}`],
    ["a placeholder with a schema in front", `select x.id from other.{{tip_pool}} as x`],
    ["a placeholder called like a function", `select x.id from {{tip_pool}}(1) as x`],
    ["a marker name written by hand", "select x.id from rmsx_read_0 as x"],
    ["two statements", `select tp.id as x ${FROM}; select 1`],
    ["xml building", `select cast(xmlelement(name a, tp.label) as text) as x ${FROM}`],
    ["json building", `select json_agg(tp.label) as x ${FROM}`],
    ["string_agg", `select string_agg(tp.label, ',') as x ${FROM}`],
    ["format", `select format('%s', tp.label) as x ${FROM}`],
    ["a named window frame function not on the list", `select lag(tp.amount) over (order by tp.id) as x ${FROM}`],
    ["row values", `select row(tp.id, tp.label) as x ${FROM}`],
    ["a collation", `select tp.label collate "C" as x ${FROM}`],
    ["a value keyword that names the role", `select current_user as x ${FROM}`],
    ["an insert, in a report", `with x as (insert into {{tip_pool}} (id) select gen_random_uuid() returning id) select count(*) as n from x`],
  ];
  for (const [what, sql] of attacks) {
    it(`refuses ${what}`, async () => {
      await expect(q(sql)).rejects.toThrow(TemplateError);
    });
  }

  it("the allow list does the refusing, not only the word scanner: none of these words is on the scanner's list", async () => {
    for (const sql of [`select to_regclass('x') as x ${FROM}`, `select ts_rewrite(tp.label, 'select 1') as x ${FROM}`, `select schema_to_xml('x', true, false, '') as x ${FROM}`, `select t.id from tip_pool as t`]) {
      const { parseTemplate } = await import("./template.js");
      expect(() => parseTemplate({ sql, mode: "query", reads: ["tip_pool"], writes: [], params: [] })).not.toThrow();
      await expect(q(sql)).rejects.toThrow(TemplateError);
    }
  });

  it("allows what reports need", async () => {
    const fine = [
      `select tp.id::text as id, cast(tp.amount as bigint) as amount, coalesce(tp.label, 'none') as label ${FROM} where tp.amount between 1 and 5 or tp.label like 'a%' or tp.label ilike '%b'`,
      `select sum(tp.amount) filter (where tp.amount > 0) as total, count(distinct tp.label) as labels, row_number() over (partition by tp.label order by tp.amount desc) as n ${FROM} group by tp.label, tp.amount having sum(tp.amount) > 0 order by 1 desc limit 10 offset 2`,
      `with a as (select tp.id, tp.amount ${FROM}), b as (select a.id from a where exists (select 1 from a as inner_a where inner_a.id = a.id)) select b.id from b union all select a.id from a`,
      `select g.n, extract(year from now()) as y, date_trunc('week', current_date) as w, to_char(now(), 'YYYY') as t from generate_series(1, 3) as g(n) cross join lateral (select tp.amount ${FROM} limit 1) as r`,
      `select case when tp.amount is null then 0 else greatest(tp.amount, 1) end as x, nullif(tp.amount, 0) as y, tp.label in ('a', 'b') as z, (array['a', 'b'])[1] as first, SUM(tp.amount) as shouted ${FROM} group by tp.amount, tp.label`,
      `select tp.id ${FROM} where tp.label = :label and (cast(:day as date) is null or tp.amount > 0)`,
    ];
    await expect(q(fine[0] as string)).resolves.toBeTruthy();
    await expect(q(fine[1] as string)).resolves.toBeTruthy();
    await expect(q(fine[2] as string)).resolves.toBeTruthy();
    await expect(q(fine[3] as string)).resolves.toBeTruthy();
    await expect(q(fine[4] as string)).resolves.toBeTruthy();
    await expect(q(fine[5] as string, ["tip_pool"], ["label", "day"])).resolves.toBeTruthy();
  });

  it("an action may only insert rows from a select into its declared targets", async () => {
    const good = "with ev as (insert into {{cash_event}} (id, amount) select gen_random_uuid(), tp.amount from {{tip_pool}} as tp on conflict do nothing returning id) select count(*) as affected from ev";
    await expect(a(good)).resolves.toBeTruthy();
    await expect(a("insert into {{cash_event}} (id, amount) select gen_random_uuid(), tp.amount from {{tip_pool}} as tp on conflict (id) do nothing")).resolves.toBeTruthy();
    const bad = [
      good.replace("on conflict do nothing", "on conflict (id) do update set amount = excluded.amount"),
      good.replace("insert into {{cash_event}}", "insert into cash_event"),
      good.replace("{{cash_event}} (id, amount)", "{{cash_event}} (id, amount, id)"),
      "insert into {{cash_event}} (id) default values",
      "with x as (update {{tip_pool}} set amount = 0 returning id) select count(*) as affected from x",
      "with x as (delete from {{tip_pool}} as tp returning tp.id) select count(*) as affected from x",
      "with x as (merge into {{cash_event}} as c using {{tip_pool}} as tp on true when matched then do nothing) select 1 as affected",
      // a data-changing part hidden one level down
      "select (with ev as (insert into {{cash_event}} (id) select gen_random_uuid() returning id) select count(*) from ev) as affected from {{tip_pool}} as tp",
      good.replace("select count(*) as affected from ev", "select count(*) as affected from ev, ts_stat('select 1') as s"),
      good.replace("gen_random_uuid()", "set_config('role', 'none', true)"),
      good.replace("returning id", "returning id into stolen"),
    ];
    for (const sql of bad) await expect(a(sql), sql).rejects.toThrow(TemplateError);
    // the same statement as a report is refused: reports never insert
    await expect(q(good, ["tip_pool"])).rejects.toThrow(TemplateError);
  });

  it("keeps the function list short and free of anything that reads text as SQL, a table or a setting", () => {
    expect(FUNCTIONS.size).toBeLessThanOrEqual(30);
    for (const name of FUNCTIONS) expect(name).not.toMatch(/xml|regclass|config|setting|query|exec|eval|dblink|ts_|^pg_|^lo_|json|format|current_/);
  });
});

describe("fields tied to a hidden field by a rule", () => {
  const def = ModelDefinition.parse({
    key: "tip_pool", pack: "custom", version: 1, name: "Tip pools", description: "Tips collected for one business date.",
    fields: [
      { key: "label", label: "Name", type: "text" },
      { key: "headcount", label: "Headcount", type: "integer" },
      { key: "day", label: "Day", type: "date" },
      { key: "hourly_rate", label: "Hourly rate", type: "money", readableBy: ["owner"] },
      { key: "account", label: "Account", type: "ref", model: "account" },
    ],
    rules: [
      { kind: "check", name: "rate_cap", message: "m", expr: { op: "or", args: [{ op: "is_null", arg: { field: "hourly_rate" } }, { op: "lte", args: [{ field: "hourly_rate" }, { op: "mul", args: [{ field: "headcount" }, { lit: 1000 }] }] }] } },
      { kind: "check", name: "label_ok", message: "m", expr: { op: "ne", args: [{ field: "label" }, { lit: "" }] } },
      { kind: "ref_value_in", name: "account_kind", field: "account", refField: "type", allowed: ["liability"], when: { op: "gt", args: [{ field: "hourly_rate" }, { lit: 0 }] }, message: "m" },
      { kind: "open_period_only", name: "open", dateField: "day" },
    ],
    defaultAccess: { owner: "write", staff: "write" },
  });

  it("finds every field a rule looks at, for every kind of rule", () => {
    expect(def.rules.map((r) => [...ruleFields(r)].sort())).toEqual([["headcount", "hourly_rate"], ["label"], ["account", "hourly_rate"], ["day"]]);
  });

  it("guards the visible fields that share a rule with a hidden one, for the role that cannot see it", () => {
    expect([...childShape(def, "staff").guarded].sort()).toEqual(["account", "headcount"]);
    expect([...childShape(def, "owner").guarded]).toEqual([]);
  });
});
