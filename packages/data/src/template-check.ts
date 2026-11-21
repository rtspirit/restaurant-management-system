// The allow list for named query and action templates.
//
// A template is parsed with the real PostgreSQL parser (libpg-query, the server's own grammar
// compiled to WebAssembly) and the tree is walked. Anything not named here is refused: an
// unknown kind of node, an unknown field on a known node, a function, a type or an operator
// that is not on the lists below. So a new SQL feature is refused until someone adds it.
//
// What a template may be:
//   * exactly one statement: a SELECT for a query. For an action, a SELECT whose WITH part may
//     hold INSERT ... SELECT into `{{model}}` targets listed in `writes` (or one such INSERT).
//   * tables only as `{{model}}` placeholders, names defined by WITH in the same statement and
//     in scope, or generate_series(...).
//   * functions only from FUNCTIONS (plus rms.current_actor). None of them reads text as SQL, a
//     table name or a setting, so a text literal is always just data.
//   * casts only to CAST_TYPES. No `reg*` types, so text never becomes a table.
//   * no INTO, no locking, no recursion, no UPDATE, DELETE or MERGE, no ON CONFLICT DO UPDATE,
//     no schema-qualified name of any kind.
//
// The same check runs when a definition is installed (`checkNamedQuery`, `checkNamedAction`)
// and every time one is run.
import type { NamedActionDefinition, NamedQueryDefinition } from "@rms/contracts";
import { parse } from "libpg-query";
import { type Piece, TemplateError, type TemplateSpec, parseTemplate } from "./template.js";

/** Functions a template may call. Keep this short. Every name here must be pure data-in, data-out. */
export const FUNCTIONS: ReadonlySet<string> = new Set([
  // from the security review's base list
  "sum", "count", "avg", "min", "max", "coalesce", "nullif", "greatest", "least", "round", "abs", "date_trunc", "to_char",
  "extract", "lower", "upper", "concat", "generate_series", "gen_random_uuid", "now", "row_number", "rank",
  // added because the library templates on main use them: all take values and return a value
  "replace", "bool_and", "bool_or", "mod", "make_date",
]);
/** Functions the parser itself writes for SQL keywords, for example EXTRACT(year FROM d). */
const SYNTAX_FUNCTIONS: ReadonlySet<string> = new Set(["extract"]);
/** The one schema-qualified function. It returns the actor the Data API set for this transaction. */
const QUALIFIED_FUNCTIONS: ReadonlySet<string> = new Set(["rms.current_actor"]);

/** Types a template may cast to, by the parser's internal names. */
const CAST_TYPES: ReadonlySet<string> = new Set(["text", "int4", "int8", "numeric", "date", "timestamptz", "bool", "uuid"]);

const OPERATORS: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%", "=", "<>", "!=", "<", "<=", ">", ">=", "||", "~~", "~~*", "!~~", "!~~*"]);
const A_EXPR_KINDS: ReadonlySet<string> = new Set([
  "AEXPR_OP", "AEXPR_IN", "AEXPR_BETWEEN", "AEXPR_NOT_BETWEEN", "AEXPR_LIKE", "AEXPR_ILIKE", "AEXPR_DISTINCT", "AEXPR_NOT_DISTINCT", "AEXPR_NULLIF",
]);
const JOIN_TYPES: ReadonlySet<string> = new Set(["JOIN_INNER", "JOIN_LEFT", "JOIN_RIGHT", "JOIN_FULL"]);
const SUBLINK_TYPES: ReadonlySet<string> = new Set(["EXISTS_SUBLINK", "EXPR_SUBLINK", "ANY_SUBLINK", "ALL_SUBLINK"]);
const SET_OPS: ReadonlySet<string> = new Set(["SETOP_NONE", "SETOP_UNION", "SETOP_INTERSECT", "SETOP_EXCEPT"]);

const READ_MARK = "rmsx_read_";
const TARGET_MARK = "rmsx_target_";
const PLAIN_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

type N = Record<string, unknown>;

function stop(why: string): never {
  throw new TemplateError(why);
}
const isObj = (v: unknown): v is N => typeof v === "object" && v !== null && !Array.isArray(v);
const body = (v: unknown, what: string): N => (isObj(v) ? v : stop(`${what} is missing or malformed`));
const items = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : stop("expected a list"));

