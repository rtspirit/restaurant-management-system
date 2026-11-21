// The test world: restaurants in task G's id range, each with a real store, real tables and a
// canary string in every place data can sit. Built once per run by global-setup.ts, removed at the end.
//
// Everything here goes through @rms/db (adminDb, provisionStore, asMigrator, asParentSync).
// Ids: orgs use the task G range (uuid suffix 90 to 9f, store prefix o_919191919xxx). Every other
// row id is derived from a name, with a `9191` marker, so runs are repeatable and nothing collides.
import { createHash } from "node:crypto";
import { AppManifest, CustomModelDefinition, type FieldDef, ModelDefinition, NamedQueryDefinition, SYSTEM_COLUMNS, columnsForField, toPublicId } from "@rms/contracts";
import { type Sql, type Tx, asMigrator, asParentSync, ident, provisionStore } from "@rms/db";
import { applyChange } from "@rms/models";

export type OrgKey = "a" | "b";
export type AnyOrgKey = OrgKey | "c" | "d";

const orgUuid = (suffix: string) => `0193a3c0-0000-7000-8000-0000000000${suffix}`;

/** A repeatable uuid for a named fixture row. Shaped like a v7 id, marked with 9191. */
export const rid = (name: string): string => {
  const h = createHash("sha256").update(`rms-task-g:${name}`).digest("hex");
  return `0193a3c0-9191-7${h.slice(0, 3)}-8${h.slice(3, 6)}-${h.slice(6, 18)}`;
};

/**
 * The secret string each restaurant holds. It appears in that restaurant's parent data, live
 * tables, draft tables and platform rows, and nowhere else. Seeing B's string while acting as
 * A is a cross-restaurant read, whatever route it took.
 */
export const CANARY: Record<OrgKey, string> = {
  a: "rmscanary_a_5d1e0c9a47",
  b: "rmscanary_b_e44b7d21f6",
};

export const ORG = {
  a: { key: "a", uuid: orgUuid("90"), prefix: "o_919191919a01", slug: "g-sec-alder", name: `Alder House ${CANARY.a}` },
  b: { key: "b", uuid: orgUuid("91"), prefix: "o_919191919b01", slug: "g-sec-birch", name: `Birch Table ${CANARY.b}` },
  /** Suspended restaurant, store provisioned. A token for it must be refused. */
  c: { key: "c", uuid: orgUuid("92"), prefix: "o_919191919c01", slug: "g-sec-cedar", name: "Cedar Counter" },
  /** Active restaurant whose store was never provisioned. */
  d: { key: "d", uuid: orgUuid("93"), prefix: "o_919191919d01", slug: "g-sec-dogwood", name: "Dogwood Diner" },
} as const;

/** A throwaway restaurant one test creates and removes by itself. Listed here so cleanup always covers it. */
export const EXTRA_ORG = { uuid: orgUuid("94"), prefix: "o_919191919e01", slug: "g-sec-elder", name: "Elder Eatery" } as const;

export const ALL_ORG_UUIDS: string[] = [...Object.values(ORG).map((o) => o.uuid), EXTRA_ORG.uuid];
export const other = (k: OrgKey): OrgKey => (k === "a" ? "b" : "a");
export const orgPublicId = (k: AnyOrgKey) => toPublicId("org", ORG[k].uuid);

export const schemas = (k: AnyOrgKey) => ({ parent: `${ORG[k].prefix}_parent`, live: ORG[k].prefix, draft: `${ORG[k].prefix}_draft` });
export const roles = (k: AnyOrgKey) => ({ rw: `${ORG[k].prefix}_rw`, draftRw: `${ORG[k].prefix}_draft_rw`, ask: `${ORG[k].prefix}_ask` });

