import { z } from "zod";
import { Ident, ModelRef, ParentModelKey, maxDepth } from "./ids.js";
import { Role } from "./auth.js";

/**
 * The model definition format. A definition is data. The compiler in packages/models turns
 * it into SQL (tables, constraints, triggers, row-level security). Agents and mini-apps never
 * write table changes or SQL. Nothing in a definition is ever spliced into SQL as free text:
 * every identifier matches `Ident` and every expression is the `Expr` tree below.
 */

export const Sensitivity = z.enum(["personal", "payroll", "financial"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

/** Today: foundation, sales, finance, plus the few cost-side models the accounts mini-app needs. */
export const ModelPack = z.enum(["foundation", "sales", "finance", "inventory", "labour", "custom"]);
export type ModelPack = z.infer<typeof ModelPack>;

const fieldBase = {
  key: Ident,
  label: z.string().min(1).max(60),
  description: z.string().max(280).optional(),
  required: z.boolean().default(false),
  sensitivity: Sensitivity.optional(),
  /**
   * Roles that may read this field. Omitted = every role that can read the model.
   * A role that cannot read a field also cannot write it, filter, sort or total on it.
   */
  readableBy: z.array(Role).min(1).optional(),
};

export const FieldDef = z.discriminatedUnion("type", [
  z.strictObject({ ...fieldBase, type: z.literal("text"), maxLength: z.number().int().positive().max(10000).optional() }),
  z.strictObject({ ...fieldBase, type: z.literal("integer") }),
  z.strictObject({ ...fieldBase, type: z.literal("decimal"), scale: z.number().int().min(0).max(6).default(2) }),
  z.strictObject({ ...fieldBase, type: z.literal("boolean") }),
  /** bigint minor units. The currency is ONE row-level `currency` column, added by the compiler. */
  z.strictObject({ ...fieldBase, type: z.literal("money") }),
  /** A numeric plus a unit column `<key>_unit` holding a unit key. */
  z.strictObject({ ...fieldBase, type: z.literal("quantity") }),
  z.strictObject({ ...fieldBase, type: z.literal("date") }),
  /** The restaurant's business date (location timezone and day cutoff). */
  z.strictObject({ ...fieldBase, type: z.literal("business_date") }),
  z.strictObject({ ...fieldBase, type: z.literal("timestamp") }),
  z.strictObject({ ...fieldBase, type: z.literal("enum"), values: z.array(Ident).min(1).max(60) }),
  /** Points at another child model in the same store. */
  z.strictObject({ ...fieldBase, type: z.literal("ref"), model: Ident, onDelete: z.enum(["restrict", "set_null"]).default("restrict") }),
  /** Points at a parent-data row. Stores the id and a label snapshot. Never a foreign key. */
  z.strictObject({ ...fieldBase, type: z.literal("parent_ref"), parentModel: ParentModelKey }),
  z.strictObject({ ...fieldBase, type: z.literal("json") }),
]);
export type FieldDef = z.infer<typeof FieldDef>;

export const FieldType = z.enum([
  "text", "integer", "decimal", "boolean", "money", "quantity", "date",
  "business_date", "timestamp", "enum", "ref", "parent_ref", "json",
]);
export type FieldType = z.infer<typeof FieldType>;

/**
 * Columns the compiler adds. Definitions must not declare them.
 * - `location_id` only when `locationScoped`.
 * - `currency` (char 3) only when the model has a money field. Defaults to the location's currency.
 * - `deleted_at` only when soft delete applies.
 * `updated_at` has millisecond precision (used by `ifUpdatedAt`).
 */
export const SYSTEM_FIELDS = [
  "id", "location_id", "currency", "source", "source_id", "created_at", "created_by",
  "updated_at", "updated_by", "deleted_at",
] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];

/** The only system fields a caller may set. `location_id` is checked against the token's locations. */
export const WRITABLE_SYSTEM_FIELDS = ["location_id", "currency"] as const;

/**
 * Where a row came from. Set by the server, never by the caller:
 * user actor + insert/update = "manual"; user actor + upsert_by_source = "import";
 * connection actor = "connection"; job or named action = "app"; seed script = "seed".
 */
export const RowSource = z.enum(["manual", "import", "connection", "app", "seed"]);
export type RowSource = z.infer<typeof RowSource>;

export const ModelAccess = z.enum(["read", "write"]);
export type ModelAccess = z.infer<typeof ModelAccess>;

/** Small safe expression tree for check rules. No function calls, no subqueries, no raw SQL. */
export type Expr =
  | { lit: string | number | boolean | null }
  | { field: string }
  | { op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "add" | "sub" | "mul"; args: [Expr, Expr] }
  | { op: "and" | "or"; args: Expr[] }
  | { op: "not" | "is_null"; arg: Expr }
  | { op: "in"; arg: Expr; values: Array<string | number> };

const ExprNode: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.strictObject({ lit: z.union([z.string().max(200), z.number(), z.boolean(), z.null()]) }),
    z.strictObject({ field: Ident }),
    z.strictObject({ op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "add", "sub", "mul"]), args: z.tuple([ExprNode, ExprNode]) }),
    z.strictObject({ op: z.enum(["and", "or"]), args: z.array(ExprNode).min(2).max(12) }),
    z.strictObject({ op: z.enum(["not", "is_null"]), arg: ExprNode }),
    z.strictObject({ op: z.literal("in"), arg: ExprNode, values: z.array(z.union([z.string().max(200), z.number()])).min(1).max(60) }),
  ]),
) as z.ZodType<Expr>;
export const Expr = z.unknown().refine(maxDepth(16), "Expression is nested too deeply").pipe(ExprNode);

