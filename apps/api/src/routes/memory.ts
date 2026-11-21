// Task M owns this file. Brief: docs/briefs/wave2.md, task M.
// Mounted at /memory by src/index.ts (lead-owned), so the full paths match MEMORY_ROUTES in @rms/contracts.
//
// The duplicate check and the session summaries, for the owner's own restaurant only. Owner only.
// Identity comes from `requireSession` only: the body is checked with a strict schema, so a body
// that names a restaurant (`orgId`) is refused, never read. A similarity score never leaves the server.
import { type SessionEnv, requireSession } from "@rms/auth";
import { DuplicateCheckRequest, DuplicateCheckResult, MEMORY_ROUTES } from "@rms/contracts";
import { checkDuplicate, recall } from "@rms/memory";
import { type Context, Hono } from "hono";
import { apiError, logLine, readJson, safeHeaders, webCors } from "../lib/http.js";

export const memoryRoutes = new Hono<SessionEnv>();

memoryRoutes.use("*", webCors());
memoryRoutes.use("*", safeHeaders());

const PREFIX = "/memory";
const path = (full: string): string => full.slice(PREFIX.length);

const ownerOnly = (c: Context<SessionEnv>) =>
  c.var.tenant.role === "owner" ? null : apiError(c, "forbidden", "Only the owner can do this.");

memoryRoutes.post(path(MEMORY_ROUTES.duplicates), requireSession, async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const parsed = DuplicateCheckRequest.safeParse(await readJson(c));
  if (!parsed.success) return apiError(c, "invalid_request", "Please tell us what you would like to build.");
  const requestId = crypto.randomUUID();
  try {
    const result = await checkDuplicate(c.var.tenant, parsed.data.text);
    return c.json(DuplicateCheckResult.parse(result));
  } catch (e) {
    logLine({ requestId, route: "memory.duplicates", error: e instanceof Error ? e.message : "unknown" });
    return apiError(c, "internal", "We could not check your mini-apps just now. Please try again.", requestId);
  }
});

memoryRoutes.get(path(MEMORY_ROUTES.summaries), requireSession, async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const requestId = crypto.randomUUID();
  try {
    const { summaries } = await recall(c.var.tenant, { limit: 20 });
    return c.json({ summaries });
  } catch (e) {
    logLine({ requestId, route: "memory.summaries", error: e instanceof Error ? e.message : "unknown" });
    return apiError(c, "internal", "We could not load what RMS remembers just now. Please try again.", requestId);
  }
});