/** Fixture row ids, by restaurant. */
export const ids = (k: OrgKey) => ({
  loc1: rid(`${k}:loc1`),
  loc2: rid(`${k}:loc2`),
  profile: rid(`${k}:profile`),
  job: rid(`${k}:job`),
  staff: rid(`${k}:staff`),
  category: rid(`${k}:category`),
  item: rid(`${k}:item`),
  modifier: rid(`${k}:modifier`),
  taxRate: rid(`${k}:tax`),
  licence: rid(`${k}:licence`),
  equipment: rid(`${k}:equipment`),
  ownerMember: rid(`${k}:member:owner`),
  staffMember: rid(`${k}:member:staff`),
  secret: rid(`${k}:secret`),
  connection: rid(`${k}:connection`),
  mcpCall: rid(`${k}:mcp_call`),
  app: rid(`${k}:app`),
  appVersion: rid(`${k}:app_version`),
  readOnlyApp: rid(`${k}:app_ro`),
  readOnlyAppVersion: rid(`${k}:app_ro_version`),
  installedApp: rid(`${k}:app_installed`),
  appSlot: rid(`${k}:app_slot`),
  deployment: rid(`${k}:deployment`),
  sandbox: rid(`${k}:sandbox`),
  session: rid(`${k}:agent_session`),
  run: rid(`${k}:agent_run`),
  memory: rid(`${k}:memory`),
  usage: rid(`${k}:usage`),
  changeSet: rid(`${k}:change_set`),
  changeReview: rid(`${k}:change_review`),
  notification: rid(`${k}:notification`),
  maintainerNotification: rid(`${k}:notification:maintainer`),
  listingPublic: rid(`${k}:listing:public`),
  listingDraft: rid(`${k}:listing:draft`),
  listingFranchise: rid(`${k}:listing:franchise`),
  listingDelisted: rid(`${k}:listing:delisted`),
  listingVersion: rid(`${k}:listing_version`),
  install: rid(`${k}:install`),
  orgModelNote: rid(`${k}:org_model:sec_note`),
  orgModelVisit: rid(`${k}:org_model:sec_visit`),
  orgModelLedger: rid(`${k}:org_model:sec_ledger`),
  orgModelChange: rid(`${k}:org_model_change`),
  audit: rid(`${k}:audit`),
  noteRow: rid(`${k}:row:note`),
  visitRow1: rid(`${k}:row:visit1`),
  visitRow2: rid(`${k}:row:visit2`),
  ledgerRow: rid(`${k}:row:ledger`),
  ledgerRow2: rid(`${k}:row:ledger2`),
  memoRow: rid(`${k}:row:memo`),
});

export const STAFF_USER_ID = rid("maintainer:staff_user");
export const NAMED_QUERY_KEY = "sec_note_search";

/** The ten parent tables: name in the restaurant's parent schema, and the platform source table. */
export const PARENT_TABLES = [
  ["profile", "restaurant_profiles"],
  ["locations", "locations"],
  ["jobs", "parent_jobs"],
  ["staff", "parent_staff"],
  ["menu_categories", "parent_menu_categories"],
  ["menu_items", "parent_menu_items"],
  ["menu_modifiers", "parent_menu_modifiers"],
  ["tax_rates", "parent_tax_rates"],
  ["licences", "parent_licences"],
  ["equipment", "parent_equipment"],
] as const;

// ---------------------------------------------------------------- model fixtures (shaped by the storage contract)
const text = (key: string, extra: Partial<FieldDef> = {}) => ({ key, label: key, type: "text", ...extra });

/**
 * The pack the fixture models claim. The Data API reads definitions through the model compiler,
 * which accepts pack "custom" only for keys that start with `x_`. These fixtures have plain keys
 * (and one is append-only), so they sit in a library pack.
 */
const PACK = "foundation" as const;

export const MODELS = {
  /** Not location-scoped. */
  sec_note: ModelDefinition.parse({
    key: "sec_note", pack: PACK, version: 1, name: "Security note", description: "A plain note used by the isolation suite.",
    fields: [text("body")], locationScoped: false, defaultAccess: { owner: "write", staff: "read" },
  }),
  /** Location-scoped, with a payroll-tagged field only the owner may read. */
  sec_visit: ModelDefinition.parse({
    key: "sec_visit", pack: PACK, version: 1, name: "Security visit", description: "A location-scoped row used by the isolation suite.",
    fields: [text("body"), { key: "wage", label: "Wage", type: "money", sensitivity: "payroll", readableBy: ["owner"] }],
    locationScoped: true, defaultAccess: { owner: "write", staff: "write" },
  }),
  /** Append-only: no update or delete, ever. Staff have no access. */
  sec_ledger: ModelDefinition.parse({
    key: "sec_ledger", pack: PACK, version: 1, name: "Security ledger", description: "An append-only table used by the isolation suite.",
    fields: [text("body")], locationScoped: false, appendOnly: true, softDelete: false, defaultAccess: { owner: "write", staff: "none" },
  }),
} as const;
/**
 * A REAL custom model: the kind a restaurant designs for itself through the build agent. Its key
 * starts with `x_`, its pack is "custom", and its tables are made by the model compiler through
 * `applyChange` (create_custom_model), in draft and live, exactly as the product does it. The
 * three models above are hand-made stand-ins that claim a library pack; this one makes sure the
 * attack tests also cover what restaurants really create.
 */
