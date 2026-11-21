// POST /data/v1/catalog: what this token may use. Shapes only: never SQL, never another
// restaurant, never a model, field, report or action the caller's ROLE could not actually use.
import { type CatalogResponse, type ModelAccess, type TenantContext, isParentRef } from "@rms/contracts";
import { effectiveAccess } from "./access.js";
import { DataApiError } from "./errors.js";
import { targetColumnsAllowed } from "./named.js";
import { PARENT_SPECS } from "./parent-models.js";
import { withPlatform } from "./platform.js";
import { type Attr, type Shape, childShape, parentKeyOf, parentShape } from "./shape.js";
import { type Checked, checkNamedAction, checkNamedQuery } from "./template-check.js";

type CatalogField = CatalogResponse["models"][number]["fields"][number];

/**
 * How one attribute is shown. The wire has no "uuid" type: a row's own `id` is shown as "id",
 * and an id that points at another table as "ref" with `refersTo`.
 */
const fieldOf = (a: Attr): CatalogField => {
  const base = { key: a.key, label: a.label, required: a.system ? false : a.required };
  if (a.key === "id") return { ...base, type: "id" };
  if (a.system && a.key === "location_id") return { ...base, type: "ref", refersTo: "parent.locations" };
  if (a.kind === "uuid") return { ...base, type: "ref", ...(a.refersTo ? { refersTo: a.refersTo } : {}) };
  return {
    ...base, type: a.kind,
    ...(a.def?.type === "enum" ? { values: a.def.values } : {}),
    ...(a.def?.type === "ref" ? { refersTo: a.def.model } : {}),
    ...(a.def?.type === "parent_ref" ? { refersTo: `parent.${a.def.parentModel}` } : {}),
  };
};

/** Every attribute the role may read, system fields included: all of them can be filtered and sorted on. */
const fieldsOf = (shape: Shape): CatalogField[] => shape.list.filter((a) => a.readable).map(fieldOf);

/**
 * Can this role run the template at all? Not if it mentions a column the role cannot read in
 * a model it reads (the run would be refused with `forbidden_field`), and not if it does not
 * pass the allow list. Matching is by column name, so it can hide a report the role could in
 * fact run. It never shows one the role cannot.
 */
const usable = (checked: Checked, reads: readonly string[], shapes: ReadonlyMap<string, Shape>): boolean => {
  if (targetColumnsAllowed(checked.pieces, shapes) !== "ok") return false;
  for (const ref of reads) {
    const shape = shapes.get(ref);
    if (!shape) return false;
    if (shape.masked.some((k) => checked.columns.has(k))) return false;
  }
  return true;
};

export const runCatalog = async (tenant: TenantContext, raw: unknown): Promise<CatalogResponse> => {
  // The body carries nothing. Anything in it is refused, like every other route's strict shape.
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 0)) {
    throw new DataApiError("invalid_request");
  }

  const loaded = await withPlatform(tenant, async (platform) => {
    const manifest = await platform.manifest();
    const refs = manifest.models.map((m) => m.use);
    const defs = await platform.models(refs.filter((r) => !isParentRef(r)));

    const access = new Map<string, ModelAccess>();
    const shapes = new Map<string, Shape>();
    const models: CatalogResponse["models"] = [];
    for (const ref of refs) {
      const def = defs.get(ref) ?? null;
      const a = effectiveAccess(manifest, def, ref, tenant);
      if (a === null) continue;
      if (isParentRef(ref)) {
        const key = parentKeyOf(ref);
        if (!key) continue;
        const spec = PARENT_SPECS[key];
        const shape = parentShape(key, tenant.role, tenant.env);
        access.set(ref, a);
        shapes.set(ref, shape);
        models.push({ ref, name: spec.name, description: spec.description, access: a, fields: fieldsOf(shape) });
      } else if (def) {
        const shape = childShape(def, tenant.role);
        access.set(ref, a);
        shapes.set(ref, shape);
        models.push({ ref, name: def.name, description: def.description, access: a, fields: fieldsOf(shape) });
      }
    }
    return { models, access, shapes, queries: await platform.namedQueries(manifest.namedQueries), actions: await platform.namedActions(manifest.actions) };
  });

  const { models, access, shapes } = loaded;
  const canRead = (r: string) => access.has(r);
  const canWrite = (r: string) => access.get(r) === "write";
  const params = (ps: ReadonlyArray<{ key: string; type: string; required: boolean }>) => ps.map((p) => ({ key: p.key, type: p.type, required: p.required }));

  const namedQueries: CatalogResponse["namedQueries"] = [];
  for (const q of loaded.queries) {
    if (!q.reads.every(canRead)) continue;
    const columns = q.columns.filter((c) => !c.readableBy || c.readableBy.includes(tenant.role)).map((c) => ({ key: c.key, label: c.label, type: c.type }));
    if (columns.length === 0) continue;
    const checked = await checkNamedQuery(q).catch(() => null);
    if (!checked || !usable(checked, q.reads, shapes)) continue;
    namedQueries.push({ key: q.key, name: q.name, description: q.description, params: params(q.params), columns });
  }

  const actions: CatalogResponse["actions"] = [];
  for (const a of loaded.actions) {
    if (!a.reads.every(canRead) || !a.writes.every(canWrite)) continue;
    const checked = await checkNamedAction(a).catch(() => null);
    if (!checked || !usable(checked, a.reads, shapes)) continue;
    actions.push({ key: a.key, name: a.name, description: a.description, params: params(a.params) });
  }

  return { models, namedQueries, actions };
};
