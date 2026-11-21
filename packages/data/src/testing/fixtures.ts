// TEST ONLY. Exported as `@rms/data/testing` for this package's tests and the API's tests.
// Nothing in the product imports it.
//
// Until the model compiler (task C) merges, the Data API tests need tables to run against.
// This helper creates two fictional restaurants and a handful of models with hand-written
// DDL, issued as the migrator role, following the storage contract (@rms/contracts
// storage.ts) and the compiler contract in the header of the store provisioning migration:
// grants per table, row-level security with rms.location_ok, append-only by grants.
//
// It uses task D's id range (…e0 to …ef) and store prefixes (o_e1e1e1e1e1xx) only, and
// removes everything it made. It never touches rows it did not create.
import { createHash } from "node:crypto";
import {
  type AppManifestInput,
  ModelDefinition,
  NamedActionDefinition,
  NamedQueryDefinition,
  SYSTEM_COLUMNS,
  type StoreEnv,
  type TenantContext,
  columnsForField,
  storeRoles,
  storeSchemas,
  toPublicId,
} from "@rms/contracts";
import { type Sql, type Tx, adminDb, asMigrator, asParentSync, ident, newUuid, provisionStore } from "@rms/db";

const uuid = (suffix: string): string => `0193a3c0-0000-7000-8000-0000000000${suffix}`;

export const T = {
  orgA: uuid("e1"), orgB: uuid("e2"),
  prefixA: "o_e1e1e1e1e101", prefixB: "o_e1e1e1e1e102",
  locA1: uuid("e3"), locA2: uuid("e4"), locB1: uuid("e5"),
  appA: uuid("e6"), appViewer: uuid("e7"), appB: uuid("e8"),
  verA: uuid("e9"), verADraft: uuid("ea"), verViewer: uuid("eb"), verB: uuid("ec"),
  ownerA: uuid("ed"), staffA: uuid("ee"), ownerB: uuid("ef"), otherOwnerA: uuid("e0"),
  /** Parent staff rows. These live only inside the test restaurants' own parent schemas. */
  staffRowA1: "0193a3c0-0000-7000-8000-00000000e1a1", staffRowA2: "0193a3c0-0000-7000-8000-00000000e1a2", staffRowB1: "0193a3c0-0000-7000-8000-00000000e1b1",
} as const;

/** Build runs for the main test mini-app of restaurant A: one still going, one that has ended. */
export const RUNS = { live: newUuid(), ended: newUuid(), session: newUuid() } as const;

export const CANARY_A = "CANARY-A-7f3d9c21-marigold-only";
export const CANARY_B = "CANARY-B-b81e44d0-slice-yard-only";

const access = { owner: "write", staff: "write" } as const;

/**
 * The pack the test models claim. The Data API reads definitions through the model compiler,
 * which only accepts pack "custom" for keys that start with `x_` and for check rules. These
 * test models have plain keys and one commit-time rule, so they sit in a library pack.
 */
const PACK = "foundation" as const;