export const CUSTOM_MODEL_KEY = "x_sec_memo";
export const CUSTOM_MODEL = CustomModelDefinition.parse({
  key: CUSTOM_MODEL_KEY, pack: "custom", version: 1, name: "Security memo", description: "A memo the restaurant designed for itself, used by the isolation suite.",
  fields: [{ key: "body", label: "Body", type: "text", required: true }], locationScoped: false, defaultAccess: { owner: "write", staff: "read" },
});
/** The one memo each restaurant starts with, in each environment. */
export const memoRows = (k: OrgKey, env: "live" | "draft") => [
  { id: env === "live" ? ids(k).memoRow : rid(`${ids(k).memoRow}:draft`), ...sys, body: `memo ${CANARY[k]} ${env}` },
];

export type ModelKey = keyof typeof MODELS;
export const MODEL_KEYS = Object.keys(MODELS) as ModelKey[];

/** The mini-app each restaurant has published: may write notes and visits, read two parent models. The ledger is NOT listed. */
export const APP_MANIFEST = AppManifest.parse({
  name: "Security app",
  models: [
    { use: "sec_note", access: "write" },
    { use: "sec_visit", access: "write" },
    { use: CUSTOM_MODEL_KEY, access: "write" },
    { use: "parent.jobs", access: "read" },
    { use: "parent.staff", access: "read" },
  ],
  namedQueries: [NAMED_QUERY_KEY],
});
/** A second mini-app that may only read notes. */
export const READ_ONLY_MANIFEST = AppManifest.parse({ name: "Security reader", models: [{ use: "sec_note", access: "read" }] });

export const NAMED_QUERY = NamedQueryDefinition.parse({
  key: NAMED_QUERY_KEY, pack: "custom", name: "Security note search", description: "Finds notes by text. Used by the isolation suite only.",
  reads: ["sec_note"], params: [{ key: "q", type: "text" }],
  sql: "select body from {{sec_note}} where body like :q", columns: [{ key: "body", label: "Body", type: "text" }],
});

/** Hand-written table SQL that follows the compiler contract in the provisioning migration's header. */
const tableSql = (k: AnyOrgKey, env: "live" | "draft", key: ModelKey): string[] => {
  const def = MODELS[key];
  const schema = env === "live" ? schemas(k).live : schemas(k).draft;
  const r = roles(k);
  const t = `${ident(schema)}.${ident(key)}`;
  const hasMoney = def.fields.some((f) => f.type === "money");
  const softDelete = def.softDelete && !def.appendOnly;
  const cols: string[] = [];
  for (const c of SYSTEM_COLUMNS) {
    if (c.when === "locationScoped" && !def.locationScoped) continue;
    if (c.when === "hasMoney" && !hasMoney) continue;
    if (c.when === "softDelete" && !softDelete) continue;
    let line = `${ident(c.name)} ${c.sqlType}${c.nullable ? "" : " not null"}`;
    if (c.name === "id") line += " primary key";
    if (c.name === "created_at" || c.name === "updated_at") line += " default date_trunc('milliseconds', now())";
    if (c.name === "currency") line += " default 'USD'";
    cols.push(line);
  }
  for (const f of def.fields) for (const c of columnsForField(f)) cols.push(`${ident(c.name)} ${c.sqlType}${c.nullable ? "" : " not null"}`);
  const out = [
    `create table ${t} (${cols.join(", ")})`,
    `create trigger touch_updated_at before update on ${t} for each row execute function rms.touch_updated_at()`,
    `revoke all on ${t} from public`,
  ];
  if (def.locationScoped) {
    out.push(`alter table ${t} enable row level security`);
    out.push(`create policy location_scope on ${t} for all using (rms.location_ok(location_id)) with check (rms.location_ok(location_id))`);
  }
  const writes = def.appendOnly ? "select, insert" : "select, insert, update, delete";
  if (env === "live") {
    out.push(`grant select on ${t} to ${ident(r.ask)}`);
    out.push(`grant ${writes} on ${t} to ${ident(r.rw)}`);
  } else {
    out.push(`grant ${writes} on ${t} to ${ident(r.draftRw)}`);
  }
  return out;
};

