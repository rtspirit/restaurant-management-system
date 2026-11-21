// Task K owns this file. Brief: docs/briefs/wave2.md, task K.
// Mounted at /ask by src/index.ts (lead-owned), so the full paths match ASK_ROUTES in @rms/contracts.
//
// The Ask agent: one question in, a stream of AgentEvents out. Owner only (ADR 0002).
// Identity comes from `requireSession` only. Model-written SQL runs ONLY through mintAskLogin, openAsk and askQuery in @rms/db.
import { Hono } from "hono";
import { safeHeaders, webCors } from "../lib/http.js";

export const askRoutes = new Hono();

askRoutes.use("*", webCors());
askRoutes.use("*", safeHeaders());
