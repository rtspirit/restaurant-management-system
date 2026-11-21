// Turns the `Expr` tree from a check rule into SQL by walking it. Every node is one of a
// fixed set of shapes. Field names go through the caller's resolver (which quotes them),
// values go through quoteLiteral, operators are fixed text.
import type { Expr } from "@rms/contracts";
import { CompileError, quoteLiteral } from "./sql.js";

const BINARY: Record<string, string> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", add: "+", sub: "-", mul: "*" };
const MAX_DEPTH = 16;
const MAX_NODES = 400;

/** Returns the SQL for one column, already quoted. Throws for a field the model does not have. */
export type FieldResolver = (field: string) => string;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const onlyKeys = (node: Record<string, unknown>, keys: string[]): void => {
  for (const k of Object.keys(node)) if (!keys.includes(k)) throw new CompileError("Expression has a part that is not allowed");
};

export const compileExpr = (expr: Expr, resolve: FieldResolver): string => {
  let nodes = 0;
  const walk = (node: unknown, depth: number): string => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new CompileError("Expression is too large");
    if (!isObject(node)) throw new CompileError("Expression is not valid");

    if (Object.hasOwn(node, "lit")) {
      onlyKeys(node, ["lit"]);
      const v = node.lit;
      if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new CompileError("Expression value is not allowed");
      return quoteLiteral(v);
    }
    if (Object.hasOwn(node, "field")) {
      onlyKeys(node, ["field"]);
      if (typeof node.field !== "string") throw new CompileError("Expression field is not valid");
      return resolve(node.field);
    }

    const op = node.op;
    if (typeof op !== "string") throw new CompileError("Expression is not valid");

    if (Object.hasOwn(BINARY, op)) {
      onlyKeys(node, ["op", "args"]);
      if (!Array.isArray(node.args) || node.args.length !== 2) throw new CompileError("Expression needs two parts");
      // "= null" is never true in SQL, so such a rule would silently check nothing.
      if ((op === "eq" || op === "ne") && node.args.some((a) => isObject(a) && Object.hasOwn(a, "lit") && a.lit === null)) {
        throw new CompileError('A value cannot be compared with nothing. Use "is_null" to test for an empty value');
      }
      return `(${walk(node.args[0], depth + 1)} ${BINARY[op]} ${walk(node.args[1], depth + 1)})`;
    }
    if (op === "and" || op === "or") {
      onlyKeys(node, ["op", "args"]);
      if (!Array.isArray(node.args) || node.args.length < 2 || node.args.length > 12) throw new CompileError("Expression needs two to twelve parts");
      return `(${node.args.map((a) => walk(a, depth + 1)).join(` ${op} `)})`;
    }
    if (op === "not") {
      onlyKeys(node, ["op", "arg"]);
      return `(not ${walk(node.arg, depth + 1)})`;
    }
    if (op === "is_null") {
      onlyKeys(node, ["op", "arg"]);
      return `(${walk(node.arg, depth + 1)} is null)`;
    }
    if (op === "in") {
      onlyKeys(node, ["op", "arg", "values"]);
      if (!Array.isArray(node.values) || node.values.length < 1 || node.values.length > 60) throw new CompileError("Expression needs one to sixty values");
      const values = node.values.map((v) => {
        if (typeof v !== "string" && typeof v !== "number") throw new CompileError("Expression value is not allowed");
        return quoteLiteral(v);
      });
      return `(${walk(node.arg, depth + 1)} in (${values.join(", ")}))`;
    }
    throw new CompileError("Expression has a part that is not allowed");
  };
  return walk(expr, 1);
};
