// Task I owns this file. Brief: docs/briefs/wave2.md, task I.
// Mounted at /agent by src/index.ts (lead-owned), so the full paths match AGENT_ROUTES in @rms/contracts.
//
// Build sessions: start a run, read a session, stream its events, hand out a preview grant, cancel.
// Identity comes from `requireSession` only (the owner's own restaurant). Building is owner-only today.
// The ids in the paths are looked up fenced to that restaurant (`withOrg`), so another restaurant's id is not found.
// Nothing raw from the sandbox or the model leaves through here: only stored, owner-safe AgentEvents.
import { Hono } from "hono";
import { safeHeaders, webCors } from "../lib/http.js";

export const agentRoutes = new Hono();

agentRoutes.use("*", webCors());
agentRoutes.use("*", safeHeaders());