const sys = { source: "seed", created_by: "system:security-suite", updated_by: "system:security-suite" };

/** Rows for a store. The draft copy carries the same canary so a draft-to-live or live-to-draft leak shows too. */
const storeRows = (k: OrgKey, env: "live" | "draft") => {
  const i = ids(k);
  const tag = `${CANARY[k]} ${env}`;
  // Draft rows get their own ids so nothing depends on live and draft sharing keys.
  const id = (base: string) => (env === "live" ? base : rid(`${base}:draft`));
  return {
    sec_note: [{ id: id(i.noteRow), ...sys, body: `note ${tag}` }],
    sec_visit: [
      { id: id(i.visitRow1), location_id: i.loc1, ...sys, body: `visit loc1 ${tag}`, wage: 4321 },
      { id: id(i.visitRow2), location_id: i.loc2, ...sys, body: `visit loc2 ${tag}`, wage: 8765 },
    ],
    // Two rows, so the table's column statistics hold real values (the catalog tests look for them).
    sec_ledger: [
      { id: id(i.ledgerRow), ...sys, body: `ledger one ${tag}` },
      { id: id(i.ledgerRow2), ...sys, body: `ledger two ${tag}` },
    ],
  } satisfies Record<ModelKey, Record<string, unknown>[]>;
};

/** Parent rows, without org_id. The same objects go to the platform source tables (with org_id) and to the parent schema. */
const parentRows = (k: OrgKey): Record<(typeof PARENT_TABLES)[number][0], Record<string, unknown>[]> => {
  const i = ids(k);
  const c = CANARY[k];
  return {
    profile: [{ id: i.profile, name: `Profile ${c}`, concept: "Neighbourhood grill", cuisine: "Grill", service_style: "full_service", seats: 40, price_band: "mid" }],
    locations: [
      { id: i.loc1, name: "North", address: `1 North Road ${c}` },
      { id: i.loc2, name: "South", address: `2 South Road ${c}` },
    ],
    jobs: [{ id: i.job, name: `Server ${c}`, house: "front" }],
    staff: [{ id: i.staff, location_id: i.loc1, full_name: `Sam Example ${c}`, job_id: i.job, email: `sam.${c}@staff.test`, phone: "555-0100", hourly_rate_minor: 1875 }],
    menu_categories: [{ id: i.category, name: `Mains ${c}`, sales_group: "food" }],
    menu_items: [{ id: i.item, category_id: i.category, name: `House plate ${c}`, price_minor: 1800 }],
    menu_modifiers: [{ id: i.modifier, item_id: i.item, name: `Extra sauce ${c}`, price_minor: 100 }],
    tax_rates: [{ id: i.taxRate, location_id: i.loc1, name: `Sales tax ${c}`, rate_bps: 800 }],
    licences: [{ id: i.licence, location_id: i.loc1, name: "Food service", number: `LIC-${c}`, expires_on: "2027-06-30" }],
    equipment: [{ id: i.equipment, location_id: i.loc1, name: `Walk-in cooler ${c}`, kind: "refrigeration" }],
  };
};

const insert = (tx: Tx | Sql, schema: string, table: string, rows: Record<string, unknown>[]) =>
  tx`insert into ${tx(schema)}.${tx(table)} ${tx(rows as never)}`;

export type WorldUsers = { ownerA: string; staffA: string; ownerB: string; maintainer: string; nobody: string };

/**
 * Builds everything. `users` are Supabase Auth user ids made by the caller (members need real users).
 * Safe to call only on a database that `destroyWorld` has just cleaned.
 */
