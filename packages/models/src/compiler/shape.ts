// What a model looks like as a table: its columns, where it lives, who may touch it.
// Column names and types come ONLY from the storage contract in @rms/contracts.
import {
  type FieldDef,
  ModelDefinition,
  StorePrefix,
  SYSTEM_COLUMNS,
  columnsForField,
  storeRoles,
  storeSchemas,
} from "@rms/contracts";
import { CompileError, isPlainName, objectName } from "./sql.js";

export type CompileTarget = {
  schema: string;
  env: "live" | "draft";
  roles: { rw: string; draftRw: string; ask: string };
};

/** Other models a definition may point at (ref fields, ledger lines, fiscal periods). */
export type ModelSource = ReadonlyMap<string, ModelDefinition> | readonly ModelDefinition[];
export type CompileContext = { models?: ModelSource };

/** The two places a restaurant's tables live, built from its store prefix and nothing else. */
export const targetsFor = (storePrefix: string): { live: CompileTarget; draft: CompileTarget } => {
  const prefix = StorePrefix.parse(storePrefix);
  const schemas = storeSchemas(prefix);
  const roles = storeRoles(prefix);
  return { live: { schema: schemas.live, env: "live", roles }, draft: { schema: schemas.draft, env: "draft", roles } };
};

export type Grantee = { role: string; write: boolean };

/**
 * Refuses any target that is not exactly one restaurant's live or draft schema with that same
 * restaurant's roles. So compiled SQL can never create a table in `platform`, `public` or a
 * parent schema, and can never grant to another restaurant's role.
 */
export const checkTarget = (target: CompileTarget): { schema: string; grantees: Grantee[] } => {
  const m = /^(o_[0-9a-f]{12})(_draft)?$/.exec(typeof target?.schema === "string" ? target.schema : "");
  if (!m?.[1]) throw new CompileError("Target is not a restaurant's schema");
  const expected = targetsFor(m[1])[target.env === "draft" ? "draft" : "live"];
  const same =
    (target.env === "live" || target.env === "draft") &&
    target.schema === expected.schema &&
    target.roles?.rw === expected.roles.rw &&
    target.roles?.draftRw === expected.roles.draftRw &&
    target.roles?.ask === expected.roles.ask;
  if (!same) throw new CompileError("Target schema and roles do not belong together");
  return {
    schema: expected.schema,
    grantees:
      expected.env === "live"
        ? [{ role: expected.roles.rw, write: true }, { role: expected.roles.ask, write: false }]
        : [{ role: expected.roles.draftRw, write: true }],
  };
};

/** Parses a definition again with the contract's schema. The compiler never trusts its caller. */
export const parseModel = (def: unknown): ModelDefinition => {
  const parsed = ModelDefinition.safeParse(def);
  if (!parsed.success) {
    const why = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new CompileError(`Model definition is not valid (${why})`);
  }
  return parsed.data;
};

export const hasSoftDelete = (def: ModelDefinition): boolean => def.softDelete && !def.appendOnly;
export const hasMoney = (def: ModelDefinition): boolean => def.fields.some((f) => f.type === "money");

export type Column = { name: string; type: string; nullable: boolean };

export const systemColumnsFor = (def: ModelDefinition): Column[] =>
  SYSTEM_COLUMNS.filter(
    (c) =>
      c.when === "always" ||
      (c.when === "locationScoped" && def.locationScoped) ||
      (c.when === "hasMoney" && hasMoney(def)) ||
      (c.when === "softDelete" && hasSoftDelete(def)),
  ).map((c) => ({ name: c.name, type: c.sqlType, nullable: c.nullable }));

export const fieldColumns = (f: FieldDef): Column[] => columnsForField(f).map((c) => ({ name: c.name, type: c.sqlType, nullable: c.nullable }));

/** Every column of the table, system columns first. Throws when two columns would share a name. */
export const tableColumns = (def: ModelDefinition): Column[] => {
  const columns = [...systemColumnsFor(def), ...def.fields.flatMap(fieldColumns)];
  const seen = new Set<string>();
  for (const c of columns) {
    if (!isPlainName(c.name)) throw new CompileError("A column name is not a plain name");
    if (seen.has(c.name)) throw new CompileError(`Two columns would be called "${c.name}"`);
    seen.add(c.name);
  }
  return columns;
};

export const findField = (def: ModelDefinition, key: string): FieldDef | undefined => def.fields.find((f) => f.key === key);

/** The column a rule expression may name: a declared field, or a system column this model has. */
export const exprColumn = (def: ModelDefinition, field: string): string => {
  if (findField(def, field) || systemColumnsFor(def).some((c) => c.name === field)) return field;
  throw new CompileError(`Model "${def.key}" has no field ${JSON.stringify(String(field).slice(0, 40))}`);
};

/** Columns a unique rule or index covers for one field key. A quantity is its number and its unit. */
export const keyColumns = (def: ModelDefinition, key: string): string[] => {
  const f = findField(def, key);
  if (f) return f.type === "quantity" ? [f.key, `${f.key}_unit`] : [f.key];
  return [exprColumn(def, key)];
};

/**
 * Names the Data API can use to tell which rule a database error came from.
 * A check rule is a constraint with this name. A trigger rule raises with this constraint name.
 */
export const ruleConstraintName = (modelKey: string, ruleName: string): string => objectName("rule", modelKey, ruleName);
export const uniqueConstraintName = (modelKey: string, fields: readonly string[]): string => objectName("key", modelKey, ...fields);
export const indexName = (modelKey: string, fields: readonly string[]): string => objectName("idx", modelKey, ...fields);

/** Looks up another model by key. Throws when it is not known. */
export type ModelLookup = (key: string) => ModelDefinition;

export const lookupFor = (self: ModelDefinition, ctx: CompileContext | undefined): ModelLookup => {
  const source = ctx?.models;
  const cache = new Map<string, ModelDefinition>([[self.key, self]]);
  return (key) => {
    const hit = cache.get(key);
    if (hit) return hit;
    const raw = source === undefined ? undefined : Array.isArray(source) ? (source as readonly ModelDefinition[]).find((m) => m?.key === key) : (source as ReadonlyMap<string, ModelDefinition>).get(key);
    if (raw === undefined) throw new CompileError(`Model ${JSON.stringify(String(key).slice(0, 40))} is not known here`);
    const parsed = parseModel(raw);
    if (parsed.key !== key) throw new CompileError("Model key does not match");
    cache.set(key, parsed);
    return parsed;
  };
};
