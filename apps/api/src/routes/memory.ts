// Task M owns this file. Brief: docs/briefs/wave2.md, task M.
// Mounted at /memory by src/index.ts (lead-owned), so the full paths match MEMORY_ROUTES in @rms/contracts.
//
// The duplicate check and the session summaries, for the owner's own restaurant only. Owner only.
// Identity comes from `requireSession` only. A similarity score never leaves the server.
import { Hono } from "hono";
import { safeHeaders, webCors } from "../lib/http.js";

export const memoryRoutes = new Hono();

memoryRoutes.use("*", webCors());
memoryRoutes.use("*", safeHeaders());
