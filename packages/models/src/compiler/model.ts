// compileModel: one model definition -> the SQL that creates its table in one schema.
// compileChange: one small structured change -> the SQL that alters that table.
//
// The SQL is meant to run as rms_tenant_migrator, which then owns the table. It follows the
// compiler contract in supabase/migrations/20261121120100_store_provisioning.sql.
import { type Expr, type FieldDef, LOCATION_POLICY_FN, ModelChange, type ModelDefinition, RowSource } from "@rms/contracts";
import { compileExpr } from "./expr.js";
import { compileTriggerRule, ruleDependencies, ruleFunctionNames } from "./rules.js";
import {
  type Column,
  type CompileContext,
  type CompileTarget,
  type Grantee,
  type ModelLookup,
  checkTarget,
  exprColumn,
  fieldColumns,
  hasMoney,
  hasSoftDelete,
  indexName,
  keyColumns,
  lookupFor,
  parseModel,
  ruleConstraintName,
  tableColumns,
  uniqueConstraintName,
} from "./shape.js";
import { CompileError, isPlainName, objectName, qualified, quoteIdent, quoteLiteral, sqlType } from "./sql.js";

export type CompiledModel = {
  model: string;
  schema: string;
  /** Creates the table with its own constraints, indexes, row-level security, grants and triggers. Needs no other table. */
  create: string[];
  /** Foreign keys and rule triggers. Needs the other tables to exist. */
  link: string[];
  /** `create` then `link`. */
  statements: string[];
};

/** A question to ask the table before a change. Any row back means "stop", with this plain-words reason. */
export type PreCheck = { sql: string; message: string };

export type CompiledChange = {
  model: string;
  schema: string;
  /** Run these first. They read the table and return a row only when the change must not go ahead. */
  checks: PreCheck[];
  statements: string[];
  /** The model's definition after the change. */
  definition: ModelDefinition;
};

const NOW_MS = "pg_catalog.date_trunc('milliseconds', pg_catalog.now())";
const CURRENCY_PATTERN = "^[A-Z]{3}$";

const functionRef = (dotted: string): string => {
  const parts = dotted.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new CompileError("Function name is not valid");
  return qualified(parts[0], parts[1]);
};

const columnSql = (c: Column): string => {
  const fallback = c.name === "created_at" || c.name === "updated_at" ? ` default ${NOW_MS}` : "";
  return `${quoteIdent(c.name)} ${sqlType(c.type)}${c.nullable ? "" : " not null"}${fallback}`;
};

type NamedCheck = { name: string; check: string };

/** Constraints that come from a field's type. */
const fieldChecks = (table: string, f: FieldDef): NamedCheck[] => {
  const col = quoteIdent(f.key);
  if (f.type === "enum") {
    for (const v of f.values) if (!isPlainName(v)) throw new CompileError("A list value is not a plain name");
    return [{ name: objectName("enum", table, f.key), check: `${col} in (${f.values.map((v) => quoteLiteral(v)).join(", ")})` }];
  }
  if (f.type === "text" && f.maxLength !== undefined) {
    return [{ name: objectName("len", table, f.key), check: `pg_catalog.char_length(${col}) <= ${quoteLiteral(f.maxLength)}` }];
  }
  if (f.type === "quantity") {
    // A quantity always carries a unit (domain rule 1).
    return [{ name: objectName("unit", table, f.key), check: `(${col} is null) = (${quoteIdent(`${f.key}_unit`)} is null)` }];
  }
  return [];
};

const foreignKey = (def: ModelDefinition, f: Extract<FieldDef, { type: "ref" }>, schema: string, lookup: ModelLookup): string => {
  if (f.required && f.onDelete === "set_null") throw new CompileError(`"${f.key}" is required, so it cannot be cleared when the linked row is deleted`);
  const target = lookup(f.model);
  return `alter table ${qualified(schema, def.key)} add constraint ${quoteIdent(objectName("fkey", def.key, f.key))} foreign key (${quoteIdent(f.key)}) references ${qualified(schema, target.key)} (${quoteIdent("id")}) on delete ${f.onDelete === "set_null" ? "set null" : "restrict"}`;
};