export const createWorld = async (admin: Sql, users: WorldUsers): Promise<void> => {
  // Restaurants.
  for (const o of Object.values(ORG)) {
    await admin`insert into platform.organizations (id, slug, name, store_prefix, brand_colour) values (${o.uuid}, ${o.slug}, ${o.name}, ${o.prefix}, '#336699')`;
  }
  for (const k of ["a", "b", "c"] as const) await provisionStore(admin, ORG[k].uuid);
  await admin`update platform.organizations set status = 'suspended' where id = ${ORG.c.uuid}`;
  await admin`insert into platform.staff_users (id, user_id, name) values (${STAFF_USER_ID}, ${users.maintainer}, 'Suite Maintainer')`;
  await admin`insert into platform.named_queries (key, pack, definition) values (${NAMED_QUERY.key}, ${NAMED_QUERY.pack}, ${admin.json(NAMED_QUERY as never)})`;

  for (const k of ["a", "b"] as const) {
    const o = ORG[k];
    const i = ids(k);
    const c = CANARY[k];
    const org = { org_id: o.uuid };

    // Parent data: source of truth in platform, then the one-way copy into the parent schema.
    const parent = parentRows(k);
    for (const [parentTable, sourceTable] of PARENT_TABLES) {
      await insert(admin, "platform", sourceTable, parent[parentTable].map((r) => ({ ...r, ...org })));
    }
    await asParentSync(admin, async (tx) => {
      for (const [parentTable] of PARENT_TABLES) await insert(tx, schemas(k).parent, parentTable, parent[parentTable]);
    });

    // Members. The staff member is tied to location 1 only.
    await admin`insert into platform.members (id, org_id, user_id, role) values (${i.ownerMember}, ${o.uuid}, ${k === "a" ? users.ownerA : users.ownerB}, 'owner')`;
    if (k === "a") {
      await admin`insert into platform.members (id, org_id, user_id, role) values (${i.staffMember}, ${o.uuid}, ${users.staffA}, 'staff')`;
      await admin`insert into platform.member_locations (org_id, member_id, location_id) values (${o.uuid}, ${i.staffMember}, ${i.loc1})`;
    }
    await admin`insert into platform.org_settings (org_id, settings) values (${o.uuid}, ${admin.json({ note: c })})`;
    await admin`insert into platform.parent_sync_state (org_id, model_key, row_count) values (${o.uuid}, 'jobs', 1)`;

    // Store tables, live and draft, with rows.
    await asMigrator(admin, async (tx) => {
      for (const env of ["live", "draft"] as const) {
        const schema = env === "live" ? schemas(k).live : schemas(k).draft;
        const rows = storeRows(k, env);
        for (const key of MODEL_KEYS) {
          for (const stmt of tableSql(k, env, key)) await tx.unsafe(stmt);
          await insert(tx, schema, key, rows[key]);
        }
      }
      // Fresh statistics, so the catalog tests have real numbers to look for.
      for (const key of MODEL_KEYS) await tx.unsafe(`analyze ${ident(schemas(k).live)}.${ident(key)}`);
    });
    await admin`insert into platform.org_models (id, org_id, key, kind, definition, status) values
      (${i.orgModelNote}, ${o.uuid}, 'sec_note', 'custom', ${admin.json({ ...MODELS.sec_note, description: `${MODELS.sec_note.description} ${c}` } as never)}, 'live'),
      (${i.orgModelVisit}, ${o.uuid}, 'sec_visit', 'custom', ${admin.json(MODELS.sec_visit as never)}, 'live'),
      (${i.orgModelLedger}, ${o.uuid}, 'sec_ledger', 'custom', ${admin.json(MODELS.sec_ledger as never)}, 'live')`;
    // The change that made the notes table. It is already live, as the table is: the Data API
    // takes changes that are NOT live yet back out of a model before a live request is checked.
    await admin`insert into platform.org_model_changes (id, org_id, org_model_id, change, compiled_sql, applied_draft_at, applied_live_at) values
      (${i.orgModelChange}, ${o.uuid}, ${i.orgModelNote}, ${admin.json({ op: "use_template", template: "sec_note" })}, ${`-- ${c}`}, now(), now())`;

    // The custom model, made the way the product makes one: the compiler, draft and live.
    await applyChange(admin, o.uuid, { op: "create_custom_model", definition: CUSTOM_MODEL }, { live: true });
    await asMigrator(admin, async (tx) => {
      for (const env of ["live", "draft"] as const) await insert(tx, env === "live" ? schemas(k).live : schemas(k).draft, CUSTOM_MODEL_KEY, memoRows(k, env));
      await tx.unsafe(`analyze ${ident(schemas(k).live)}.${ident(CUSTOM_MODEL_KEY)}`);
    });

    // Mini-apps, versions and everything hanging off them.
    await admin`insert into platform.apps (id, org_id, slug, number, name, status) values
      (${i.app}, ${o.uuid}, 'sec-app', 1, ${`Security app ${c}`}, 'published'),
      (${i.readOnlyApp}, ${o.uuid}, 'sec-reader', 2, 'Security reader', 'published'),
      (${i.installedApp}, ${o.uuid}, 'sec-installed', 3, 'Installed app', 'draft')`;
    await admin`insert into platform.app_versions (id, app_id, org_id, number, manifest, status, summary) values
      (${i.appVersion}, ${i.app}, ${o.uuid}, 1, ${admin.json(APP_MANIFEST as never)}, 'published', ${`First version ${c}`}),
      (${i.readOnlyAppVersion}, ${i.readOnlyApp}, ${o.uuid}, 1, ${admin.json(READ_ONLY_MANIFEST as never)}, 'published', 'First version')`;
    await admin`update platform.apps set current_version_id = ${i.appVersion}, published_version_id = ${i.appVersion} where id = ${i.app}`;
    await admin`update platform.apps set current_version_id = ${i.readOnlyAppVersion}, published_version_id = ${i.readOnlyAppVersion} where id = ${i.readOnlyApp}`;
    await admin`insert into platform.app_models (app_id, org_id, model_ref, access) values (${i.app}, ${o.uuid}, 'sec_note', 'write')`;
    await admin`insert into platform.app_profiles (app_id, org_id, purpose) values (${i.app}, ${o.uuid}, ${`Keeps notes ${c}`})`;
    await admin`insert into platform.app_slots (id, app_id, org_id, slot_type, config) values (${i.appSlot}, ${i.app}, ${o.uuid}, 'nav', ${admin.json({ label: c })})`;
    await admin`insert into platform.deployments (id, app_id, org_id, version_id, env, screens_key) values (${i.deployment}, ${i.app}, ${o.uuid}, ${i.appVersion}, 'live', ${`screens/${c}`})`;
    await admin`insert into platform.sandboxes (id, app_id, org_id, preview_url) values (${i.sandbox}, ${i.app}, ${o.uuid}, ${`https://preview.test/${c}`})`;
    // Stored code (Wave 3): the published version's source, with the canary inside it.
    await admin`insert into platform.objects (key, org_id, bytes, content_type, sha256, size)
      select ${`orgs/org_${o.uuid.replaceAll("-", "")}/apps/app_${i.app.replaceAll("-", "")}/versions/1.bundle`}, ${o.uuid}::uuid, b, 'application/vnd.rms.source+json', encode(sha256(b), 'hex'), octet_length(b)
      from (select convert_to(${JSON.stringify({ format: 1, files: [{ path: "src/screens/index.ts", text: `// ${c}` }] })}, 'UTF8') as b) s`;

    // Agent rows and memory.
    await admin`insert into platform.agent_sessions (id, org_id, user_id, app_id, mode, model, title) values
      (${i.session}, ${o.uuid}, ${k === "a" ? users.ownerA : users.ownerB}, ${i.app}, 'ask', 'fixture-model', ${`Session ${c}`})`;
    await admin`insert into platform.agent_runs (id, session_id, org_id, sandbox_id, error) values (${i.run}, ${i.session}, ${o.uuid}, ${i.sandbox}, ${`run note ${c}`})`;
    await admin`insert into platform.agent_events (run_id, seq, session_id, org_id, type, payload) values (${i.run}, 1, ${i.session}, ${o.uuid}, 'message.done', ${admin.json({ text: c })})`;
    await admin`insert into platform.org_memory (id, org_id, kind, text, source_session_id) values (${i.memory}, ${o.uuid}, 'fact', ${`The owner said ${c}`}, ${i.session})`;
    await admin`insert into platform.usage_events (id, org_id, kind, quantity, unit) values (${i.usage}, ${o.uuid}, ${`tokens ${c}`}, 10, 'token')`;

    // Connections and stored secrets.
    await admin`insert into platform.secrets (id, org_id, purpose, ciphertext) values (${i.secret}, ${o.uuid}, 'connection', ${`ciphertext ${c}`})`;
    await admin`insert into platform.mcp_connections (id, org_id, name, url, secret_id, tools) values
      (${i.connection}, ${o.uuid}, 'Demo POS', ${`https://pos.test/${c}`}, ${i.secret}, ${admin.json([{ name: "list_sales" }])})`;
    await admin`insert into platform.mcp_tool_grants (org_id, connection_id, consumer_type, consumer_id, tool_name, access) values
      (${o.uuid}, ${i.connection}, 'app', ${i.app}, ${`list_sales_${c}`}, 'read')`;
    await admin`insert into platform.mcp_calls (id, org_id, connection_id, consumer, tool_name, args_summary, status) values
      (${i.mcpCall}, ${o.uuid}, ${i.connection}, 'app', 'list_sales', ${admin.json({ note: c })}, 'ok')`;

    // Governance.
    // The database derives the tier from the signals, so the fixture carries real signals.
    await admin`insert into platform.change_sets (id, org_id, app_id, origin, actor, signals, tier, summary, owner_summary, decision) values
      (${i.changeSet}, ${o.uuid}, ${i.app}, 'share', 'user:fixture', '{public_share}', 'T3', ${`Wants to share ${c}`}, ${`You asked to share a mini-app ${c}`}, 'pending_maintainer')`;
    await admin`insert into platform.change_reviews (id, change_set_id, staff_id, decision, note) values (${i.changeReview}, ${i.changeSet}, ${STAFF_USER_ID}, 'rejected', ${`review ${c}`})`;
    await admin`insert into platform.notifications (id, audience, org_id, change_set_id, kind, title) values
      (${i.notification}, 'owner', ${o.uuid}, ${i.changeSet}, 'change', ${`Notice ${c}`}),
      (${i.maintainerNotification}, 'maintainer', ${o.uuid}, ${i.changeSet}, 'change', ${`For maintainers only ${c}`})`;

    // Marketplace: one listing other restaurants may see (no canary in it), three they may not.
    await admin`insert into platform.listings (id, source_app_id, publisher_org_id, visibility, status, title, summary, category) values
      (${i.listingPublic},    ${i.app}, ${o.uuid}, 'public',    'listed',   ${`Open tracker ${k}`}, 'A shared tracker', 'ops'),
      (${i.listingDraft},     ${i.app}, ${o.uuid}, 'public',    'draft',    ${`Draft ${c}`},        ${`Not listed yet ${c}`}, 'ops'),
      (${i.listingFranchise}, ${i.app}, ${o.uuid}, 'franchise', 'listed',   ${`Franchise ${c}`},    ${`Franchise only ${c}`}, 'ops'),
      (${i.listingDelisted},  ${i.app}, ${o.uuid}, 'public',    'delisted', ${`Delisted ${c}`},     ${`Taken down ${c}`}, 'ops')`;
    await admin`insert into platform.listing_versions (id, listing_id, number, bundle_key, manifest) values (${i.listingVersion}, ${i.listingPublic}, 1, ${`bundles/${c}`}, ${admin.json(APP_MANIFEST as never)})`;

    // Operations.
    await admin`insert into platform.audit_log (id, org_id, actor, action, target_type, meta) values (${i.audit}, ${o.uuid}, 'user:fixture', 'data.insert', 'sec_note', ${admin.json({ note: c })})`;
    await admin`insert into platform.outbox (topic, org_id, payload) values ('change_set.created', ${o.uuid}, ${admin.json({ note: c })})`;
    await admin`insert into platform.idempotency_keys (org_id, app_id, env, user_id, key, response) values
      (${o.uuid}, ${i.app}, 'live', ${k === "a" ? users.ownerA : users.ownerB}, 'fixture-key-0001', ${admin.json({ note: c })})`;
  }

  // Rows that tie the two restaurants together the legitimate way: each installed the other's public listing.
  for (const k of ["a", "b"] as const) {
    const theirs = ids(other(k));
    await admin`insert into platform.installs (id, listing_id, listing_version_id, org_id, app_id, model_mapping) values
      (${ids(k).install}, ${theirs.listingPublic}, ${theirs.listingVersion}, ${ORG[k].uuid}, ${ids(k).installedApp}, ${admin.json({ note: CANARY[k] })})`;
    await admin`insert into platform.org_recommendations (org_id, listing_id, score, reasons) values (${ORG[k].uuid}, ${theirs.listingPublic}, 0.5, ${[`Fits ${CANARY[k]}`]})`;
  }
};