/** Splits a wrapped node `{ Kind: {...} }` into its kind and fields. */
const node = (v: unknown): [string, N] => {
  if (!isObj(v)) return stop("expected a node");
  const keys = Object.keys(v);
  if (keys.length !== 1) return stop("expected one node");
  const kind = keys[0] as string;
  return [kind, body(v[kind], kind)];
};
/** Refuses any field that is not on the list for its node. `location` only says where the text was. */
const only = (b: N, allowed: readonly string[], what: string): void => {
  for (const k of Object.keys(b)) if (k !== "location" && !allowed.includes(k)) stop(`${what} uses "${k}", which is not allowed`);
};
const text = (v: unknown): string => {
  const [kind, b] = node(v);
  if (kind !== "String" || typeof b.sval !== "string") return stop("expected a name");
  return b.sval;
};
const oneOf = (v: unknown, allowed: ReadonlySet<string>, fallback: string, what: string): void => {
  const s = v === undefined ? fallback : v;
  if (typeof s !== "string" || !allowed.has(s)) stop(`${what} is not allowed`);
};

type Walk = {
  mode: "query" | "action";
  /** Names defined by WITH that are visible where the walk is now, innermost last. */
  scopes: Array<Set<string>>;
  reads: Set<string>;
  targets: Set<string>;
  seenReads: Set<string>;
  seenTargets: Set<string>;
  /** Every column name the template mentions, for the catalog's "can this role use it" check. */
  columns: Set<string>;
};

const inScope = (w: Walk, name: string): boolean => w.scopes.some((s) => s.has(name));

const alias = (v: unknown): void => {
  if (v === undefined) return;
  const b = body(v, "alias");
  only(b, ["aliasname", "colnames"], "an alias");
  if (typeof b.aliasname !== "string" || !PLAIN_NAME.test(b.aliasname) || b.aliasname.startsWith("rmsx_")) stop("alias is not a plain name");
  for (const c of items(b.colnames)) text(c);
};

/** A relation by name: a `{{model}}` placeholder or a WITH name in scope. Never anything else. */
const rangeVar = (b: N, w: Walk): void => {
  only(b, ["relname", "inh", "relpersistence", "alias"], "a table reference");
  if (b.inh !== true || (b.relpersistence !== undefined && b.relpersistence !== "p")) stop("table reference form is not allowed");
  const name = b.relname;
  if (typeof name !== "string") return stop("table reference has no name");
  alias(b.alias);
  if (name.startsWith(READ_MARK)) {
    if (!w.reads.has(name) || w.seenReads.has(name)) stop("placeholder is out of place");
    w.seenReads.add(name);
    return;
  }
  if (!inScope(w, name)) stop("a table that is not a {{model}} placeholder or a name defined in this statement");
};

const withClause = (v: unknown, w: Walk, allowInsert: boolean): boolean => {
  if (v === undefined) return false;
  const b = body(v, "with");
  only(b, ["ctes", "recursive"], "a with clause");
  if (b.recursive !== undefined && b.recursive !== false) stop("recursive queries are not allowed");
  const scope = new Set<string>();
  w.scopes.push(scope);
  for (const c of items(b.ctes)) {
    const [kind, cte] = node(c);
    if (kind !== "CommonTableExpr") stop("unexpected item in a with clause");
    only(cte, ["ctename", "aliascolnames", "ctematerialized", "ctequery"], "a with item");
    const name = cte.ctename;
    if (typeof name !== "string" || !PLAIN_NAME.test(name) || name.startsWith("pg_") || name.startsWith("rmsx_")) return stop("with name is not a plain name");
    for (const a of items(cte.aliascolnames)) text(a);
    const [qKind, q] = node(cte.ctequery);
    if (qKind === "SelectStmt") selectStmt(q, w, false);
    else if (qKind === "InsertStmt" && allowInsert) insertStmt(q, w);
    else stop(`${qKind} is not allowed here`);
    // A with name is visible to the items after it and to the main statement, not to itself or earlier items.
    scope.add(name);
  }
  return true;
};

const selectOf = (v: unknown, w: Walk): void => {
  const b = body(v, "select");
  const keys = Object.keys(b);
  if (keys.length === 1 && keys[0] === "SelectStmt") selectStmt(body(b.SelectStmt, "select"), w, false);
  else selectStmt(b, w, false);
};

