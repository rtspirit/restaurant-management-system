// Platform lookups for one request: the mini-app's manifest, the restaurant's model
// definitions, and named query and action definitions.
//
// Everything is keyed by the verified tenant context. The org, app, version and environment
// come from the token. Nothing here takes an id from a request body.
import {
  AppManifest,
  type AuditEntry,
  ModelDefinition,
  NamedActionDefinition,
  NamedQueryDefinition,
  type StoreEnv,
  type TenantContext,
  toUuid,
} from "@rms/contracts";
import { type Tx, actorText, apiDb, newUuid, withOrg } from "@rms/db";
import { DataApiError } from "./errors.js";
import { Params, run } from "./sql.js";

export type Ids = { orgUuid: string; appUuid: string; userUuid: string };

/** Raw uuids from the verified context. A context with no mini-app cannot use the Data API. */
export const idsOf = (tenant: TenantContext): Ids => {
  if (!tenant.appId || tenant.actor.type !== "user") throw new DataApiError("unauthenticated");
  if (tenant.env === "live" ? !tenant.appVersionId || tenant.runId !== undefined : !tenant.runId || tenant.appVersionId !== undefined) {
    throw new DataApiError("unauthenticated");
  }
  return { orgUuid: toUuid(tenant.orgId), appUuid: toUuid(tenant.appId), userUuid: toUuid(tenant.actor.id) };
};

