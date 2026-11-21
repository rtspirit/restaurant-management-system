import { z } from "zod";
import { Ident } from "./ids.js";
import { Role } from "./auth.js";

/**
 * The model definition format. A definition is data. The compiler in packages/models turns
 * it into SQL (tables, constraints, row-level security) and into typed clients. Agents and
 * mini-apps never write table changes themselves.
 */

export const Sensitivity = z.enum(["personal", "payroll", "financial"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const ModelPack = z.enum(["foundation", "sales", "finance", "inventory", "labour", "custom"]);
export type ModelPack = z.infer<typeof ModelPack>;

const fieldBase = {
  key: Ident,
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().default(false),
  sensitivity: Sensitivity.optional(),
  /** Roles that may read this field. Omitted = every role that can read the model. */
  readableBy: z.array(Role).optional(),
};

export const FieldDef = z.discriminatedUnion("type", [
  z.object({ ...fieldBase, type: z.literal("text"), maxLength: z.number().int().positive().optional() }),
  z.object({ ...fieldBase, type: z.literal("integer") }),
  z.object({ ...fieldBase, type: z.literal("decimal"), scale: z.number().int().min(0).max(6).default(2) }),
  z.object({ ...fieldBase, type: z.literal("boolean") }),
  /** Stored as bigint minor units plus a currency column `<key>_currency`. */
  z.object({ ...fieldBase, type: z.literal("money") }),
  /** Stored as a numeric plus a unit column `<key>_unit` that points at `unit`. */
  z.object({ ...fieldBase, type: z.literal("quantity") }),
  z.object({ ...fieldBase, type: z.literal("date") }),
  /** The restaurant's business date (location timezone and day cutoff). */
  z.object({ ...fieldBase, type: z.literal("business_date") }),
  z.object({ ...fieldBase, type: z.literal("timestamp") }),
  z.object({ ...fieldBase, type: z.literal("enum"), values: z.array(Ident).min(1) }),
  /** Points at another child model in the same store. */
  z.object({ ...fieldBase, type: z.literal("ref"), model: Ident, onDelete: z.enum(["restrict", "set_null"]).default("restrict") }),
  /** Points at a parent-data row. Stores the id and a label snapshot. Never a foreign key. */
  z.object({ ...fieldBase, type: z.literal("parent_ref"), parentModel: Ident }),
  z.object({ ...fieldBase, type: z.literal("json") }),
]);
export type FieldDef = z.infer<typeof FieldDef>;

export const FieldType = z.enum([
  "text", "integer", "decimal", "boolean", "money", "quantity", "date",
  "business_date", "timestamp", "enum", "ref", "parent_ref", "json",
]);
export type FieldType = z.infer<typeof FieldType>;

/**
 * Columns the compiler adds to every model. Definitions must not declare them.
 * `location_id` is added only when `locationScoped` is true.
 */
export const SYSTEM_FIELDS = [
  "id", "location_id", "source", "source_id", "created_at", "created_by",
  "updated_at", "updated_by", "deleted_at",
] as const;

export const RowSource = z.enum(["manual", "import", "connection", "app", "seed"]);
export type RowSource = z.infer<typeof RowSource>;

export const ModelAccess = z.enum(["read", "write"]);
export type ModelAccess = z.infer<typeof ModelAccess>;

/** Rules the compiler turns into database constraints or triggers. */
export const ModelRule = z.discriminatedUnion("kind", [
  /** A plain check on one row, in a small safe expression language (see packages/models). */
  z.object({ kind: z.literal("check"), name: Ident, expr: z.string().min(1), message: z.string() }),
  /** Child rows grouped by `groupBy` must sum to zero across `debit - credit`. Ledger rule. */
  z.object({ kind: z.literal("balanced"), name: Ident, lineModel: Ident, groupBy: Ident, debit: Ident, credit: Ident }),
  /** No insert when the row's business date falls in a closed fiscal period. */
  z.object({ kind: z.literal("open_period_only"), name: Ident, dateField: Ident }),
]);
export type ModelRule = z.infer<typeof ModelRule>;

export const ModelDefinition = z.object({
  key: Ident,
  pack: ModelPack,
  version: z.number().int().positive(),
  name: z.string().min(1),
  /** Plain words. The agent picks models by meaning, so this matters. */
  description: z.string().min(10),
  fields: z.array(FieldDef).min(1),
  /** Adds `location_id` and row-level security by the caller's locations. */
  locationScoped: z.boolean().default(true),
  /** No update or delete, ever. Corrections are new rows. (Ledger, events.) */
  appendOnly: z.boolean().default(false),
  /** Soft delete through `deleted_at`. Ignored when appendOnly. */
  softDelete: z.boolean().default(true),
  /** Unique constraints. `source` + `source_id` uniqueness is always added for imports. */
  unique: z.array(z.array(Ident).min(1)).default([]),
  indexes: z.array(z.array(Ident).min(1)).default([]),
  rules: z.array(ModelRule).default([]),
  /** Lowest access each role gets by default. A mini-app manifest can only narrow it. */
  defaultAccess: z.object({ owner: ModelAccess, staff: z.union([ModelAccess, z.literal("none")]) }),
  /** The field shown when another row points at this one. */
  labelField: Ident.optional(),
});
export type ModelDefinition = z.infer<typeof ModelDefinition>;

/** Parent models are described the same way, but are always read-only and never compiled per app. */
export const ParentModelDefinition = ModelDefinition.omit({ pack: true, defaultAccess: true, appendOnly: true, softDelete: true, rules: true })
  .extend({ readOnly: z.literal(true) });
export type ParentModelDefinition = z.infer<typeof ParentModelDefinition>;

/** A structured change to a restaurant's model. The platform compiles the SQL. */
export const ModelChange = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create_model"), definition: ModelDefinition }),
  z.object({ op: z.literal("add_field"), model: Ident, field: FieldDef }),
  z.object({ op: z.literal("add_unique"), model: Ident, fields: z.array(Ident).min(1) }),
  z.object({ op: z.literal("add_index"), model: Ident, fields: z.array(Ident).min(1) }),
]);
export type ModelChange = z.infer<typeof ModelChange>;

/**
 * Named query: a report defined on the model layer and compiled by the platform.
 * Mini-apps call it by name with typed parameters. They never send SQL.
 */
export const NamedQueryParam = z.object({
  key: Ident,
  type: z.enum(["text", "integer", "date", "business_date", "boolean"]),
  required: z.boolean().default(true),
});

export const NamedQueryDefinition = z.object({
  key: Ident,
  pack: ModelPack,
  name: z.string().min(1),
  description: z.string().min(10),
  /** Every model the query reads. Access is checked against all of them. */
  reads: z.array(Ident).min(1),
  params: z.array(NamedQueryParam).default([]),
  /**
   * SQL template written by maintainers only. Table names appear as {{model_key}} and are
   * replaced by the compiler with the caller's own schema-qualified tables. Parameters
   * appear as :key and are always bound, never spliced.
   */
  sql: z.string().min(1),
  columns: z.array(z.object({ key: Ident, label: z.string(), type: FieldType, sensitivity: Sensitivity.optional() })).min(1),
});
export type NamedQueryDefinition = z.infer<typeof NamedQueryDefinition>;
