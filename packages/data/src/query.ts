// POST /data/v1/query: read rows of one model, with filter, sort, pages and totals.
import { QueryRequest, type QueryResponse, type Row, type TenantContext } from "@rms/contracts";
import { type Tx, ident } from "@rms/db";
import { shapesFor } from "./access.js";
import { canonical, decodeCursor, encodeCursor, sha256 } from "./cursor.js";
import { DataApiError } from "./errors.js";
import { SORTABLE, type SortItem, afterCursor, attrOf, compileFilter, cursorExprs, orderBy, resolveSort } from "./filter.js";
import { withPlatform } from "./platform.js";
import { type Attr, type Kind, type Shape, baseConditions, decode, selectExprs, tableOf, textExpr } from "./shape.js";
import { Params, readOnlyStore, run } from "./sql.js";

const SUMMABLE: ReadonlySet<Kind> = new Set<Kind>(["integer", "money", "decimal"]);
const RANGEABLE: ReadonlySet<Kind> = new Set<Kind>(["integer", "money", "decimal", "date", "business_date", "timestamp", "text", "enum"]);
const MAX_GROUPS = 1000;

type Totals = NonNullable<QueryRequest["totals"]>;
type Aggregate = Totals["aggregates"][number];

type AggPlan = { as: string; sql: string; read: (v: unknown) => unknown };

const trimZeros = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
const wholeNumber = (v: unknown): unknown => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : String(v);
};

const planAggregate = (shape: Shape, a: Aggregate): AggPlan => {
  if (a.fn === "count") {
    const target = a.field === undefined ? "*" : ident(attrOf(shape, a.field).key);
    return { as: a.as, sql: `count(${target})::text`, read: (v) => Number(v ?? 0) };
  }
  if (a.field === undefined) throw new DataApiError("invalid_request", "A total needs to say which detail to add up.");
  const attr = attrOf(shape, a.field);
  const col = ident(attr.key);
  const refuse = (): never => {
    throw new DataApiError("invalid_request", `"${attr.label}" cannot be totalled that way.`);
  };
  switch (a.fn) {
    case "sum":
      if (!SUMMABLE.has(attr.kind)) return refuse();
      return { as: a.as, sql: `sum(${col})::text`, read: attr.kind === "decimal" ? (v) => (v === null || v === undefined ? null : String(v)) : wholeNumber };
    case "avg":
      if (!SUMMABLE.has(attr.kind)) return refuse();
      return { as: a.as, sql: `round(avg(${col}), 6)::text`, read: (v) => (v === null || v === undefined ? null : trimZeros(String(v))) };
    case "min":
    case "max":
      if (!RANGEABLE.has(attr.kind)) return refuse();
      return { as: a.as, sql: textExpr(attr.kind, `${a.fn}(${col})`), read: (v) => decode(attr, v) };
  }
};

type TotalsPlan = { groups: Attr[]; aggs: AggPlan[] };

const planTotals = (shape: Shape, totals: Totals): TotalsPlan => {
  const groups = (totals.groupBy ?? []).map((k) => {
    const a = attrOf(shape, k);
    if (!SORTABLE.has(a.kind)) throw new DataApiError("invalid_request", `Totals cannot be grouped by "${a.label}".`);
    return a;
  });
  const names = new Set<string>(groups.map((g) => g.key));
  if (names.size !== groups.length) throw new DataApiError("invalid_request", "The same detail is named twice in the grouping.");
  const aggs = totals.aggregates.map((a) => {
    if (names.has(a.as)) throw new DataApiError("invalid_request", "Two totals have the same name.");
    names.add(a.as);
    return planAggregate(shape, a);
  });
  return { groups, aggs };
};