/** The test models. Each is a valid ModelDefinition, parsed below. */
export const MODELS = [
  ModelDefinition.parse({
    key: "tip_pool", pack: PACK, version: 1, name: "Tip pools", description: "Tips collected for one business date at one location, to be shared out.",
    fields: [
      { key: "business_date", label: "Business date", type: "business_date", required: true },
      { key: "label", label: "Name", type: "text", required: true, maxLength: 80 },
      { key: "amount", label: "Amount", type: "money", required: true },
      { key: "hourly_rate", label: "Hourly rate", type: "money", sensitivity: "payroll", readableBy: ["owner"] },
      { key: "status", label: "Status", type: "enum", values: ["open", "closed"] },
      { key: "share", label: "Share", type: "decimal", scale: 2 },
      { key: "closed", label: "Closed", type: "boolean" },
      { key: "weight", label: "Weight", type: "quantity" },
      { key: "notes", label: "Notes", type: "json" },
      { key: "counted_at", label: "Counted at", type: "timestamp" },
      { key: "headcount", label: "Headcount", type: "integer" },
    ],
    unique: [["location_id", "business_date", "label"]], defaultAccess: access, labelField: "label",
    rules: [
      { kind: "check", name: "amount_not_negative", expr: { op: "gte", args: [{ field: "amount" }, { lit: 0 }] }, message: "A tip pool cannot be less than zero." },
      // Compares a field everyone can read with one only the owner can read.
      {
        kind: "check", name: "rate_under_cap", message: "The hourly rate is too high for that headcount.",
        expr: { op: "or", args: [{ op: "is_null", arg: { field: "hourly_rate" } }, { op: "is_null", arg: { field: "headcount" } }, { op: "lte", args: [{ field: "hourly_rate" }, { op: "mul", args: [{ field: "headcount" }, { lit: 1000 }] }] }] },
      },
    ],
  }),
  ModelDefinition.parse({
    key: "cash_event", pack: PACK, version: 1, name: "Cash events", description: "Money in and out of the till. Never changed once written.",
    appendOnly: true,
    fields: [
      { key: "business_date", label: "Business date", type: "business_date", required: true },
      { key: "amount", label: "Amount", type: "money", required: true },
      { key: "kind", label: "Kind", type: "enum", values: ["paid_in", "paid_out", "payout"], required: true },
    ],
    defaultAccess: access,
    // Stands in for the ledger's "balanced" rule: checked by a deferred trigger, at the end of the batch.
    rules: [{ kind: "balanced", name: "cash_not_negative", lineModel: "cash_event", lineRef: "id", debit: "amount", credit: "amount" }],
  }),
  ModelDefinition.parse({
    key: "staff_note", pack: PACK, version: 1, name: "Staff notes", description: "A short note about one member of staff, with the tip pool it relates to.",
    fields: [
      { key: "staff", label: "Staff member", type: "parent_ref", parentModel: "staff", required: true },
      { key: "note", label: "Note", type: "text", required: true },
      { key: "tip_pool", label: "Tip pool", type: "ref", model: "tip_pool" },
    ],
    defaultAccess: { owner: "write", staff: "read" },
  }),
  ModelDefinition.parse({
    key: "owner_ledger", pack: PACK, version: 1, name: "Owner ledger", description: "Private money notes only the owner may see or change.",
    locationScoped: false, softDelete: false,
    fields: [
      { key: "memo", label: "Memo", type: "text", required: true },
      { key: "total", label: "Total", type: "money" },
    ],
    defaultAccess: { owner: "write", staff: "none" },
  }),
  ModelDefinition.parse({
    key: "secret_plan", pack: PACK, version: 1, name: "Secret plans", description: "A model that exists but is in no mini-app manifest.",
    locationScoped: false,
    fields: [{ key: "plan", label: "Plan", type: "text", required: true }],
    defaultAccess: access,
  }),
  ModelDefinition.parse({
    key: "draft_idea", pack: PACK, version: 1, name: "Draft ideas", description: "A model that only exists in the draft store so far.",
    locationScoped: false,
    fields: [{ key: "idea", label: "Idea", type: "text", required: true }],
    defaultAccess: access,
  }),
];
/** Exists for restaurant B only. */
export const B_ONLY = ModelDefinition.parse({
  key: "b_only", pack: PACK, version: 1, name: "B only", description: "A model only the second test restaurant has.",
  locationScoped: false,
  fields: [{ key: "secret", label: "Secret", type: "text", required: true }],
  defaultAccess: access,
});
const DRAFT_ONLY = new Set(["draft_idea"]);

export const QUERY_KEYS = { totals: "taskd_pool_totals", rates: "taskd_pool_rates", writes: "taskd_bad_write", undeclared: "taskd_bad_ref", unlisted: "taskd_unlisted", attack: "taskd_attack" } as const;

/**
 * The template the security review used to read another restaurant's table: SQL hidden in a
 * text literal, run by a function that evaluates text, after switching role. `{prefix}` is
 * the other restaurant's store prefix.
 */
