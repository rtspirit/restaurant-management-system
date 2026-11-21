import { z } from "zod";
import { Ident, Uuid } from "./ids.js";

/**
 * Data API wire shapes. Mini-apps send these through @rms/sdk with an app or run token.
 *
 * There is deliberately NO org, restaurant, schema, role, user or environment field anywhere
 * in a request. All of that comes from the verified token. Adding such a field is a security bug.
 */

export const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof Scalar>;

export const FilterOp = z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "starts_with", "is_null", "between"]);
export type FilterOp = z.infer<typeof FilterOp>;

export type Filter =
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter }
  | { field: string; op: FilterOp; value?: Scalar | Scalar[] };

export const Filter: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(Filter).min(1).max(20) }),
    z.strictObject({ or: z.array(Filter).min(1).max(20) }),
    z.strictObject({ not: Filter }),
    z.strictObject({ field: Ident, op: FilterOp, value: z.union([Scalar, z.array(Scalar).max(200)]).optional() }),
  ]),
) as z.ZodType<Filter>;

export const Sort = z.strictObject({ field: Ident, dir: z.enum(["asc", "desc"]).default("asc") });

export const Aggregate = z.strictObject({
  fn: z.enum(["count", "sum", "avg", "min", "max"]),
  /** Omitted only for count. */
  field: Ident.optional(),
  as: Ident,
});

export const MAX_PAGE = 500;

export const QueryRequest = z.strictObject({
  model: z.string().regex(/^(parent\.)?[a-z][a-z0-9_]{0,47}$/),
  /** Omitted = every field the caller may read. */
  fields: z.array(Ident).max(100).optional(),
  where: Filter.optional(),
  sort: z.array(Sort).max(5).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE).default(50),
  cursor: z.string().max(512).optional(),
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
  /** Fields hidden from this caller's role. The values are absent, not blanked. */
  masked: z.array(Ident).default([]),
});
export type QueryResponse = z.infer<typeof QueryResponse>;

/** Writes never target a parent model. The schema makes "parent." unrepresentable here. */
const ChildModel = Ident;

export const WriteOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("insert"), model: ChildModel, values: Row, clientRef: z.string().max(64).optional() }),
  z.strictObject({ op: z.literal("update"), model: ChildModel, id: Uuid, values: Row, ifUpdatedAt: z.iso.datetime().optional() }),
  z.strictObject({ op: z.literal("delete"), model: ChildModel, id: Uuid }),
  /** Insert, or update the row with the same source + source_id. Makes imports repeatable. */
  z.strictObject({ op: z.literal("upsert_by_source"), model: ChildModel, sourceId: z.string().min(1).max(200), values: Row }),
]);
export type WriteOp = z.infer<typeof WriteOp>;

export const MAX_BATCH = 500;

/** All ops run in one transaction. Any failure rolls back all of them. */
export const BatchRequest = z.strictObject({
  ops: z.array(WriteOp).min(1).max(MAX_BATCH),
  /** Repeating a batch with the same key returns the first result and writes nothing. */
  idempotencyKey: z.string().min(8).max(100).optional(),
});
export type BatchRequest = z.infer<typeof BatchRequest>;

export const BatchResponse = z.object({
  results: z.array(z.object({ op: z.string(), model: z.string(), id: Uuid, clientRef: z.string().optional() })),
});
export type BatchResponse = z.infer<typeof BatchResponse>;

export const NamedQueryRequest = z.strictObject({
  query: Ident,
  params: z.record(Ident, Scalar).default({}),
  limit: z.number().int().min(1).max(5000).default(1000),
});
export type NamedQueryRequest = z.infer<typeof NamedQueryRequest>;

export const NamedQueryResponse = z.object({
  columns: z.array(z.object({ key: z.string(), label: z.string(), type: z.string() })),
  rows: z.array(Row),
  masked: z.array(Ident).default([]),
});
export type NamedQueryResponse = z.infer<typeof NamedQueryResponse>;

/**
 * Errors. `message` is plain words, safe to show an owner. `detail` is for logs and the
 * maintainer console only and is never sent to a mini-app's screens.
 */
export const DataErrorCode = z.enum([
  "unauthenticated", // no token, bad signature, expired, wrong audience
  "forbidden_model", // model or access not in the mini-app's manifest
  "forbidden_role", // the user's role may not do this
  "forbidden_field", // tried to filter, sort or total on a field the role cannot read
  "read_only", // tried to write parent data
  "invalid_request", // failed validation against the model definition
  "not_found",
  "conflict", // unique rule, stale ifUpdatedAt, closed period, unbalanced entry
  "limit", // too many rows, too slow, over budget
  "internal",
]);
export type DataErrorCode = z.infer<typeof DataErrorCode>;

export const DataError = z.object({ error: z.object({ code: DataErrorCode, message: z.string(), requestId: z.string() }) });
export type DataError = z.infer<typeof DataError>;

/** Routes, all POST, all under the API origin. */
export const DATA_ROUTES = {
  query: "/data/v1/query",
  batch: "/data/v1/batch",
  named: "/data/v1/named",
  /** Model and named-query catalog visible to this token (shapes only). */
  catalog: "/data/v1/catalog",
} as const;