function selectStmt(b: N, w: Walk, top: boolean): void {
  only(
    b,
    ["distinctClause", "targetList", "fromClause", "whereClause", "groupClause", "groupDistinct", "havingClause", "windowClause", "valuesLists",
      "sortClause", "limitOffset", "limitCount", "limitOption", "withClause", "op", "all", "larg", "rarg"],
    "a select",
  );
  oneOf(b.limitOption, new Set(["LIMIT_OPTION_DEFAULT", "LIMIT_OPTION_COUNT"]), "LIMIT_OPTION_DEFAULT", "this limit form");
  oneOf(b.op, SET_OPS, "SETOP_NONE", "this set operation");
  const pushed = withClause(b.withClause, w, top && w.mode === "action");
  if (b.larg !== undefined) selectOf(b.larg, w);
  if (b.rarg !== undefined) selectOf(b.rarg, w);
  for (const f of items(b.fromClause)) fromItem(f, w);
  for (const d of items(b.distinctClause)) if (!(isObj(d) && Object.keys(d).length === 0)) expr(d, w);
  for (const t of items(b.targetList)) resTarget(t, w, true);
  if (b.whereClause !== undefined) expr(b.whereClause, w);
  for (const g of items(b.groupClause)) expr(g, w);
  if (b.havingClause !== undefined) expr(b.havingClause, w);
  for (const d of items(b.windowClause)) {
    const [kind, def] = node(d);
    if (kind !== "WindowDef") stop("unexpected window item");
    windowDef(def, w);
  }
  for (const row of items(b.valuesLists)) expr(row, w);
  for (const s of items(b.sortClause)) sortBy(s, w);
  if (b.limitOffset !== undefined) expr(b.limitOffset, w);
  if (b.limitCount !== undefined) expr(b.limitCount, w);
  if (pushed) w.scopes.pop();
}

function insertStmt(b: N, w: Walk): void {
  only(b, ["relation", "cols", "selectStmt", "onConflictClause", "returningClause", "returningList", "withClause", "override"], "an insert");
  oneOf(b.override, new Set(["OVERRIDING_NOT_SET"]), "OVERRIDING_NOT_SET", "this insert form");
  const rel = body(b.relation, "insert target");
  only(rel, ["relname", "inh", "relpersistence"], "an insert target");
  const name = rel.relname;
  if (typeof name !== "string" || !name.startsWith(TARGET_MARK) || !w.targets.has(name) || w.seenTargets.has(name)) stop("an insert may only go into a {{model}} placeholder listed in writes");
  w.seenTargets.add(name as string);
  if (items(b.cols).length === 0) stop("an insert must name its columns");
  for (const c of items(b.cols)) resTarget(c, w, false);
  const pushed = withClause(b.withClause, w, false);
  const [kind, sel] = node(b.selectStmt);
  if (kind !== "SelectStmt") stop("an insert must take its rows from a select");
  selectStmt(sel, w, false);
  if (b.onConflictClause !== undefined) {
    const oc = body(b.onConflictClause, "on conflict");
    only(oc, ["action", "infer"], "on conflict");
    if (oc.action !== "ONCONFLICT_NOTHING") stop("on conflict may only do nothing");
    if (oc.infer !== undefined) {
      const inf = body(oc.infer, "on conflict target");
      only(inf, ["indexElems", "whereClause"], "an on conflict target");
      for (const e of items(inf.indexElems)) {
        const [k, el] = node(e);
        if (k !== "IndexElem") stop("unexpected on conflict target");
        only(el, ["name", "ordering", "nulls_ordering"], "an on conflict column");
        if (typeof el.name !== "string") stop("on conflict column form is not allowed");
        oneOf(el.ordering, new Set(["SORTBY_DEFAULT"]), "SORTBY_DEFAULT", "this on conflict form");
        oneOf(el.nulls_ordering, new Set(["SORTBY_NULLS_DEFAULT"]), "SORTBY_NULLS_DEFAULT", "this on conflict form");
      }
      if (inf.whereClause !== undefined) expr(inf.whereClause, w);
    }
  }
  if (b.returningClause !== undefined) {
    const r = body(b.returningClause, "returning");
    only(r, ["exprs"], "returning");
    for (const t of items(r.exprs)) resTarget(t, w, true);
  }
  for (const t of items(b.returningList)) resTarget(t, w, true);
  if (pushed) w.scopes.pop();
}