const CheckRule = z.strictObject({ kind: z.literal("check"), name: Ident, expr: Expr, message: z.string().max(200) });

/** Rules the compiler turns into constraints or triggers. All but `check` are library-only. */
export const ModelRule = z.discriminatedUnion("kind", [
  CheckRule,
  /**
   * Ledger rule, on the header model. For each header row, its lines in `lineModel` (joined by
   * `lineRef`) must share one currency and have sum(debit) = sum(credit). Enforced by a deferred
   * constraint trigger at commit, so header and lines go in one batch.
   */
  z.strictObject({ kind: z.literal("balanced"), name: Ident, lineModel: Ident, lineRef: Ident, debit: Ident, credit: Ident }),
  /** No insert when the row's date falls in a `fiscal_period` whose status is closed. */
  z.strictObject({ kind: z.literal("open_period_only"), name: Ident, dateField: Ident }),
  /**
   * The row that `field` points at must have `refField` in `allowed`, whenever `when` holds.
   * Example: a posting rule for tips, sales tax or gift cards sold may only target an account
   * whose type is "liability" (domain rule 4).
   */
  z.strictObject({ kind: z.literal("ref_value_in"), name: Ident, field: Ident, refField: Ident, allowed: z.array(Ident).min(1), when: Expr.optional(), message: z.string().max(200) }),
]);
export type ModelRule = z.infer<typeof ModelRule>;

const modelShape = {
  key: Ident,
  version: z.number().int().positive(),
  name: z.string().min(1).max(60),
  /** Plain words. The agent picks models by meaning, so this matters. */
  description: z.string().min(10).max(400),
  fields: z.array(FieldDef).min(1).max(80),
  /** Adds `location_id` and row-level security by the caller's locations. */
  locationScoped: z.boolean().default(true),
  /** No update or delete, ever, enforced by grants. Corrections are new rows. */
  appendOnly: z.boolean().default(false),
  /** Soft delete through `deleted_at`. Ignored when appendOnly. */
  softDelete: z.boolean().default(true),
  /** Unique constraints. Uniqueness of (source, source_id) is always added. */
  unique: z.array(z.array(Ident).min(1).max(6)).max(8).default([]),
  indexes: z.array(z.array(Ident).min(1).max(6)).max(12).default([]),
  /** The HIGHEST access each role may have. A mini-app manifest can only narrow it. */
  defaultAccess: z.strictObject({ owner: ModelAccess, staff: z.union([ModelAccess, z.literal("none")]) }),
  /** The field shown when another row points at this one. Must be readable by every role that can read the model. */
  labelField: Ident.optional(),
};

type ModelLike = { fields: FieldDef[]; unique?: string[][]; indexes?: string[][]; labelField?: string | undefined; rules?: ModelRule[] };

const checkModel = (m: ModelLike, ctx: z.RefinementCtx) => {
  const system = new Set<string>(SYSTEM_FIELDS);
  const seen = new Set<string>();
  const bad = (message: string) => ctx.addIssue({ code: "custom", message });
  for (const f of m.fields) {
    if (system.has(f.key)) bad(`"${f.key}" is a system field`);
    if (seen.has(f.key)) bad(`Duplicate field "${f.key}"`);
    seen.add(f.key);
  }
  for (const f of m.fields) if (f.type === "quantity" && seen.has(`${f.key}_unit`)) bad(`"${f.key}_unit" collides with the unit column of "${f.key}"`);
  const known = (k: string) => seen.has(k) || system.has(k);
  for (const group of [...(m.unique ?? []), ...(m.indexes ?? [])]) for (const k of group) if (!known(k)) bad(`Unknown field "${k}" in a unique rule or index`);
  if (m.labelField && !seen.has(m.labelField)) bad(`Unknown label field "${m.labelField}"`);
};

