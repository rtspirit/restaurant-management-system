// Task L owns this file. Brief: docs/briefs/wave2.md, task L.
// Mounted at /connections by src/index.ts (lead-owned), so the full paths match CONNECTION_ROUTES in @rms/contracts.
//
// Connected systems: the catalog, connect, approve the tool list, bring information in, disconnect. Owner only.
// Identity comes from `requireSession` only. A connection's token is never returned by any route.
import { Hono } from "hono";
import { safeHeaders, webCors } from "../lib/http.js";

export const connectionRoutes = new Hono();

connectionRoutes.use("*", webCors());
connectionRoutes.use("*", safeHeaders());