function resTarget(v: unknown, w: Walk, withValue: boolean): void {
  const [kind, b] = node(v);
  if (kind !== "ResTarget") stop("unexpected item in a column list");
  only(b, ["name", "val"], "a column");
  if (b.name !== undefined && typeof b.name !== "string") stop("column name is malformed");
  if (withValue) expr(b.val, w);
  else if (b.val !== undefined || typeof b.name !== "string") stop("insert column list must be plain names");
}

function fromItem(v: unknown, w: Walk): void {
  const [kind, b] = node(v);
  switch (kind) {
    case "RangeVar":
      return rangeVar(b, w);
    case "RangeSubselect": {
      only(b, ["lateral", "subquery", "alias"], "a subquery");
      const [k, sub] = node(b.subquery);
      if (k !== "SelectStmt") stop("a subquery must be a select");
      alias(b.alias);
      return selectStmt(sub, w, false);
    }
    case "JoinExpr":
      only(b, ["jointype", "isNatural", "larg", "rarg", "usingClause", "quals", "alias", "rtindex"], "a join");
      oneOf(b.jointype, JOIN_TYPES, "JOIN_INNER", "this join type");
      fromItem(b.larg, w);
      fromItem(b.rarg, w);
      for (const u of items(b.usingClause)) text(u);
      if (b.quals !== undefined) expr(b.quals, w);
      return alias(b.alias);
    case "RangeFunction": {
      only(b, ["lateral", "functions", "alias"], "a function in from");
      const fns = items(b.functions);
      if (fns.length !== 1) stop("only one function is allowed in from");
      const [k, list] = node(fns[0]);
      const parts = k === "List" ? items(list.items) : stop("unexpected function form");
      const [fk, fn] = node(parts[0]);
      if (fk !== "FuncCall" || funcName(fn) !== "generate_series") stop("only generate_series may be used as a table");
      if (parts.length > 1 && !(isObj(parts[1]) && Object.keys(parts[1]).length === 0)) stop("column definitions are not allowed");
      funcCall(fn, w);
      return alias(b.alias);
    }
    default:
      return stop(`${kind} is not allowed in from`);
  }
}

const funcName = (b: N): string => items(b.funcname).map(text).join(".");

function funcCall(b: N, w: Walk): void {
  only(b, ["funcname", "args", "agg_order", "agg_filter", "over", "agg_star", "agg_distinct", "funcformat"], "a function call");
  const parts = items(b.funcname).map(text);
  const format = b.funcformat ?? "COERCE_EXPLICIT_CALL";
  const name = parts.join(".");
  const allowed =
    (parts.length === 1 && format === "COERCE_EXPLICIT_CALL" && FUNCTIONS.has(name)) ||
    (parts.length === 2 && format === "COERCE_EXPLICIT_CALL" && QUALIFIED_FUNCTIONS.has(name)) ||
    (parts.length === 2 && format === "COERCE_SQL_SYNTAX" && parts[0] === "pg_catalog" && SYNTAX_FUNCTIONS.has(parts[1] as string));
  if (!allowed) stop("a function that is not on the allowed list");
  for (const a of items(b.args)) expr(a, w);
  for (const s of items(b.agg_order)) sortBy(s, w);
  if (b.agg_filter !== undefined) expr(b.agg_filter, w);
  if (b.over !== undefined) windowDef(body(b.over, "over"), w);
}

function windowDef(b: N, w: Walk): void {
  only(b, ["name", "refname", "partitionClause", "orderClause", "frameOptions", "startOffset", "endOffset"], "a window");
  for (const p of items(b.partitionClause)) expr(p, w);
  for (const s of items(b.orderClause)) sortBy(s, w);
  if (b.startOffset !== undefined) expr(b.startOffset, w);
  if (b.endOffset !== undefined) expr(b.endOffset, w);
}

function sortBy(v: unknown, w: Walk): void {
  const [kind, b] = node(v);
  if (kind !== "SortBy") stop("unexpected item in order by");
  only(b, ["node", "sortby_dir", "sortby_nulls"], "an order by item");
  oneOf(b.sortby_dir, new Set(["SORTBY_DEFAULT", "SORTBY_ASC", "SORTBY_DESC"]), "SORTBY_DEFAULT", "this sort direction");
  expr(b.node, w);
}

