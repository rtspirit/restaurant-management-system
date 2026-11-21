// @rms/data: the Data API core. Every mini-app read and write goes through here.
//
// The rules this package keeps (plan 4.11, ADR 0002 to 0004):
//   * The restaurant, user, role, locations, environment and mini-app come ONLY from the
//     verified TenantContext. No function here takes any of them from a request body.
//   * A store is entered only through `withStore` from @rms/db.
//   * Every name placed in SQL comes from a parsed model definition, the storage contract or
//     the fixed parent table list, and goes through `ident()`. Every value is a bound parameter.
//   * A refusal is always one of the DataErrorCode values with a plain-word message. Database
//     error text never leaves the server.
import type { TenantContext } from "@rms/contracts";
import { runBatch } from "./batch.js";
import { runCatalog } from "./catalog.js";
import { type ErrorHints, errorResponse } from "./errors.js";
import { runNamedAction, runNamedQuery } from "./named.js";
import { runQuery } from "./query.js";

export { runBatch } from "./batch.js";
export { runCatalog } from "./catalog.js";
export { DataApiError, errorResponse, toDataApiError } from "./errors.js";
export { runNamedAction, runNamedQuery } from "./named.js";
export { runQuery } from "./query.js";
export { TemplateError, parseTemplate, renderTemplate } from "./template.js";
export { decodeCursor, encodeCursor } from "./cursor.js";
export { readOnlyStore, run } from "./sql.js";

export type DataRoute = "query" | "batch" | "named" | "action" | "catalog";
export type DataReply = { status: number; body: unknown };

const HINTS: Record<DataRoute, ErrorHints> = { query: { op: "read" }, batch: { op: "write" }, named: { op: "named" }, action: { op: "named" }, catalog: { op: "read" } };

/**
 * Runs one Data API request and always returns a reply: the route's response, or a DataError.
 * `tenant` must be the context `requireDataToken` built from a verified app or run token.
 * `body` is the parsed JSON body, untrusted.
 */
export const handleData = async (route: DataRoute, tenant: TenantContext, body: unknown, requestId: string): Promise<DataReply> => {
  try {
    switch (route) {
      case "query":
        return { status: 200, body: await runQuery(tenant, body) };
      case "batch":
        return { status: 200, body: await runBatch(tenant, body, requestId) };
      case "named":
        return { status: 200, body: await runNamedQuery(tenant, body) };
      case "action":
        return { status: 200, body: await runNamedAction(tenant, body, requestId) };
      case "catalog":
        return { status: 200, body: await runCatalog(tenant, body) };
    }
  } catch (e) {
    return errorResponse(e, requestId, route, HINTS[route]);
  }
};
