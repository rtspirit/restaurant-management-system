// @rms/data: the Data API core. Every mini-app read and write goes through here.
//
// The rules this package keeps (plan 4.11, ADR 0002 to 0004):
//   * The restaurant, user, role, locations, environment and mini-app come ONLY from the
//     verified TenantContext. No function here takes any of them from a request body.
//   * A store is entered only through `withStore` from @rms/db.
//   * Every name placed in SQL comes from a parsed model definition, the storage contract or
//     the fixed parent table list, and goes through `ident()`. Every value is a bound parameter.
//   * A named query or action template runs only after it passes the allow list in
//     template-check.ts (real PostgreSQL parser, everything not listed is refused).
//   * A refusal is always one of the DataErrorCode values with a plain-word message. Database
//     error text never leaves the server.
import type { TenantContext } from "@rms/contracts";
import { runBatch } from "./batch.js";
import { runCatalog } from "./catalog.js";
import { DataApiError, type ErrorHints, errorResponse } from "./errors.js";
import { enterRestaurant } from "./limit.js";
import { runNamedAction, runNamedQuery } from "./named.js";
import { readParent } from "./parent-read.js";
import { runQuery } from "./query.js";

export { runBatch } from "./batch.js";
export { runCatalog } from "./catalog.js";
export { DataApiError, errorResponse, toDataApiError } from "./errors.js";
export { runNamedAction, runNamedQuery } from "./named.js";
export { runQuery } from "./query.js";
export { type ParentRead, readParent } from "./parent-read.js";
export { TemplateError, parseTemplate, renderTemplate } from "./template.js";
export { FUNCTIONS, checkNamedAction, checkNamedQuery, checkTemplate } from "./template-check.js";
export { decodeCursor, encodeCursor } from "./cursor.js";
export { readOnlyStore, run } from "./sql.js";
export { DEFAULT_MAX_IN_FLIGHT, maxInFlight } from "./limit.js";

export type DataRoute = "query" | "batch" | "named" | "action" | "catalog";
export type DataReply = { status: number; body: unknown };

const TOO_MUCH_AT_ONCE = "Too much is being asked for at once. Please try again in a moment.";

const HINTS: Record<DataRoute, ErrorHints> = { query: { op: "read" }, batch: { op: "write" }, named: { op: "named" }, action: { op: "named" }, catalog: { op: "read" } };

const dispatch = async (route: DataRoute, tenant: TenantContext, body: unknown, requestId: string): Promise<unknown> => {
  switch (route) {
    case "query":
      return runQuery(tenant, body);
    case "batch":
      return runBatch(tenant, body, requestId);
    case "named":
      return runNamedQuery(tenant, body);
    case "action":
      return runNamedAction(tenant, body, requestId);
    case "catalog":
      return runCatalog(tenant, body);
  }
};

/**
 * Runs one Data API request and always returns a reply: the route's response, or a DataError.
 * `tenant` must be the context `requireDataToken` built from a verified app or run token.
 * `body` is the parsed JSON body, untrusted.
 */
export const handleData = async (route: DataRoute, tenant: TenantContext, body: unknown, requestId: string): Promise<DataReply> => {
  const leave = enterRestaurant(tenant.orgId);
  if (!leave) return errorResponse(new DataApiError("limit", TOO_MUCH_AT_ONCE), requestId, route);
  try {
    return { status: 200, body: await dispatch(route, tenant, body, requestId) };
  } catch (e) {
    return errorResponse(e, requestId, route, HINTS[route]);
  } finally {
    leave();
  }
};

/**
 * Reads one of a restaurant's parent-data lists for RMS's own screens and always returns a
 * reply. Counts toward the same per-restaurant cap as mini-app requests.
 * `tenant` must be the context `requireSession` built from a verified sign-in. `model` is
 * untrusted: it is checked against the ten fixed lists.
 */
export const handleParentRead = async (tenant: TenantContext, model: unknown, requestId: string): Promise<DataReply> => {
  const leave = enterRestaurant(tenant.orgId);
  if (!leave) return errorResponse(new DataApiError("limit", TOO_MUCH_AT_ONCE), requestId, "parent");
  try {
    return { status: 200, body: await readParent(tenant, model) };
  } catch (e) {
    return errorResponse(e, requestId, "parent", { op: "read" });
  } finally {
    leave();
  }
};
