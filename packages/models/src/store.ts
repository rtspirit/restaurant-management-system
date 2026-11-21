// Creates and changes a restaurant's model tables, in its draft and live schemas.
//
// Every function here:
//   * takes the admin connection and the org's uuid (from a verified session or a job, never a request),
//   * does all its work in ONE transaction, under a per-restaurant lock,
//   * compiles SQL from definitions with the compiler, runs it as rms_tenant_migrator,
//   * records what it did in platform.org_models and platform.org_model_changes.
// SQL is always compiled fresh from definitions. The `compiled_sql` column is a record. It is never run.
import { ModelChange, type ModelDefinition, StorePrefix, Uuid, toUuid } from "@rms/contracts";
import { type Sql, type Tx, asMigrator, newUuid } from "@rms/db";
import {
  type CompileTarget,
  type PreCheck,
  checkQuery,
  checkStatement,
  compileChange,
  compileDiscard,
  compileDrop,
  compileModel,
  modelDependencies,
  targetsFor,
} from "./compiler/index.js";
import { CUSTOM_KEY_PREFIX, parseModel } from "./compiler/shape.js";

/** Limits that keep one restaurant from growing its store, or one definition, without bound. */
export const STORE_LIMITS = {
  modelsPerRestaurant: 60,
  customModelRefs: 12,
  customModelIndexes: 12,
  customDefinitionBytes: 64 * 1024,
  statementTimeout: "30s",
  lockTimeout: "10s",
} as const;

export type StoreOptions = {
  /** Model definitions to use instead of the installed library (platform.model_templates). */
  library?: { models: readonly ModelDefinition[] };
  /** The agent run that asked for this, if any. Recorded on new models. */
  runId?: string;
  /** The change set this belongs to, if any. Recorded on new changes. */
  changeSetId?: string;
};

type ModelState = {
  id: string;
  key: string;
  kind: "standard" | "custom";
  /** "draft": the table is in the draft schema only. "live": it is in both. */
  status: "draft" | "live";
  definition: ModelDefinition;
  isNew: boolean;
  dirty: boolean;
};

type ChangeState = {
  id: string;
  modelKey: string;
  change: ModelChange;
  /** SQL compiled in this call, by schema, for the record. */
  sql: string[];
  appliedLive: boolean;
  isNew: boolean;
  dirty: boolean;
};

/** One thing to do in the restaurant's schemas, in order: change something, or look first. */
type Step = { kind: "statement"; sql: string } | { kind: "check"; sql: string; message: string };

type Session = {
  orgUuid: string;
  targets: { live: CompileTarget; draft: CompileTarget };
  models: Map<string, ModelState>;
  /** Changes not yet applied to live, oldest first. */
  pending: ChangeState[];
  library: (key: string) => ModelDefinition | undefined;
  /** Keys that have a row in platform.model_templates. */
  installed: Set<string>;
  /** Keys held by a record that is not a proper model: a custom model with a name custom models may not have. */
  blocked: Set<string>;
  steps: Step[];
  removedModels: ModelState[];
  removedChanges: ChangeState[];
  opts: StoreOptions;
};

const orgUuidOf = (org: string): string => (org.startsWith("org_") ? toUuid(org) : org);

const record = (target: CompileTarget, statements: string[]): string => `-- ${target.schema}\n${statements.map((s) => `${s};`).join("\n")}`;

const run = (s: Session, statements: string[]): void => {
  for (const sql of statements) s.steps.push({ kind: "statement", sql });
};
const look = (s: Session, checks: PreCheck[]): void => {
  for (const c of checks) s.steps.push({ kind: "check", sql: c.sql, message: c.message });
};

const definitions = (s: Session, extra: ModelDefinition[] = []): Map<string, ModelDefinition> =>
  new Map([...[...s.models.values()].map((m) => [m.key, m.definition] as const), ...extra.map((d) => [d.key, d] as const)]);

const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);

/** The definition as it was before these changes: what the live table has while they are pending. */
const withoutChanges = (def: ModelDefinition, changes: ModelChange[]): ModelDefinition => {
  let fields = [...def.fields];
  const unique = [...def.unique];
  const indexes = [...def.indexes];
  for (const c of changes) {
    if (c.op === "add_field") fields = fields.filter((f) => f.key !== c.field.key);
    if (c.op === "add_unique") {
      const i = unique.findLastIndex((u) => sameKeys(u, c.fields));
      if (i >= 0) unique.splice(i, 1);
    }
    if (c.op === "add_index") {
      const i = indexes.findLastIndex((u) => sameKeys(u, c.fields));
      if (i >= 0) indexes.splice(i, 1);
    }
  }
  return parseModel({ ...def, fields, unique, indexes });
};

