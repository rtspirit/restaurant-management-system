// Checks values from a request against the field format table in @rms/contracts and turns
// them into text for binding. Nothing here builds SQL from a value.
import { CurrencyCode, DateValue, DecimalValue, MoneyValue, QuantityValue, TimestampValue, Uuid } from "@rms/contracts";
import { DataApiError } from "./errors.js";
import type { Attr, Kind } from "./shape.js";

const bad = (attr: Pick<Attr, "label">, what: string): never => {
  throw new DataApiError("invalid_request", `"${attr.label}" ${what}.`);
};

const MAX_TEXT = 10000;
const MAX_JSON = 100_000;

const isRealDate = (s: string): boolean => {
  if (!DateValue.safeParse(s).success) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * A timestamp as the exact text we compare and store: ISO, UTC, at most milliseconds. That is
 * the precision the wire format carries, so what is written always reads back equal.
 */
const timestampText = (v: unknown): string | null => {
  if (typeof v !== "string" || !TimestampValue.safeParse(v).success) return null;
  if (Number.isNaN(Date.parse(v))) return null;
  const frac = /\.(\d+)Z$/.exec(v);
  if (frac && (frac[1] as string).length > 3) return null;
  return v;
};

const decimalText = (v: unknown): string | null => {
  if (typeof v === "string" && DecimalValue.safeParse(v).success) return v;
  if (typeof v === "number" && Number.isFinite(v) && DecimalValue.safeParse(String(v)).success) return String(v);
  return null;
};

/**
 * One scalar from a filter or cursor, as text to bind. Throws `invalid_request` when the value
 * does not fit the attribute's kind. Kinds that cannot be compared never reach this function.
 */
export const scalarText = (attr: Attr, v: unknown): string => {
  switch (attr.kind) {
    case "text":
    case "enum":
      if (typeof v !== "string" || v.includes("\u0000")) return bad(attr, "needs text");
      return v;
    case "integer":
    case "money":
      if (!MoneyValue.safeParse(v).success) return bad(attr, "needs a whole number");
      return String(v);
    case "decimal": {
      const t = decimalText(v);
      return t ?? bad(attr, "needs a number written as text, like \"12.50\"");
    }
    case "boolean":
      if (typeof v !== "boolean") return bad(attr, "needs true or false");
      return v ? "true" : "false";
    case "date":
    case "business_date":
      if (typeof v !== "string" || !isRealDate(v)) return bad(attr, "needs a date like 2026-11-15");
      return v;
    case "timestamp": {
      const t = timestampText(v);
      return t ?? bad(attr, "needs a date and time like 2026-11-15T03:10:00.000Z (no finer than milliseconds)");
    }
    case "uuid":
    case "ref":
    case "parent_ref":
      if (typeof v !== "string" || !Uuid.safeParse(v).success) return bad(attr, "needs a record id");
      return v.toLowerCase();
    default:
      return bad(attr, "cannot be compared");
  }
};

export type ColumnValue = { column: string; value: string | null; kind: Kind; /** For a `ref` field: the model the id must point into. */ refModel?: string };

/**
 * A value from a write, as the column values to store. `null` clears the field.
 * parent_ref returns only the id column: the caller adds the label after checking the id exists.
 */
export const writeColumns = (attr: Attr, v: unknown): ColumnValue[] => {
  const cols = (main: string | null, extra?: string | null): ColumnValue[] => {
    const out: ColumnValue[] = [{ column: attr.key, value: main, kind: attr.kind }];
    if (attr.extra && attr.kind === "quantity") out.push({ column: attr.extra, value: extra ?? null, kind: "text" });
    return out;
  };
  if (v === null || v === undefined) {
    if (attr.required) return bad(attr, "is required");
    return cols(null, null);
  }
  const def = attr.def;
  switch (attr.kind) {
    case "text": {
      if (typeof v !== "string" || v.includes("\u0000")) return bad(attr, "needs text");
      const max = def?.type === "text" && def.maxLength ? def.maxLength : MAX_TEXT;
      if (v.length > max) return bad(attr, `is too long (the limit is ${max} characters)`);
      // Currency is the one text-like system column with its own form.
      if (attr.system && attr.key === "currency" && !CurrencyCode.safeParse(v).success) return bad(attr, "needs a three letter currency code like USD");
      return cols(v);
    }
    case "enum":
      if (typeof v !== "string" || def?.type !== "enum" || !def.values.includes(v)) return bad(attr, "is not one of the allowed choices");
      return cols(v);
    case "decimal": {
      if (typeof v !== "string" || !DecimalValue.safeParse(v).success) return bad(attr, "needs a number written as text, like \"12.50\"");
      const scale = def?.type === "decimal" ? def.scale : 2;
      const [whole = "", frac = ""] = v.replace("-", "").split(".");
      if (frac.length > scale) return bad(attr, `can have at most ${scale} decimal places`);
      if (whole.length > 18 - scale) return bad(attr, "is too large");
      return cols(v);
    }
    case "quantity": {
      const q = QuantityValue.safeParse(v);
      if (!q.success) return bad(attr, "needs an amount and a unit, like { \"value\": \"2.5\", \"unit\": \"kg\" }");
      if ((q.data.value.replace("-", "").split(".")[0] ?? "").length > 12) return bad(attr, "is too large");
      return cols(q.data.value, q.data.unit);
    }
    case "json": {
      const text = JSON.stringify(v);
      if (text === undefined) return bad(attr, "is not valid");
      if (text.length > MAX_JSON) return bad(attr, "is too large");
      return cols(text);
    }
    case "ref": {
      const out = cols(scalarText(attr, v));
      if (def?.type === "ref" && out[0]) out[0].refModel = def.model;
      return out;
    }
    default:
      return cols(scalarText(attr, v));
  }
};