function typeName(v: unknown): void {
  const b = body(v, "type");
  only(b, ["names", "typemod", "typmods"], "a type");
  const names = items(b.names).map(text);
  const base = names.length === 2 && names[0] === "pg_catalog" ? names[1] : names.length === 1 ? names[0] : undefined;
  if (base === undefined || !CAST_TYPES.has(base)) stop("a cast to a type that is not on the allowed list");
  if (b.typemod !== undefined && b.typemod !== -1) stop("type form is not allowed");
  const mods = items(b.typmods);
  if (mods.length > 0 && base !== "numeric") stop("type form is not allowed");
  for (const m of mods) {
    const [k, c] = node(m);
    if (k !== "A_Const" || !isObj(c.ival)) stop("type form is not allowed");
  }
}

function expr(v: unknown, w: Walk): void {
  const [kind, b] = node(v);
  switch (kind) {
    case "ColumnRef": {
      only(b, ["fields"], "a column reference");
      const fields = items(b.fields);
      if (fields.length < 1 || fields.length > 2) stop("a name with a schema in it");
      fields.forEach((f, i) => {
        const [k, fb] = node(f);
        if (k === "A_Star" && i === fields.length - 1) return;
        if (k !== "String" || typeof fb.sval !== "string") return stop("column reference is malformed");
        if (fb.sval.startsWith("rmsx_")) return stop("placeholder is out of place");
        if (i === fields.length - 1) w.columns.add(fb.sval);
      });
      return;
    }
    case "A_Const":
      return only(b, ["ival", "fval", "sval", "boolval", "isnull"], "a constant");
    case "ParamRef":
      return only(b, ["number"], "a parameter");
    case "A_Expr": {
      only(b, ["kind", "name", "lexpr", "rexpr", "rexpr_list_start", "rexpr_list_end"], "an expression");
      oneOf(b.kind, A_EXPR_KINDS, "AEXPR_OP", "this kind of expression");
      const names = items(b.name).map(text);
      if (names.length !== 1) stop("a schema-qualified operator");
      if ((b.kind ?? "AEXPR_OP") === "AEXPR_OP" && !OPERATORS.has(names[0] as string)) stop("an operator that is not on the allowed list");
      if (b.lexpr !== undefined) expr(b.lexpr, w);
      if (b.rexpr !== undefined) expr(b.rexpr, w);
      return;
    }
    case "List":
      only(b, ["items"], "a list");
      for (const i of items(b.items)) expr(i, w);
      return;
    case "BoolExpr":
      only(b, ["boolop", "args"], "a condition");
      for (const a of items(b.args)) expr(a, w);
      return;
    case "NullTest":
      only(b, ["arg", "nulltesttype", "argisrow"], "a null test");
      return expr(b.arg, w);
    case "BooleanTest":
      only(b, ["arg", "booltesttype"], "a boolean test");
      return expr(b.arg, w);
    case "CaseExpr":
      only(b, ["arg", "args", "defresult"], "a case");
      if (b.arg !== undefined) expr(b.arg, w);
      for (const a of items(b.args)) {
        const [k, cw] = node(a);
        if (k !== "CaseWhen") stop("unexpected item in a case");
        only(cw, ["expr", "result"], "a case branch");
        expr(cw.expr, w);
        expr(cw.result, w);
      }
      if (b.defresult !== undefined) expr(b.defresult, w);
      return;
    case "CoalesceExpr":
      only(b, ["args"], "coalesce");
      for (const a of items(b.args)) expr(a, w);
      return;
    case "MinMaxExpr":
      only(b, ["op", "args"], "greatest or least");
      for (const a of items(b.args)) expr(a, w);
      return;
    case "SubLink": {
      only(b, ["subLinkType", "testexpr", "operName", "subselect"], "a subquery");
      oneOf(b.subLinkType, SUBLINK_TYPES, "", "this kind of subquery");
      for (const o of items(b.operName)) if (!OPERATORS.has(text(o))) stop("an operator that is not on the allowed list");
      if (b.testexpr !== undefined) expr(b.testexpr, w);
      const [k, sub] = node(b.subselect);
      if (k !== "SelectStmt") stop("a subquery must be a select");
      return selectStmt(sub, w, false);
    }
    case "TypeCast":
      only(b, ["arg", "typeName"], "a cast");
      typeName(b.typeName);
      return expr(b.arg, w);
    case "FuncCall":
      return funcCall(b, w);
    // A list of values and "the n-th one", as the fiscal calendar action uses for month names.
    case "A_ArrayExpr":
      only(b, ["elements", "list_start", "list_end"], "a list of values");
      for (const e of items(b.elements)) expr(e, w);
      return;
    case "A_Indirection": {
      only(b, ["arg", "indirection"], "an item of a list");
      expr(b.arg, w);
      for (const i of items(b.indirection)) {
        const [k, idx] = node(i);
        if (k !== "A_Indices") stop("only a numbered item of a list may be picked");
        only(idx, ["uidx"], "an item number");
        expr(idx.uidx, w);
      }
      return;
    }
    case "SQLValueFunction":
      only(b, ["op", "typmod"], "a value keyword");
      return oneOf(b.op, new Set(["SVFOP_CURRENT_DATE", "SVFOP_CURRENT_TIMESTAMP"]), "", "this keyword");
    default:
      return stop(`${kind} is not allowed`);
  }
}

