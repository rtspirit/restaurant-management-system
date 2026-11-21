// Named query and action templates.
//
// Templates are written by maintainers and stored in platform.named_queries / named_actions.
// A mini-app only ever sends a key and typed parameters. This file turns a template into one
// statement, following the rules written above NamedQueryDefinition in @rms/contracts and the
// conventions the library packs use:
//
//   {{model}} <alias>    a table to read. It becomes a bracketed subquery over the caller's own
//                        schema with only the columns their role may read and removed rows
//                        hidden. The template supplies the alias. Must be listed in `reads`.
//   insert into {{m}} (a, b)   an insert target (actions only). It becomes the bare table in the
//                        caller's own schema. Must be listed in `writes` and must name its
//                        columns, which are checked against the model before anything runs.
//   :key                 a parameter. Always bound, never spliced. Must be declared.
//
// What a request sends never becomes part of the statement text: parameters are bound, and
// model names come from the stored definition.
//
// This file is the SCANNER: it finds the placeholders and parameters, and refuses a semicolon,
// a comment marker, a dollar sign, an undeclared reference or parameter, and a few words a
// report has no use for. It is a first, cheap layer. It does not decide what SQL is allowed.
//
// That decision is the ALLOW LIST in template-check.ts, which parses the scanned template with
// the real PostgreSQL parser and refuses anything not named there. Nothing runs a template
// without going through `checkTemplate`.
import { Ident, ModelRef } from "@rms/contracts";

export class TemplateError extends Error {}

function stop(why: string): never {
  throw new TemplateError(why);
}

export type Piece =
  | { t: "text"; text: string }
  | { t: "read"; ref: string }
  | { t: "target"; ref: string; columns: string[] }
  | { t: "param"; key: string };

export type TemplateSpec = {
  sql: string;
  mode: "query" | "action";
  reads: readonly string[];
  writes: readonly string[];
  params: readonly string[];
};

/**
 * Words refused outside text literals. Only things that could sit INSIDE one select or one
 * insert matter here: other statement kinds cannot be nested and the first-word check below
 * refuses them anyway.
 */
const BANNED = new Set(["set_config", "delete", "merge", "truncate", "query_to_xml", "query_to_xml_and_xmlschema"]);
const BANNED_PREFIX = /^(pg_|lo_|dblink)/;
const OTHER_STORE = /^o_[0-9a-f]{12}/;
/** Schemas a template may never reach into. Refused when written as a qualifier (`name.`). */
const BANNED_SCHEMAS = new Set([
  "platform", "auth", "vault", "storage", "information_schema", "extensions", "realtime", "graphql", "graphql_public",
  "net", "cron", "pgsodium", "supabase_functions", "public",
]);

const isWordStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/**
 * Scans a template into pieces. Throws TemplateError for anything outside the rules.
 * Text inside '...' literals and `::type` casts is copied untouched.
 */
