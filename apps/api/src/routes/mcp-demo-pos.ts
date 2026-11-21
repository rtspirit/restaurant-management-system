// Task L owns this file. Brief: docs/briefs/wave2.md, task L.
// Mounted at /mcp/demo-pos by src/index.ts (lead-owned), so the full paths match DEMO_POS.route in @rms/contracts.
//
// Demo POS: a made-up point-of-sale system, served as an MCP server (stateless, streamable HTTP).
// Called by the gateway only, server to server, so there is no browser access here at all.
// The restaurant and the connection come from the verified connection token (`verifyConnectionToken`) and nothing else.
import { Hono } from "hono";
import { safeHeaders } from "../lib/http.js";

export const demoPosRoutes = new Hono();

demoPosRoutes.use("*", safeHeaders());
