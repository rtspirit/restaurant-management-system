import { z } from "zod";
import { Ident, ModelRef, Uuid, maxDepth } from "./ids.js";
import { ModelAccess, SYSTEM_FIELDS, WRITABLE_SYSTEM_FIELDS } from "./models.js";

/**
 * Data API wire shapes. Mini-apps send these through @rms/sdk with an app or run token.
 *
 * There is deliberately NO org, restaurant, schema, role, user or environment field anywhere
 * in a request. All of that comes from the verified token. Adding such a field is a security bug.
 */

/**
 * How each field type travels in JSON, in both directions. One table, so the compiler, the
 * Data API, the SDK, the seed and the UI agree.
 *
 * | Field type     | JSON                                                                    |
 * |----------------|-------------------------------------------------------------------------|
 * | text, enum     | string                                                                  |
 * | integer        | number (safe integer)                                                   |
 * | decimal        | string, for example "12.50" (never a float)                             |
 * | boolean        | boolean                                                                 |
 * | money          | number: whole minor units (cents). The currency is the row's `currency` |
 * | quantity       | { "value": "2.5", "unit": "kg" }                                        |
 * | date           | "YYYY-MM-DD"                                                            |
 * | business_date  | "YYYY-MM-DD"                                                            |
 * | timestamp      | ISO 8601 UTC with milliseconds, for example "2026-11-15T03:10:00.000Z"  |
 * | ref            | raw uuid string. Reads may add "<key>_label" when the caller may read the target |
 * | parent_ref     | write: raw uuid string. read: { "id": uuid, "label": string }           |
 * | json           | any JSON value                                                          |
 * | ids            | `id`, `location_id` and refs are raw uuids inside rows                  |
 */
export const MoneyValue = z.number().int().refine(Number.isSafeInteger, "Money must be whole minor units");
export const DecimalValue = z.string().regex(/^-?\d{1,15}(\.\d{1,6})?$/);
export const QuantityValue = z.strictObject({ value: DecimalValue, unit: Ident });
export const DateValue = z.iso.date();
export const TimestampValue = z.iso.datetime();
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
export const ParentRefValue = z.strictObject({ id: Uuid, label: z.string() });
export type QuantityValue = z.infer<typeof QuantityValue>;
export type ParentRefValue = z.infer<typeof ParentRefValue>;

export const Scalar = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof Scalar>;

export type Filter =
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter }
  | { field: string; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "starts_with"; value: Scalar }
  | { field: string; op: "in"; value: Scalar[] }
  | { field: string; op: "between"; value: [Scalar, Scalar] }
  | { field: string; op: "is_null"; value: boolean };

export const MAX_FILTER_DEPTH = 8;

const FilterNode: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(FilterNode).min(1).max(20) }),
    z.strictObject({ or: z.array(FilterNode).min(1).max(20) }),
    z.strictObject({ not: FilterNode }),
    z.strictObject({ field: Ident, op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "starts_with"]), value: Scalar }),
    z.strictObject({ field: Ident, op: z.literal("in"), value: z.array(Scalar).min(1).max(200) }),
    z.strictObject({ field: Ident, op: z.literal("between"), value: z.tuple([Scalar, Scalar]) }),
    z.strictObject({ field: Ident, op: z.literal("is_null"), value: z.boolean() }),
  ]),
) as z.ZodType<Filter>;

/**
 * Filtering, sorting or totalling on a field the caller's role cannot read is refused with
 * `forbidden_field` (otherwise a hidden value could be found by bisection).
 */
export const Filter = z.unknown().refine(maxDepth(MAX_FILTER_DEPTH * 2 + 2), "Filter is nested too deeply").pipe(FilterNode);

export const Sort = z.strictObject({ field: Ident, dir: z.enum(["asc", "desc"]).default("asc") });

export const Aggregate = z.strictObject({
  fn: z.enum(["count", "sum", "avg", "min", "max"]),
  /** Omitted only for count. */
  field: Ident.optional(),
  as: Ident,
});

export const MAX_PAGE = 500;

export const QueryRequest = z.strictObject({
  model: ModelRef,
  /** Omitted = every field the caller may read. Naming an unreadable field is `forbidden_field`. */
  fields: z.array(Ident).max(100).optional(),
  where: Filter.optional(),
  sort: z.array(Sort).max(5).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE).default(50),
  /** Opaque and signed by the server. Bound to the token's org, the model, `where` and `sort`. */
  cursor: z.string().max(1024).optional(),
  /** Totals over the filtered rows, optionally grouped. Returned beside the rows. */
  totals: z.strictObject({ groupBy: z.array(Ident).max(4).optional(), aggregates: z.array(Aggregate).min(1).max(10) }).optional(),
  includeDeleted: z.boolean().optional(),
});
export type QueryRequest = z.infer<typeof QueryRequest>;

export const Row = z.record(z.string(), z.unknown());
export type Row = z.infer<typeof Row>;

export const QueryResponse = z.object({
  rows: z.array(Row),
  nextCursor: z.string().nullable(),
  totals: z.array(Row).optional(),
  /** Fields hidden from this caller's role. The keys are absent from rows, not blanked. */
  masked: z.array(Ident).default([]),
});
export type QueryResponse = z.infer<typeof QueryResponse>;

const blockedOnWrite = new Set<string>(SYSTEM_FIELDS.filter((f) => !(WRITABLE_SYSTEM_FIELDS as readonly string[]).includes(f)));

/**
 * Values for a write. Keys are field keys. Of the system fields only `location_id` and
 * `currency` may be set: the server sets the rest. `location_id` must be inside the token's
 * locations (checked by the API and again by row-level security WITH CHECK). Writing a field
 * the caller's role cannot read is `forbidden_field`.
 */
