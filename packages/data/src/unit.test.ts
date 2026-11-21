// Unit tests that need no database: the template scanner, cursors, the filter builder, value
// checks and the error mapping. The database-backed suite is apps/api/src/routes/data.test.ts.
import { describe, expect, it } from "vitest";
import { type Filter, ModelDefinition } from "@rms/contracts";
import { canonical, decodeCursor, encodeCursor, sha256 } from "./cursor.js";
import { DataApiError, errorResponse, toDataApiError } from "./errors.js";
import { afterCursor, compileFilter, resolveSort } from "./filter.js";
import { childShape, parentShape } from "./shape.js";
import { Params } from "./sql.js";
import { type Piece, TemplateError, parseTemplate, renderTemplate } from "./template.js";
import { writeColumns } from "./values.js";

// Not a real secret: a fixed value so cursor signing works without the local env file.
process.env.RMS_TOKEN_SECRET ??= "unit-test-only-not-a-real-secret-000000000000";

// ---------------------------------------------------------------- real library templates
// Copied from the library packs (task C2, packages/models/src/packs) as test inputs.

const SALES_BY_LOCATION = `select cast(sd.location_id as text) as location_id,
       loc.name as location_name,
       cast(sum(sd.net_sales) as bigint) as net_sales,
       cast(sum(sd.gross_sales) as bigint) as gross_sales,
       cast(sum(sd.discounts) as bigint) as discounts,
       cast(sum(sd.comps) as bigint) as comps,
       cast(sum(coalesce(sd.guests, 0)) as bigint) as guests,
       cast(sum(coalesce(sd.checks, 0)) as bigint) as checks,
       round(100.0 * sum(sd.net_sales) / nullif(sum(sum(sd.net_sales)) over (), 0), 1) as share_pct
from {{sales_day}} as sd
left join {{parent.locations}} as loc on loc.id = sd.location_id
where sd.business_date between cast(:from_date as date) and cast(:to_date as date)
group by sd.location_id, loc.name
order by loc.name, sd.location_id`;

const SALES_BY_DAY = `with cal as (
  select fc.id
  from {{fiscal_calendar}} as fc
  where fc.active
  order by fc.id
  limit 1
),
wk as (
  select fw.start_date, fw.end_date
  from {{fiscal_week}} as fw
  where fw.calendar = (select cal.id from cal)
    and cast(:week_of as date) between fw.start_date and fw.end_date
)
select sd.business_date as business_date,
       cast(sum(sd.net_sales) as bigint) as net_sales,
       cast(sum(coalesce(sd.guests, 0)) as bigint) as guests
from {{sales_day}} as sd
join wk on sd.business_date between wk.start_date and wk.end_date
where (cast(:location_id as uuid) is null or sd.location_id = cast(:location_id as uuid))
group by sd.business_date
order by sd.business_date`;

const POST_LABOUR_DAY = `with ld as (
  select d.id, d.location_id, d.currency, d.business_date, d.job_group, d.labour_cost
  from {{labour_day}} as d
  where d.id = cast(:labour_day_id as uuid)
),
simple_rule as (
  select distinct on (pr.part) pr.part, pr.account
  from {{posting_rule}} as pr
  where pr.active
  order by pr.part, pr.id
),
parts as (
  select 10 as line_order, 'Staff cost, ' || replace(ld.job_group, '_', ' ') as memo, r.account as account, ld.labour_cost as signed
  from ld
  left join lateral (
    select pr.account
    from {{posting_rule}} as pr
    where pr.active
      and pr.part = 'labour_cost'
      and (pr.job_group = ld.job_group or pr.job_group is null)
    order by (pr.job_group is null), pr.id
    limit 1
  ) as r on true
  union all
  select 20, 'Wages owed', r.account, -ld.labour_cost
  from ld
  left join simple_rule as r on r.part = 'labour_payable'
),
entry as (
  insert into {{journal_entry}} (id, location_id, business_date, memo, origin, origin_id, source, source_id, created_by, updated_by)
  select gen_random_uuid(), src.location_id, src.business_date, 'Staff cost', 'labour_day', cast(src.id as text), 'app', 'labour_day/' || cast(src.id as text), rms.current_actor(), rms.current_actor()
  from ld as src
  where exists (select 1 from parts as p where p.signed <> 0)
  on conflict do nothing
  returning id, location_id
),
lines as (
  insert into {{journal_line}} (id, location_id, currency, entry, line_number, account, debit, credit, memo, source, created_by, updated_by)
  select gen_random_uuid(), e.location_id, src.currency, e.id, row_number() over (order by p.line_order, p.memo), p.account, greatest(p.signed, 0), greatest(-p.signed, 0), p.memo, 'app', rms.current_actor(), rms.current_actor()
  from entry as e
  cross join ld as src
  cross join parts as p
  where p.signed <> 0
  returning id
)
select (select count(*) from entry) + (select count(*) from lines) as affected`;