/** Limits on a model the agent designed. Library models are reviewed by maintainers instead. */
const checkCustomLimits = (def: ModelDefinition): void => {
  if (def.fields.filter((f) => f.type === "ref").length > STORE_LIMITS.customModelRefs) throw new Error(`A custom model can link to at most ${STORE_LIMITS.customModelRefs} other models`);
  if (def.indexes.length > STORE_LIMITS.customModelIndexes) throw new Error(`A custom model can have at most ${STORE_LIMITS.customModelIndexes} indexes`);
  if (Buffer.byteLength(JSON.stringify(def)) >= STORE_LIMITS.customDefinitionBytes) throw new Error("The custom model's definition is too large");
};

const loadSession = async (tx: Tx, orgUuid: string, opts: StoreOptions): Promise<Session> => {
  const [org] = await tx<{ store_prefix: string; store_ready: boolean }[]>`select store_prefix, store_ready from platform.organizations where id = ${orgUuid}`;
  if (!org?.store_ready) throw new Error("The restaurant's store is not ready");
  const targets = targetsFor(StorePrefix.parse(org.store_prefix));

  const rows = await tx<{ id: string; key: string; kind: "standard" | "custom"; status: string; definition: unknown }[]>`
    select id, key, kind, status, definition from platform.org_models where org_id = ${orgUuid}`;
  const models = new Map<string, ModelState>();
  const byId = new Map<string, string>();
  const blocked = new Set<string>();
  for (const r of rows) {
    if (r.status !== "draft" && r.status !== "live") continue; // archived models are left alone
    // A custom model outside the x_ names is never loaded, never compiled, and never built on.
    if (r.kind === "custom" && !r.key.startsWith(CUSTOM_KEY_PREFIX)) {
      blocked.add(r.key);
      continue;
    }
    const definition = parseModel(r.definition);
    // The record and the definition must agree on what kind of model this is.
    if ((r.kind === "custom") !== (definition.pack === "custom") || definition.key !== r.key) throw new Error(`The record of model "${r.key}" does not match its definition`);
    models.set(r.key, { id: r.id, key: r.key, kind: r.kind, status: r.status, definition, isNew: false, dirty: false });
    byId.set(r.id, r.key);
  }
  const archived = new Set(rows.filter((r) => r.status === "archived").map((r) => r.key));

  const changeRows = await tx<{ id: string; org_model_id: string | null; change: unknown }[]>`
    select id, org_model_id, change from platform.org_model_changes
    where org_id = ${orgUuid} and applied_live_at is null order by created_at, id`;
  const pending: ChangeState[] = [];
  for (const r of changeRows) {
    const modelKey = r.org_model_id ? byId.get(r.org_model_id) : undefined;
    if (!modelKey) continue;
    pending.push({ id: r.id, modelKey, change: ModelChange.parse(r.change), sql: [], appliedLive: false, isNew: false, dirty: false });
  }

  const installedRows = await tx<{ key: string }[]>`select key from platform.model_templates`;
  const installed = new Set(installedRows.map((r) => r.key));

  let library: Session["library"];
  if (opts.library) {
    const given = new Map(opts.library.models.map((m) => [m.key, m] as const));
    library = (key) => (archived.has(key) ? undefined : given.get(key));
  } else {
    const templates = await tx<{ key: string; definition: unknown }[]>`
      select t.key, v.definition from platform.model_templates t
      join platform.model_template_versions v on v.template_key = t.key and v.version = t.current_version
      where t.status = 'active'`;
    const raw = new Map(templates.map((t) => [t.key, t.definition] as const));
    const parsed = new Map<string, ModelDefinition>();
    library = (key) => {
      if (archived.has(key) || !raw.has(key)) return undefined;
      let def = parsed.get(key);
      if (!def) parsed.set(key, (def = parseModel(raw.get(key))));
      return def;
    };
  }
  return { orgUuid, targets, models, pending, library, installed, blocked, steps: [], removedModels: [], removedChanges: [], opts };
};