export type Checked = { pieces: Piece[]; columns: ReadonlySet<string> };

const check = async (spec: TemplateSpec): Promise<Checked> => {
  // First the scanner: placeholders, parameters, and its own refusals (semicolons, comments, dollar signs).
  const pieces = parseTemplate(spec);
  // Then the real parser, on the template with a plain marker name where each placeholder is.
  const reads = new Set<string>();
  const targets = new Set<string>();
  let params = 0;
  const skeleton = pieces
    .map((p, i) => {
      if (p.t === "text") return p.text;
      if (p.t === "param") return `$${++params}`;
      if (p.t === "read") {
        reads.add(`${READ_MARK}${i}`);
        return `${READ_MARK}${i}`;
      }
      targets.add(`${TARGET_MARK}${i}`);
      return `${TARGET_MARK}${i} (${p.columns.join(", ")})`;
    })
    .join("");
  let tree: N;
  try {
    tree = (await parse(skeleton)) as unknown as N;
  } catch {
    return stop("the statement does not parse");
  }
  const stmts = items(tree.stmts);
  if (stmts.length !== 1) stop("exactly one statement is allowed");
  const [kind, stmt] = node(body(stmts[0], "statement").stmt);
  const w: Walk = { mode: spec.mode, scopes: [], reads, targets, seenReads: new Set(), seenTargets: new Set(), columns: new Set() };
  if (kind === "SelectStmt") selectStmt(stmt, w, true);
  else if (kind === "InsertStmt" && spec.mode === "action") insertStmt(stmt, w);
  else stop("the statement is not of the expected kind");
  // Every placeholder must have landed where a table goes. One that the parser read as
  // something else (a column, say) is refused.
  if (w.seenReads.size !== reads.size || w.seenTargets.size !== targets.size) stop("placeholder is out of place");
  return { pieces, columns: w.columns };
};

const cache = new Map<string, Promise<Checked>>();

/** Checks a template against the allow list. Throws TemplateError. Results are remembered per text. */
export const checkTemplate = (spec: TemplateSpec): Promise<Checked> => {
  const key = JSON.stringify([spec.mode, spec.reads, spec.writes, spec.params, spec.sql]);
  let hit = cache.get(key);
  if (!hit) {
    if (cache.size > 500) cache.clear();
    hit = check(spec);
    cache.set(key, hit);
  }
  return hit;
};

/** For whoever installs definitions: throws TemplateError unless the query's template is allowed. */
export const checkNamedQuery = (def: Pick<NamedQueryDefinition, "sql" | "reads" | "params">): Promise<Checked> =>
  checkTemplate({ sql: def.sql, mode: "query", reads: def.reads, writes: [], params: def.params.map((p) => p.key) });

/** For whoever installs definitions: throws TemplateError unless the action's template is allowed. */
export const checkNamedAction = (def: Pick<NamedActionDefinition, "sql" | "reads" | "writes" | "params">): Promise<Checked> =>
  checkTemplate({ sql: def.sql, mode: "action", reads: def.reads, writes: def.writes, params: def.params.map((p) => p.key) });
