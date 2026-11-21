import { z } from "zod";
import { SessionId } from "./ids.js";

/**
 * The Ask agent: answers an owner's question about their own restaurant from their own data.
 *
 * Demo: owner-only (ADR 0002). There is one query login per restaurant and it can read every
 * column, so staff do not get Ask until there is a second login with column-level grants.
 *
 * The walls, from the outside in. Each one is built to hold if the one before it has a bug:
 *   1. the parser check below (`ASK_SQL_RULES`), on the real PostgreSQL grammar
 *   2. the envelope in @rms/db (`askQuery`): read-only transaction, settings reset, time limit,
 *      one statement as a subquery, row cap, always rolled back
 *   3. the login itself: one restaurant, read-only, 15 minutes, member of nothing else
 * Model-written SQL runs ONLY through `mintAskLogin`, `openAsk` and `askQuery`. Never through
 * `apiDb`, `adminDb` or `withStore`.
 */

/** Ask a question. The restaurant and the user come from the owner's session. */
export const AskRequest = z.strictObject({
  /** Omitted = a new conversation. */
  sessionId: SessionId.optional(),
  text: z.string().min(1).max(2000),
});
export type AskRequest = z.infer<typeof AskRequest>;

/**
 * Ask routes on the API origin. Owner's RMS session. Owner only.
 * `ask` answers with a server-sent event stream of `AgentEvent`s (agent.ts, `EVENT_STREAM`),
 * mode "ask", in this order: `run.started`, `user.message`, then any of `message.delta`,
 * `message.done`, `answer.table`, `answer.source`, and last `run.done` or `run.failed`.
 * One request, one answer: there is nothing to resume. The stored events can be read again
 * with `history`.
 */
export const ASK_ROUTES = {
  ask: "/ask/v1/ask", // POST AskRequest -> event stream
  history: "/ask/v1/sessions/:sessionId", // GET -> { events: AgentEvent[] }
} as const;

/**
 * The query tool the model calls. No org, schema or role parameter, ever: the server takes the
 * restaurant from the signed-in session.
 */
export const AskQueryToolInput = z.strictObject({
  sql: z.string().min(1).max(8000),
  purpose: z.string().max(200),
});
export type AskQueryToolInput = z.infer<typeof AskQueryToolInput>;

export const ASK_QUERY_LIMITS = {
  timeoutMs: 5000,
  maxRows: 500,
  maxStatements: 1,
  maxSqlLength: 8000,
  /** The most one row may weigh as text. Checked IN THE DATABASE before any row is fetched. */
  maxRowBytes: 8192,
  /** The most a whole answer may weigh as JSON when it is handed to the model. */
  maxResultBytes: 200_000,
  /** Rows the model is shown. More than this and it is told to add up or narrow down. */
  maxRowsToModel: 200,
  /** Tool calls in one answer. */
  maxQueries: 6,
} as const;

/**
 * What the tool hands back to the model. ROWS ONLY: no database messages, no error text, no
 * plan, no table list. A refusal is one of a few fixed sentences chosen by the server.
 * Values are plain: text, numbers, true or false, or nothing.
 */
export const AskQueryToolResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    columns: z.array(z.string().max(63)).max(50),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(ASK_QUERY_LIMITS.maxRowsToModel),
    /** True when there were more rows than are shown. */
    truncated: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    problem: z.enum(["not_allowed", "too_slow", "too_large", "failed", "limit"]),
    /** A fixed sentence for the model, for example "That query is not allowed. Use one SELECT over the tables you were given." */
    hint: z.string().max(200),
  }),
]);
export type AskQueryToolResult = z.infer<typeof AskQueryToolResult>;

/**
 * The allow list for Ask SQL. Enforced with `libpg-query` (the same parser the Data API uses
 * for named query templates), by walking the parsed tree. EVERYTHING NOT NAMED HERE IS REFUSED:
 * an unknown kind of node, an unknown field on a known node, a function, a type or an operator
 * that is not listed. A new SQL feature is refused until someone adds it here.
 *
 * In words:
 *   - exactly one statement, and it is a SELECT. WITH is allowed (not recursive, and every part
 *     is itself a SELECT). UNION, INTERSECT and EXCEPT are allowed.
 *   - a table is either a name defined by WITH in the same statement, or one of THIS
 *     restaurant's own tables BY EXACT NAME: the checker is given the list (the restaurant's
 *     live model tables and the ten parent tables) from the platform for the signed-in
 *     restaurant. A name not on that list is refused, whatever it is. Names may not carry a
 *     schema, a database or quotes that change their meaning. So the database's own catalogs,
 *     `platform`, `auth`, and every other restaurant cannot be named at all.
 *   - functions only from `functions`, written without a schema. None of them reads a setting,
 *     reads text as SQL or as a table name, builds a long value, sleeps or writes.
 *   - casts only to `castTypes`. No `reg*` types, so text never becomes a table.
 *   - no INTO, no FOR UPDATE or any other locking, no TABLESAMPLE, no LATERAL function calls
 *     other than `generate_series`, no parameters ($1), no schema-qualified name of any kind.
 */
