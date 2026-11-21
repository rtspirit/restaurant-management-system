// The model library: what the packs export, checked and ready to install.
// This file does NOT import ./packs. The lead wires `LIBRARY = buildLibrary(packs)`.
import { ModelDefinition, NamedActionDefinition, NamedQueryDefinition, isParentRef } from "@rms/contracts";
import type { Sql } from "@rms/db";
import { CUSTOM_KEY_PREFIX, compileModel, modelDependencies, targetsFor } from "./compiler/index.js";

/** What `src/packs/index.ts` exports. Taken as unknown and parsed here, so a bad pack fails loudly. */
export type PackExports = {
  models: readonly unknown[];
  namedQueries: readonly unknown[];
  namedActions: readonly unknown[];
};

export type Library = {
  readonly models: readonly ModelDefinition[];
  readonly namedQueries: readonly NamedQueryDefinition[];
  readonly namedActions: readonly NamedActionDefinition[];
};

const unique = <T extends { key: string }>(what: string, items: T[]): T[] => {
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.key)) throw new Error(`Library has two ${what} called "${i.key}"`);
    seen.add(i.key);
  }
  return items;
};

/**
 * Checks a set of packs and returns the library. It fails when a definition does not match the
 * contract, when a key is used twice, when a model points at a model that is not in the
 * library, when a named query or action names an unknown model, or when a model does not compile.
 */
export const buildLibrary = (packs: PackExports): Library => {
  const models = unique("models", packs.models.map((m) => ModelDefinition.parse(m)));
  const namedQueries = unique("named queries", packs.namedQueries.map((q) => NamedQueryDefinition.parse(q)));
  const namedActions = unique("named actions", packs.namedActions.map((a) => NamedActionDefinition.parse(a)));

  const keys = new Set(models.map((m) => m.key));
  for (const m of models) {
    if (m.pack === "custom") throw new Error(`Library model "${m.key}" cannot be in the custom pack`);
    // Keys that start with x_ belong to the models restaurants design for themselves.
    if (m.key.startsWith(CUSTOM_KEY_PREFIX)) throw new Error(`Library model "${m.key}" cannot have a key that starts with "${CUSTOM_KEY_PREFIX}"`);
    for (const dep of modelDependencies(m)) if (!keys.has(dep)) throw new Error(`Library model "${m.key}" needs "${dep}", which is not in the library`);
  }
  const known = (ref: string) => isParentRef(ref) || keys.has(ref);
  for (const q of namedQueries) for (const r of q.reads) if (!known(r)) throw new Error(`Named query "${q.key}" reads "${r}", which is not in the library`);
  for (const a of namedActions) {
    for (const r of a.reads) if (!known(r)) throw new Error(`Named action "${a.key}" reads "${r}", which is not in the library`);
    for (const w of a.writes) if (!keys.has(w)) throw new Error(`Named action "${a.key}" writes "${w}", which is not in the library`);
  }

  // Compile every model once against a made-up store, so a model that cannot be built is
  // found here and not while a restaurant is being set up.
  const sample = targetsFor("o_000000000000");
  for (const m of models) {
    compileModel(m, sample.draft, { models });
    compileModel(m, sample.live, { models });
  }
  return Object.freeze({ models, namedQueries, namedActions });
};

/** JSON with object keys in a fixed order, so two values can be compared whatever order they were stored in. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );

/**
 * Writes the library into platform.model_templates, model_template_versions, named_queries and
 * named_actions. Admin connection only. Safe to run again with the same library.
 * A model version is never changed in place: if a definition differs from the one stored under
 * the same key and version, this stops and asks for a new version number. Named queries and
 * actions have no versions and are replaced.
 */
export const installLibrary = async (adminSql: Sql, library: Library): Promise<{ models: number; namedQueries: number; namedActions: number }> => {
  const lib = buildLibrary(library);
  await adminSql.begin(async (tx) => {
    for (const m of lib.models) {
      await tx`
        insert into platform.model_templates (key, pack, name, description, current_version)
        values (${m.key}, ${m.pack}, ${m.name}, ${m.description}, ${m.version})
        on conflict (key) do update set pack = excluded.pack, name = excluded.name, description = excluded.description,
          current_version = greatest(platform.model_templates.current_version, excluded.current_version), status = 'active'`;
      const [stored] = await tx<{ definition: unknown }[]>`
        select definition from platform.model_template_versions where template_key = ${m.key} and version = ${m.version} for update`;
      if (stored && canonical(stored.definition) !== canonical(m)) {
        throw new Error(`Library model "${m.key}" changed but is still version ${m.version}. Give it a new version number`);
      }
      if (!stored) {
        await tx`insert into platform.model_template_versions (template_key, version, definition) values (${m.key}, ${m.version}, ${JSON.stringify(m)}::text::jsonb)`;
      }
    }
    for (const q of lib.namedQueries) {
      await tx`
        insert into platform.named_queries (key, pack, definition) values (${q.key}, ${q.pack}, ${JSON.stringify(q)}::text::jsonb)
        on conflict (key) do update set pack = excluded.pack, definition = excluded.definition, updated_at = now()`;
    }
    for (const a of lib.namedActions) {
      await tx`
        insert into platform.named_actions (key, pack, definition) values (${a.key}, ${a.pack}, ${JSON.stringify(a)}::text::jsonb)
        on conflict (key) do update set pack = excluded.pack, definition = excluded.definition, updated_at = now()`;
    }
  });
  return { models: lib.models.length, namedQueries: lib.namedQueries.length, namedActions: lib.namedActions.length };
};