/** Platform tables that hold a restaurant's rows, with the column that names the restaurant. Read from the catalog. */
export const orgScopedTables = async (admin: Sql): Promise<{ table: string; column: string }[]> => {
  const rows = await admin<{ table: string; column: string }[]>`
    select c.relname as table, a.attname as column
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and not a.attisdropped
    where n.nspname = 'platform' and c.relkind = 'r' and a.attname in ('org_id', 'publisher_org_id')
    order by c.relname`;
  return rows.map((r) => ({ table: r.table, column: r.column }));
};

/**
 * Puts both restaurants' store tables back to exactly the rows `createWorld` planted. The Data
 * API tests write through the real routes (and a removed row is only marked as removed), while
 * the database tests that run after them expect an untouched world.
 */
export const restoreStoreRows = async (admin: Sql): Promise<void> => {
  await asMigrator(admin, async (tx) => {
    for (const k of ["a", "b"] as const) {
      for (const env of ["live", "draft"] as const) {
        const schema = env === "live" ? schemas(k).live : schemas(k).draft;
        const rows = storeRows(k, env);
        for (const key of MODEL_KEYS) {
          const keep = rows[key].map((r) => r.id);
          await tx`delete from ${tx(schema)}.${tx(key)} where id <> all(${keep}::uuid[])`;
        }
        await tx`delete from ${tx(schema)}.${tx(CUSTOM_MODEL_KEY)} where id <> all(${memoRows(k, env).map((r) => r.id)}::uuid[])`;
      }
    }
  });
};

