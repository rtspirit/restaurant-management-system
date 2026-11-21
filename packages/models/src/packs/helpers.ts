import type { Expr, FieldDef, ModelDefinition, NamedActionDefinition, NamedQueryDefinition } from "@rms/contracts";

/**
 * Small authoring helpers for the library packs. Nothing here changes the definition format:
 * every helper returns plain data that is parsed by the zod schemas in `@rms/contracts`.
 */

/** What a pack file writes: the definition before defaults are filled in. */
export type ModelInput = (typeof ModelDefinition)["_zod"]["input"];
export type FieldInput = (typeof FieldDef)["_zod"]["input"];
export type NamedQueryInput = (typeof NamedQueryDefinition)["_zod"]["input"];
export type NamedActionInput = (typeof NamedActionDefinition)["_zod"]["input"];

type Sensitivity = "personal" | "payroll" | "financial";
type Role = "owner" | "staff";

type Common = {
  description?: string;
  required?: boolean;
  sensitivity?: Sensitivity;
  readableBy?: Role[];
};

// ---------------------------------------------------------------- fields

export const text = (key: string, label: string, o: Common & { maxLength?: number } = {}): FieldInput => ({ type: "text", key, label, ...o });
export const integer = (key: string, label: string, o: Common = {}): FieldInput => ({ type: "integer", key, label, ...o });
export const decimal = (key: string, label: string, o: Common & { scale?: number } = {}): FieldInput => ({ type: "decimal", key, label, ...o });
export const boolean = (key: string, label: string, o: Common = {}): FieldInput => ({ type: "boolean", key, label, ...o });
/** Whole minor units. Tagged `financial` unless the caller says otherwise (domain rule 8). */
export const money = (key: string, label: string, o: Common = {}): FieldInput => ({ type: "money", key, label, sensitivity: "financial", ...o });
/** A number that always carries its unit (domain rule 1). */
export const quantity = (key: string, label: string, o: Common = {}): FieldInput => ({ type: "quantity", key, label, ...o });
export const date = (key: string, label: string, o: Common = {}): FieldInput => ({ type: "date", key, label, ...o });
export const timestamp = (key: string, label: string, o: Common = {}): FieldInput => ({ type: "timestamp", key, label, ...o });
export const oneOf = (key: string, label: string, values: string[], o: Common = {}): FieldInput => ({ type: "enum", key, label, values, ...o });
export const ref = (key: string, label: string, model: string, o: Common & { onDelete?: "restrict" | "set_null" } = {}): FieldInput => ({ type: "ref", key, label, model, ...o });
export const parentRef = (
  key: string,
  label: string,
  parentModel: Extract<FieldInput, { type: "parent_ref" }>["parentModel"],
  o: Common = {},
): FieldInput => ({ type: "parent_ref", key, label, parentModel, ...o });

/** The restaurant's business day this row belongs to (domain rule 2). Always the same key. */
export const businessDate = (description: string): FieldInput => ({
  type: "business_date",
  key: "business_date",
  label: "Business date",
  description,
  required: true,
});

// ---------------------------------------------------------------- expressions (check rules)

type Lit = string | number | boolean | null;
export const f = (field: string): Expr => ({ field });
export const lit = (value: Lit): Expr => ({ lit: value });
export const eq = (a: Expr, b: Expr): Expr => ({ op: "eq", args: [a, b] });
export const ne = (a: Expr, b: Expr): Expr => ({ op: "ne", args: [a, b] });
export const gt = (a: Expr, b: Expr): Expr => ({ op: "gt", args: [a, b] });
export const gte = (a: Expr, b: Expr): Expr => ({ op: "gte", args: [a, b] });
export const lte = (a: Expr, b: Expr): Expr => ({ op: "lte", args: [a, b] });
export const add = (a: Expr, b: Expr): Expr => ({ op: "add", args: [a, b] });
export const sub = (a: Expr, b: Expr): Expr => ({ op: "sub", args: [a, b] });
export const and = (...args: Expr[]): Expr => ({ op: "and", args });
export const or = (...args: Expr[]): Expr => ({ op: "or", args });
export const not = (arg: Expr): Expr => ({ op: "not", arg });
export const isNull = (arg: Expr): Expr => ({ op: "is_null", arg });
export const isIn = (arg: Expr, values: Array<string | number>): Expr => ({ op: "in", arg, values });

type Rule = NonNullable<ModelInput["rules"]>[number];
export const check = (name: string, expr: Expr, message: string): Rule => ({ kind: "check", name, expr, message });

// ---------------------------------------------------------------- access presets

/** The highest access each role may have on a model. A mini-app manifest can only narrow it. */
export const ACCESS = {
  /** Lists the whole team needs to read. Only the owner changes them. */
  ownerWritesStaffReads: { owner: "write", staff: "read" },
  /** Day-to-day records the team fills in. */
  everyoneWrites: { owner: "write", staff: "write" },
  /** Books and money owed. Owner only. */
  ownerOnly: { owner: "write", staff: "none" },
} as const satisfies Record<string, ModelInput["defaultAccess"]>;

// ---------------------------------------------------------------- SQL templates

/**
 * Tidies a template: removes the indentation that comes from writing it inside TypeScript and
 * lines a multi-line fragment up under the place it is inserted. It only changes whitespace.
 * Templates are one statement, have no comments, never use `::` casts and never put a colon
 * inside a quoted string, so a simple `:key` binder cannot mistake anything else for a parameter
 * (the pack tests check all of this).
 */
export const sql = (strings: TemplateStringsArray, ...values: string[]): string => {
  let raw = "";
  strings.forEach((part, i) => {
    raw += part;
    const value = values[i];
    if (value === undefined) return;
    const lineStart = raw.lastIndexOf("\n") + 1;
    const indent = /^ */.exec(raw.slice(lineStart))?.[0] ?? "";
    raw += value.split("\n").join(`\n${indent}`);
  });
  const lines = raw.replace(/^\n+/, "").replace(/\s+$/, "").split("\n");
  const margin = Math.min(...lines.filter((l) => l.trim() !== "").map((l) => /^ */.exec(l)?.[0].length ?? 0));
  return lines.map((l) => l.slice(margin).replace(/\s+$/, "")).join("\n");
};