export const parseTemplate = (spec: TemplateSpec): Piece[] => {
  const s = spec.sql;
  const n = s.length;
  const reads = new Set(spec.reads);
  const writes = new Set(spec.writes);
  const params = new Set(spec.params);
  const pieces: Piece[] = [];
  /** Significant tokens so far, lower case. Used to see `insert into` and `do update`. */
  const seen: string[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) pieces.push({ t: "text", text: buf });
    buf = "";
  };
  const skipSpace = (from: number): number => {
    let j = from;
    while (isSpace(s[j])) j++;
    return j;
  };
  const checkWord = (word: string, end: number): void => {
    const w = word.toLowerCase();
    // `rmsx_` is the prefix of the marker names the allow-list check puts where placeholders are.
    if (BANNED.has(w) || BANNED_PREFIX.test(w) || OTHER_STORE.test(w) || w.startsWith("rmsx_")) stop("a word that is not allowed in a template");
    if (w === "update" && !(spec.mode === "action" && seen[seen.length - 1] === "do")) stop("a template may not update rows");
    if (w === "insert" && spec.mode !== "action") stop("a query may not insert");
    if (BANNED_SCHEMAS.has(w) && s[skipSpace(end)] === ".") stop("a template may only reach tables through {{model}}");
  };

  while (i < n) {
    const c = s[i] as string;
    const d = s[i + 1];

    if (c === "'") {
      const before = s[i - 1];
      if (before === "&" || ((before === "e" || before === "E") && !isWordChar(s[i - 2]))) stop("escape strings are not allowed");
      let j = i + 1;
      for (;;) {
        if (j >= n) stop("text literal is not closed");
        if (s[j] === "'") {
          if (s[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      buf += s.slice(i, j + 1);
      seen.push("'text'");
      i = j + 1;
    } else if (c === '"') {
      if (s[i - 1] === "&") stop("escape names are not allowed");
      const j = s.indexOf('"', i + 1);
      if (j < 0) stop("quoted name is not closed");
      const name = s.slice(i + 1, j);
      if (s[j + 1] === '"' || !/^[A-Za-z_][A-Za-z0-9_ ]{0,62}$/.test(name)) stop("quoted name is not a plain name");
      checkWord(name, j + 1);
      buf += s.slice(i, j + 1);
      seen.push(name.toLowerCase());
      i = j + 1;
    } else if ((c === "-" && d === "-") || (c === "/" && d === "*")) {
      stop("comments are not allowed");
    } else if (c === "$") {
      stop("dollar signs are not allowed");
    } else if (c === ";") {
      stop("semicolons are not allowed");
    } else if (c === "{" && d === "{") {
      const j = s.indexOf("}}", i + 2);
      if (j < 0) stop("model reference is not closed");
      const ref = s.slice(i + 2, j).trim();
      if (!ModelRef.safeParse(ref).success) stop("model reference is not a model name");
      let after = j + 2;
      const isTarget = seen[seen.length - 1] === "into" && seen[seen.length - 2] === "insert";
      flush();
      if (isTarget) {
        if (spec.mode !== "action") stop("a query may not insert");
        if (!writes.has(ref)) stop("insert target is not listed in writes");
        after = skipSpace(after);
        if (s[after] !== "(") stop("an insert must name its columns");
        const close = s.indexOf(")", after);
        if (close < 0) stop("column list is not closed");
        const columns = s.slice(after + 1, close).split(",").map((x) => x.trim().toLowerCase());
        if (!columns.every((x) => Ident.safeParse(x).success)) stop("column list is not a list of plain names");
        if (new Set(columns).size !== columns.length) stop("a column is named twice");
        pieces.push({ t: "target", ref, columns });
        after = close + 1;
      } else {
        if (!reads.has(ref)) stop("model reference is not listed in reads");
        pieces.push({ t: "read", ref });
      }
      seen.push("{{}}");
      i = after;
    } else if (c === "{" || c === "}") {
      stop("a brace outside a model reference");
    } else if (c === ":") {
      if (d === ":") {
        buf += "::";
        seen.push("::");
        i += 2;
      } else if (isWordStart(d)) {
        let e = i + 1;
        while (isWordChar(s[e])) e++;
        const key = s.slice(i + 1, e);
        if (!params.has(key)) stop("parameter is not declared");
        flush();
        pieces.push({ t: "param", key });
        seen.push(":param");
        i = e;
      } else {
        stop("a colon that is not a parameter");
      }
    } else if (isWordStart(c)) {
      let e = i;
      while (isWordChar(s[e])) e++;
      const word = s.slice(i, e);
      checkWord(word, e);
      buf += word;
      seen.push(word.toLowerCase());
      i = e;
    } else if (/[0-9]/.test(c)) {
      let e = i;
      while (e < n && /[0-9A-Za-z_.]/.test(s[e] as string)) e++;
      buf += s.slice(i, e);
      seen.push("0");
      i = e;
    } else {
      buf += c;
      if (!isSpace(c)) seen.push(c);
      i++;
    }
  }
  flush();

  const first = seen[0];
  if (spec.mode === "query" ? first !== "select" && first !== "with" : first !== "insert" && first !== "with") stop("statement is not of the expected kind");
  return pieces;
};

export type Renderers = {
  /** The subquery for a table to read, without brackets. */
  read(ref: string): string;
  /** The bare table for an insert target, with its checked column list. */
  target(ref: string, columns: readonly string[]): string;
  /** The placeholder for a bound parameter. */
  param(key: string): string;
};

export const renderTemplate = (pieces: readonly Piece[], r: Renderers): string =>
  pieces
    .map((p) => {
      switch (p.t) {
        case "text":
          return p.text;
        case "read":
          return `(${r.read(p.ref)})`;
        case "target":
          return r.target(p.ref, p.columns);
        case "param":
          return r.param(p.key);
      }
    })
    .join("");