export const ASK_SQL_RULES = {
  statement: "select",
  maxLength: ASK_QUERY_LIMITS.maxSqlLength,
  /** How deeply the statement may nest (subqueries, expressions). */
  maxDepth: 40,
  functions: [
    // totals
    "count", "sum", "avg", "min", "max", "bool_and", "bool_or",
    // numbers
    "round", "abs", "ceil", "floor", "trunc", "mod",
    // nothing-handling (some are parsed as their own node kinds: allow those kinds too)
    "coalesce", "nullif", "greatest", "least",
    // dates
    "date_trunc", "date_part", "extract", "to_char", "make_date", "now", "age",
    // text, short only
    "lower", "upper", "length", "trim", "btrim", "left", "right",
    // windows
    "row_number", "rank", "dense_rank", "lag", "lead",
    // series of dates or numbers, for filling gaps
    "generate_series",
  ],
  castTypes: ["text", "int4", "int8", "numeric", "float8", "date", "timestamptz", "bool", "uuid", "interval"],
  operators: ["+", "-", "*", "/", "%", "=", "<>", "!=", "<", "<=", ">", ">=", "||", "~~", "~~*", "!~~", "!~~*"],
  joinTypes: ["JOIN_INNER", "JOIN_LEFT", "JOIN_RIGHT", "JOIN_FULL"],
  setOperations: ["SETOP_NONE", "SETOP_UNION", "SETOP_INTERSECT", "SETOP_EXCEPT"],
  sublinks: ["EXISTS_SUBLINK", "EXPR_SUBLINK", "ANY_SUBLINK", "ALL_SUBLINK"],
  /** Keywords the parser turns into their own node kind and which are safe: CURRENT_DATE and CURRENT_TIMESTAMP only. */
  valueKeywords: ["SVFOP_CURRENT_DATE", "SVFOP_CURRENT_TIMESTAMP"],
  /**
   * Not a deny list (the allow list above is the rule). These are named so the attack tests
   * prove each one is refused: settings, catalogs, files, sleeping, long values, other servers.
   */
  mustRefuse: {
    functions: [
      "set_config", "current_setting", "pg_sleep", "pg_read_file", "pg_ls_dir", "pg_stat_file", "lo_import", "lo_export", "lo_get",
      "dblink", "query_to_xml", "table_to_xml", "pg_advisory_lock", "pg_terminate_backend", "pg_cancel_backend", "version",
      "current_database", "current_schemas", "has_table_privilege", "pg_get_functiondef", "txid_current", "nextval", "setval",
      "repeat", "lpad", "rpad", "string_agg", "array_agg", "json_agg", "jsonb_agg", "format", "concat", "encode", "convert_from",
    ],
    keywords: ["SVFOP_CURRENT_USER", "SVFOP_SESSION_USER", "SVFOP_USER", "SVFOP_CURRENT_ROLE", "SVFOP_CURRENT_CATALOG", "SVFOP_CURRENT_SCHEMA"],
    relations: ["pg_class", "pg_roles", "pg_shadow", "pg_authid", "pg_settings", "pg_stat_activity", "pg_namespace", "pg_tables", "information_schema.tables", "platform.organizations", "platform.secrets", "auth.users"],
    castTypes: ["regclass", "regproc", "regrole", "regnamespace", "regtype", "oid", "name", "xml", "json", "jsonb", "bytea"],
  },
} as const;

/**
 * The size check that closes "one huge cell reaches the server's memory". Before the real
 * query, the tool runs this through `askQuery` with the checked SQL in place of the marker. It
 * returns one small row. If `biggest` is over `ASK_QUERY_LIMITS.maxRowBytes` the real query is
 * never run and the model is told `too_large`.
 */
export const ASK_SIZE_PROBE = {
  marker: "/*__ASK_SQL__*/",
  sql: "select coalesce(max(octet_length(_rms_probe::text)), 0)::int8 as biggest, count(*)::int8 as n from (\n/*__ASK_SQL__*/\n) as _rms_probe",
} as const;