const fake = (pieces: Piece[]): string =>
  renderTemplate(pieces, { read: (ref) => `SUB<${ref}>`, target: (ref, cols) => `TABLE<${ref}> (${cols.join(", ")})`, param: (key) => `BOUND<${key}>` });
const q = (sql: string, reads: string[] = ["tip_pool"], params: string[] = []) => parseTemplate({ sql, mode: "query", reads, writes: [], params });
const a = (sql: string, reads: string[] = ["tip_pool"], writes: string[] = ["cash_event"], params: string[] = []) => parseTemplate({ sql, mode: "action", reads, writes, params });

describe("named templates", () => {
  it("expands a real report: subqueries without an alias of our own, parameters bound", () => {
    const pieces = q(SALES_BY_LOCATION, ["sales_day", "parent.locations"], ["from_date", "to_date"]);
    expect(pieces.filter((p) => p.t === "read").map((p) => (p as { ref: string }).ref)).toEqual(["sales_day", "parent.locations"]);
    const text = fake(pieces);
    expect(text).toContain("from (SUB<sales_day>) as sd");
    expect(text).toContain("left join (SUB<parent.locations>) as loc on loc.id = sd.location_id");
    expect(text).toContain("between cast(BOUND<from_date> as date) and cast(BOUND<to_date> as date)");
    expect(text).not.toMatch(/\{\{|\}\}|:from_date|:to_date/);
  });

  it("expands a real report with a repeated optional parameter", () => {
    const pieces = q(SALES_BY_DAY, ["sales_day", "fiscal_calendar", "fiscal_week"], ["week_of", "location_id"]);
    expect(pieces.filter((p) => p.t === "param").map((p) => (p as { key: string }).key)).toEqual(["week_of", "location_id", "location_id"]);
    expect(fake(pieces)).toContain("where (cast(BOUND<location_id> as uuid) is null or sd.location_id = cast(BOUND<location_id> as uuid))");
  });

  it("expands a real action: insert targets become bare tables with their column list", () => {
    const pieces = a(POST_LABOUR_DAY, ["labour_day", "posting_rule"], ["journal_entry", "journal_line"], ["labour_day_id"]);
    const targets = pieces.filter((p) => p.t === "target") as Array<{ ref: string; columns: string[] }>;
    expect(targets.map((t) => t.ref)).toEqual(["journal_entry", "journal_line"]);
    expect(targets[0]?.columns).toEqual(["id", "location_id", "business_date", "memo", "origin", "origin_id", "source", "source_id", "created_by", "updated_by"]);
    expect(pieces.filter((p) => p.t === "read").map((p) => (p as { ref: string }).ref)).toEqual(["labour_day", "posting_rule", "posting_rule"]);
    const text = fake(pieces);
    expect(text).toContain("insert into TABLE<journal_entry> (id, location_id, business_date, memo, origin, origin_id, source, source_id, created_by, updated_by)\n  select gen_random_uuid()");
    expect(text).toContain("from (SUB<labour_day>) as d");
    expect(text).toContain("rms.current_actor()");
    expect(text).toContain("on conflict do nothing");
    expect(text.trimEnd().endsWith("as affected")).toBe(true);
  });

  it("leaves casts and text literals alone", () => {
    const text = fake(q("select tp.id::text as id, ':not_a_param' as a, '{{not_a_ref}}' as b, 'it''s; fine -- really' as c, tp.amount::numeric(18,2) from {{tip_pool}} as tp where tp.label = :label", ["tip_pool"], ["label"]));
    expect(text).toBe("select tp.id::text as id, ':not_a_param' as a, '{{not_a_ref}}' as b, 'it''s; fine -- really' as c, tp.amount::numeric(18,2) from (SUB<tip_pool>) as tp where tp.label = BOUND<label>");
  });

  const refusedQueries: Array<[string, string]> = [
    ["a semicolon in the middle", "select 1 from {{tip_pool}} as tp; select 2"],
    ["a trailing semicolon", "select 1 from {{tip_pool}} as tp;"],
    ["a line comment", "select 1 from {{tip_pool}} as tp -- where tp.id is null"],
    ["a block comment", "select 1 /* hidden */ from {{tip_pool}} as tp"],
    ["a numbered placeholder of its own", "select 1 from {{tip_pool}} as tp where tp.id = $1"],
    ["dollar quoting", "select $$x$$ from {{tip_pool}} as tp"],
    ["a model it did not declare", "select 1 from {{owner_ledger}} as ol"],
    ["parent data it did not declare", "select 1 from {{parent.staff}} as s"],
    ["something that is not a model name", "select 1 from {{tip_pool; drop table x}} as tp"],
    ["a schema-qualified reference", "select 1 from {{o_e1e1e1e1e102.tip_pool}} as tp"],
    ["a parameter it did not declare", "select 1 from {{tip_pool}} as tp where tp.id = :id"],
    ["a delete inside a common table expression", "with gone as (delete from {{tip_pool}} as tp returning tp.id) select count(*) from gone"],
    ["an update", "with x as (update {{tip_pool}} set amount = 0 returning id) select count(*) from x"],
    ["an insert", "with x as (insert into {{tip_pool}} (id) values (gen_random_uuid()) returning id) select count(*) from x"],
    ["a merge", "with x as (merge into t using s on true when matched then do nothing) select 1 from {{tip_pool}} as tp"],
    ["a settings change through a function", "select set_config('role', 'postgres', true) from {{tip_pool}} as tp"],
    ["a system function", "select pg_sleep(10) from {{tip_pool}} as tp"],
    ["a system catalog", "select 1 from pg_roles, {{tip_pool}} as tp"],
    ["a platform table", "select 1 from platform.secrets, {{tip_pool}} as tp"],
    ["a platform table, quoted", 'select 1 from "platform".secrets, {{tip_pool}} as tp'],
    ["a platform table, with a gap", "select 1 from platform . secrets, {{tip_pool}} as tp"],
    ["another restaurant's schema", "select 1 from o_e1e1e1e1e102.tip_pool as x, {{tip_pool}} as tp"],
    ["another restaurant's schema, quoted", 'select 1 from "o_e1e1e1e1e102"."tip_pool" as x, {{tip_pool}} as tp'],
    ["the auth schema", "select 1 from auth.users as u, {{tip_pool}} as tp"],
    ["large object functions", "select lo_import('/etc/passwd') from {{tip_pool}} as tp"],
    ["dblink", "select * from dblink('x', 'select 1') as t(a int), {{tip_pool}} as tp"],
    ["an escape string", "select E'a\\'b' from {{tip_pool}} as tp"],
    ["a unicode escape string", "select U&'d\\0061t' from {{tip_pool}} as tp"],
    ["a text literal that is not closed", "select 'abc from {{tip_pool}} as tp"],
    ["a quoted name that is not closed", 'select "abc from {{tip_pool}} as tp'],
    ["a model reference that is not closed", "select 1 from {{tip_pool as tp"],
    ["a stray brace", "select 1 from {{tip_pool}} as tp where tp.label = {x}"],
    ["a stray colon", "select arr[1:2] from {{tip_pool}} as tp"],
    ["a statement that is not a select", "drop table tip_pool"],
    ["a settings statement", "set role postgres"],
    ["a bracketed start", "(select 1 from {{tip_pool}} as tp)"],
    ["nothing at all", "   "],
  ];
  for (const [what, sql] of refusedQueries) {
    it(`refuses a report with ${what}`, () => {
      expect(() => q(sql)).toThrow(TemplateError);
    });
  }

  it("refuses an action that steps outside its rules", () => {
    const good = "with ev as (insert into {{cash_event}} (id, amount) select gen_random_uuid(), tp.amount from {{tip_pool}} as tp on conflict do nothing returning id) select count(*) as affected from ev";
    expect(a(good).some((p) => p.t === "target")).toBe(true);
    expect(() => a(good.replace("{{cash_event}}", "{{tip_pool}}"))).toThrow(TemplateError); // insert target not in writes
    expect(() => a(good.replace("{{cash_event}} (id, amount)", "{{cash_event}}"))).toThrow(TemplateError); // no column list
    expect(() => a(good.replace("(id, amount)", "(id, amount, id)"))).toThrow(TemplateError); // a column twice
    expect(() => a(good.replace("(id, amount)", '(id, "amount; drop")'))).toThrow(TemplateError);
    expect(() => a(good.replace("{{tip_pool}} as tp", "{{cash_event}} as tp"))).toThrow(TemplateError); // reads a model only listed in writes
    expect(() => a(good.replace("insert into {{cash_event}}", "insert into o_e1e1e1e1e102.cash_event"))).toThrow(TemplateError);
    expect(() => a(good.replace("insert into {{cash_event}}", "insert into cash_event"))).not.toThrow(); // no such table on the search path: the database refuses it
    expect(() => a("with x as (update {{tip_pool}} set amount = 0 returning id) select count(*) as affected from x")).toThrow(TemplateError);
    expect(() => a("with x as (delete from {{tip_pool}} as tp returning tp.id) select count(*) as affected from x")).toThrow(TemplateError);
    expect(() => a(`${good}; select 1`)).toThrow(TemplateError);
    expect(() => a("truncate cash_event")).toThrow(TemplateError);
    // `on conflict ... do update` is part of an insert and stays allowed
    expect(() => a("insert into {{cash_event}} (id, amount) select tp.id, tp.amount from {{tip_pool}} as tp on conflict (id) do update set amount = excluded.amount")).not.toThrow();
    // a query may never contain an insert target
    expect(() => q(good, ["tip_pool"])).toThrow(TemplateError);
  });
});