/** JSON field values may nest, but not without limit (a 5,000-deep value crashed the server before any check). */
export const MAX_VALUE_DEPTH = 16;
export const WriteValues = z
  .unknown()
  .refine(maxDepth(MAX_VALUE_DEPTH + 1), "A value is nested too deeply")
  .pipe(z.record(Ident, z.unknown()).refine((v) => Object.keys(v).every((k) => !blockedOnWrite.has(k)), "A system field cannot be set"));
export type WriteValues = z.infer<typeof WriteValues>;

/** Writes take a child model key (`Ident`). "parent.x" is not an Ident, so it cannot be written. */
export const WriteOp = z.discriminatedUnion("op", [
  /** `id`: optional client-made uuid v7, so later ops in the same batch can point at this row. */
  z.strictObject({ op: z.literal("insert"), model: Ident, id: Uuid.optional(), values: WriteValues }),
  z.strictObject({ op: z.literal("update"), model: Ident, id: Uuid, values: WriteValues, ifUpdatedAt: TimestampValue.optional() }),
  z.strictObject({ op: z.literal("delete"), model: Ident, id: Uuid }),
  /** Insert, or update the row with the same source id. Makes imports repeatable. */
  z.strictObject({ op: z.literal("upsert_by_source"), model: Ident, sourceId: z.string().min(1).max(200), values: WriteValues }),
]);
export type WriteOp = z.infer<typeof WriteOp>;

export const MAX_BATCH = 500;

/** All ops run in one transaction, in order. Any failure rolls back all of them. */
export const BatchRequest = z.strictObject({
  ops: z.array(WriteOp).min(1).max(MAX_BATCH),
  /**
   * Repeating a batch with the same key returns the first result and writes nothing.
   * Stored and looked up per (org, app, env, user) from the token, never globally.
   */
  idempotencyKey: z.string().min(8).max(100).optional(),
});
export type BatchRequest = z.infer<typeof BatchRequest>;

export const BatchResponse = z.object({
  results: z.array(z.object({ op: z.string(), model: z.string(), id: Uuid })),
});
export type BatchResponse = z.infer<typeof BatchResponse>;

const Params = z.record(Ident, Scalar).default({});

export const NamedQueryRequest = z.strictObject({ query: Ident, params: Params, limit: z.number().int().min(1).max(5000).default(1000) });
export type NamedQueryRequest = z.infer<typeof NamedQueryRequest>;

export const NamedQueryResponse = z.object({
  columns: z.array(z.object({ key: z.string(), label: z.string(), type: z.string() })),
  rows: z.array(Row),
  masked: z.array(Ident).default([]),
});
export type NamedQueryResponse = z.infer<typeof NamedQueryResponse>;

export const NamedActionRequest = z.strictObject({ action: Ident, params: Params });
export type NamedActionRequest = z.infer<typeof NamedActionRequest>;
export const NamedActionResponse = z.object({ affected: z.number().int().nonnegative() });

/** What a token may see of the model layer. Shapes only: never SQL, never another restaurant. */
export const CatalogResponse = z.object({
  models: z.array(z.object({
    ref: z.string(),
    name: z.string(),
    description: z.string(),
    access: ModelAccess,
    fields: z.array(z.object({ key: z.string(), label: z.string(), type: z.string(), required: z.boolean(), values: z.array(z.string()).optional(), refersTo: z.string().optional() })),
  })),
  namedQueries: z.array(z.object({ key: z.string(), name: z.string(), description: z.string(), params: z.array(z.object({ key: z.string(), type: z.string(), required: z.boolean() })), columns: z.array(z.object({ key: z.string(), label: z.string(), type: z.string() })) })),
  actions: z.array(z.object({ key: z.string(), name: z.string(), description: z.string(), params: z.array(z.object({ key: z.string(), type: z.string(), required: z.boolean() })) })),
});
export type CatalogResponse = z.infer<typeof CatalogResponse>;

/**
 * Errors. `message` is plain words, safe to show an owner. Internal detail goes to logs with
 * the request id and is never sent to a mini-app's screens.
 */
export const DataErrorCode = z.enum([
  "unauthenticated", // no token, bad signature, expired, wrong audience or kind
  "forbidden_model", // model, query or action not in the mini-app's manifest, or access too low
  "forbidden_role", // the user's role may not do this
  "forbidden_field", // read, write, filter, sort or total on a field the role cannot read
  "forbidden_location", // a row or location_id outside the token's locations
  "read_only", // tried to write parent data
  "invalid_request", // failed validation against the wire shape or the model definition
  "not_found",
  "conflict", // unique rule, stale ifUpdatedAt, closed period, unbalanced entry
  "limit", // too many rows, too slow, over budget
  "internal",
]);
export type DataErrorCode = z.infer<typeof DataErrorCode>;

export const DATA_ERROR_STATUS: Record<DataErrorCode, number> = {
  unauthenticated: 401, forbidden_model: 403, forbidden_role: 403, forbidden_field: 403, forbidden_location: 403,
  read_only: 403, invalid_request: 400, not_found: 404, conflict: 409, limit: 429, internal: 500,
};

export const DataError = z.object({ error: z.object({ code: DataErrorCode, message: z.string(), requestId: z.string() }) });
export type DataError = z.infer<typeof DataError>;

/** Routes, all POST with a JSON body, all under the API origin. */
export const DATA_ROUTES = {
  query: "/data/v1/query",
  batch: "/data/v1/batch",
  named: "/data/v1/named",
  action: "/data/v1/action",
  catalog: "/data/v1/catalog",
} as const;
