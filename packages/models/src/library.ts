// The model library: what the packs export, checked and ready to install.
// This file does NOT import ./packs. The lead wires `LIBRARY = buildLibrary(packs)`.
import { ModelDefinition, NamedActionDefinition, NamedQueryDefinition, isParentRef } from "@rms/contracts";
import type { Sql } from "@rms/db";
import { compileModel, modelDependencies, targetsFor } from "./compiler/index.js";

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

/**
 * Writes the library into platform.model_templates, model_template_versions, named_queries and
 * named_actions. Admin connection only. Safe to run again: rows are updated in place.
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
      await tx`
        insert into platform.model_template_versions (template_key, version, definition)
        values (${m.key}, ${m.version}, ${JSON.stringify(m)}::text::jsonb)
        on conflict (template_key, version) do update set definition = excluded.definition`;
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