export const attackSql = (prefix: string): string =>
  `select cast(table_to_xml(cast(w.t as regclass), true, false, '') as text) as leak
from {{tip_pool}} as tp
cross join (
  select '${prefix}.tip_pool' as t
  from ts_stat('select to_tsvector(set_config(''role'', ''${prefix}_rw'', true))') as s
) as w
limit 1`;
export const ACTION_KEYS = { close: "taskd_close_pool", setRate: "taskd_set_rate", unlisted: "taskd_unlisted_action" } as const;

const totalsSql = `
select cast(tp.location_id as text) as location_id,
       loc.name as location_name,
       tp.business_date as business_date,
       cast(sum(tp.amount) as bigint) as total,
       cast(count(*) as bigint) as entries
from {{tip_pool}} as tp
left join {{parent.locations}} as loc on loc.id = tp.location_id
where tp.business_date = cast(:business_date as date)
  and (cast(:location_id as uuid) is null or tp.location_id = cast(:location_id as uuid))
group by tp.location_id, loc.name, tp.business_date
order by loc.name, tp.location_id`;

export const NAMED_QUERIES = [
  NamedQueryDefinition.parse({
    key: QUERY_KEYS.totals, pack: "custom", name: "Tip pool totals", description: "Tip pool totals for one business date, one row per location.",
    reads: ["tip_pool", "parent.locations"],
    params: [{ key: "business_date", type: "business_date" }, { key: "location_id", type: "uuid", required: false }],
    sql: totalsSql,
    columns: [
      { key: "location_id", label: "Location id", type: "text" },
      { key: "location_name", label: "Location", type: "text" },
      { key: "business_date", label: "Business date", type: "business_date" },
      { key: "total", label: "Total", type: "money" },
      { key: "entries", label: "Entries", type: "integer", readableBy: ["owner"] },
    ],
  }),
  NamedQueryDefinition.parse({
    key: QUERY_KEYS.rates, pack: "custom", name: "Tip pool rates", description: "Reads the owner-only hourly rate, so staff cannot run it.",
    reads: ["tip_pool"], params: [],
    sql: "select cast(sum(coalesce(tp.hourly_rate, 0)) as bigint) as rate_total from {{tip_pool}} as tp",
    columns: [{ key: "rate_total", label: "Rate total", type: "money" }],
  }),
  NamedQueryDefinition.parse({
    key: QUERY_KEYS.writes, pack: "custom", name: "Bad write", description: "A broken report that tries to remove rows. It must never run.",
    reads: ["tip_pool"], params: [],
    sql: "with gone as (delete from {{tip_pool}} as tp returning tp.id) select count(*) as n from gone",
    columns: [{ key: "n", label: "N", type: "integer" }],
  }),
  NamedQueryDefinition.parse({
    key: QUERY_KEYS.undeclared, pack: "custom", name: "Bad reference", description: "A broken report that reads a model it did not declare.",
    reads: ["tip_pool"], params: [],
    sql: "select count(*) as n from {{owner_ledger}} as ol",
    columns: [{ key: "n", label: "N", type: "integer" }],
  }),
  NamedQueryDefinition.parse({
    key: QUERY_KEYS.attack, pack: "custom", name: "Attack", description: "A hostile report that tries to read the other test restaurant's table.",
    reads: ["tip_pool"], params: [],
    sql: attackSql("o_e1e1e1e1e102"),
    columns: [{ key: "leak", label: "Leak", type: "text" }],
  }),
  NamedQueryDefinition.parse({
    key: QUERY_KEYS.unlisted, pack: "custom", name: "Unlisted", description: "A working report that no test manifest lists.",
    reads: ["tip_pool"], params: [],
    sql: "select count(*) as n from {{tip_pool}} as tp",
    columns: [{ key: "n", label: "N", type: "integer" }],
  }),
];