const columnList = (def: ModelDefinition, keys: readonly string[]): { columns: string[]; sql: string } => {
  const columns = keys.flatMap((k) => keyColumns(def, k));
  if (new Set(columns).size !== columns.length) throw new CompileError("A field is listed twice");
  return { columns, sql: columns.map(quoteIdent).join(", ") };
};

const createIndex = (def: ModelDefinition, schema: string, keys: readonly string[]): string =>
  `create index ${quoteIdent(indexName(def.key, keys))} on ${qualified(schema, def.key)} (${columnList(def, keys).sql})`;

/** An index the compiler adds by itself (links and location). Named apart from the ones a definition asks for. */
const autoIndex = (def: ModelDefinition, schema: string, column: string): string =>
  `create index ${quoteIdent(objectName("auto", def.key, column))} on ${qualified(schema, def.key)} (${quoteIdent(exprColumn(def, column))})`;

const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * A unique rule. On a soft-delete model it only counts rows that are not deleted, so a
 * deleted row never blocks a new one with the same values. That needs an index, not a constraint.
 */
const uniqueRule = (def: ModelDefinition, schema: string, keys: readonly string[]): { inline?: string; statement?: string; drop: string } => {
  const name = uniqueConstraintName(def.key, keys);
  const columns = columnList(def, keys).sql;
  const table = qualified(schema, def.key);
  if (hasSoftDelete(def)) {
    return {
      statement: `create unique index ${quoteIdent(name)} on ${table} (${columns}) where ${quoteIdent("deleted_at")} is null`,
      drop: `drop index ${qualified(schema, name)}`,
    };
  }
  return {
    inline: `constraint ${quoteIdent(name)} unique (${columns})`,
    statement: `alter table ${table} add constraint ${quoteIdent(name)} unique (${columns})`,
    drop: `alter table ${table} drop constraint ${quoteIdent(name)}`,
  };
};

/** Finds rows that already share the same values. It returns at most one row, and that row holds no data. */
const duplicateCheck = (def: ModelDefinition, schema: string, keys: readonly string[]): PreCheck => {
  const { columns } = columnList(def, keys);
  const filled = [...columns.map((c) => `${quoteIdent(c)} is not null`), ...(hasSoftDelete(def) ? [`${quoteIdent("deleted_at")} is null`] : [])];
  return {
    sql: `select 1 as found from ${qualified(schema, def.key)} where ${filled.join(" and ")} group by ${columns.map(quoteIdent).join(", ")} having pg_catalog.count(*) > 1 limit 1`,
    message: "Some rows already share the same values. Change or remove them first, then add the rule.",
  };
};

const tableGrants = (def: ModelDefinition, table: string, grantees: Grantee[]): string[] => [
  `revoke all on table ${table} from public`,
  ...grantees.map((g) => `grant ${g.write ? (def.appendOnly ? "select, insert" : "select, insert, update, delete") : "select"} on table ${table} to ${quoteIdent(g.role)}`),
];

/** Other models this one needs to exist: ref targets, ledger lines, the fiscal period. Not itself. */
export const modelDependencies = (def: ModelDefinition): string[] => {
  const keys = [...def.fields.flatMap((f) => (f.type === "ref" ? [f.model] : [])), ...ruleDependencies(def)];
  return [...new Set(keys)].filter((k) => k !== def.key);
};