// ---------------------------------------------------------------- cursors
describe("cursors", () => {
  const binding = sha256(canonical({ org: "a", model: "tip_pool", where: null, sort: [["amount", "asc"]] }));

  it("round-trips, including empty values", () => {
    expect(decodeCursor(encodeCursor(binding, ["12", null, "x"]), binding, 3)).toEqual(["12", null, "x"]);
  });

  it("refuses a cursor that was changed, cut, or made for another question", () => {
    const c = encodeCursor(binding, ["12", "id"]);
    const [payload, mac] = c.split(".") as [string, string];
    const other = Buffer.from(JSON.stringify({ b: binding, k: ["0", "id"] })).toString("base64url");
    const bad = [`${other}.${mac}`, `${payload}.${mac.slice(0, -2)}AA`, payload, `${payload}.`, `.${mac}`, "", "a.b.c", `${payload}.${mac}.x`];
    for (const x of bad) expect(() => decodeCursor(x, binding, 2), x).toThrow(DataApiError);
    expect(() => decodeCursor(c, sha256(canonical({ org: "b" })), 2)).toThrow(DataApiError);
    expect(() => decodeCursor(c, binding, 3)).toThrow(DataApiError);
    expect(decodeCursor(c, binding, 2)).toEqual(["12", "id"]);
  });

  it("canonical JSON does not depend on key order", () => {
    expect(canonical({ a: 1, b: [{ y: 2, x: 1 }] })).toBe(canonical({ b: [{ x: 1, y: 2 }], a: 1 }));
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: "1" }));
  });
});

