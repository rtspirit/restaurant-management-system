// Connections as the owner sees and changes them: the catalog, connect, approve the tool list,
// disconnect, and the plain-words view. Every function takes the restaurant from the verified
// session (`GatewayTenant`) and nothing else. No function returns an address, a token or a hash.
import {
  type ConnectionView,
  DEMO_POS,
  type McpCatalogEntry,
  type McpToolInfo,
  SYNC_CONSUMER,
  toPublicId,
  toUuid,
} from "@rms/contracts";
import { type Tx, adminDb, apiDb, newUuid, withOrg } from "@rms/db";
import { type GatewayOptions, GatewayError, type GatewayTenant, demoPosUrl, listTools, loadConnection, storedTools, toolsHash } from "./gateway.js";

/** The one catalog entry today. Plain words: this is what the owner reads on the card. */
export const DEMO_POS_CATALOG = {
  key: DEMO_POS.catalogKey,
  name: DEMO_POS.name,
  vendor: "RMS",
  category: "Point of sale",
  description: "Brings in your sales, payments, staff hours, delivery payouts, supplier bills and stock counts.",
  auth: "rms",
} as const;

/** The words shown when a system's tool list changed since the owner last allowed it. */
export const TOOLS_CHANGED_TEXT = `${DEMO_POS.name} changed what it offers. Have a look before RMS reads from it again.`;

/** Puts the Demo POS row in the catalog if it is missing, and keeps its address current. Admin connection. */
export const ensureCatalog = async (): Promise<void> => {
  const c = DEMO_POS_CATALOG;
  await adminDb()`
    insert into platform.mcp_catalog (key, name, vendor, category, url, auth, description, status)
    values (${c.key}, ${c.name}, ${c.vendor}, ${c.category}, ${demoPosUrl()}, 'rms', ${c.description}, 'listed')
    on conflict (key) do update set name = excluded.name, vendor = excluded.vendor, category = excluded.category,
      url = excluded.url, auth = excluded.auth, description = excluded.description`;
};

type Row = {
  id: string;
  name: string;
  catalog_key: string | null;
  status: "connected" | "needs_approval" | "error" | "disconnected";
  tools: unknown;
  tools_hash: string | null;
  last_synced_at: Date | null;
  granted: string[] | null;
};

// Built once from constants (SYNC_CONSUMER is a literal in @rms/contracts), never from a request:
// nothing a caller sends reaches this text. Ids are bound as parameters where it is used.
const ROW_SELECT = `
  select c.id, c.name, c.catalog_key, c.status, c.tools, c.tools_hash, c.last_synced_at,
         (select array_agg(g.tool_name order by g.tool_name) from platform.mcp_tool_grants g
           where g.connection_id = c.id and g.org_id = c.org_id
             and g.consumer_type = '${SYNC_CONSUMER.type}' and g.consumer_id = '${SYNC_CONSUMER.id}') as granted
    from platform.mcp_connections c`;

const ago = (at: Date, now = Date.now()): string => {
  const minutes = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

const statusText = (r: Row): string => {
  switch (r.status) {
    case "connected":
      return r.last_synced_at ? `Connected. Last brought in sales ${ago(r.last_synced_at)}.` : "Connected. Nothing brought in yet.";
    case "needs_approval":
      // Grants left from an earlier yes mean the list changed after the owner allowed it.
      return (r.granted?.length ?? 0) > 0 ? TOOLS_CHANGED_TEXT : "Waiting for you to allow what RMS will read.";
    case "error":
      return "Something went wrong while connecting. Please try again.";
    default:
      return "Not connected.";
  }
};

/**
 * A connection as the owner sees it, plus `toolsVersion`: the hash of the tool list shown, which
 * Allow must send back so the owner can only allow the list they saw. (Not yet in the shared
 * `ConnectionView` contract: asked of the lead.)
 */
export type ConnectionViewWithVersion = ConnectionView & { toolsVersion: string | null };

const toView = (r: Row): ConnectionViewWithVersion => {
  const granted = new Set(r.granted ?? []);
  return {
    id: toPublicId("con", r.id),
    name: r.name,
    catalogKey: r.catalog_key,
    status: r.status,
    statusText: statusText(r),
    tools: storedTools(r.tools).map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly, granted: granted.has(t.name) })),
    lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
    canSync: r.catalog_key === DEMO_POS.catalogKey,
    toolsVersion: r.tools_hash,
  };
};

const orgUuidOf = (tenant: GatewayTenant): string => toUuid(tenant.orgId);

