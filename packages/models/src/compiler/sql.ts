// The ONLY three ways text gets into compiled SQL:
//   quoteIdent   for every name (schema, table, column, role, constraint, index, trigger, function)
//   quoteLiteral for every value
//   fixed text written in this package
// Nothing from a model definition is ever placed in SQL any other way.
import { createHash } from "node:crypto";

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

const PLAIN_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export const isPlainName = (name: unknown): name is string => typeof name === "string" && PLAIN_NAME.test(name);

const shown = (value: unknown): string => JSON.stringify(String(value).slice(0, 40));

/** Quotes a name after checking it is a plain lowercase name of at most 63 characters. Throws otherwise. */
export const quoteIdent = (name: unknown): string => {
  if (!isPlainName(name)) throw new CompileError(`Not a plain name: ${shown(name)}`);
  return `"${name}"`;
};

/** `"schema"."name"`. */
export const qualified = (schema: string, name: string): string => `${quoteIdent(schema)}.${quoteIdent(name)}`;

const PLAIN_NUMBER = /^-?[0-9]{1,21}(\.[0-9]{1,20})?$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Turns a value into SQL text.
 * Strings always use the escape form E'...': backslashes and quotes are doubled, so the result
 * reads the same whatever `standard_conforming_strings` is set to. A dollar sign is written as
 * its byte code, so a string can never close a dollar-quoted function body.
 */
export const quoteLiteral = (value: unknown): string => {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    const text = String(value);
    if (!Number.isFinite(value) || !PLAIN_NUMBER.test(text)) throw new CompileError(`Number cannot be used: ${shown(value)}`);
    return text.startsWith("-") ? `(${text})` : text;
  }
  if (typeof value === "string") {
    if (value.length > 1000) throw new CompileError("Text value is too long");
    if (value.includes("\u0000") || LONE_SURROGATE.test(value)) throw new CompileError("Text value has characters the database cannot store");
    return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''").replaceAll("$", "\\x24")}'`;
  }
  throw new CompileError("Value cannot be used");
};

/**
 * A name for a constraint, index, trigger, policy or function. Built only from plain names,
 * always at most 63 bytes, and always ends in a short hash of its parts so two different sets
 * of parts never give the same name (for example fields [a, b_c] and [a_b, c]).
 */
export const objectName = (kind: string, ...parts: string[]): string => {
  for (const part of [kind, ...parts]) if (!isPlainName(part)) throw new CompileError(`Not a plain name: ${shown(part)}`);
  const hash = createHash("sha256").update(JSON.stringify([kind, ...parts])).digest("hex").slice(0, 8);
  const tail = `_${kind}_${hash}`;
  const name = `${parts.join("_").slice(0, 63 - tail.length)}${tail}`;
  if (!isPlainName(name)) throw new CompileError("Could not build a safe name");
  return name;
};

/** Column types the compiler will emit. Anything else from the storage contract is refused. */
const SQL_TYPE = /^(text|bigint|boolean|date|timestamptz|uuid|jsonb|char\(3\)|numeric\(18,[0-6]\))$/;

export const sqlType = (type: unknown): string => {
  if (typeof type !== "string" || !SQL_TYPE.test(type)) throw new CompileError(`Column type is not allowed: ${shown(type)}`);
  return type;
};

const BODY_TAG = "$rms$";

/** Wraps a function body written by this package. A body never holds a dollar sign (see quoteLiteral). */
export const functionBody = (body: string): string => {
  if (body.includes("$")) throw new CompileError("Function body holds a dollar sign");
  return `${BODY_TAG}\n${body}\n${BODY_TAG}`;
};
