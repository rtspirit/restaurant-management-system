// The Demo POS MCP server RMS hosts. Stateless: a fresh server for every request
// (`createMcpHandler`, MCP TypeScript SDK v2; docs/reference/verified-apis.md section 9).
//
// Who is asking comes from the bearer connection token ONLY (`verifyConnectionToken`). The
// token names the restaurant and the connection; the connection must exist for that restaurant,
// be the Demo POS, and be `connected` or `needs_approval`. Nothing in the request body, query or
// path can name a restaurant. The answers are that restaurant's demo template numbers and no
// one else's.
import { DEMO_POS, DEMO_POS_TOOLS, DEMO_POS_TOOL_NAMES, type DemoPosToolName, toUuid } from "@rms/contracts";
import { TokenError, bearer, verifyConnectionToken } from "@rms/auth";
import { apiDb, withOrg } from "@rms/db";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import type { DemoTemplate } from "@rms/seed";
import { demoPosAnswer, templateForName } from "./data.js";

/** The restaurant and connection a verified token stands for, and the template its numbers come from. */
export type DemoPosCaller = { orgUuid: string; connectionUuid: string; template: DemoTemplate | null };

const refusal = (status: 401 | 403, message: string): Response =>
  new Response(JSON.stringify({ error: { code: status === 401 ? "unauthenticated" : "forbidden", message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Checks the bearer header and the connection behind it. Returns the caller, or the refusal to
 * send. A missing, forged, expired or wrong-kind token is 401. A token whose connection is
 * missing, someone else's, disconnected or not the Demo POS is 403.
 */
export const demoPosCaller = async (authorization: string | null): Promise<DemoPosCaller | Response> => {
  let orgUuid: string;
  let connectionUuid: string;
  try {
    const claims = await verifyConnectionToken(bearer(authorization));
    orgUuid = toUuid(claims.org);
    connectionUuid = toUuid(claims.connection);
  } catch (e) {
    if (e instanceof TokenError) return refusal(401, "A valid connection token is needed.");
    throw e;
  }
  // Fenced to the token's restaurant by row-level security as well as by the where clause.
  const [row] = await withOrg(apiDb(), orgUuid, (tx) => tx<{ status: string; catalog_key: string | null; name: string }[]>`
    select c.status, c.catalog_key, o.name
      from platform.mcp_connections c
      join platform.organizations o on o.id = c.org_id
     where c.id = ${connectionUuid} and c.org_id = ${orgUuid}`);
  if (!row || row.catalog_key !== DEMO_POS.catalogKey || (row.status !== "connected" && row.status !== "needs_approval")) {
    return refusal(403, "This connection is not active.");
  }
  return { orgUuid, connectionUuid, template: templateForName(row.name) };
};

/** A fresh server for one request, answering for one template only. Every tool is read-only. */
export const buildDemoPosServer = (template: DemoTemplate | null): McpServer => {
  const server = new McpServer({ name: DEMO_POS.serverName, version: "1.0.0" });
  for (const name of DEMO_POS_TOOL_NAMES) {
    const spec = DEMO_POS_TOOLS[name as DemoPosToolName];
    server.registerTool(
      name,
      {
        description: spec.description,
        inputSchema: spec.input,
        outputSchema: spec.output,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      // The SDK has already checked the arguments against `inputSchema`. `demoPosAnswer` parses
      // them again with the contract's shape, and parses its answer with the output shape.
      async (args: unknown) => {
        const structuredContent = demoPosAnswer(template, name, args ?? {}) as Record<string, unknown>;
        return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
      },
    );
  }
  return server;
};

/** Serves one HTTP request to the Demo POS. Auth first; nothing reaches the MCP handler without a good token. */
export const serveDemoPos = async (request: Request): Promise<Response> => {
  const caller = await demoPosCaller(request.headers.get("authorization"));
  if (caller instanceof Response) return caller;
  // One handler per request, bound to this caller's template: nothing is shared between callers.
  // The tools send no progress messages, so every answer is a single JSON body.
  const handler = createMcpHandler(() => buildDemoPosServer(caller.template));
  return handler.fetch(request);
};
