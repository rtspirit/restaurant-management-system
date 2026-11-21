// A second wall, on purpose written apart from the code that builds SQL. Before the store
// runs a compiled statement it is read here once more, without trusting how it was built:
//   * it must start with one of the few commands the compiler ever emits,
//   * outside quoted names, quoted values and the one function body tag there may be no
//     semicolon, no comment marker, no dollar sign and no backslash.
// So even if a bug upstream let text through, it could not become a second statement.
import { CompileError } from "./sql.js";

const BODY_TAG = "$rms$";

const STATEMENT =
  /^(create table|create unique index|create index|create policy|create trigger|create constraint trigger|create function|alter table|grant|revoke all on|drop index|drop table|drop function) /;
/** The one shape of pre-check the compiler emits, with quoted names shown as #. No quoted values at all. */
const QUERY = /^select 1 as found from #\.# where # is not null( and # is not null)*( and # is null)? group by #(, #)* having pg_catalog\.count\(\*\) > 1 limit 1$/;

const refuse = (why: string): never => {
  throw new CompileError(`Refused to run a statement: ${why}`);
};

/** Returns the text outside quotes (a quoted name becomes #, a quoted value ?, a function body a space) and any function bodies. */
const scan = (sql: string): { outside: string; bodies: string[] } => {
  let outside = "";
  const bodies: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (sql.startsWith(BODY_TAG, i)) {
      const end = sql.indexOf(BODY_TAG, i + BODY_TAG.length);
      if (end < 0) refuse("a function body is not closed");
      bodies.push(sql.slice(i + BODY_TAG.length, end));
      outside += " ";
      i = end + BODY_TAG.length;
    } else if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0) refuse("a quoted name is not closed");
      // Two quotes in a row would be one name with a quote inside it.
      if (sql[end + 1] === '"' || !/^[a-z][a-z0-9_]{0,62}$/.test(sql.slice(i + 1, end))) refuse("a quoted name is not a plain name");
      outside += "#";
      i = end + 1;
    } else if (ch === "'") {
      const escapes = sql[i - 1] === "E" && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? " ");
      let j = i + 1;
      for (;;) {
        const c = sql[j];
        if (c === undefined) refuse("a quoted value is not closed");
        if (c === "\\") {
          if (!escapes) refuse("a backslash in a plain quoted value");
          j += 2;
        } else if (c === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j += 1;
      }
      outside += "?";
      i = j + 1;
    } else {
      if (ch === "#" || ch === "?") refuse("it holds a character that is never emitted");
      outside += ch;
      i += 1;
    }
  }
  return { outside, bodies };
};

const clean = (text: string, allowSemicolon: boolean): void => {
  if (!allowSemicolon && text.includes(";")) refuse("it holds more than one statement");
  if (text.includes("--") || text.includes("/*") || text.includes("*/")) refuse("it holds a comment");
  if (text.includes("$") || text.includes("\\")) refuse("it holds a character that is never emitted");
};

/** Throws unless `sql` is one statement of a kind the compiler emits. */
export const checkStatement = (sql: string): string => {
  if (typeof sql !== "string" || !STATEMENT.test(sql)) refuse("it is not a command the compiler emits");
  const { outside, bodies } = scan(sql);
  clean(outside, false);
  if (bodies.length > (sql.startsWith("create function ") ? 1 : 0)) refuse("a function body where none belongs");
  for (const body of bodies) {
    const inner = scan(body);
    if (inner.bodies.length > 0) refuse("a function body inside a function body");
    clean(inner.outside, true);
  }
  return sql;
};

/** Throws unless `sql` is one of the compiler's read-only pre-checks. */
export const checkQuery = (sql: string): string => {
  if (typeof sql !== "string") refuse("it is not a check the compiler emits");
  const { outside, bodies } = scan(sql);
  if (bodies.length > 0) refuse("a function body where none belongs");
  clean(outside, false);
  if (!QUERY.test(outside)) refuse("it is not a check the compiler emits");
  return sql;
};