const parseJson = (text: unknown): unknown => {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export type Platform = {
  manifest(): Promise<AppManifest>;
  /** Definitions of this restaurant's models, for the token's environment. Missing keys are absent. */
  models(keys: readonly string[]): Promise<Map<string, ModelDefinition>>;
  namedQuery(key: string): Promise<NamedQueryDefinition | null>;
  namedQueries(keys: readonly string[]): Promise<NamedQueryDefinition[]>;
  namedAction(key: string): Promise<NamedActionDefinition | null>;
  namedActions(keys: readonly string[]): Promise<NamedActionDefinition[]>;
  storedResponse(key: string): Promise<StoredResponse | null>;
};

export type StoredResponse = { fingerprint: string; body: unknown };

const placeholders = (p: Params, keys: readonly string[]): string => keys.map((k) => p.add(k, "text")).join(", ");

/**
 * THE one place the Data API reads a restaurant's model definitions. Nothing else in this
 * package reads `org_models`.
 *
 * Returns the definitions for `keys` as they stand in `env`. Keys that do not exist for this
 * restaurant in that environment are simply absent. Live requests see only models that are
 * live. Builds and previews also see models that are still draft.
 *
 * NOTE FOR INTEGRATION: a restaurant's draft tables can be ahead of live, and
 * `org_models.definition` holds the DRAFT definition. Once the model compiler is merged, the
 * body of this function becomes a call to its `effectiveDefinition(sql, orgUuid, key, env)`
 * per key, so a live request is checked against the live shape. Until then, a field that
 * exists only in draft would be accepted by a live request and then fail at the database
 * with a plain "internal" error: wrong answer code, but nothing is read or written.
 *
 * `orgUuid` and `env` MUST come from the verified token. `tx` must be fenced to that org.
 */
export const loadDefinitions = async (tx: Tx, orgUuid: string, keys: readonly string[], env: StoreEnv): Promise<Map<string, ModelDefinition>> => {
  const out = new Map<string, ModelDefinition>();
  const unique = [...new Set(keys)];
  if (unique.length === 0) return out;
  const p = new Params();
  const org = p.add(orgUuid, "uuid");
  const status = env === "live" ? "status = 'live'" : "status in ('draft', 'live')";
  const rows = await run(
    tx,
    `select key, definition::text as definition from platform.org_models where org_id = ${org} and ${status} and key in (${placeholders(p, unique)})`,
    p.values,
  );
  for (const r of rows) {
    const parsed = ModelDefinition.safeParse(parseJson(r.definition));
    if (!parsed.success || parsed.data.key !== r.key) throw new DataApiError("internal", undefined, `model definition does not parse: ${String(r.key)}`);
    out.set(parsed.data.key, parsed.data);
  }
  return out;
};

const platformFor = (tx: Tx, tenant: TenantContext, ids: Ids): Platform => {
  const namedMany = async <T>(table: "named_queries" | "named_actions", keys: readonly string[], parse: (v: unknown) => T | null): Promise<T[]> => {
    if (keys.length === 0) return [];
    const p = new Params();
    const rows = await run(tx, `select key, definition::text as definition from platform.${table} where key in (${placeholders(p, keys)}) order by key`, p.values);
    const out: T[] = [];
    for (const r of rows) {
      const def = parse(parseJson(r.definition));
      if (def && (def as { key?: unknown }).key === r.key) out.push(def);
    }
    return out;
  };
  const parseQuery = (v: unknown) => {
    const r = NamedQueryDefinition.safeParse(v);
    return r.success ? r.data : null;
  };
  const parseAction = (v: unknown) => {
    const r = NamedActionDefinition.safeParse(v);
    return r.success ? r.data : null;
  };

  return {
    async manifest() {
      // App token: the pinned version must be published and belong to this app and restaurant.
      // Run token: the app's current working version, and only while the token's own run is
      // still going (a run of this app, in this restaurant, that has not ended).
      // A paused or deleted mini-app stops both kinds at once. No row means no access.
      const p = new Params();
      const text =
        tenant.env === "live"
          ? `select v.manifest::text as manifest
               from platform.app_versions v
               join platform.apps a on a.id = v.app_id and a.org_id = v.org_id
              where v.id = ${p.add(toUuid(tenant.appVersionId as string), "uuid")}
                and v.app_id = ${p.add(ids.appUuid, "uuid")}
                and v.org_id = ${p.add(ids.orgUuid, "uuid")}
                and v.status = 'published'
                and a.status not in ('deleted', 'paused')`
          : `select v.manifest::text as manifest
               from platform.apps a
               join platform.app_versions v on v.id = a.current_version_id and v.app_id = a.id and v.org_id = a.org_id
              where a.id = ${p.add(ids.appUuid, "uuid")}
                and a.org_id = ${p.add(ids.orgUuid, "uuid")}
                and a.status not in ('deleted', 'paused')
                and exists (
                  select 1
                    from platform.agent_runs r
                    join platform.agent_sessions s on s.id = r.session_id and s.org_id = r.org_id
                   where r.id = ${p.add(toUuid(tenant.runId as string), "uuid")}
                     and r.org_id = a.org_id
                     and s.app_id = a.id
                     and r.status in ('running', 'paused', 'waiting'))`;
      const rows = await run(tx, text, p.values);
      if (rows.length !== 1) throw new DataApiError("unauthenticated", "This mini-app is not available. Please open it again from RMS.");
      const parsed = AppManifest.safeParse(parseJson(rows[0]?.manifest));
      if (!parsed.success) throw new DataApiError("forbidden_model", undefined, "manifest does not parse");
      return parsed.data;
    },

    models: (keys) => loadDefinitions(tx, ids.orgUuid, keys, tenant.env),

    namedQuery: async (key) => (await namedMany("named_queries", [key], parseQuery))[0] ?? null,
    namedQueries: (keys) => namedMany("named_queries", keys, parseQuery),
    namedAction: async (key) => (await namedMany("named_actions", [key], parseAction))[0] ?? null,
    namedActions: (keys) => namedMany("named_actions", keys, parseAction),

    async storedResponse(key) {
      const p = new Params();
      const rows = await run(
        tx,
        `select response::text as response from platform.idempotency_keys
          where org_id = ${p.add(ids.orgUuid, "uuid")} and app_id = ${p.add(ids.appUuid, "uuid")} and env = ${p.add(tenant.env, "text")}
            and user_id = ${p.add(ids.userUuid, "uuid")} and key = ${p.add(key, "text")}`,
        p.values,
      );
      const stored = parseJson(rows[0]?.response) as { fingerprint?: unknown; body?: unknown } | undefined;
      if (!stored || typeof stored.fingerprint !== "string") return null;
      return { fingerprint: stored.fingerprint, body: stored.body };
    },
  };
};

/** Runs `fn` with platform access fenced to the token's restaurant (row-level security by org). */
export const withPlatform = <T>(tenant: TenantContext, fn: (p: Platform, ids: Ids) => Promise<T>): Promise<T> => {
  const ids = idsOf(tenant);
  return withOrg(apiDb(), ids.orgUuid, (tx) => fn(platformFor(tx, tenant, ids), ids));
};

export type AuditInput = Pick<AuditEntry, "action" | "targetType" | "targetId" | "meta"> & { requestId: string };

/**
 * Writes one audit row. `tx` must be running as the server login with `rms.org` set to the
 * token's restaurant. `meta` holds counts and keys only, never field values.
 */
export const writeAudit = async (tx: Tx, tenant: TenantContext, ids: Ids, a: AuditInput): Promise<void> => {
  const p = new Params();
  await run(
    tx,
    `insert into platform.audit_log (id, org_id, actor, action, target_type, target_id, meta, request_id)
     values (${p.add(newUuid(), "uuid")}, ${p.add(ids.orgUuid, "uuid")}, ${p.add(actorText(tenant.actor), "text")}, ${p.add(a.action, "text")},
             ${p.add(a.targetType, "text")}, ${p.add(a.targetId, "text")}, ${p.add(JSON.stringify(a.meta), "jsonb")}, ${p.add(a.requestId, "text")})`,
    p.values,
  );
};

/** Thrown when another request stored the same idempotency key first. */
export class IdempotencyRace extends Error {}

/** Stores the first response for an idempotency key. Same transaction rules as `writeAudit`. */
export const storeResponse = async (tx: Tx, tenant: TenantContext, ids: Ids, key: string, stored: StoredResponse): Promise<void> => {
  const p = new Params();
  try {
    await run(
      tx,
      `insert into platform.idempotency_keys (org_id, app_id, env, user_id, key, response)
       values (${p.add(ids.orgUuid, "uuid")}, ${p.add(ids.appUuid, "uuid")}, ${p.add(tenant.env, "text")}, ${p.add(ids.userUuid, "uuid")},
               ${p.add(key, "text")}, ${p.add(JSON.stringify(stored), "jsonb")})`,
      p.values,
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new IdempotencyRace();
    throw e;
  }
};