export const NAMED_ACTIONS = [
  NamedActionDefinition.parse({
    key: ACTION_KEYS.close, pack: "custom", name: "Pay out a tip pool", description: "Writes one cash event for a tip pool. Running it again changes nothing.",
    reads: ["tip_pool"], writes: ["cash_event"], params: [{ key: "pool_id", type: "uuid" }], idempotent: true,
    sql: `
with tp as (
  select p.id, p.location_id, p.currency, p.business_date, p.amount
  from {{tip_pool}} as p
  where p.id = cast(:pool_id as uuid)
),
ev as (
  insert into {{cash_event}} (id, location_id, currency, business_date, amount, kind, source, source_id, created_by, updated_by)
  select gen_random_uuid(), tp.location_id, tp.currency, tp.business_date, tp.amount, 'payout', 'app', 'tip_pool/' || cast(tp.id as text), rms.current_actor(), rms.current_actor()
  from tp
  on conflict do nothing
  returning id
)
select (select count(*) from ev) as affected`,
  }),
  NamedActionDefinition.parse({
    key: ACTION_KEYS.setRate, pack: "custom", name: "Copy a pool with its rate", description: "Writes the owner-only hourly rate, so staff cannot run it.",
    reads: ["tip_pool"], writes: ["tip_pool"], params: [{ key: "pool_id", type: "uuid" }], idempotent: true,
    sql: `
with src as (
  select p.id, p.location_id, p.currency, p.business_date, p.amount
  from {{tip_pool}} as p
  where p.id = cast(:pool_id as uuid)
),
made as (
  insert into {{tip_pool}} (id, location_id, currency, business_date, label, amount, hourly_rate, source, source_id, created_by, updated_by)
  select gen_random_uuid(), src.location_id, src.currency, src.business_date, 'Rate copy', src.amount, 1500, 'app', 'rate_copy/' || cast(src.id as text), rms.current_actor(), rms.current_actor()
  from src
  on conflict do nothing
  returning id
)
select (select count(*) from made) as affected`,
  }),
  NamedActionDefinition.parse({
    key: ACTION_KEYS.unlisted, pack: "custom", name: "Unlisted action", description: "A working action that no test manifest lists.",
    reads: ["tip_pool"], writes: ["cash_event"], params: [], idempotent: true,
    sql: "with x as (select tp.id from {{tip_pool}} as tp) select 0 as affected",
  }),
];

const use = (model: string, a: "read" | "write") => ({ use: model, access: a });

/** The published manifest of the main test mini-app (restaurants A and B). */
export const MANIFEST_MAIN: AppManifestInput = {
  name: "Task D test app",
  models: [
    use("tip_pool", "write"), use("cash_event", "write"), use("staff_note", "write"), use("owner_ledger", "write"),
    use("draft_idea", "write"), use("b_only", "write"), use("parent.staff", "read"), use("parent.locations", "read"),
  ],
  namedQueries: [QUERY_KEYS.totals, QUERY_KEYS.rates, QUERY_KEYS.writes, QUERY_KEYS.undeclared, QUERY_KEYS.attack],
  actions: [ACTION_KEYS.close, ACTION_KEYS.setRate],
};
/** The working (unpublished) manifest a run token gets. Deliberately different from the published one. */
export const MANIFEST_DRAFT: AppManifestInput = {
  name: "Task D test app (draft)",
  models: [use("tip_pool", "write"), use("draft_idea", "write"), use("parent.staff", "read")],
};
/** A second mini-app that may only look. */
export const MANIFEST_VIEWER: AppManifestInput = { name: "Task D viewer", models: [use("tip_pool", "read"), use("parent.staff", "read")] };

const TS_DEFAULT = "date_trunc('milliseconds', now())";

/** The name the model compiler gives a rule's constraint (its `ruleConstraintName`), so the tests raise what it raises. */
const ruleConstraint = (model: string, rule: string): string => {
  const tail = `_rule_${createHash("sha256").update(JSON.stringify(["rule", model, rule])).digest("hex").slice(0, 8)}`;
  return `${`${model}_${rule}`.slice(0, 63 - tail.length)}${tail}`;
};