export const compileModel = (definition: ModelDefinition, target: CompileTarget, ctx?: CompileContext): CompiledModel => {
  const def = parseModel(definition);
  const { schema, grantees } = checkTarget(target);
  const lookup = lookupFor(def, ctx);
  const table = qualified(schema, def.key);
  const columns = tableColumns(def);

  const ruleNames = new Set<string>();
  for (const r of def.rules) {
    if (ruleNames.has(r.name)) throw new CompileError(`Two rules are called "${r.name}"`);
    ruleNames.add(r.name);
  }
  const uniques = def.unique.filter((u, i) => def.unique.findIndex((o) => sameKeys(o, u)) === i);
  const indexes = def.indexes.filter((u, i) => def.indexes.findIndex((o) => sameKeys(o, u)) === i);

  const checks: NamedCheck[] = [
    { name: objectName("source", def.key), check: `${quoteIdent("source")} in (${RowSource.options.map((s) => quoteLiteral(s)).join(", ")})` },
    ...(hasMoney(def) ? [{ name: objectName("currency", def.key), check: `${quoteIdent("currency")} ~ ${quoteLiteral(CURRENCY_PATTERN)}` }] : []),
    ...def.fields.flatMap((f) => fieldChecks(def.key, f)),
    ...def.rules.flatMap((r) =>
      r.kind === "check" ? [{ name: ruleConstraintName(def.key, r.name), check: compileExpr(r.expr as Expr, (f) => quoteIdent(exprColumn(def, f))) }] : [],
    ),
  ];

  const body = [
    ...columns.map(columnSql),
    `constraint ${quoteIdent(objectName("pkey", def.key))} primary key (${quoteIdent("id")})`,
    ...checks.map((c) => `constraint ${quoteIdent(c.name)} check (${c.check})`),
    ...uniques.flatMap((u) => (hasSoftDelete(def) ? [] : [uniqueRule(def, schema, u).inline as string])),
  ];

  // Indexes the definition asks for, plus one per link and one on the location, unless an
  // index or unique rule already starts with that column.
  // (A unique rule on a soft-delete model is a partial index, which cannot serve every lookup.)
  const leading = new Set([...(hasSoftDelete(def) ? [] : uniques), ...indexes].map((k) => keyColumns(def, k[0] as string)[0]));
  const extra = [...(def.locationScoped ? ["location_id"] : []), ...def.fields.flatMap((f) => (f.type === "ref" ? [f.key] : []))].filter((k) => !leading.has(k));

  const policy = def.locationScoped ? `${functionRef(LOCATION_POLICY_FN)}(${quoteIdent("location_id")})` : "true";

  const create = [
    `create table ${table} (\n  ${body.join(",\n  ")}\n)`,
    // Re-importing the same source record is harmless (domain rule 8).
    `create unique index ${quoteIdent(objectName("srcid", def.key))} on ${table} (${quoteIdent("source")}, ${quoteIdent("source_id")}) where ${quoteIdent("source_id")} is not null`,
    ...uniques.flatMap((u) => (hasSoftDelete(def) ? [uniqueRule(def, schema, u).statement as string] : [])),
    ...indexes.map((k) => createIndex(def, schema, k)),
    ...extra.map((k) => autoIndex(def, schema, k)),
    // Every table has row-level security on, so a role with no policy sees nothing. Location-scoped
    // models are fenced by the caller's locations. The rest are open to this restaurant's own roles only.
    `alter table ${table} enable row level security`,
    `create policy ${quoteIdent(objectName("rls", def.key))} on ${table} as permissive for all to ${grantees.map((g) => quoteIdent(g.role)).join(", ")} using (${policy}) with check (${policy})`,
    ...tableGrants(def, table, grantees),
    `create trigger ${quoteIdent(objectName("touch", def.key))} before insert or update on ${table} for each row execute function ${functionRef("rms.touch_updated_at")}()`,
  ];

  const link = [
    ...def.fields.flatMap((f) => (f.type === "ref" ? [foreignKey(def, f, schema, lookup)] : [])),
    ...def.rules.flatMap((r) => (r.kind === "check" ? [] : compileTriggerRule(def, r, schema, lookup))),
  ];

  return { model: def.key, schema, create, link, statements: [...create, ...link] };
};

/**
 * add_field (optional fields only), add_unique, add_index. `current` is the model as it is in
 * the target schema now. Creating a model is compileModel's job, so the other two ops are refused.
 */
