// @rms/db: the ONLY way server code opens a database connection or enters a restaurant's store.
// Owned by the lead. Do not copy these helpers into other packages.
import postgres from "postgres";
import { v7 as uuidv7 } from "uuid";
import {
  type Actor,
  type IdPrefix,
  type LocationScope,
  SESSION_SETTINGS,
  StorePrefix,
  type TenantContext,
  storeRoles,
  storeSchemas,
  toPublicId,
  toUuid,
} from "@rms/contracts";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

/** A new uuid v7 (time-ordered). All row and object ids are made here, in application code. */
export const newUuid = (): string => uuidv7();
export const newId = <P extends IdPrefix>(prefix: P) => toPublicId(prefix, newUuid());

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
};

/**
 * Transaction-mode poolers do not support prepared statements, and Vercel functions are
 * short-lived, so: no prepared statements, a small pool, and bigint returned as strings.
 */
const open = (url: string, max = 5): Sql =>
  postgres(url, { prepare: false, max, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} });

let api: Sql | undefined;
let admin: Sql | undefined;

/** Restaurant-facing connection (login `rms_api`). Sees platform rows only through `withOrg`. */
export const apiDb = (): Sql => (api ??= open(need("DATABASE_URL")));

/** Sign-up, provisioning, jobs, seed, maintainer console (login `rms_admin`). */
// Sized so a handful of sign-ups at once cannot starve it: onboarding holds one connection for
// its per-user lock while the restaurant is created on others.
export const adminDb = (): Sql => (admin ??= open(need("DATABASE_ADMIN_URL"), 10));

export const closeAll = async (): Promise<void> => {
  await Promise.all([api?.end({ timeout: 5 }), admin?.end({ timeout: 5 })]);
  api = undefined;
  admin = undefined;
};

/** Quotes an identifier after checking it is a plain lowercase name. Throws otherwise. */
export const ident = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("Unsafe identifier");
  return `"${name}"`;
};

export const actorText = (a: Actor): string => `${a.type}:${a.type === "user" || a.type === "connection" ? toUuid(a.id) : a.id}`;

const locationsText = (scope: LocationScope): string => (scope === "all" ? "all" : scope.map(toUuid).join(","));

/**
 * Runs `fn` in one transaction with platform row-level security fenced to one org.
 * `orgId` MUST come from a verified session or token, never from a request.
 */
export const withOrg = <T>(sql: Sql, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> => {
  const org = orgId.startsWith("org_") ? toUuid(orgId) : orgId;
  return sql.begin(async (tx) => {
    await tx`select set_config(${SESSION_SETTINGS.org}, ${org}, true)`;
    return fn(tx);
  }) as Promise<T>;
};

export type StoreHandle = {
  /** Quoted schema names, safe to place in SQL text. */
  readonly schema: string;
  readonly parentSchema: string;
  readonly env: "live" | "draft";
  /** `"schema"."table"` for a child table in this store. Validates the table name. */
  table(name: string): string;
  /** `"schema_parent"."table"` for a parent table. */
  parentTable(name: string): string;
};

/**
 * Runs `fn` in one transaction INSIDE one restaurant's store:
 *   - switches to that restaurant's Data API role for the transaction only (SET LOCAL ROLE),
 *   - sets the caller's locations and actor for row-level security and audit columns,
 *   - also fences platform rows to the same org.
 * Everything comes from `ctx`, which is built only from a verified token or session.
 * This is the single implementation of "enter a store". Do not write another one.
 */
export const withStore = <T>(sql: Sql, ctx: TenantContext, fn: (tx: Tx, store: StoreHandle) => Promise<T>): Promise<T> => {
  const prefix = StorePrefix.parse(ctx.storePrefix);
  const roles = storeRoles(prefix);
  const schemas = storeSchemas(prefix);
  const role = ctx.env === "live" ? roles.rw : roles.draftRw;
  const schema = ctx.env === "live" ? schemas.live : schemas.draft;
  const store: StoreHandle = {
    schema: ident(schema),
    parentSchema: ident(schemas.parent),
    env: ctx.env,
    table: (name) => `${ident(schema)}.${ident(name)}`,
    parentTable: (name) => `${ident(schemas.parent)}.${ident(name)}`,
  };
  return sql.begin(async (tx) => {
    await tx`select set_config(${SESSION_SETTINGS.org}, ${toUuid(ctx.orgId)}, true),
                    set_config(${SESSION_SETTINGS.locations}, ${locationsText(ctx.locations)}, true),
                    set_config(${SESSION_SETTINGS.actor}, ${actorText(ctx.actor)}, true)`;
    // Role names cannot be bound as parameters. `role` is built from a prefix that passed
    // StorePrefix (o_ + 12 hex) and is quoted by ident().
    await tx.unsafe(`set local role ${ident(role)}`);
    return fn(tx, store);
  }) as Promise<T>;
};

/**
 * Creates a restaurant's schemas, roles and grants. Admin connection only.
 * The org row (with its store prefix) must already exist.
 */
export const provisionStore = async (adminSql: Sql, orgUuid: string): Promise<StorePrefix> => {
  const [row] = await adminSql<{ prefix: string }[]>`select platform.provision_store(${orgUuid}) as prefix`;
  return StorePrefix.parse(row?.prefix);
};

/** A fresh, unused store prefix: "o_" + 12 random hex characters. */
export const newStorePrefix = (): StorePrefix => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `o_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
};

/** Runs `fn` as the table-creating role, for applying compiled model changes. Admin connection only. */
export const asMigrator = <T>(adminSql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  adminSql.begin(async (tx) => {
    await tx.unsafe("set local role rms_tenant_migrator");
    return fn(tx);
  }) as Promise<T>;

/** Runs `fn` as the parent-data writer, for the one-way copy. Admin connection only. */
export const asParentSync = <T>(adminSql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  adminSql.begin(async (tx) => {
    await tx.unsafe("set local role rms_parent_sync");
    return fn(tx);
  }) as Promise<T>;

export * from "./ask.js";