/** Hand-written DDL for one model in one schema, per the storage and compiler contracts. */
const ddlFor = (def: ModelDefinition, prefix: string, env: StoreEnv): string[] => {
  const schemas = storeSchemas(prefix);
  const roles = storeRoles(prefix);
  const schema = ident(env === "live" ? schemas.live : schemas.draft);
  const table = `${schema}.${ident(def.key)}`;
  const hasMoney = def.fields.some((f) => f.type === "money");
  const softDelete = def.softDelete && !def.appendOnly;
  const lines: string[] = [];
  for (const c of SYSTEM_COLUMNS) {
    if ((c.when === "locationScoped" && !def.locationScoped) || (c.when === "hasMoney" && !hasMoney) || (c.when === "softDelete" && !softDelete)) continue;
    const extra = c.name === "id" ? " primary key" : c.name === "created_at" || c.name === "updated_at" ? ` default ${TS_DEFAULT}` : "";
    lines.push(`${ident(c.name)} ${c.sqlType}${c.nullable ? "" : " not null"}${extra}`);
  }
  for (const f of def.fields) {
    for (const c of columnsForField(f)) lines.push(`${ident(c.name)} ${c.sqlType}${c.nullable ? "" : " not null"}`);
    if (f.type === "enum") lines.push(`check (${ident(f.key)} in (${f.values.map((v) => `'${ident(v).slice(1, -1)}'`).join(", ")}))`);
    if (f.type === "ref") lines.push(`foreign key (${ident(f.key)}) references ${schema}.${ident(f.model)} (id) on delete ${f.onDelete === "set_null" ? "set null" : "restrict"}`);
  }
  for (const u of def.unique) lines.push(`unique (${u.map(ident).join(", ")})`);
  if (def.key === "tip_pool") {
    lines.push(`constraint ${ident(ruleConstraint("tip_pool", "amount_not_negative"))} check (amount >= 0)`);
    lines.push(`constraint ${ident(ruleConstraint("tip_pool", "rate_under_cap"))} check (hourly_rate is null or headcount is null or hourly_rate <= headcount * 1000)`);
  }
  const out = [
    `create table ${table} (${lines.join(", ")})`,
    `create unique index on ${table} (source, source_id) where source_id is not null`,
    `create trigger touch_updated_at before insert or update on ${table} for each row execute function rms.touch_updated_at()`,
    `revoke all on ${table} from public`,
  ];
  if (def.locationScoped) {
    out.push(`alter table ${table} enable row level security`);
    out.push(`create policy by_location on ${table} for all using (rms.location_ok(location_id)) with check (rms.location_ok(location_id))`);
  }
  const rights = def.appendOnly ? "select, insert" : "select, insert, update, delete";
  if (env === "live") {
    out.push(`grant select on ${table} to ${ident(roles.ask)}`);
    out.push(`grant ${rights} on ${table} to ${ident(roles.rw)}`);
  } else out.push(`grant ${rights} on ${table} to ${ident(roles.draftRw)}`);
  if (def.key === "cash_event") {
    // Stands in for a rule checked at commit (like the ledger's "balanced" rule): the till for
    // one business date and location may dip below zero inside a batch, but not at the end of it.
    const fn = `${schema}.${ident("taskd_cash_not_negative")}`;
    out.push(
      `create function ${fn}() returns trigger language plpgsql as $fn$
       begin
         if (select coalesce(sum(amount), 0) from ${table} where business_date = new.business_date and location_id = new.location_id) < 0 then
           raise exception using errcode = 'check_violation', message = 'taskd internal rule text: cash went negative', table = 'cash_event', constraint = '${ruleConstraint("cash_event", "cash_not_negative")}';
         end if;
         return null;
       end $fn$`,
      `create constraint trigger cash_not_negative after insert on ${table} deferrable initially deferred for each row execute function ${fn}()`,
    );
  }
  return out;
};