/**
 * Removes every row and store this suite made, in any state a failed run may have left.
 * Only rows of task G's own restaurants are touched. Tables are retried until the links between them allow the delete.
 */
export const destroyWorld = async (admin: Sql): Promise<void> => {
  // drop_store needs the restaurant's row, so stores go first. A real failure here must stop the cleanup.
  const present = await admin<{ id: string; store_prefix: string }[]>`select id, store_prefix from platform.organizations where id = any(${ALL_ORG_UUIDS})`;
  for (const { id, store_prefix } of present) {
    // A large object owned by a store role used to stop the role being dropped (closed: db/closed-findings.test.ts). Removing any first keeps cleanup independent of that fix.
    for (const role of [`${store_prefix}_rw`, `${store_prefix}_draft_rw`]) {
      const exists = await admin`select 1 from pg_catalog.pg_roles where rolname = ${role}`;
      if (exists.length === 0) continue;
      await admin.begin(async (tx) => {
        await tx.unsafe(`set local role ${ident(role)}`);
        await tx.unsafe("select lo_unlink(m.oid) from pg_catalog.pg_largeobject_metadata m where m.lomowner = (select oid from pg_catalog.pg_roles where rolname = current_user)");
      });
    }
    await admin`select platform.drop_store(${id})`;
  }
  const scoped = await orgScopedTables(admin);
  const steps: Array<() => Promise<unknown>> = [
    () => admin`delete from platform.change_reviews where id = any(${[rid("a:change_review"), rid("b:change_review")]}) or staff_id = ${STAFF_USER_ID}`,
    () => admin`delete from platform.listing_versions where listing_id in (select id from platform.listings where publisher_org_id = any(${ALL_ORG_UUIDS}))`,
    () => admin`update platform.apps set current_version_id = null, published_version_id = null where org_id = any(${ALL_ORG_UUIDS})`,
    ...scoped.filter((t) => t.table !== "organizations").map((t) => () => admin`delete from platform.${admin(t.table)} where ${admin(t.column)} = any(${ALL_ORG_UUIDS})`),
    () => admin`delete from platform.staff_users where id = ${STAFF_USER_ID}`,
    () => admin`delete from platform.named_queries where key = ${NAMED_QUERY_KEY}`,
    () => admin`delete from platform.organizations where id = any(${ALL_ORG_UUIDS})`,
  ];
  let lastError: unknown;
  for (let pass = 0; pass < 8; pass++) {
    let failed = 0;
    for (const step of steps) {
      await step().catch((e: unknown) => {
        failed++;
        lastError = e;
      });
    }
    if (failed === 0) return;
  }
  throw new Error(`Security suite cleanup did not finish: ${(lastError as Error)?.message ?? "unknown"}`);
};

/** What is left behind, for the "leaves nothing" check: rows, schemas and roles. */
export const leftovers = async (admin: Sql): Promise<{ rows: number; schemas: number; roles: number }> => {
  let rows = 0;
  for (const t of await orgScopedTables(admin)) {
    const [r] = await admin<{ n: number }[]>`select count(*)::int as n from platform.${admin(t.table)} where ${admin(t.column)} = any(${ALL_ORG_UUIDS})`;
    rows += r?.n ?? 0;
  }
  const [s] = await admin<{ n: number }[]>`select count(*)::int as n from pg_catalog.pg_namespace where nspname like 'o\\_919191919%'`;
  const [r] = await admin<{ n: number }[]>`select count(*)::int as n from pg_catalog.pg_roles where rolname like 'o\\_919191919%'`;
  return { rows, schemas: s?.n ?? 0, roles: r?.n ?? 0 };
};