// ---------------------------------------------------------------- filters and values
const def = ModelDefinition.parse({
  key: "tip_pool", pack: "custom", version: 1, name: "Tip pools", description: "Tips collected for one business date.",
  fields: [
    { key: "label", label: "Name", type: "text", required: true, maxLength: 20 },
    { key: "amount", label: "Amount", type: "money", required: true },
    { key: "hourly_rate", label: "Hourly rate", type: "money", sensitivity: "payroll", readableBy: ["owner"] },
    { key: "status", label: "Status", type: "enum", values: ["open", "closed"] },
    { key: "share", label: "Share", type: "decimal", scale: 2 },
    { key: "weight", label: "Weight", type: "quantity" },
    { key: "notes", label: "Notes", type: "json" },
    { key: "staff", label: "Staff", type: "parent_ref", parentModel: "staff" },
  ],
  defaultAccess: { owner: "write", staff: "write" },
});
const asOwner = childShape(def, "owner");
const asStaff = childShape(def, "staff");

/** The only characters and words our own SQL fragments are ever made of. */
const SAFE_SQL = /^[a-z0-9_"$:()<>=,.\s]*$/;

describe("filter builder", () => {
  const hostile = ["'; drop table tip_pool; --", '" or 1=1 --', "$99 or true", "\\", "label); delete from x; --", "0; select pg_sleep(9)", "\u0000", "%' or '1'='1"];

  it("binds every value and builds SQL from known names only", () => {
    for (const h of hostile.filter((x) => !x.includes("\u0000"))) {
      const p = new Params();
      const f: Filter = { and: [{ field: "label", op: "eq", value: h }, { or: [{ field: "label", op: "contains", value: h }, { field: "label", op: "in", value: [h, "x"] }] }, { not: { field: "label", op: "starts_with", value: h } }] };
      const sql = compileFilter(asOwner, f, p);
      expect(sql, sql).toMatch(SAFE_SQL);
      expect(sql).not.toContain(h);
      expect(p.values).toEqual([h, h, h, "x", h]);
    }
  });

  it("refuses a hostile or unknown field name before any SQL exists", () => {
    for (const h of [...hostile, "id; drop", "tip_pool.label", "label as x", "hourly_rate_", "staff_label", "weight_unit", "LABEL"]) {
      const err = (() => {
        try {
          compileFilter(asOwner, { field: h, op: "is_null", value: true }, new Params());
        } catch (e) {
          return e;
        }
      })();
      expect(err, h).toBeInstanceOf(DataApiError);
      expect((err as DataApiError).code).toBe("invalid_request");
    }
  });

  it("refuses a field the role cannot read, in a filter and in a sort", () => {
    expect(() => compileFilter(asStaff, { field: "hourly_rate", op: "gt", value: 1 }, new Params())).toThrow(expect.objectContaining({ code: "forbidden_field" }));
    expect(() => compileFilter(asStaff, { not: { or: [{ field: "label", op: "eq", value: "x" }, { field: "hourly_rate", op: "is_null", value: false }] } }, new Params())).toThrow(expect.objectContaining({ code: "forbidden_field" }));
    expect(() => resolveSort(asStaff, [{ field: "hourly_rate", dir: "asc" }])).toThrow(expect.objectContaining({ code: "forbidden_field" }));
    expect(compileFilter(asOwner, { field: "hourly_rate", op: "gt", value: 1 }, new Params())).toBe('"hourly_rate" > ($1::text)::bigint');
    expect(asStaff.masked).toEqual(["hourly_rate"]);
  });

  it("refuses values and operators that do not fit the field", () => {
    const bad: Filter[] = [
      { field: "amount", op: "eq", value: "1" }, { field: "amount", op: "eq", value: 1.5 }, { field: "amount", op: "eq", value: null },
      { field: "amount", op: "contains", value: "1" }, { field: "notes", op: "eq", value: "x" }, { field: "weight", op: "gt", value: 1 },
      { field: "id", op: "eq", value: "nope" }, { field: "id", op: "gt", value: "0193a3c0-0000-7000-8000-0000000000e1" },
      { field: "created_at", op: "gt", value: "2026-11-15" }, { field: "label", op: "in", value: ["a", 1] }, { field: "share", op: "eq", value: "1e5" },
    ];
    for (const f of bad) expect(() => compileFilter(asOwner, f, new Params()), JSON.stringify(f)).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });

  it("builds a stable keyset condition for mixed directions and empty values", () => {
    const sort = resolveSort(asOwner, [{ field: "status", dir: "desc" }, { field: "amount", dir: "asc" }]);
    expect(sort.map((s) => s.attr.key)).toEqual(["status", "amount", "id"]);
    const p = new Params();
    const sql = afterCursor(sort, [null, "500", "0193a3c0-0000-7000-8000-0000000000e1"], p);
    expect(sql).toMatch(SAFE_SQL);
    expect(sql).toContain('"status" is not null');
    expect(sql).toContain('("status" is null and ("amount" > ($1::text)::bigint or "amount" is null))');
    expect(p.values).toEqual(["500", "500", "0193a3c0-0000-7000-8000-0000000000e1"]);
  });
});

describe("shapes and write values", () => {
  it("follows the storage contract for columns", () => {
    expect(asOwner.list.map((x) => x.key)).toEqual(["id", "location_id", "currency", "source", "source_id", "created_at", "created_by", "updated_at", "updated_by", "deleted_at", "label", "amount", "hourly_rate", "status", "share", "weight", "notes", "staff"]);
    expect(asOwner.attrs.get("weight")?.extra).toBe("weight_unit");
    expect(asOwner.attrs.get("staff")?.extra).toBe("staff_label");
    expect(asOwner.list.filter((x) => x.settable && x.system).map((x) => x.key)).toEqual(["location_id", "currency"]);
    const appendOnly = childShape(ModelDefinition.parse({ ...def, key: "cash_event", appendOnly: true, locationScoped: false, fields: [{ key: "memo", label: "Memo", type: "text" }] }), "owner");
    expect(appendOnly.list.map((x) => x.key)).toEqual(["id", "source", "source_id", "created_at", "created_by", "updated_at", "updated_by", "memo"]);
  });

  it("hides pay and contact details in parent data by role, and from every draft request", () => {
    expect(parentShape("staff", "owner", "live").masked).toEqual([]);
    expect(parentShape("staff", "staff", "live").masked).toEqual(["email", "phone", "hourly_rate_minor"]);
    expect(parentShape("staff", "owner", "draft").masked).toEqual(["email", "phone", "hourly_rate_minor"]);
    for (const key of ["profile", "locations", "jobs", "menu_items"] as const) expect(parentShape(key, "staff", "draft").list.every((x) => !x.settable)).toBe(true);
  });

  it("checks write values against the field format table", () => {
    const attr = (k: string) => asOwner.attrs.get(k)!;
    expect(writeColumns(attr("amount"), 1250)).toEqual([{ column: "amount", value: "1250", kind: "money" }]);
    expect(writeColumns(attr("share"), "12.50")).toEqual([{ column: "share", value: "12.50", kind: "decimal" }]);
    expect(writeColumns(attr("weight"), { value: "2.5", unit: "kg" })).toEqual([{ column: "weight", value: "2.5", kind: "quantity" }, { column: "weight_unit", value: "kg", kind: "text" }]);
    expect(writeColumns(attr("weight"), null)).toEqual([{ column: "weight", value: null, kind: "quantity" }, { column: "weight_unit", value: null, kind: "text" }]);
    expect(writeColumns(attr("notes"), { a: [1, "x"] })).toEqual([{ column: "notes", value: '{"a":[1,"x"]}', kind: "json" }]);
    const bad: Array<[string, unknown]> = [
      ["amount", "1250"], ["amount", 12.5], ["amount", Number.MAX_SAFE_INTEGER + 2], ["share", 12.5], ["share", "1.234"], ["share", "12345678901234567.00"],
      ["status", "weird"], ["label", "x".repeat(21)], ["label", 5], ["label", null], ["label", "nul\u0000"], ["weight", { value: "2", unit: "KG!" }],
      ["weight", { value: "2", unit: "kg", org: "x" }], ["weight", "2kg"],
    ];
    for (const [k, v] of bad) expect(() => writeColumns(attr(k), v), `${k}=${JSON.stringify(v)}`).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });
});

// ---------------------------------------------------------------- errors
describe("database errors", () => {
  const DB_TEXT = 'SECRET-DB-TEXT relation "o_e1e1e1e1e102.tip_pool" Key (email)=(casey@taskd-b.test)';
  const pg = (code: string, more: Record<string, unknown> = {}) => Object.assign(new Error(DB_TEXT), { name: "PostgresError", code, detail: DB_TEXT, ...more });

  it("maps each database failure to one of our codes", () => {
    const code = (c: string, hints = {}, more = {}) => toDataApiError(pg(c, more), hints).code;
    expect(code("23505")).toBe("conflict");
    expect(code("23503", { op: "write" })).toBe("invalid_request");
    expect(code("23503", { op: "delete" })).toBe("conflict");
    expect(code("23502")).toBe("invalid_request");
    expect(code("23514")).toBe("invalid_request");
    expect(code("57014")).toBe("limit");
    expect(code("22P02")).toBe("invalid_request");
    expect(code("40001")).toBe("conflict");
    expect(code("42703", { op: "named", hasMaskedFields: true })).toBe("forbidden_field");
    expect(code("42703", { op: "named", hasMaskedFields: false })).toBe("internal");
    expect(code("42601")).toBe("internal");
    expect(code("25006")).toBe("internal");
    expect(code("42501")).toBe("forbidden_model");
    expect(toDataApiError(Object.assign(new Error('new row violates row-level security policy for table "x"'), { name: "PostgresError", code: "42501" })).code).toBe("forbidden_location");
    expect(toDataApiError(new TypeError("boom")).code).toBe("internal");
  });

  it("tells a broken model rule apart by the compiler's constraint name", () => {
    const models = [{
      key: "journal_entry",
      rules: ModelDefinition.parse({ ...def, key: "journal_entry", rules: [
        { kind: "balanced", name: "entry_balances", lineModel: "journal_line", lineRef: "entry", debit: "debit", credit: "credit" },
        { kind: "open_period_only", name: "period_open", dateField: "business_date" },
        { kind: "check", name: "memo_present", expr: { op: "not", arg: { op: "is_null", arg: { field: "label" } } }, message: "An entry needs a memo." },
      ] }).rules,
    }];
    const hit = (constraint_name: string) => toDataApiError(pg("23514", { constraint_name }), { op: "write", models });
    expect(hit("journal_entry_entry_balances_rule_0a1b2c3d")).toMatchObject({ code: "conflict", message: expect.stringMatching(/does not balance/) });
    expect(hit("journal_entry_period_open_rule_ffffffff")).toMatchObject({ code: "conflict", message: expect.stringMatching(/closed/) });
    expect(hit("journal_entry_memo_present_rule_12345678")).toMatchObject({ code: "invalid_request", message: "An entry needs a memo." });
    expect(hit("journal_entry_status_check")).toMatchObject({ code: "invalid_request" });
    expect(hit("other_model_entry_balances_rule_0a1b2c3d").code).toBe("invalid_request");
  });

  it("never passes database text on", () => {
    for (const c of ["23505", "23503", "23514", "42501", "42703", "42601", "57014", "22P02", "P0001", "XX000"]) {
      const out = errorResponse(pg(c, { constraint_name: "tip_pool_label_key", table_name: "tip_pool" }), "req-1", "batch", { op: "write" });
      const text = JSON.stringify(out.body);
      expect(text).not.toMatch(/SECRET-DB-TEXT|relation|o_e1e1|casey|tip_pool_label_key/);
      expect(Object.keys(out.body.error).sort()).toEqual(["code", "message", "requestId"]);
      expect(out.status).toBeGreaterThanOrEqual(400);
    }
  });
});