/** Creates new models in the draft schema, as one batch so they may point at each other. */
const createInDraft = (s: Session, items: { definition: ModelDefinition; kind: "standard" | "custom"; change: ModelChange }[]): void => {
  if (items.length === 0) return;
  const ctx = { models: definitions(s, items.map((i) => i.definition)) };
  const compiled = items.map((i) => compileModel(i.definition, s.targets.draft, ctx));
  run(s, [...compiled.flatMap((c) => c.create), ...compiled.flatMap((c) => c.link)]);
  items.forEach((item, i) => {
    const c = compiled[i];
    if (!c) return;
    const definition = parseModel(item.definition);
    if ((item.kind === "custom") !== (definition.pack === "custom")) throw new Error("A custom model must be in the custom pack, and only a custom model may be");
    s.models.set(definition.key, { id: newUuid(), key: definition.key, kind: item.kind, status: "draft", definition, isNew: true, dirty: false });
    s.pending.push({ id: newUuid(), modelKey: definition.key, change: item.change, sql: [record(s.targets.draft, c.statements)], appliedLive: false, isNew: true, dirty: false });
  });
};

/**
 * Library models not yet in the store, with everything they need, dependencies first.
 * A custom model can never stand in for a library model: if the restaurant has its own model
 * under a key the library needs, this stops. (A library model's rules can create trigger
 * functions with owner rights. Those must only ever sit on tables the library defined.)
 */
const missingFromLibrary = (s: Session, keys: readonly string[]): ModelDefinition[] => {
  const out: ModelDefinition[] = [];
  const seen = new Set<string>();
  const visit = (key: string, neededBy?: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const existing = s.models.get(key);
    if (s.blocked.has(key) || (existing && existing.kind !== "standard")) {
      throw new Error(`This restaurant has its own model called "${String(key).slice(0, 48)}". It cannot be used in place of the library model`);
    }
    if (existing) return;
    const def = s.library(key);
    if (!def) throw new Error(`Model "${String(key).slice(0, 48)}" is not in the library${neededBy ? `. Model "${neededBy}" needs it` : ""}`);
    if (def.pack === "custom") throw new Error("A library model cannot be in the custom pack");
    // Links to other models, a ledger's line model, and the fiscal period that an
    // open-period rule reads. A model's link to itself is not a dependency.
    for (const dep of modelDependencies(def)) visit(dep, def.key);
    out.push(def);
  };
  for (const k of keys) visit(k);
  return out;
};

/**
 * Brings models up to date in the live schema: a model that is only in draft gets its live
 * table (with everything it points at), and changes waiting on a live model are applied in order.
 */
const bringLive = (s: Session, keys: readonly string[]): string[] => {
  const promote: ModelState[] = [];
  const replay: ModelState[] = [];
  const seen = new Set<string>();
  const asked = new Set(keys);
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const m = s.models.get(key);
    if (!m) throw new Error(`Model "${String(key).slice(0, 48)}" is not in this restaurant's store`);
    // Whatever the newest definition points at must have a live table first.
    for (const dep of modelDependencies(m.definition)) visit(dep);
    if (m.status === "draft") promote.push(m);
    // Waiting changes are applied only to the models that were asked for, not to what they point at.
    else if (asked.has(key) && s.pending.some((p) => p.modelKey === key && !p.appliedLive)) replay.push(m);
  };
  for (const k of keys) visit(k);

  if (promote.length > 0) {
    const ctx = { models: definitions(s) };
    const compiled = promote.map((m) => compileModel(m.definition, s.targets.live, ctx));
    run(s, [...compiled.flatMap((c) => c.create), ...compiled.flatMap((c) => c.link)]);
    promote.forEach((m, i) => {
      const c = compiled[i];
      if (!c) return;
      m.status = "live";
      m.dirty = true;
      const waiting = s.pending.filter((p) => p.modelKey === m.key && !p.appliedLive);
      waiting.forEach((p, n) => {
        p.appliedLive = true;
        p.dirty = true;
        // The whole table is created from the newest definition. Record that SQL on the first change.
        if (n === 0) p.sql.push(record(s.targets.live, c.statements));
      });
    });
  }

  for (const m of replay) {
    const waiting = s.pending.filter((p) => p.modelKey === m.key && !p.appliedLive);
    let live = withoutChanges(m.definition, waiting.map((p) => p.change));
    for (const p of waiting) {
      const c = compileChange(p.change, live, s.targets.live, { models: definitions(s) });
      look(s, c.checks);
      run(s, c.statements);
      p.sql.push(record(s.targets.live, c.statements));
      p.appliedLive = true;
      p.dirty = true;
      live = c.definition;
    }
  }
  return [...promote, ...replay].map((m) => m.key);
};