const runTotals = async (tx: Tx, table: string, where: string, whereValues: readonly (string | null)[], plan: TotalsPlan): Promise<Row[]> => {
  const select = [
    ...plan.groups.map((g, i) => `${textExpr(g.kind, ident(g.key))} as g${i}`),
    ...plan.aggs.map((a, i) => `${a.sql} as a${i}`),
  ];
  const groupCols = plan.groups.map((g) => ident(g.key)).join(", ");
  const p = new Params();
  for (const v of whereValues) p.values.push(v);
  const text =
    `select ${select.join(", ")} from ${table} where ${where}` +
    (plan.groups.length > 0 ? ` group by ${groupCols} order by ${groupCols}` : "") +
    ` limit ${p.add(String(MAX_GROUPS + 1), "integer")}`;
  const rows = await run(tx, text, p.values);
  if (rows.length > MAX_GROUPS) throw new DataApiError("limit", "Those totals have too many groups. Narrow the filter or group by less.");
  return rows.map((r) => {
    const out: Row = {};
    plan.groups.forEach((g, i) => (out[g.key] = decode(g, r[`g${i}`])));
    plan.aggs.forEach((a, i) => (out[a.as] = a.read(r[`a${i}`])));
    return out;
  });
};

export const runQuery = async (tenant: TenantContext, raw: unknown): Promise<QueryResponse> => {
  const parsed = QueryRequest.safeParse(raw);
  if (!parsed.success) throw new DataApiError("invalid_request");
  const req = parsed.data;

  const { shape, ids } = await withPlatform(tenant, async (platform, ids) => {
    const manifest = await platform.manifest();
    const shapes = await shapesFor(platform, manifest, tenant, [{ ref: req.model, need: "read" }]);
    return { shape: shapes.get(req.model) as Shape, ids };
  });

  // Everything below is checked against the shape before any SQL is built.
  const wanted: Attr[] = req.fields ? [...new Set(req.fields)].map((k) => attrOf(shape, k)) : shape.list.filter((a) => a.readable);
  const sort: SortItem[] = resolveSort(shape, req.sort ?? []);
  const totals = req.totals ? planTotals(shape, req.totals) : null;

  const whereParams = new Params();
  const conditions = baseConditions(shape, { includeDeleted: req.includeDeleted === true });
  if (req.where) conditions.push(compileFilter(shape, req.where, whereParams));
  const where = conditions.length > 0 ? conditions.join(" and ") : "true";
  const whereValues = [...whereParams.values];

  const binding = sha256(
    canonical({
      org: ids.orgUuid, app: ids.appUuid, user: ids.userUuid, role: tenant.role, loc: tenant.locations, env: tenant.env,
      model: shape.ref, where: req.where ?? null, sort: sort.map((s) => [s.attr.key, s.dir]), del: req.includeDeleted === true,
    }),
  );

  // Row query: the caller's columns, then the exact sort values the next cursor is built from.
  const select: string[] = [];
  const slots: Array<{ attr: Attr; main: string; extra?: string }> = [];
  for (const a of wanted) {
    const exprs = selectExprs(a);
    const main = `c${select.length}`;
    select.push(`${exprs[0] as string} as ${main}`);
    if (exprs[1]) {
      const extra = `c${select.length}`;
      select.push(`${exprs[1]} as ${extra}`);
      slots.push({ attr: a, main, extra });
    } else slots.push({ attr: a, main });
  }
  cursorExprs(sort).forEach((e, i) => select.push(`${e} as k${i}`));

  const rowParams = new Params();
  for (const v of whereValues) rowParams.values.push(v);
  let rowWhere = where;
  if (req.cursor !== undefined) rowWhere += ` and ${afterCursor(sort, decodeCursor(req.cursor, binding, sort.length), rowParams)}`;

  return readOnlyStore(tenant, "read", async (tx, store) => {
    const table = tableOf(shape, store);
    const text = `select ${select.join(", ")} from ${table} where ${rowWhere} order by ${orderBy(sort)} limit ${rowParams.add(String(req.limit + 1), "integer")}`;
    const found = await run(tx, text, rowParams.values);
    const page = found.slice(0, req.limit);
    const rows: Row[] = page.map((r) => {
      const out: Row = {};
      for (const s of slots) out[s.attr.key] = decode(s.attr, r[s.main], s.extra ? r[s.extra] : undefined);
      return out;
    });
    const last = page[page.length - 1];
    const nextCursor =
      found.length > req.limit && last
        ? encodeCursor(binding, sort.map((_, i) => (last[`k${i}`] === null || last[`k${i}`] === undefined ? null : String(last[`k${i}`]))))
        : null;
    const response: QueryResponse = { rows, nextCursor, masked: shape.masked };
    if (totals) response.totals = await runTotals(tx, table, where, whereValues, totals);
    return response;
  });
};
