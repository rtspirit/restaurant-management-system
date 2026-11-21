// Task L owns this file. Brief: docs/briefs/wave2.md, task L.
// Mounted at /mcp/demo-pos by src/index.ts (lead-owned), so the full paths match DEMO_POS.route in @rms/contracts.
//
// Demo POS: a made-up point-of-sale system, served as an MCP server (stateless, streamable HTTP).
// Called by the gateway only, server to server, so there is no browser access here at all.
// The restaurant and the connection come from the verified connection token (`verifyConnectionToken`) and nothing else.
import { bearer } from "@rms/auth";
import { serveDemoPos } from "@rms/mcp";
import { Hono } from "hono";
import { safeHeaders } from "../lib/http.js";

export const demoPosRoutes = new Hono();

demoPosRoutes.use("*", safeHeaders());

/** The API's own host name, from API_URL. Requests naming any other host are refused (DNS rebinding). */
const allowedHost = (): string | null => {
  try {
    return process.env.API_URL ? new URL(process.env.API_URL).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

demoPosRoutes.use("*", async (c, next) => {
  // No credential, no conversation: refused before anything else is looked at.
  if (!bearer(c.req.header("authorization"))) {
    return c.json({ error: { code: "unauthenticated", message: "A valid connection token is needed." } }, 401);
  }
  const host = allowedHost();
  if (!host) return c.json({ error: { code: "unavailable", message: "Demo POS is not available right now." } }, 503);
  // The server builds the request address from the Host header, so this is the host asked for.
  let asked: string | null = null;
  try {
    asked = new URL(c.req.url).hostname.toLowerCase();
  } catch {
    asked = null;
  }
  if (asked !== host) return c.json({ error: { code: "forbidden", message: "Not available here." } }, 403);
  // Server to server only: a browser always sends an Origin, the gateway never does.
  if (c.req.header("origin") !== undefined) return c.json({ error: { code: "forbidden", message: "Not available here." } }, 403);
  await next();
});

demoPosRoutes.all("/", (c) => serveDemoPos(c.req.raw));