const flush = async (tx: Tx, s: Session): Promise<void> => {
  for (const p of s.removedChanges) if (!p.isNew) await tx`delete from platform.org_model_changes where id = ${p.id} and org_id = ${s.orgUuid} and applied_live_at is null`;
  for (const m of s.removedModels) if (!m.isNew) await tx`delete from platform.org_models where id = ${m.id} and org_id = ${s.orgUuid} and status = 'draft'`;

  for (const m of s.models.values()) {
    const definition = JSON.stringify(m.definition);
    if (m.isNew) {
      const template = m.kind === "standard" && s.installed.has(m.key) ? m.key : null;
      await tx`
        insert into platform.org_models (id, org_id, key, kind, template_key, template_version, definition, status, created_by_run_id)
        values (${m.id}, ${s.orgUuid}, ${m.key}, ${m.kind}, ${template}, ${m.kind === "standard" ? m.definition.version : null},
                ${definition}::text::jsonb, ${m.status}, ${s.opts.runId ?? null})`;
    } else if (m.dirty) {
      await tx`update platform.org_models set definition = ${definition}::text::jsonb, status = ${m.status} where id = ${m.id} and org_id = ${s.orgUuid}`;
    }
  }
  for (const p of s.pending) {
    const model = s.models.get(p.modelKey);
    if (!model) continue;
    const sql = p.sql.join("\n\n");
    if (p.isNew) {
      await tx`
        insert into platform.org_model_changes (id, org_id, org_model_id, change_set_id, change, compiled_sql, destructive, applied_draft_at, applied_live_at)
        values (${p.id}, ${s.orgUuid}, ${model.id}, ${s.opts.changeSetId ?? null}, ${JSON.stringify(p.change)}::text::jsonb, ${sql}, false,
                now(), case when ${p.appliedLive} then now() end)`;
    } else if (p.dirty) {
      await tx`
        update platform.org_model_changes
        set applied_live_at = now(), compiled_sql = case when ${sql} = '' then compiled_sql else compiled_sql || E'\n\n' || ${sql} end
        where id = ${p.id} and org_id = ${s.orgUuid}`;
    }
  }
};

/**
 * Runs the planned steps as the migrator. Every statement is read once more by the guard
 * (compiler/guard.ts) before it is sent: one statement, of a kind the compiler emits.
 */
const execute = async (tx: Tx, steps: Step[]): Promise<void> => {
  for (const step of steps) {
    if (step.kind === "statement") {
      await tx.unsafe(checkStatement(step.sql));
    } else {
      const rows = await tx.unsafe(checkQuery(step.sql));
      // The row says only that something was found. Its values never leave the database.
      if (rows.length > 0) throw new Error(step.message);
    }
  }
};

/**
 * One transaction per restaurant: lock, read what is there, plan and compile (no database
 * work), run the SQL as the migrator, then write the records as the admin login.
 * A failure anywhere rolls back the tables and the records together.
 */
const inStore = async <T>(adminSql: Sql, org: string, opts: StoreOptions, work: (s: Session) => T): Promise<T> => {
  const orgUuid = Uuid.parse(orgUuidOf(org));
  return asMigrator(adminSql, async (tx) => {
    await tx.unsafe(`set local lock_timeout = '${STORE_LIMITS.lockTimeout}'`);
    await tx.unsafe(`set local statement_timeout = '${STORE_LIMITS.statementTimeout}'`);
    // Compiled SQL names everything in full. An empty search path makes sure nothing else is ever picked up.
    await tx.unsafe("set local search_path = ''");
    await tx`select pg_advisory_xact_lock(hashtextextended(${`rms.models:${orgUuid}`}, 0))`;
    // The migrator cannot read `platform`. Step back to the admin login for the reads and records.
    await tx.unsafe("set local role rms_admin");
    const s = await loadSession(tx, orgUuid, opts);
    const out = work(s);
    if (s.models.size + s.blocked.size > STORE_LIMITS.modelsPerRestaurant) throw new Error(`A restaurant can have at most ${STORE_LIMITS.modelsPerRestaurant} models`);
    if (s.steps.length > 0) {
      await tx.unsafe("set local role rms_tenant_migrator");
      await execute(tx, s.steps);
      await tx.unsafe("set local role rms_admin");
    }
    await flush(tx, s);
    return out;
  });
};

