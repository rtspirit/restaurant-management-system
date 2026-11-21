// Task L owns this file. Brief: docs/briefs/wave2.md, task L.
// Mounted at /connections by src/index.ts (lead-owned), so the full paths match CONNECTION_ROUTES in @rms/contracts.
//
// Connected systems: the catalog, connect, approve the tool list, bring information in, disconnect. Owner only.
// Identity comes from `requireSession` only. A connection's token is never returned by any route.
import { ApproveToolsRequest, ConnectRequest, SyncRequest, toUuid } from "@rms/contracts";
import { type SessionEnv, requireSession } from "@rms/auth";
import { adminDb } from "@rms/db";
import { GovernanceError, confirmByOwner, recordChange } from "@rms/governance";
import {
  GatewayError,
  type GatewayOptions,
  approveTools,
  catalogEntries,
  connectDemoPos,
  disconnect,
  listConnections,
  syncDemoPos,
} from "@rms/mcp";
import { type Context, Hono } from "hono";
import { apiError, logLine, readJson, safeHeaders, webCors } from "../lib/http.js";

export const connectionRoutes = new Hono<SessionEnv>();

connectionRoutes.use("*", webCors());
connectionRoutes.use("*", safeHeaders());
connectionRoutes.use("*", requireSession);
// Wave 2 routes are owner-only.
connectionRoutes.use("*", async (c, next) => {
  if (c.get("tenant").role !== "owner") return apiError(c, "forbidden", "Only the owner can change connected systems.");
  await next();
});

/** Test seam: how the gateway reaches a connected system. Never set outside tests. */
let gatewayOptions: GatewayOptions = {};
export const setGatewayOptionsForTests = (opts: GatewayOptions): void => {
  gatewayOptions = opts;
};

const gatewayFailure = (c: Context, e: unknown) => {
  if (e instanceof GatewayError) {
    if (e.reason === "not_found") return apiError(c, "not_found", e.message);
    if (e.reason === "denied") return apiError(c, "busy", e.message);
    if (e.reason === "unavailable") return apiError(c, "unavailable", e.message);
    return apiError(c, "unavailable", e.message);
  }
  throw e;
};

const tenantOf = (c: Context<SessionEnv>) => ({ orgId: c.get("tenant").orgId });

connectionRoutes.get("/v1/catalog", async (c) => {
  try {
    return c.json({ entries: await catalogEntries(tenantOf(c)) });
  } catch (e) {
    return gatewayFailure(c, e);
  }
});

connectionRoutes.get("/v1", async (c) => c.json({ connections: await listConnections(tenantOf(c)) }));

connectionRoutes.post("/v1", async (c) => {
  const parsed = ConnectRequest.safeParse(await readJson(c));
  if (!parsed.success) return apiError(c, "invalid_request", "That request was not understood.");
  if (parsed.data.kind === "custom") return apiError(c, "unavailable", "Connecting your own system is not available yet.");
  if (parsed.data.key !== "demo_pos") return apiError(c, "not_found", "That system is not in the list.");

  const tenant = c.get("tenant");
  const requestId = crypto.randomUUID();
  try {
    const outcome = await connectDemoPos(tenantOf(c), gatewayOptions);
    if (outcome.created) {
      // A new connection is a T2 change: recorded, then confirmed at once, because pressing
      // Connect IS the owner's one-sentence yes. Both on the admin connection (ADR 0004).
      const change = await adminDb().begin((tx) =>
        recordChange(tx, {
          orgUuid: tenant.orgId,
          origin: "connection",
          actor: tenant.actor,
          signals: ["new_connection"],
          subject: { kind: "connection", name: outcome.view.name },
          diff: { tools: outcome.tools.map((t) => t.name), readOnly: outcome.tools.every((t) => t.readOnly) },
          requestId,
        }),
      );
      if (change.decision === "pending_owner") {
        await confirmByOwner(adminDb(), { orgUuid: tenant.orgId, changeSetId: change.id, actor: tenant.actor, role: tenant.role, requestId });
      }
    }
    return c.json(outcome.view);
  } catch (e) {
    if (e instanceof GovernanceError) {
      logLine({ requestId, at: "connections.connect", error: e.message });
      return apiError(c, "internal", "Something went wrong on our side. Please try again.", requestId);
    }
    return gatewayFailure(c, e);
  }
});

connectionRoutes.post("/v1/:connectionId/approve", async (c) => {
  const parsed = ApproveToolsRequest.safeParse(await readJson(c));
  if (!parsed.success) return apiError(c, "invalid_request", "That request was not understood.");
  try {
    return c.json(await approveTools(tenantOf(c), c.req.param("connectionId"), parsed.data.tools));
  } catch (e) {
    return gatewayFailure(c, e);
  }
});

connectionRoutes.post("/v1/:connectionId/sync", async (c) => {
  const body = await readJson(c);
  const parsed = SyncRequest.safeParse(body ?? {});
  if (!parsed.success) return apiError(c, "invalid_request", "That request was not understood.");
  const tenant = c.get("tenant");
  if (tenant.actor.type !== "user") return apiError(c, "forbidden", "Only the owner can bring in sales.");
  try {
    const result = await syncDemoPos({ tenant: tenantOf(c), ownerUserId: toUuid(tenant.actor.id), connectionId: c.req.param("connectionId") }, gatewayOptions);
    return c.json(result);
  } catch (e) {
    return gatewayFailure(c, e);
  }
});

connectionRoutes.post("/v1/:connectionId/disconnect", async (c) => {
  // No body. An empty object is tolerated; anything else (an org id, say) is refused.
  const body = await readJson(c);
  if (body !== undefined && !(body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)) {
    return apiError(c, "invalid_request", "That request was not understood.");
  }
  try {
    return c.json(await disconnect(tenantOf(c), c.req.param("connectionId")));
  } catch (e) {
    return gatewayFailure(c, e);
  }
});
