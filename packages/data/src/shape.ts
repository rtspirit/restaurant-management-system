// A "shape" is everything the Data API needs to know about one table for one caller:
// which attributes exist, which the caller's role may read, and how each travels as JSON.
//
// Every name that ends up in SQL text comes from here, and so from a parsed model definition
// (field keys), the storage contract (system columns) or the fixed parent table list.
// A request can only pick among these names by exact match. It can never add one.
import {
  type Expr,
  type FieldDef,
  type FieldType,
  type ModelDefinition,
  type ModelRule,
  type ParentModelKey,
  type Role,
  SYSTEM_COLUMNS,
  type StoreEnv,
  WRITABLE_SYSTEM_FIELDS,
  columnsForField,
  isParentRef,
} from "@rms/contracts";
import { type StoreHandle, ident } from "@rms/db";
import { PARENT_SPECS } from "./parent-models.js";
import type { PgType } from "./sql.js";

/** How a value is stored and sent. The field types, plus "uuid" for id columns. */
export type Kind = FieldType | "uuid";

export type Attr = {
  /** The key on the wire and the name of the main column. */
  key: string;
  label: string;
  kind: Kind;
  /** Second column for quantity (`<key>_unit`) and parent_ref (`<key>_label`). */
  extra?: string;
  required: boolean;
  /** May this caller's role read it? Unreadable also means: no write, filter, sort or total. */
  readable: boolean;
  system: boolean;
  /** May appear in write values (fields, plus location_id and currency). */
  settable: boolean;
  def?: FieldDef;
  /** For parent-data link columns: the parent table the id points at. */
  refersTo?: string;
};

export type Shape = {
  ref: string;
  parent: boolean;
  /** Table name inside the store's live, draft or parent schema. */
  table: string;
  attrs: ReadonlyMap<string, Attr>;
  list: readonly Attr[];
  /** Keys hidden from this caller. */
  masked: string[];
  /**
   * Readable fields that share a model rule with a hidden field. Writing one would let the
   * caller learn the hidden value from whether the rule passes, so writes to them are refused.
   */
  guarded: ReadonlySet<string>;
  locationColumn: "location_id" | "id" | null;
  softDelete: boolean;
  appendOnly: boolean;
  hasMoney: boolean;
  def?: ModelDefinition;
};

export const PG_TYPE: Record<Kind, PgType> = {
  text: "text", enum: "text", integer: "bigint", money: "bigint", decimal: "numeric", boolean: "boolean",
  date: "date", business_date: "date", timestamp: "timestamptz", ref: "uuid", uuid: "uuid",
  parent_ref: "uuid", quantity: "numeric", json: "jsonb",
};

const SYSTEM_KIND: Record<(typeof SYSTEM_COLUMNS)[number]["name"], Kind> = {
  id: "uuid", location_id: "uuid", currency: "text", source: "text", source_id: "text",
  created_at: "timestamp", created_by: "text", updated_at: "timestamp", updated_by: "text", deleted_at: "timestamp",
};

const SYSTEM_LABEL: Record<(typeof SYSTEM_COLUMNS)[number]["name"], string> = {
  id: "Id", location_id: "Location", currency: "Currency", source: "Source", source_id: "Source id",
  created_at: "Created", created_by: "Created by", updated_at: "Last updated", updated_by: "Last updated by", deleted_at: "Removed",
};

const settableSystem = new Set<string>(WRITABLE_SYSTEM_FIELDS);

const fieldReadable = (f: { readableBy?: Role[] | undefined }, role: Role): boolean => !f.readableBy || f.readableBy.includes(role);

const exprFields = (e: Expr, out: Set<string>): void => {
  if ("field" in e) out.add(e.field);
  else if ("args" in e) for (const a of e.args) exprFields(a, out);
  else if ("arg" in e) exprFields(e.arg, out);
};

/** Every field a model rule looks at, whatever its kind. */
export const ruleFields = (rule: ModelRule): Set<string> => {
  const out = new Set<string>();
  switch (rule.kind) {
    case "check":
      exprFields(rule.expr, out);
      break;
    case "balanced":
      for (const k of [rule.lineRef, rule.debit, rule.credit]) out.add(k);
      break;
    case "open_period_only":
      out.add(rule.dateField);
      break;
    case "ref_value_in":
      out.add(rule.field);
      if (rule.when) exprFields(rule.when, out);
      break;
  }
  return out;
};

const guardedFields = (def: ModelDefinition, hidden: ReadonlySet<string>): Set<string> => {
  const out = new Set<string>();
  if (hidden.size === 0) return out;
  for (const rule of def.rules) {
    const fields = ruleFields(rule);
    if (![...fields].some((f) => hidden.has(f))) continue;
    for (const f of fields) if (!hidden.has(f)) out.add(f);
  }
  return out;
};