export type EnsureResult = {
  /** Created now, in draft and live. */
  created: string[];
  /** Were in draft only. Now also live. */
  madeLive: string[];
  /** Already live. Nothing done. */
  unchanged: string[];
};

/**
 * Makes sure these library models exist in the restaurant's draft AND live schemas, with every
 * model they point at, dependencies first. Running it again does nothing.
 */
export const ensureModels = (adminSql: Sql, org: string, keys: readonly string[], opts: StoreOptions = {}): Promise<EnsureResult> =>
  inStore(adminSql, org, opts, (s) => {
    const wanted = [...new Set(keys)];
    const missing = missingFromLibrary(s, wanted);
    const unchanged = wanted.filter((k) => s.models.get(k)?.status === "live");
    createInDraft(s, missing.map((definition) => ({ definition, kind: "standard" as const, change: { op: "use_template" as const, template: definition.key } })));
    const created = missing.map((m) => m.key);
    const toLive = [...created, ...wanted.filter((k) => s.models.get(k)?.status === "draft")];
    const live = bringLive(s, [...new Set(toLive)]);
    return { created, madeLive: live.filter((k) => !created.includes(k)), unchanged };
  });

export type ApplyOptions = StoreOptions & {
  /** Also apply to live now (the mini-app is being published, or the owner confirmed). */
  live?: boolean;
  /** The owner said yes to this change. Needed for a unique rule on a library model. */
  ownerConfirmed?: boolean;
};

export type ApplyResult = {
  /** The model the change was about. */
  model: string;
  /** The row in platform.org_model_changes, or null when there was nothing to do. */
  changeId: string | null;
  appliedDraft: boolean;
  appliedLive: boolean;
};

/**
 * Applies one structured change. Draft first, always. Live only when `live` is true.
 * The change is validated here. A custom model's key starts with `x_` and may not shadow a
 * library model. A unique rule is only added when no rows already break it, and on a library
 * model only when the owner confirmed.
 */
export const applyChange = async (adminSql: Sql, org: string, change: ModelChange, opts: ApplyOptions = {}): Promise<ApplyResult> => {
  const ch = ModelChange.parse(change);
  return inStore(adminSql, org, opts, (s) => {
    const before = new Set(s.pending.map((p) => p.id));
    let model: string;

    if (ch.op === "use_template") {
      model = ch.template;
      const missing = missingFromLibrary(s, [model]);
      createInDraft(s, missing.map((definition) => ({ definition, kind: "standard" as const, change: { op: "use_template" as const, template: definition.key } })));
    } else if (ch.op === "create_custom_model") {
      model = ch.definition.key;
      const definition = parseModel(ch.definition);
      if (s.models.has(model) || s.blocked.has(model)) throw new Error("This restaurant already has a model with that name");
      if (s.library(model) || s.installed.has(model)) throw new Error("That name belongs to a library model");
      checkCustomLimits(definition);
      for (const dep of modelDependencies(definition)) if (!s.models.has(dep)) throw new Error(`Model "${dep}" is not in this restaurant's store yet`);
      createInDraft(s, [{ definition, kind: "custom", change: ch }]);
    } else {
      model = ch.model;
      const m = s.models.get(model);
      if (!m) throw new Error("Model is not in this restaurant's store");
      if (ch.op === "add_unique" && m.kind === "standard" && opts.ownerConfirmed !== true) {
        throw new Error("A unique rule on a library model needs the owner to confirm it first");
      }
      const c = compileChange(ch, m.definition, s.targets.draft, { models: definitions(s) });
      if (m.kind === "custom") checkCustomLimits(c.definition);
      look(s, c.checks);
      // Look at live too, when the rule can already be checked there, so that the owner hears
      // about rows that break it now and not on the day the mini-app is published.
      if (ch.op === "add_unique" && m.status === "live" && !opts.live) {
        const live = withoutChanges(m.definition, s.pending.filter((p) => p.modelKey === model && !p.appliedLive).map((p) => p.change));
        try {
          look(s, compileChange(ch, live, s.targets.live, { models: definitions(s) }).checks);
        } catch {
          // The rule uses a field that is not live yet. It is checked when that field goes live.
        }
      }
      run(s, c.statements);
      m.definition = c.definition;
      m.dirty = true;
      s.pending.push({ id: newUuid(), modelKey: model, change: ch, sql: [record(s.targets.draft, c.statements)], appliedLive: false, isNew: true, dirty: false });
    }

    if (opts.live) bringLive(s, [model]);
    const mine = s.pending.find((p) => p.modelKey === model && !before.has(p.id));
    return { model, changeId: mine?.id ?? null, appliedDraft: mine !== undefined, appliedLive: s.models.get(model)?.status === "live" && !s.pending.some((p) => p.modelKey === model && !p.appliedLive) };
  });
};

