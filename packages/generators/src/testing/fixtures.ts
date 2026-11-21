// Test-only: a catalog file built from the real model library (@rms/models LIBRARY), shaped the
// way the Data API's catalog shows it (system fields first, refs with `refersTo`). Not built
// into dist: tsconfig excludes this folder.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelAccess, ModelCatalogEntry, NamedCatalogEntry, SandboxCatalog } from "@rms/contracts";
import { LIBRARY } from "@rms/models";

type LibField = { key: string; label: string; type: string; required?: boolean; values?: string[]; model?: string; parentModel?: string };
type LibModel = { key: string; name: string; description: string; locationScoped?: boolean; fields: LibField[] };
type LibQuery = { key: string; name: string; description: string; params: Array<{ key: string; type: string; required?: boolean }>; columns: Array<{ key: string; label: string; type: string }> };

const models = LIBRARY.models as unknown as LibModel[];
const queries = LIBRARY.namedQueries as unknown as LibQuery[];

export const modelEntry = (key: string, access: ModelAccess): ModelCatalogEntry => {
  const m = models.find((x) => x.key === key);
  if (!m) throw new Error(`no library model ${key}`);
  const system: ModelCatalogEntry["fields"] = [
    { key: "id", label: "Id", type: "id", required: false },
    ...(m.locationScoped ? [{ key: "location_id", label: "Location", type: "ref", required: false, refersTo: "parent.locations" }] : []),
    { key: "created_at", label: "Created", type: "timestamp", required: false },
    { key: "updated_at", label: "Updated", type: "timestamp", required: false },
  ];
  const own = m.fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required ?? false,
    ...(f.type === "enum" && f.values ? { values: f.values } : {}),
    ...(f.type === "ref" && f.model ? { refersTo: f.model } : {}),
    ...(f.type === "parent_ref" && f.parentModel ? { refersTo: `parent.${f.parentModel}` } : {}),
  }));
  return { kind: "model", ref: m.key, name: m.name, description: m.description, state: "in_app", access, fields: [...system, ...own] };
};

export const queryEntry = (key: string): NamedCatalogEntry => {
  const q = queries.find((x) => x.key === key);
  if (!q) throw new Error(`no library query ${key}`);
  return {
    kind: "named_query",
    key: q.key,
    name: q.name,
    description: q.description,
    params: q.params.map((p) => ({ key: p.key, type: p.type, required: p.required ?? true })),
    columns: q.columns.map((c) => ({ key: c.key, label: c.label, type: c.type })),
  };
};

export const catalogFor = (opts: { models?: Array<[string, ModelAccess]>; queries?: string[]; extraQueries?: NamedCatalogEntry[] }): SandboxCatalog => ({
  writtenAt: "2026-11-21T12:00:00.000Z",
  models: (opts.models ?? []).map(([k, a]) => modelEntry(k, a)),
  namedQueries: [...(opts.queries ?? []).map(queryEntry), ...(opts.extraQueries ?? [])],
  actions: [],
});

export const writeCatalog = (appDir: string, catalog: SandboxCatalog): void => {
  mkdirSync(join(appDir, ".rms"), { recursive: true });
  writeFileSync(join(appDir, ".rms/catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
};

/** The catalog used by the vendor and accounts tests. */
export const demoCatalog = (): SandboxCatalog =>
  catalogFor({
    models: [
      ["vendor", "write"],
      ["vendor_bill", "read"],
    ],
    queries: ["weekly_pnl", "prime_cost_by_week", "sales_by_day"],
  });