const ModelBase = z.strictObject({ ...modelShape, pack: ModelPack, rules: z.array(ModelRule).max(20).default([]) });

/** A library model, written by maintainers. */
export const ModelDefinition = ModelBase.superRefine(checkModel);
export type ModelDefinition = z.infer<typeof ModelDefinition>;

/**
 * A model the agent designed for one restaurant. Always pack "custom", only `check` rules,
 * and its key may not shadow a library model (the platform checks that against the library).
 */
export const CustomModelDefinition = z
  .strictObject({ ...modelShape, pack: z.literal("custom"), rules: z.array(CheckRule).max(10).default([]) })
  .superRefine(checkModel);
export type CustomModelDefinition = z.infer<typeof CustomModelDefinition>;

/** Parent models are described the same way but are read-only and never compiled per restaurant by an agent. */
export const ParentModelDefinition = z
  .strictObject({
    key: ParentModelKey,
    version: z.number().int().positive(),
    name: z.string().min(1).max(60),
    description: z.string().min(10).max(400),
    fields: z.array(FieldDef).min(1).max(80),
    labelField: Ident.optional(),
    readOnly: z.literal(true),
  })
  .superRefine(checkModel);
export type ParentModelDefinition = z.infer<typeof ParentModelDefinition>;

/**
 * A structured change to a restaurant's store, proposed by the build agent. The platform
 * validates it, compiles the SQL and applies it to draft first. The agent never sends SQL.
 */
export const ModelChange = z.discriminatedUnion("op", [
  /** Instantiate a library model for this restaurant. */
  z.strictObject({ op: z.literal("use_template"), template: Ident }),
  z.strictObject({ op: z.literal("create_custom_model"), definition: CustomModelDefinition }),
  /** Optional fields only (`required` must be false) unless the owner confirmed a T2 change. */
  z.strictObject({ op: z.literal("add_field"), model: Ident, field: FieldDef }),
  z.strictObject({ op: z.literal("add_unique"), model: Ident, fields: z.array(Ident).min(1).max(6) }),
  z.strictObject({ op: z.literal("add_index"), model: Ident, fields: z.array(Ident).min(1).max(6) }),
]);
export type ModelChange = z.infer<typeof ModelChange>;

export const NamedParam = z.strictObject({
  key: Ident,
  type: z.enum(["text", "integer", "date", "business_date", "boolean", "uuid"]),
  required: z.boolean().default(true),
});

/**
 * Named query: a report written by MAINTAINERS on the model layer and compiled by the platform.
 * Mini-apps call it by name with typed parameters. They never send SQL.
 *
 * Rules for the template and its compiler:
 * - Tables appear only as {{model_ref}} (for example {{sales_day}} or {{parent.locations}}).
 *   Each expands to a subquery over the caller's own schema that selects only the columns the
 *   caller's role may read, hides soft-deleted rows, and applies the location scope.
 *   A reference not listed in `reads` fails compilation.
 * - Parameters appear only as :key and are always bound, never spliced.
 * - One SELECT statement. It always runs in a READ ONLY transaction as the restaurant's role.
 */
export const NamedQueryDefinition = z.strictObject({
  key: Ident,
  pack: ModelPack,
  name: z.string().min(1).max(60),
  description: z.string().min(10).max(400),
  reads: z.array(ModelRef).min(1).max(12),
  params: z.array(NamedParam).max(10).default([]),
  sql: z.string().min(1).max(20000),
  columns: z
    .array(z.strictObject({ key: Ident, label: z.string().max(60), type: FieldType, sensitivity: Sensitivity.optional(), readableBy: z.array(Role).min(1).optional() }))
    .min(1)
    .max(60),
});
export type NamedQueryDefinition = z.infer<typeof NamedQueryDefinition>;

/**
 * Named action: a write written by MAINTAINERS, for example "post a day of sales to the ledger".
 * Same template rules as a named query, except the statement may insert into the models listed
 * in `writes` (written as {{model}} targets). It runs in one read-write transaction as the
 * restaurant's role, so every model rule (balanced, open period, append-only) still applies.
 * A caller needs read access to every `reads` model and write access to every `writes` model.
 */
export const NamedActionDefinition = z.strictObject({
  key: Ident,
  pack: ModelPack,
  name: z.string().min(1).max(60),
  description: z.string().min(10).max(400),
  reads: z.array(ModelRef).min(1).max(12),
  writes: z.array(Ident).min(1).max(6),
  params: z.array(NamedParam).max(10).default([]),
  sql: z.string().min(1).max(20000),
  /** Running it twice with the same parameters changes nothing the second time. Required. */
  idempotent: z.literal(true),
});
export type NamedActionDefinition = z.infer<typeof NamedActionDefinition>;