/** The shape of a restaurant's own model for one role. `def` has already passed ModelDefinition. */
export const childShape = (def: ModelDefinition, role: Role): Shape => {
  const hasMoney = def.fields.some((f) => f.type === "money");
  const softDelete = def.softDelete && !def.appendOnly;
  const list: Attr[] = [];
  for (const c of SYSTEM_COLUMNS) {
    if (c.when === "locationScoped" && !def.locationScoped) continue;
    if (c.when === "hasMoney" && !hasMoney) continue;
    if (c.when === "softDelete" && !softDelete) continue;
    list.push({ key: c.name, label: SYSTEM_LABEL[c.name], kind: SYSTEM_KIND[c.name], required: !c.nullable, readable: true, system: true, settable: settableSystem.has(c.name) });
  }
  for (const f of def.fields) {
    const cols = columnsForField(f);
    const extra = cols[1]?.name;
    list.push({
      key: f.key, label: f.label, kind: f.type, ...(extra ? { extra } : {}), required: f.required,
      readable: fieldReadable(f, role), system: false, settable: true, def: f,
    });
  }
  const masked = list.filter((a) => !a.readable).map((a) => a.key);
  return {
    ref: def.key, parent: false, table: def.key, attrs: new Map(list.map((a) => [a.key, a])), list,
    masked, guarded: guardedFields(def, new Set(masked)),
    locationColumn: def.locationScoped ? "location_id" : null, softDelete, appendOnly: def.appendOnly, hasMoney, def,
  };
};

/** The shape of a parent-data table for one role and environment. Read-only, always. */
export const parentShape = (key: ParentModelKey, role: Role, env: StoreEnv): Shape => {
  const spec = PARENT_SPECS[key];
  const list: Attr[] = spec.columns.map((c) => ({
    key: c.key, label: c.label, kind: c.kind, required: false,
    readable: fieldReadable(c, role) && !(env === "draft" && c.liveOnly === true), system: false, settable: false,
    ...(c.refersTo ? { refersTo: c.refersTo } : {}),
  }));
  return {
    ref: `parent.${key}`, parent: true, table: key, attrs: new Map(list.map((a) => [a.key, a])), list,
    masked: list.filter((a) => !a.readable).map((a) => a.key), guarded: new Set(),
    locationColumn: spec.locationColumn, softDelete: false, appendOnly: false, hasMoney: false,
  };
};

export const parentKeyOf = (ref: string): ParentModelKey | null => {
  if (!isParentRef(ref)) return null;
  const key = ref.slice("parent.".length);
  return key in PARENT_SPECS ? (key as ParentModelKey) : null;
};

/** `"schema"."table"` for a shape, in the caller's own store. */
export const tableOf = (shape: Shape, store: StoreHandle): string => (shape.parent ? store.parentTable(shape.table) : store.table(shape.table));

/**
 * Conditions every read of this table carries, whatever the request says:
 * removed rows hidden, and only the caller's locations. Row-level security applies the
 * location rule on a restaurant's own tables as well. Parent tables have no row-level
 * security, so for them this condition is the location rule.
 */
export const baseConditions = (shape: Shape, opts: { includeDeleted?: boolean } = {}): string[] => {
  const out: string[] = [];
  if (shape.softDelete && !opts.includeDeleted) out.push(`${ident("deleted_at")} is null`);
  if (shape.locationColumn) {
    const col = ident(shape.locationColumn);
    out.push(shape.parent && shape.locationColumn === "location_id" ? `(${col} is null or rms.location_ok(${col}))` : `rms.location_ok(${col})`);
  }
  return out;
};

/** Every stored column the caller may read, by name. Used for named-query subqueries. */
export const readableColumns = (shape: Shape): string[] =>
  shape.list.filter((a) => a.readable).flatMap((a) => (a.extra ? [a.key, a.extra] : [a.key]));

/** Every stored column of the table, with the attribute it belongs to. */
export const allColumns = (shape: Shape): Map<string, Attr> => {
  const m = new Map<string, Attr>();
  for (const a of shape.list) {
    m.set(a.key, a);
    if (a.extra) m.set(a.extra, a);
  }
  return m;
};

const ISO_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** SQL that turns a column of this kind into text in the wire format. `col` is already quoted. */
export const textExpr = (kind: Kind, col: string, exact = false): string => {
  switch (kind) {
    case "date":
    case "business_date":
      return `to_char(${col}, 'YYYY-MM-DD')`;
    case "timestamp":
      return `to_char(${col} at time zone 'UTC', ${exact ? ISO_US : ISO_MS})`;
    case "json":
      // Sent as text and parsed here, so the result does not depend on the driver's type handling.
      return `to_jsonb(${col})::text`;
    default:
      return `${col}::text`;
  }
};

/** The select-list expressions for one attribute: one, or two for quantity and parent_ref. */
export const selectExprs = (a: Attr, qualifier = ""): string[] => {
  const main = textExpr(a.kind, `${qualifier}${ident(a.key)}`);
  return a.extra ? [main, `${qualifier}${ident(a.extra)}`] : [main];
};

const trimZeros = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

const toNumber = (s: string): number | string => {
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : s;
};

/** Turns what `selectExprs` returned into the JSON value from the field format table. */
export const decode = (a: Pick<Attr, "kind">, main: unknown, extra?: unknown): unknown => {
  if (main === null || main === undefined) return null;
  switch (a.kind) {
    case "integer":
    case "money":
      return toNumber(String(main));
    case "quantity":
      return { value: trimZeros(String(main)), unit: extra === null || extra === undefined ? "" : String(extra) };
    case "parent_ref":
      return { id: String(main), label: extra === null || extra === undefined ? "" : String(extra) };
    case "boolean":
      return main === true || main === "true" || main === "t";
    case "json":
      return typeof main === "string" ? (JSON.parse(main) as unknown) : main;
    default:
      return String(main);
  }
};
