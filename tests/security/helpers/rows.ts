// One small, valid, brand-new row for each platform table a test may need to insert into.
// Used by the cross-restaurant link tests and the row-security tests, so both attack with rows
// that would be accepted if only the restaurant were right. That is what makes the refusal mean something.
import { createHash, randomUUID } from "node:crypto";
import type { Tx } from "@rms/db";
import { ORG, type OrgKey, ids } from "./world.js";

type RowValues = Record<string, unknown>;

/**
 * A new row for `table`, owned by restaurant `k` and pointing only at `k`'s own fixture rows.
 * Keys that must be unique are chosen so the row never collides with the fixture.
 */
export const TEMPLATES: Record<string, (k: OrgKey) => RowValues> = {
  member_locations: (k) => ({ org_id: ORG[k].uuid, member_id: ids(k).ownerMember, location_id: ids(k).loc2 }),
  apps: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, slug: "template-app", number: 50, name: "Template app" }),
  app_versions: (k) => ({ id: randomUUID(), app_id: ids(k).app, org_id: ORG[k].uuid, number: 50, manifest: { name: "Template" } }),
  app_models: (k) => ({ app_id: ids(k).readOnlyApp, org_id: ORG[k].uuid, model_ref: "sec_ledger", access: "read" }),
  app_profiles: (k) => ({ app_id: ids(k).readOnlyApp, org_id: ORG[k].uuid, purpose: "Template" }),
  app_slots: (k) => ({ id: randomUUID(), app_id: ids(k).app, org_id: ORG[k].uuid, slot_type: "nav" }),
  deployments: (k) => ({ id: randomUUID(), app_id: ids(k).app, org_id: ORG[k].uuid, version_id: ids(k).appVersion, env: "live", screens_key: "screens/template" }),
  sandboxes: (k) => ({ id: randomUUID(), app_id: ids(k).app, org_id: ORG[k].uuid }),
  agent_sessions: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, user_id: randomUUID(), app_id: ids(k).app, mode: "ask", model: "fixture-model" }),
  agent_runs: (k) => ({ id: randomUUID(), session_id: ids(k).session, org_id: ORG[k].uuid, sandbox_id: ids(k).sandbox }),
  agent_events: (k) => ({ run_id: ids(k).run, seq: 50, session_id: ids(k).session, org_id: ORG[k].uuid, type: "message.done", payload: { text: "template" } }),
  org_memory: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, kind: "fact", text: "Template", source_session_id: ids(k).session }),
  mcp_connections: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, name: "Template connection", url: "https://template.test", secret_id: ids(k).secret }),
  mcp_tool_grants: (k) => ({ org_id: ORG[k].uuid, connection_id: ids(k).connection, consumer_type: "ask", consumer_id: "template", tool_name: "template_tool", access: "read" }),
  mcp_calls: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, connection_id: ids(k).connection, consumer: "template", tool_name: "template_tool", status: "ok" }),
  change_sets: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, app_id: ids(k).app, origin: "build", actor: "user:template", tier: "T0", summary: "Template", decision: "applied" }),
  notifications: (k) => ({ id: randomUUID(), audience: "owner", org_id: ORG[k].uuid, change_set_id: ids(k).changeSet, kind: "template", title: "Template" }),
  org_model_changes: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, org_model_id: ids(k).orgModelNote, change: { op: "add_index" }, compiled_sql: "-- template" }),
  installs: (k) => ({ id: randomUUID(), listing_id: ids(k).listingPublic, listing_version_id: ids(k).listingVersion, org_id: ORG[k].uuid, app_id: ids(k).installedApp }),
  listings: (k) => ({ id: randomUUID(), source_app_id: ids(k).app, publisher_org_id: ORG[k].uuid, title: "Template", summary: "Template", category: "ops" }),
  parent_staff: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, location_id: ids(k).loc1, full_name: "Template Person", job_id: ids(k).job }),
  parent_menu_items: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, category_id: ids(k).category, name: "Template item", price_minor: 100 }),
  parent_menu_modifiers: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, item_id: ids(k).item, name: "Template modifier" }),
  parent_tax_rates: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, location_id: ids(k).loc1, name: "Template tax", rate_bps: 100 }),
  parent_licences: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, location_id: ids(k).loc1, name: "Template licence" }),
  parent_equipment: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, location_id: ids(k).loc1, name: "Template equipment" }),
  // Tables with no link to another restaurant-owned row. Used by the row-security tests.
  org_settings: (k) => ({ org_id: ORG[k].uuid }),
  idempotency_keys: (k) => ({ org_id: ORG[k].uuid, app_id: ids(k).app, env: "live", user_id: randomUUID(), key: "template-key-0001", response: { ok: true } }),
  audit_log: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, actor: "user:template", action: "data.insert", target_type: "template" }),
  outbox: (k) => ({ topic: "change_set.created", org_id: ORG[k].uuid }),
  usage_events: (k) => ({ id: randomUUID(), org_id: ORG[k].uuid, kind: "template", quantity: 1, unit: "token" }),
  // Stored mini-app code (Wave 3). A well-formed source object for the restaurant's own mini-app.
  objects: (k) => {
    const bytes = Buffer.from("template");
    const hex = (uuid: string) => uuid.replaceAll("-", "");
    return {
      key: `orgs/org_${hex(ORG[k].uuid)}/apps/app_${hex(ids(k).installedApp)}/versions/50.bundle`,
      org_id: ORG[k].uuid,
      bytes,
      content_type: "text/plain",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
  },
};

/** The fixture row of restaurant `k` in each table other rows point at. */
export const PARENT_ROW: Record<string, (k: OrgKey) => string> = {
  members: (k) => ids(k).ownerMember,
  locations: (k) => ids(k).loc1,
  // The read-only app has no profile or model rows, so pointing at it trips no unique key before the link is checked.
  apps: (k) => ids(k).readOnlyApp,
  app_versions: (k) => ids(k).appVersion,
  sandboxes: (k) => ids(k).sandbox,
  agent_sessions: (k) => ids(k).session,
  agent_runs: (k) => ids(k).run,
  secrets: (k) => ids(k).secret,
  org_memory: (k) => ids(k).memory,
  mcp_connections: (k) => ids(k).connection,
  change_sets: (k) => ids(k).changeSet,
  org_models: (k) => ids(k).orgModelNote,
  parent_jobs: (k) => ids(k).job,
  parent_menu_categories: (k) => ids(k).category,
  parent_menu_items: (k) => ids(k).item,
};

/** Inserts one row into a platform table. Objects become JSON columns. Bytes stay bytes. */
export const insertRow = (tx: Tx, table: string, row: RowValues): Promise<unknown> => {
  const values = Object.fromEntries(Object.entries(row).map(([key, v]) => [key, v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) ? tx.json(v as never) : v]));
  return tx`insert into platform.${tx(table)} ${tx(values as never)}`;
};