const readRow = async (tx: Tx, orgUuid: string, connectionUuid: string): Promise<Row> => {
  const [row] = await tx.unsafe<Row[]>(`${ROW_SELECT} where c.id = $1 and c.org_id = $2`, [connectionUuid, orgUuid]);
  if (!row) throw new GatewayError("not_found", "That connection was not found.");
  return row;
};

/** One connection as the owner sees it. */
export const connectionView = async (tenant: GatewayTenant, connectionId: string): Promise<ConnectionViewWithVersion> => {
  const conn = await loadConnection(tenant, connectionId);
  const orgUuid = orgUuidOf(tenant);
  return toView(await withOrg(apiDb(), orgUuid, (tx) => readRow(tx, orgUuid, conn.id)));
};

/** Every connection of this restaurant that is not switched off, newest first. */
export const listConnections = async (tenant: GatewayTenant): Promise<ConnectionViewWithVersion[]> => {
  const orgUuid = orgUuidOf(tenant);
  const rows = await withOrg(apiDb(), orgUuid, (tx) =>
    tx.unsafe<Row[]>(`${ROW_SELECT} where c.org_id = $1 and c.status <> 'disconnected' order by c.created_at desc limit 50`, [orgUuid]),
  );
  return rows.map(toView);
};

/** The catalog, with whether this restaurant already has each one connected. */
export const catalogEntries = async (tenant: GatewayTenant): Promise<McpCatalogEntry[]> => {
  await ensureCatalog();
  const orgUuid = orgUuidOf(tenant);
  return withOrg(apiDb(), orgUuid, async (tx) => {
    const entries = await tx<{ key: string; name: string; vendor: string; category: string; description: string; auth: string; connected: boolean }[]>`
      select k.key, k.name, k.vendor, k.category, k.description, k.auth,
             exists (select 1 from platform.mcp_connections c
                      where c.org_id = ${orgUuid} and c.catalog_key = k.key and c.status in ('connected', 'needs_approval')) as connected
        from platform.mcp_catalog k
       where k.status = 'listed'
       order by k.name`;
    return entries.map((e) => ({ key: e.key, name: e.name, vendor: e.vendor, category: e.category, description: e.description, auth: e.auth === "rms" ? "rms" : "bearer", connected: e.connected }));
  });
};

export type ConnectOutcome = {
  view: ConnectionViewWithVersion;
  /** True when this press made (or remade) the connection, so a change must be recorded. False when it was already there. */
  created: boolean;
  tools: McpToolInfo[];
};

/**
 * Connects the Demo POS for this restaurant: makes the connection (or switches an old one back
 * on), lists its tools through the gateway and stores them with their hash. The connection then
 * waits for the owner to allow the list (`needs_approval`). Pressing it again while it is
 * already there changes nothing.
 */
export const connectDemoPos = async (tenant: GatewayTenant, opts: GatewayOptions = {}): Promise<ConnectOutcome> => {
  await ensureCatalog();
  const orgUuid = orgUuidOf(tenant);
  const { id, created } = await withOrg(apiDb(), orgUuid, async (tx) => {
    const fresh = newUuid();
    await tx`
      insert into platform.mcp_connections (id, org_id, name, catalog_key, url, auth_type, status)
      values (${fresh}, ${orgUuid}, ${DEMO_POS.name}, ${DEMO_POS.catalogKey}, ${demoPosUrl()}, 'none', 'needs_approval')
      on conflict (org_id, name) do nothing`;
    const [row] = await tx<{ id: string; status: string; catalog_key: string | null }[]>`
      select id, status, catalog_key from platform.mcp_connections where org_id = ${orgUuid} and name = ${DEMO_POS.name} for update`;
    if (!row || row.catalog_key !== DEMO_POS.catalogKey) throw new GatewayError("failed", "Could not connect Demo POS. Please try again.");
    if (row.id === fresh) return { id: row.id, created: true };
    if (row.status === "connected" || row.status === "needs_approval") return { id: row.id, created: false };
    // Switched off or failed before: switch it back on, waiting for the owner's yes again.
    await tx`update platform.mcp_connections set status = 'needs_approval', url = ${demoPosUrl()} where id = ${row.id} and org_id = ${orgUuid}`;
    return { id: row.id, created: true };
  });
  const connectionId = toPublicId("con", id);

  if (!created) {
    const view = await connectionView(tenant, connectionId);
    const conn = await loadConnection(tenant, connectionId);
    return { view, created, tools: storedTools(conn.tools) };
  }

  let tools: McpToolInfo[];
  try {
    tools = await listTools(tenant, connectionId, opts);
  } catch (e) {
    await withOrg(apiDb(), orgUuid, (tx) => tx`update platform.mcp_connections set status = 'error' where id = ${id} and org_id = ${orgUuid}`);
    throw e;
  }
  await withOrg(apiDb(), orgUuid, async (tx) => {
    // A new yes is needed for whatever is listed now: earlier grants go.
    await tx`delete from platform.mcp_tool_grants where connection_id = ${id} and org_id = ${orgUuid}`;
    await tx`update platform.mcp_connections
                set tools = ${tx.json(tools as never)}, tools_hash = ${toolsHash(tools)}, checked_at = now()
              where id = ${id} and org_id = ${orgUuid}`;
  });
  return { view: await connectionView(tenant, connectionId), created, tools };
};

