// The gateway: the ONLY code in RMS that talks to a connected system (plan 4.8).
//
// For every call it checks, in this order, before anything leaves the server:
//   1. the connection belongs to the caller's restaurant (row-level security by org, and the
//      where clause), else `not_found`;
//   2. the connection is `connected`;
//   3. the tool is on the list the owner approved;
//   4. the tool is marked read-only (a write tool is refused today);
//   5. the tool is granted to that consumer (`mcp_tool_grants`);
//   6. the arguments pass the tool's input shape (Demo POS).
// Then it mints the credential (Demo POS: a fresh connection token per call, never stored),
// calls with the MCP client (20 second limit, redirects refused), parses the answer with the
// tool's output shape (Demo POS) or keeps it as opaque data (custom), and writes one
// `mcp_calls` row with a redacted argument summary: argument names and dates, never values.
//
// Tool output is DATA. It is returned to the caller as parsed data and never read, followed or
// passed anywhere as instructions. The connection's token never leaves this file.
import {
  ConnectionId,
  DEMO_POS,
  DEMO_POS_TOOLS,
  type DemoPosToolName,
  McpToolInfo,
  type OrgId,
  type ToolConsumer,
  canonicalToolList,
  toPublicId,
  toUuid,
} from "@rms/contracts";
import { mintConnectionToken } from "@rms/auth";
import { apiDb, newUuid, withOrg } from "@rms/db";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Who is calling: the restaurant from the verified session. Nothing else is needed or trusted. */
export type GatewayTenant = { orgId: OrgId };

export type GatewayOptions = {
  /** The fetch the MCP client uses. Tests route it to an in-process server. Default: global fetch. */
  fetch?: FetchLike;
  /** Per call. Default 20 seconds. */
  timeoutMs?: number;
};

export type GatewayErrorReason = "not_found" | "denied" | "failed" | "unavailable";

/** A refusal or failure. `message` is plain words an owner may see. */
export class GatewayError extends Error {
  constructor(
    readonly reason: GatewayErrorReason,
    message: string,
  ) {
    super(message);
  }
}

export const CALL_TIMEOUT_MS = 20_000;

/** SHA-256 (hex) of the canonical tool list: what `mcp_connections.tools_hash` holds. */
export const toolsHash = (tools: readonly McpToolInfo[]): string => createHash("sha256").update(canonicalToolList(tools)).digest("hex");

/** Where the Demo POS is served: the API's own address plus the route. Worked out fresh, never taken from a stored row. */
export const demoPosUrl = (): string => {
  const base = process.env.API_URL;
  if (!base) throw new GatewayError("unavailable", "Demo POS is not available right now.");
  return new URL(DEMO_POS.route, new URL(base).origin).toString();
};

type ConnectionRow = {
  id: string;
  org_id: string;
  status: string;
  catalog_key: string | null;
  tools: unknown;
};

const orgUuidOf = (tenant: GatewayTenant): string => toUuid(tenant.orgId);

/** The connection, if it is this restaurant's. A malformed or foreign id is simply not found. */
export const loadConnection = async (tenant: GatewayTenant, connectionId: string): Promise<ConnectionRow> => {
  const parsed = ConnectionId.safeParse(connectionId);
  if (!parsed.success) throw new GatewayError("not_found", "That connection was not found.");
  const orgUuid = orgUuidOf(tenant);
  const [row] = await withOrg(apiDb(), orgUuid, (tx) => tx<ConnectionRow[]>`
    select id, org_id, status, catalog_key, tools from platform.mcp_connections
     where id = ${toUuid(parsed.data)} and org_id = ${orgUuid}`);
  if (!row) throw new GatewayError("not_found", "That connection was not found.");
  return row;
};

/** The approved tool list stored on a connection. Anything that does not parse is left out. */
export const storedTools = (raw: unknown): McpToolInfo[] =>
  (Array.isArray(raw) ? raw : []).flatMap((t) => {
    const p = McpToolInfo.safeParse(t);
    return p.success ? [p.data] : [];
  });

/** Names and dates only. A value that is not a plain date is replaced by its kind. */
export const redactArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { names: Object.keys(args).sort().slice(0, 20) };
  for (const [k, v] of Object.entries(args)) {
    if (/^[a-z][a-z0-9_]{0,40}$/i.test(k) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) out[k] = v;
  }
  return out;
};

const recordCall = async (
  tenant: GatewayTenant,
  connectionUuid: string,
  consumer: ToolConsumer,
  tool: string,
  args: Record<string, unknown>,
  status: "ok" | "error" | "denied",
  durationMs: number | null,
): Promise<void> => {
  const orgUuid = orgUuidOf(tenant);
  await withOrg(apiDb(), orgUuid, (tx) => tx`
    insert into platform.mcp_calls (id, org_id, connection_id, consumer, tool_name, args_summary, status, duration_ms)
    values (${newUuid()}, ${orgUuid}, ${connectionUuid}, ${`${consumer.type}:${consumer.id}`.slice(0, 120)}, ${tool.slice(0, 64)},
            ${tx.json(redactArgs(args) as never)}, ${status}, ${durationMs})`);
};

/**
 * Opens an MCP client to the connection, runs `fn`, and always closes it. The credential is
 * minted here, for this restaurant and this connection, and handed only to the transport.
 */
