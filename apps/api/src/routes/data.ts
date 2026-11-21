// The Data API routes. Task D owns this file. Mounted at /data by src/index.ts (lead-owned),
// so the full paths match DATA_ROUTES in @rms/contracts.
//
// This file is deliberately thin. It does three things and nothing else:
//   1. `requireDataToken` verifies the app or run token and builds the tenant context.
//   2. The JSON body is read (size-capped) and handed over as untrusted data.
//   3. `handleData` from @rms/data does the rest and always returns a reply.
// The restaurant, user, role, locations and environment are taken from `c.var.tenant` only.
// Nothing here reads a query string, a path parameter or any header other than the token.
import { type DataEnv, requireDataToken } from "@rms/auth";
import { DATA_ERROR_STATUS, type DataError } from "@rms/contracts";
import { type DataRoute, handleData } from "@rms/data";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Largest request body, in bytes. A full batch of 500 ops fits comfortably. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const refuse = (c: Context, code: "invalid_request" | "limit", message: string) => {
  const body: DataError = { error: { code, message, requestId: crypto.randomUUID() } };
  return c.json(body, DATA_ERROR_STATUS[code] as ContentfulStatusCode);
};

export const dataRoutes = new Hono<DataEnv>();

dataRoutes.use("*", requireDataToken);
dataRoutes.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => refuse(c, "limit", "That request is too large. Please send less at once.") }));

const route = (name: DataRoute) => async (c: Context<DataEnv>) => {
  const requestId = crypto.randomUUID();
  let body: unknown;
  const text = await c.req.text();
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return refuse(c, "invalid_request", "That request is not valid.");
    }
  }
  const reply = await handleData(name, c.var.tenant, body, requestId);
  return c.json(reply.body as object, reply.status as ContentfulStatusCode);
};

dataRoutes.post("/v1/query", route("query"));
dataRoutes.post("/v1/batch", route("batch"));
dataRoutes.post("/v1/named", route("named"));
dataRoutes.post("/v1/action", route("action"));
dataRoutes.post("/v1/catalog", route("catalog"));