/**
 * The owner allows the tool list they were shown. Refused as stale unless `names` is exactly the
 * stored list. Every read-only tool is then granted to the sync; a write tool never is.
 */
export const approveTools = async (
  tenant: GatewayTenant,
  connectionId: string,
  names: readonly string[],
  toolsVersion: string,
): Promise<ConnectionViewWithVersion> => {
  const conn = await loadConnection(tenant, connectionId);
  if (conn.status === "disconnected" || conn.status === "error") throw new GatewayError("denied", "This connection is switched off. Connect it again first.");
  const tools = storedTools(conn.tools);
  const stored = tools.map((t) => t.name).sort();
  const sent = [...new Set(names)].sort();
  const stale = new GatewayError("denied", "What this system offers has changed since you looked. Please look again.");
  // Names AND the hash of the list the owner was shown: a changed description with the same names is a different list.
  if (stored.length === 0 || stored.length !== sent.length || stored.some((n, i) => n !== sent[i])) throw stale;
  if (!conn.tools_hash || conn.tools_hash !== toolsVersion || toolsHash(tools) !== conn.tools_hash) throw stale;
  const orgUuid = orgUuidOf(tenant);
  await withOrg(apiDb(), orgUuid, async (tx) => {
    // Re-checked under a row lock, so the list cannot change between the check and the yes.
    const [locked] = await tx<{ tools_hash: string | null }[]>`
      select tools_hash from platform.mcp_connections where id = ${conn.id} and org_id = ${orgUuid} for update`;
    if (locked?.tools_hash !== toolsVersion) throw stale;
    await tx`delete from platform.mcp_tool_grants where connection_id = ${conn.id} and org_id = ${orgUuid}`;
    for (const t of tools.filter((x) => x.readOnly)) {
      await tx`insert into platform.mcp_tool_grants (org_id, connection_id, consumer_type, consumer_id, tool_name, access, confirm)
               values (${orgUuid}, ${conn.id}, ${SYNC_CONSUMER.type}, ${SYNC_CONSUMER.id}, ${t.name}, 'read', false)`;
    }
    await tx`update platform.mcp_connections set status = 'connected', checked_at = now() where id = ${conn.id} and org_id = ${orgUuid}`;
  });
  return connectionView(tenant, connectionId);
};

/** Switches a connection off: no grants, no stored secret. The row stays, so its history does too. */
export const disconnect = async (tenant: GatewayTenant, connectionId: string): Promise<ConnectionViewWithVersion> => {
  const conn = await loadConnection(tenant, connectionId);
  const orgUuid = orgUuidOf(tenant);
  const secretId = await withOrg(apiDb(), orgUuid, async (tx) => {
    const [row] = await tx<{ secret_id: string | null }[]>`select secret_id from platform.mcp_connections where id = ${conn.id} and org_id = ${orgUuid} for update`;
    await tx`delete from platform.mcp_tool_grants where connection_id = ${conn.id} and org_id = ${orgUuid}`;
    await tx`update platform.mcp_connections set status = 'disconnected', secret_id = null where id = ${conn.id} and org_id = ${orgUuid}`;
    return row?.secret_id ?? null;
  });
  // Stored secrets are admin-only.
  if (secretId) await adminDb()`delete from platform.secrets where id = ${secretId} and org_id = ${orgUuid}`;
  return connectionView(tenant, connectionId);
};

/**
 * Marks a connection as failed, with no grants: for example when its change could not be
 * recorded. It then works for nothing until the owner connects it again (which records again).
 */
export const markConnectionError = async (tenant: GatewayTenant, connectionId: string): Promise<void> => {
  const conn = await loadConnection(tenant, connectionId);
  const orgUuid = orgUuidOf(tenant);
  await withOrg(apiDb(), orgUuid, async (tx) => {
    await tx`delete from platform.mcp_tool_grants where connection_id = ${conn.id} and org_id = ${orgUuid}`;
    await tx`update platform.mcp_connections set status = 'error' where id = ${conn.id} and org_id = ${orgUuid}`;
  });
};