const exec = (sql: Sql | Tx, text: string, values: Array<string | null> = []) =>
  values.length > 0 ? sql.unsafe(text, values, { simple: false }) : sql.unsafe(text);

const ORGS = [
  { id: T.orgA, prefix: T.prefixA, slug: "taskd-a", name: "Task D Test Kitchen A" },
  { id: T.orgB, prefix: T.prefixB, slug: "taskd-b", name: "Task D Test Kitchen B" },
] as const;

/** Removes everything this file creates. Safe to run when nothing exists. */
export const cleanupData = async (): Promise<void> => {
  const sql = adminDb();
  for (const o of ORGS) {
    await exec(sql, "select platform.drop_store($1::uuid)", [o.id]).catch(() => {});
    for (const table of ["idempotency_keys", "audit_log", "agent_runs", "agent_sessions", "app_versions", "apps", "org_models"]) {
      await exec(sql, `delete from platform.${ident(table)} where org_id = $1::uuid`, [o.id]);
    }
    await exec(sql, "delete from platform.organizations where id = $1::uuid", [o.id]);
  }
  for (const key of Object.values(QUERY_KEYS)) await exec(sql, "delete from platform.named_queries where key = $1::text", [key]);
  for (const key of Object.values(ACTION_KEYS)) await exec(sql, "delete from platform.named_actions where key = $1::text", [key]);
};