const withClient = async <T>(tenant: GatewayTenant, conn: ConnectionRow, opts: GatewayOptions, fn: (client: Client, timeout: number) => Promise<T>): Promise<T> => {
  if (conn.catalog_key !== DEMO_POS.catalogKey) {
    // Connect by address and token is not built yet (task L, step 7), so there is nothing to call.
    throw new GatewayError("unavailable", "Connecting your own system is not available yet.");
  }
  const token = await mintConnectionToken({ kind: "connection", aud: "mcp", org: tenant.orgId, connection: toPublicId("con", conn.id) });
  const timeout = opts.timeoutMs ?? CALL_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeout);
  const base = opts.fetch ?? (globalThis.fetch as FetchLike);
  // Redirects are refused outright, and every request shares one deadline.
  const guarded: FetchLike = (url, init = {}) =>
    base(url, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
  const transport = new StreamableHTTPClientTransport(new URL(demoPosUrl()), {
    authProvider: { token: async () => token },
    fetch: guarded,
    requestInit: { redirect: "error" },
    onInsufficientScope: "throw",
  });
  const client = new Client({ name: "rms-gateway", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout });
    return await fn(client, timeout);
  } finally {
    await client.close().catch(() => undefined);
  }
};

/**
 * Lists the connection's tools as the system describes them now. Used when connecting and
 * before every sync. Allowed while the connection is `connected` or `needs_approval`.
 * Descriptions and schemas are data: stored and shown, never followed.
 */
export const listTools = async (tenant: GatewayTenant, connectionId: string, opts: GatewayOptions = {}): Promise<McpToolInfo[]> => {
  const conn = await loadConnection(tenant, connectionId);
  if (conn.status !== "connected" && conn.status !== "needs_approval") throw new GatewayError("denied", "This connection is switched off.");
  let raw: { name: string; description?: string | undefined; annotations?: { readOnlyHint?: boolean | undefined } | undefined; inputSchema: unknown }[];
  try {
    raw = await withClient(tenant, conn, opts, async (client, timeout) => (await client.listTools(undefined, { timeout, cacheMode: "bypass" })).tools);
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    logFailure("list_tools", e);
    throw new GatewayError("failed", "Could not reach the system. Please try again.");
  }
  if (raw.length > 60) throw new GatewayError("failed", "The system offers more than RMS can show.");
  return raw.map((t) => {
    const parsed = McpToolInfo.safeParse({
      name: t.name,
      description: (t.description ?? "").slice(0, 400),
      // Only an explicit "read-only" counts. Anything else is treated as a write.
      readOnly: t.annotations?.readOnlyHint === true,
      inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : {},
    });
    if (!parsed.success) throw new GatewayError("failed", "The system described what it offers in a way RMS cannot read.");
    return parsed.data;
  });
};

/** One line for the log: what failed, never arguments, answers or tokens. */
const logFailure = (what: string, e: unknown): void => {
  const name = e instanceof Error ? e.name : "unknown";
  console.error(JSON.stringify({ at: "mcp-gateway", what, error: name }));
};

/**
 * Calls one tool for one consumer. Returns the answer as DATA: parsed down to the tool's output
 * shape for Demo POS, or the raw structured answer (opaque) for anything else.
 */
export const callTool = async (
  tenant: GatewayTenant,
  connectionId: string,
  consumer: ToolConsumer,
  tool: string,
  args: Record<string, unknown>,
  opts: GatewayOptions = {},
): Promise<unknown> => {
  const conn = await loadConnection(tenant, connectionId);
  const deny = async (message: string): Promise<never> => {
    await recordCall(tenant, conn.id, consumer, tool, args, "denied", null);
    throw new GatewayError("denied", message);
  };

  if (conn.status !== "connected") return deny("This connection is not switched on.");
  const approved = storedTools(conn.tools).find((t) => t.name === tool);
  if (!approved) return deny("RMS was not allowed to use that.");
  if (!approved.readOnly) return deny("RMS only reads from connected systems.");
  const orgUuid = orgUuidOf(tenant);
  const [grant] = await withOrg(apiDb(), orgUuid, (tx) => tx<{ access: string }[]>`
    select access from platform.mcp_tool_grants
     where org_id = ${orgUuid} and connection_id = ${conn.id}
       and consumer_type = ${consumer.type} and consumer_id = ${consumer.id} and tool_name = ${tool}`);
  if (!grant || grant.access !== "read") return deny("RMS was not allowed to use that.");

  const demoTool = conn.catalog_key === DEMO_POS.catalogKey ? (DEMO_POS_TOOLS[tool as DemoPosToolName] ?? null) : null;
  if (conn.catalog_key === DEMO_POS.catalogKey) {
    if (!demoTool) return deny("RMS was not allowed to use that.");
    if (!demoTool.input.safeParse(args).success) return deny("That question cannot be asked.");
  }

  const started = Date.now();
  let answer: unknown;
  try {
    const result = await withClient(tenant, conn, opts, (client, timeout) => client.callTool({ name: tool, arguments: args }, { timeout }));
    if (result.isError) throw new Error("tool answered with an error");
    // The structured answer is the data. Text content is ignored: it is never shown to a model or followed.
    answer = result.structuredContent;
    if (demoTool) {
      const parsed = demoTool.output.safeParse(answer);
      if (!parsed.success) throw new Error("answer does not fit the tool's shape");
      answer = parsed.data;
    }
  } catch (e) {
    await recordCall(tenant, conn.id, consumer, tool, args, "error", Date.now() - started);
    if (e instanceof GatewayError) throw e;
    logFailure(tool, e);
    throw new GatewayError("failed", "The system did not answer as expected. Please try again.");
  }
  await recordCall(tenant, conn.id, consumer, tool, args, "ok", Date.now() - started);
  return answer;
};
