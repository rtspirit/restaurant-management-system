// Errors the Data API sends. Every message here is written by us, in plain words.
// The database's own message text never leaves this file: only its error code is read.
import { DATA_ERROR_STATUS, type DataError, type DataErrorCode, type ModelDefinition, type ModelRule } from "@rms/contracts";

const DEFAULT_MESSAGE: Record<DataErrorCode, string> = {
  unauthenticated: "Please sign in again.",
  forbidden_model: "This mini-app is not allowed to use that information.",
  forbidden_role: "Your role does not allow this.",
  forbidden_field: "Your role cannot see or change one of those details.",
  forbidden_location: "That is outside the locations you work with.",
  read_only: "That information is managed by RMS and cannot be changed here.",
  invalid_request: "That request is not valid.",
  not_found: "That record could not be found.",
  conflict: "That change clashes with what is already saved.",
  limit: "That is too much at once. Please ask for less.",
  internal: "Something went wrong on our side. Please try again.",
};

/** The only error type the Data API lets out. `message` is always one of our own plain sentences. */
export class DataApiError extends Error {
  constructor(
    readonly code: DataErrorCode,
    message?: string,
    /** Short internal note for the log. Never sent. Must not hold field values. */
    readonly note?: string,
  ) {
    super(message ?? DEFAULT_MESSAGE[code]);
  }
}

type PgError = { code: string; constraint_name?: string; table_name?: string; message?: string };

/** A database error has a five character SQLSTATE in `code` and comes from the driver's error class. */
export const isPgError = (e: unknown): e is PgError =>
  typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" && /^[0-9A-Z]{5}$/.test((e as { code: string }).code) &&
  (e as { name?: unknown }).name === "PostgresError";

export type ErrorHints = {
  /** What was being attempted, to pick the fitting code for a broken link. */
  op?: "read" | "write" | "delete" | "named";
  /** True when the caller's role has hidden fields among the models a report reads. */
  hasMaskedFields?: boolean;
  /** The models being written, so a broken model rule can be told apart by its name. */
  models?: ReadonlyArray<Pick<ModelDefinition, "key" | "rules">>;
};

/**
 * Finds the model rule a failed constraint belongs to. The model compiler names a rule's
 * constraint `<model>_<rule>` (cut to fit) followed by `_rule_<8 hex>`. The name is only
 * compared, never shown.
 */
const brokenRule = (e: PgError, models: ErrorHints["models"]): ModelRule | null => {
  const name = e.constraint_name;
  if (!name || !models || !/_rule_[0-9a-f]{8}$/.test(name)) return null;
  const stem = name.slice(0, -14);
  let found: ModelRule | null = null;
  for (const m of models) {
    for (const r of m.rules) {
      if (`${m.key}_${r.name}`.slice(0, 49) !== stem) continue;
      // If two rules share a cut-off name, prefer the stricter answer.
      if (!found || found.kind === "check") found = r;
    }
  }
  return found;
};

const ruleError = (rule: ModelRule, note: string): DataApiError => {
  switch (rule.kind) {
    case "check":
      return new DataApiError("invalid_request", rule.message, note);
    case "balanced":
      return new DataApiError("conflict", "That entry does not balance. Both sides must add up to the same amount, in one currency.", note);
    case "open_period_only":
      return new DataApiError("conflict", "That date falls in a period that is already closed.", note);
    case "ref_value_in":
      return new DataApiError("conflict", rule.message, note);
  }
};

/**
 * Turns a database error into one of our codes. Reads the SQLSTATE only, plus one fixed phrase
 * to tell a row-level security refusal from a missing grant. Never copies database text.
 */
export const fromPg = (e: PgError, hints: ErrorHints = {}): DataApiError => {
  const s = e.code;
  const note = `sqlstate ${s}`;
  if (s === "23505") return new DataApiError("conflict", "A record with those details already exists.", note);
  if (s === "23503") {
    return hints.op === "delete"
      ? new DataApiError("conflict", "That record is still used by other records, so it cannot be removed.", note)
      : new DataApiError("invalid_request", "One of the linked records does not exist.", note);
  }
  if (s === "23502") return new DataApiError("invalid_request", "A required detail is missing.", note);
  if (s === "23514") {
    // A model rule (raised by a compiled check or trigger, possibly only at the end of the
    // batch) or a plain column check such as an enum's allowed values.
    const rule = brokenRule(e, hints.models);
    return rule ? ruleError(rule, note) : new DataApiError("invalid_request", "One of the values is not allowed for this kind of record.", note);
  }
  if (s.startsWith("23")) return new DataApiError("conflict", undefined, note);
  if (s === "42501") {
    const rls = typeof e.message === "string" && e.message.includes("row-level security");
    return rls ? new DataApiError("forbidden_location", undefined, note) : new DataApiError("forbidden_model", "That is not allowed for this kind of record.", note);
  }
  if (s === "57014") return new DataApiError("limit", "That took too long. Please ask for less at once.", note);
  if (s.startsWith("22")) return new DataApiError("invalid_request", "One of the values is not in the right form.", note);
  if (s === "P0001" || s === "23P01") return new DataApiError("conflict", "That change breaks one of the rules for these records.", note);
  if (s === "40001" || s === "40P01" || s === "55P03") return new DataApiError("conflict", "Someone else changed this at the same time. Please try again.", note);
  if (s === "42703" && hints.op === "named" && hints.hasMaskedFields) {
    return new DataApiError("forbidden_field", "This report needs details your role cannot see.", note);
  }
  return new DataApiError("internal", undefined, note);
};

export const toDataApiError = (e: unknown, hints: ErrorHints = {}): DataApiError => {
  if (e instanceof DataApiError) return e;
  if (isPgError(e)) return fromPg(e, hints);
  return new DataApiError("internal", undefined, e instanceof Error ? `${e.name}: ${e.message.slice(0, 160)}` : "unknown");
};

export type ErrorResponse = { status: number; body: DataError };

/** The response for a failure. Logs the internal note with the request id. Values are never logged. */
export const errorResponse = (e: unknown, requestId: string, route: string, hints: ErrorHints = {}): ErrorResponse => {
  const err = toDataApiError(e, hints);
  if (err.code === "internal" || err.note) {
    const pg = isPgError(e) ? { constraint: e.constraint_name, table: e.table_name } : {};
    console.error(JSON.stringify({ at: "data-api", requestId, route, code: err.code, note: err.note, ...pg }));
  }
  return { status: DATA_ERROR_STATUS[err.code], body: { error: { code: err.code, message: err.message, requestId } } };
};
