// Turns a request's filter and sort into SQL conditions. Field names are looked up in the
// shape (never copied from the request), and every value is bound.
import type { Filter } from "@rms/contracts";
import { ident } from "@rms/db";
import { DataApiError } from "./errors.js";
import { type Attr, type Kind, PG_TYPE, type Shape, textExpr } from "./shape.js";
import type { Params } from "./sql.js";
import { scalarText } from "./values.js";

const ORDERED: ReadonlySet<Kind> = new Set<Kind>(["text", "enum", "integer", "money", "decimal", "date", "business_date", "timestamp"]);
const EQUATABLE: ReadonlySet<Kind> = new Set<Kind>([...ORDERED, "boolean", "uuid", "ref", "parent_ref"]);
const TEXTUAL: ReadonlySet<Kind> = new Set<Kind>(["text", "enum"]);
/** Kinds a list can be sorted or grouped by. */
export const SORTABLE: ReadonlySet<Kind> = new Set<Kind>([...ORDERED, "boolean", "uuid", "ref"]);

/**
 * Finds an attribute by the key a request named. Unknown key: `invalid_request`.
 * A key the role cannot read: `forbidden_field`, whatever it is used for (fields, filter,
 * sort, totals or a write), so a hidden value cannot be found by bisection.
 */
export const attrOf = (shape: Shape, key: string): Attr => {
  const a = shape.attrs.get(key);
  if (!a) throw new DataApiError("invalid_request", "One of the details named is not part of this kind of record.");
  if (!a.readable) throw new DataApiError("forbidden_field");
  return a;
};

const COMPARE = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
const MAX_CONDITIONS = 200;

const wrongOp = (a: Attr): never => {
  throw new DataApiError("invalid_request", `"${a.label}" cannot be filtered that way.`);
};

const noNull = (a: Attr, v: unknown): void => {
  if (v === null) throw new DataApiError("invalid_request", `To find records with no "${a.label}", use the "is empty" filter.`);
};

/** Compiles a filter tree to one SQL condition. */
export const compileFilter = (shape: Shape, filter: Filter, params: Params): string => {
  let count = 0;
  const walk = (f: Filter): string => {
    if ("and" in f) return `(${f.and.map(walk).join(" and ")})`;
    if ("or" in f) return `(${f.or.map(walk).join(" or ")})`;
    if ("not" in f) return `(not ${walk(f.not)})`;
    if (++count > MAX_CONDITIONS) throw new DataApiError("limit", "That filter has too many conditions.");
    const a = attrOf(shape, f.field);
    const col = ident(a.key);
    const bind = (v: unknown): string => params.add(scalarText(a, v), PG_TYPE[a.kind]);
    switch (f.op) {
      case "is_null":
        return f.value ? `${col} is null` : `${col} is not null`;
      case "eq":
      case "ne":
        if (!EQUATABLE.has(a.kind)) return wrongOp(a);
        noNull(a, f.value);
        return `${col} ${COMPARE[f.op]} ${bind(f.value)}`;
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        if (!ORDERED.has(a.kind)) return wrongOp(a);
        noNull(a, f.value);
        return `${col} ${COMPARE[f.op]} ${bind(f.value)}`;
      case "between":
        if (!ORDERED.has(a.kind)) return wrongOp(a);
        noNull(a, f.value[0]);
        noNull(a, f.value[1]);
        return `(${col} >= ${bind(f.value[0])} and ${col} <= ${bind(f.value[1])})`;
      case "in":
        if (!EQUATABLE.has(a.kind)) return wrongOp(a);
        for (const v of f.value) noNull(a, v);
        return `${col} in (${f.value.map(bind).join(", ")})`;
      case "contains":
      case "starts_with": {
        if (!TEXTUAL.has(a.kind)) return wrongOp(a);
        noNull(a, f.value);
        const needle = params.add(scalarText(a, f.value), "text");
        return f.op === "contains" ? `strpos(lower(${col}::text), lower(${needle})) > 0` : `starts_with(lower(${col}::text), lower(${needle}))`;
      }
    }
  };
  return walk(filter);
};

export type SortItem = { attr: Attr; dir: "asc" | "desc" };

/** The request's sort, checked, with `id` added last so the order is total and pages are stable. */
export const resolveSort = (shape: Shape, sort: ReadonlyArray<{ field: string; dir: "asc" | "desc" }>): SortItem[] => {
  const out: SortItem[] = [];
  const seen = new Set<string>();
  for (const s of sort) {
    const attr = attrOf(shape, s.field);
    if (!SORTABLE.has(attr.kind)) throw new DataApiError("invalid_request", `Records cannot be sorted by "${attr.label}".`);
    if (seen.has(attr.key)) throw new DataApiError("invalid_request", "The same detail is named twice in the sort.");
    seen.add(attr.key);
    out.push({ attr, dir: s.dir });
  }
  if (!seen.has("id")) {
    const id = shape.attrs.get("id");
    if (!id) throw new DataApiError("internal", undefined, "table has no id");
    out.push({ attr: id, dir: "asc" });
  }
  return out;
};

/** Empty values sort as the largest, in both directions (the database's own default). */
export const orderBy = (sort: readonly SortItem[]): string =>
  sort.map((s) => `${ident(s.attr.key)} ${s.dir === "asc" ? "asc nulls last" : "desc nulls first"}`).join(", ");

/** Exact text of each sort column for the last row of a page, to build the next cursor from. */
export const cursorExprs = (sort: readonly SortItem[]): string[] => sort.map((s) => textExpr(s.attr.kind, ident(s.attr.key), true));

/**
 * "Rows that come after the cursor row", written out column by column so it works with mixed
 * directions and empty values. `keys` come from a cursor we signed, and are still bound.
 */
export const afterCursor = (sort: readonly SortItem[], keys: ReadonlyArray<string | null>, params: Params): string => {
  const branches: string[] = [];
  for (let i = 0; i < sort.length; i++) {
    const parts: string[] = [];
    for (let j = 0; j < i; j++) {
      const s = sort[j] as SortItem;
      const v = keys[j] ?? null;
      parts.push(v === null ? `${ident(s.attr.key)} is null` : `${ident(s.attr.key)} = ${params.add(v, PG_TYPE[s.attr.kind])}`);
    }
    const s = sort[i] as SortItem;
    const col = ident(s.attr.key);
    const v = keys[i] ?? null;
    if (s.dir === "asc") {
      if (v === null) continue; // nothing sorts after an empty value
      parts.push(`(${col} > ${params.add(v, PG_TYPE[s.attr.kind])} or ${col} is null)`);
    } else {
      parts.push(v === null ? `${col} is not null` : `${col} < ${params.add(v, PG_TYPE[s.attr.kind])}`);
    }
    branches.push(`(${parts.join(" and ")})`);
  }
  return branches.length > 0 ? `(${branches.join(" or ")})` : "false";
};