export const setupData = async (): Promise<void> => {
  await cleanupData();
  const sql = adminDb();
  for (const o of ORGS) {
    await exec(sql, "insert into platform.organizations (id, slug, name, store_prefix) values ($1::uuid, $2::text, $3::text, $4::text)", [o.id, o.slug, o.name, o.prefix]);
    await provisionStore(sql, o.id);
  }

  // Parent data, written straight into each restaurant's parent schema as the sync role
  // (task B's one-way copy does this for real).
  await asParentSync(sql, async (tx) => {
    const loc = (prefix: string, id: string, name: string) =>
      exec(tx, `insert into ${ident(`${prefix}_parent`)}.locations (id, name, currency) values ($1::uuid, $2::text, 'USD')`, [id, name]);
    await loc(T.prefixA, T.locA1, "Downtown");
    await loc(T.prefixA, T.locA2, "Riverside");
    await loc(T.prefixB, T.locB1, `Yard ${CANARY_B}`);
    const staff = (prefix: string, id: string, location: string, name: string, email: string, rate: string) =>
      exec(tx, `insert into ${ident(`${prefix}_parent`)}.staff (id, location_id, full_name, email, phone, hourly_rate_minor) values ($1::uuid, $2::uuid, $3::text, $4::text, '555-0100', ($5::text)::bigint)`, [id, location, name, email, rate]);
    await staff(T.prefixA, T.staffRowA1, T.locA1, "Avery Stone", "avery@taskd-a.test", "2150");
    await staff(T.prefixA, T.staffRowA2, T.locA2, "Blake Rivers", "blake@taskd-a.test", "1980");
    await staff(T.prefixB, T.staffRowB1, T.locB1, `Casey ${CANARY_B}`, "casey@taskd-b.test", "3300");
  });

  // Tables, as the migrator. Draft and live for most. `draft_idea` exists in draft only.
  await asMigrator(sql, async (tx) => {
    for (const o of ORGS) {
      const defs = o.id === T.orgB ? [...MODELS, B_ONLY] : MODELS;
      for (const def of defs) {
        for (const env of ["draft", "live"] as const) {
          if (env === "live" && DRAFT_ONLY.has(def.key)) continue;
          for (const statement of ddlFor(def, o.prefix, env)) await tx.unsafe(statement);
        }
      }
    }
  });

  for (const o of ORGS) {
    const defs = o.id === T.orgB ? [...MODELS, B_ONLY] : MODELS;
    for (const def of defs) {
      await exec(sql, "insert into platform.org_models (id, org_id, key, kind, definition, status) values ($1::uuid, $2::uuid, $3::text, 'custom', ($4::text)::jsonb, $5::text)", [
        newUuid(), o.id, def.key, JSON.stringify(def), DRAFT_ONLY.has(def.key) ? "draft" : "live",
      ]);
    }
  }

  const app = (id: string, org: string, slug: string, number: string, current: string) =>
    exec(sql, "insert into platform.apps (id, org_id, slug, number, name, status, current_version_id) values ($1::uuid, $2::uuid, $3::text, ($4::text)::integer, $3::text, 'published', $5::uuid)", [id, org, slug, number, current]);
  const version = (id: string, appId: string, org: string, number: string, manifest: AppManifestInput, status: string) =>
    exec(sql, "insert into platform.app_versions (id, app_id, org_id, number, manifest, status) values ($1::uuid, $2::uuid, $3::uuid, ($4::text)::integer, ($5::text)::jsonb, $6::text)", [id, appId, org, number, JSON.stringify(manifest), status]);
  await app(T.appA, T.orgA, "taskd-main", "1", T.verADraft);
  await version(T.verA, T.appA, T.orgA, "1", MANIFEST_MAIN, "published");
  await version(T.verADraft, T.appA, T.orgA, "2", MANIFEST_DRAFT, "draft");
  await app(T.appViewer, T.orgA, "taskd-viewer", "2", T.verViewer);
  await version(T.verViewer, T.appViewer, T.orgA, "1", MANIFEST_VIEWER, "published");
  await app(T.appB, T.orgB, "taskd-main", "1", T.verB);
  await version(T.verB, T.appB, T.orgB, "1", MANIFEST_MAIN, "published");

  // A build session for the main mini-app of A, with one run still going and one that ended.
  await exec(sql, "insert into platform.agent_sessions (id, org_id, user_id, app_id, mode, model) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'build', 'taskd-test-model')", [RUNS.session, T.orgA, T.ownerA, T.appA]);
  await exec(sql, "insert into platform.agent_runs (id, session_id, org_id, status) values ($1::uuid, $2::uuid, $3::uuid, 'running')", [RUNS.live, RUNS.session, T.orgA]);
  await exec(sql, "insert into platform.agent_runs (id, session_id, org_id, status, ended_at) values ($1::uuid, $2::uuid, $3::uuid, 'done', now())", [RUNS.ended, RUNS.session, T.orgA]);

  for (const q of NAMED_QUERIES) await exec(sql, "insert into platform.named_queries (key, pack, definition) values ($1::text, $2::text, ($3::text)::jsonb)", [q.key, q.pack, JSON.stringify(q)]);
  for (const a of NAMED_ACTIONS) await exec(sql, "insert into platform.named_actions (key, pack, definition) values ($1::text, $2::text, ($3::text)::jsonb)", [a.key, a.pack, JSON.stringify(a)]);
};

export type Who = {
  org?: "A" | "B";
  role?: "owner" | "staff";
  user?: string;
  /** Raw location uuids, or "all". */
  locations?: "all" | string[];
  app?: string;
  version?: string;
};

/** A tenant context as `requireDataToken` would build it, for calling the engine directly. */
export const tenantFor = (env: StoreEnv, who: Who = {}): TenantContext => {
  const b = who.org === "B";
  const locations = who.locations === undefined || who.locations === "all" ? ("all" as const) : (who.locations.map((l) => toPublicId("loc", l)) as [`loc_${string}`, ...`loc_${string}`[]]);
  const base = {
    orgId: toPublicId("org", b ? T.orgB : T.orgA),
    storePrefix: b ? T.prefixB : T.prefixA,
    actor: { type: "user" as const, id: toPublicId("usr", who.user ?? (b ? T.ownerB : who.role === "staff" ? T.staffA : T.ownerA)) },
    role: who.role ?? "owner",
    locations,
    env,
    appId: toPublicId("app", who.app ?? (b ? T.appB : T.appA)),
  };
  return env === "live" ? { ...base, appVersionId: toPublicId("ver", who.version ?? (b ? T.verB : T.verA)) } : { ...base, runId: toPublicId("run", RUNS.live) };
};