export const compileChange = (change: ModelChange, current: ModelDefinition, target: CompileTarget, ctx?: CompileContext): CompiledChange => {
  const parsedChange = ModelChange.safeParse(change);
  if (!parsedChange.success) throw new CompileError("Change is not valid");
  const ch = parsedChange.data;
  const def = parseModel(current);
  const { schema } = checkTarget(target);
  const table = qualified(schema, def.key);
  if (ch.op !== "add_field" && ch.op !== "add_unique" && ch.op !== "add_index") throw new CompileError("This change creates a model. Use compileModel");
  if (ch.model !== def.key) throw new CompileError("Change is for a different model");

  if (ch.op === "add_field") {
    const f = ch.field;
    if (f.required) throw new CompileError("Only optional fields can be added this way");
    // The first money field would need a currency on every row that is already there.
    if (f.type === "money" && !hasMoney(def)) throw new CompileError("This model has no money fields yet, so a money field cannot be added this way");
    const next = parseModel({ ...def, fields: [...def.fields, f] });
    tableColumns(next);
    const lookup = lookupFor(next, ctx);
    const statements = [
      ...fieldColumns(f).map((c) => `alter table ${table} add column ${columnSql(c)}`),
      ...fieldChecks(def.key, f).map((c) => `alter table ${table} add constraint ${quoteIdent(c.name)} check (${c.check})`),
      ...(f.type === "ref" ? [foreignKey(next, f, schema, lookup), autoIndex(next, schema, f.key)] : []),
    ];
    return { model: def.key, schema, checks: [], statements, definition: next };
  }

  if (ch.op === "add_unique") {
    if (def.unique.some((u) => sameKeys(u, ch.fields))) throw new CompileError("That unique rule is already there");
    const next = parseModel({ ...def, unique: [...def.unique, ch.fields] });
    return {
      model: def.key,
      schema,
      checks: [duplicateCheck(next, schema, ch.fields)],
      statements: [uniqueRule(next, schema, ch.fields).statement as string],
      definition: next,
    };
  }

  if (def.indexes.some((u) => sameKeys(u, ch.fields))) throw new CompileError("That index is already there");
  const next = parseModel({ ...def, indexes: [...def.indexes, ch.fields] });
  return { model: def.key, schema, checks: [], statements: [createIndex(next, schema, ch.fields)], definition: next };
};

/**
 * Takes one add_field, add_unique or add_index back out of a schema. `current` is the model
 * WITH the change. Only for a change that is in draft and not yet live.
 */
export const compileDiscard = (change: ModelChange, current: ModelDefinition, target: CompileTarget): CompiledChange => {
  const parsedChange = ModelChange.safeParse(change);
  if (!parsedChange.success) throw new CompileError("Change is not valid");
  const ch = parsedChange.data;
  const def = parseModel(current);
  const { schema } = checkTarget(target);
  const table = qualified(schema, def.key);
  if (ch.op !== "add_field" && ch.op !== "add_unique" && ch.op !== "add_index") throw new CompileError("This change created a model. Use compileDrop");
  if (ch.model !== def.key) throw new CompileError("Change is for a different model");

  if (ch.op === "add_field") {
    const f = def.fields.find((x) => x.key === ch.field.key);
    if (!f) throw new CompileError("The model does not have that field");
    const used = [...def.unique, ...def.indexes].some((keys) => keys.includes(f.key)) || def.labelField === f.key;
    if (used) throw new CompileError("A rule or index still uses that field");
    const next = parseModel({ ...def, fields: def.fields.filter((x) => x.key !== f.key) });
    // The field's own checks, link and index go with the column.
    return { model: def.key, schema, checks: [], statements: fieldColumns(f).map((c) => `alter table ${table} drop column ${quoteIdent(c.name)}`), definition: next };
  }
  const list = ch.op === "add_unique" ? def.unique : def.indexes;
  const at = list.findLastIndex((u) => sameKeys(u, ch.fields));
  if (at < 0) throw new CompileError("The model does not have that rule");
  const rest = list.filter((_, i) => i !== at);
  if (ch.op === "add_unique") {
    return { model: def.key, schema, checks: [], statements: [uniqueRule(def, schema, ch.fields).drop], definition: parseModel({ ...def, unique: rest }) };
  }
  return { model: def.key, schema, checks: [], statements: [`drop index ${qualified(schema, indexName(def.key, ch.fields))}`], definition: parseModel({ ...def, indexes: rest }) };
};

/**
 * Removes a model's table from one schema, with the trigger functions its rules created (and
 * with them their triggers on other tables). It fails, and changes nothing, while another table
 * still points at this one.
 */
export const compileDrop = (definition: ModelDefinition, target: CompileTarget): string[] => {
  const def = parseModel(definition);
  const { schema } = checkTarget(target);
  return [...ruleFunctionNames(def).map((fn) => `drop function ${qualified(schema, fn)}() cascade`), `drop table ${qualified(schema, def.key)}`];
};