/**
 * Brings waiting changes live: models that are only in draft get their live table, and
 * changes waiting on live models are applied in order. With no keys, everything that is waiting.
 * Returns the models that changed.
 */
export const publishModelChanges = (adminSql: Sql, org: string, keys?: readonly string[], opts: StoreOptions = {}): Promise<string[]> =>
  inStore(adminSql, org, opts, (s) => bringLive(s, keys ?? [...s.models.keys()]));

/**
 * Throws away one change that is in draft and not yet live, and undoes it in the draft schema.
 * Changes to one model are discarded newest first. A new model can be discarded only while
 * no other model points at it. Returns the model the change was about.
 */
export const discardPendingChange = (adminSql: Sql, org: string, changeId: string, opts: StoreOptions = {}): Promise<{ model: string }> =>
  inStore(adminSql, org, opts, (s) => {
    const id = Uuid.parse(changeId);
    const p = s.pending.find((x) => x.id === id);
    if (!p) throw new Error("That change is not waiting. It is already live, or it does not belong to this restaurant");
    const m = s.models.get(p.modelKey);
    if (!m) throw new Error("Model is not in this restaurant's store");
    const waiting = s.pending.filter((x) => x.modelKey === p.modelKey);
    if (waiting[waiting.length - 1] !== p) throw new Error("Discard the newer changes to this model first");

    if (p.change.op === "add_field" || p.change.op === "add_unique" || p.change.op === "add_index") {
      const c = compileDiscard(p.change, m.definition, s.targets.draft);
      run(s, c.statements);
      m.definition = c.definition;
      m.dirty = true;
    } else {
      if (m.status !== "draft") throw new Error("That model is already live");
      for (const other of s.models.values()) {
        if (other.key !== m.key && modelDependencies(other.definition).includes(m.key)) throw new Error(`Model "${other.key}" still points at this one`);
      }
      run(s, compileDrop(m.definition, s.targets.draft));
      s.models.delete(m.key);
      s.removedModels.push(m);
    }
    s.pending.splice(s.pending.indexOf(p), 1);
    s.removedChanges.push(p);
    return { model: p.modelKey };
  });

/**
 * The model as it is in one environment. Draft can be ahead of live: platform.org_models holds
 * the newest (draft) definition, and changes not yet live are taken back out for "live".
 * Returns undefined when the model is not in that environment. Works on either connection
 * (inside `withOrg` for the restaurant-facing one).
 */
export const effectiveDefinition = async (db: Sql | Tx, org: string, key: string, env: "live" | "draft"): Promise<ModelDefinition | undefined> => {
  const sql = db as Sql;
  const orgUuid = Uuid.parse(orgUuidOf(org));
  const [row] = await sql<{ id: string; status: string; definition: unknown }[]>`
    select id, status, definition from platform.org_models where org_id = ${orgUuid} and key = ${key}`;
  if (!row || (row.status !== "live" && row.status !== "draft")) return undefined;
  const definition = parseModel(row.definition);
  if (env === "draft") return definition;
  if (row.status !== "live") return undefined;
  const waiting = await sql<{ change: unknown }[]>`
    select change from platform.org_model_changes
    where org_id = ${orgUuid} and org_model_id = ${row.id} and applied_live_at is null order by created_at, id`;
  return withoutChanges(definition, waiting.map((w) => ModelChange.parse(w.change)));
};
