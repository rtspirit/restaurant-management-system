// POST /data/v1/catalog: what this token may use. Shapes only: never SQL, never another
// restaurant, never a model, field, report or action the caller could not actually use.
import { type CatalogResponse, type ModelAccess, type TenantContext, isParentRef } from "@rms/contracts";
import { effectiveAccess } from "./access.js";
import { DataApiError } from "./errors.js";
import { withPlatform } from "./platform.js";
import { type Shape, childShape, parentKeyOf, parentShape } from "./shape.js";
import { PARENT_SPECS } from "./parent-models.js";

const fieldsOf = (shape: Shape): CatalogResponse["models"][number]["fields"] =>
  shape.list
    .filter((a) => a.readable && !a.system)
    .map((a) => ({
      key: a.key, label: a.label, type: a.kind === "uuid" ? "ref" : a.kind, required: a.required,
      ...(a.def?.type === "enum" ? { values: a.def.values } : {}),
      ...(a.def?.type === "ref" ? { refersTo: a.def.model } : {}),
      ...(a.def?.type === "parent_ref" ? { refersTo: `parent.${a.def.parentModel}` } : {}),
    }));

export const runCatalog = async (tenant: TenantContext, raw: unknown): Promise<CatalogResponse> => {
  // The body carries nothing. Anything in it is refused, like every other route's strict shape.
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 0)) {
    throw new DataApiError("invalid_request");
  }

  return withPlatform(tenant, async (platform) => {
    const manifest = await platform.manifest();
    const refs = manifest.models.map((m) => m.use);
    const defs = await platform.models(refs.filter((r) => !isParentRef(r)));

    const access = new Map<string, ModelAccess>();
    const models: CatalogResponse["models"] = [];
    for (const ref of refs) {
      const def = defs.get(ref) ?? null;
      const a = effectiveAccess(manifest, def, ref, tenant);
      if (a === null) continue;
      if (isParentRef(ref)) {
        const key = parentKeyOf(ref);
        if (!key) continue;
        const spec = PARENT_SPECS[key];
        access.set(ref, a);
        models.push({ ref, name: spec.name, description: spec.description, access: a, fields: fieldsOf(parentShape(key, tenant.role, tenant.env)) });
      } else if (def) {
        access.set(ref, a);
        models.push({ ref, name: def.name, description: def.description, access: a, fields: fieldsOf(childShape(def, tenant.role)) });
      }
    }

    const canRead = (r: string) => access.has(r);
    const canWrite = (r: string) => access.get(r) === "write";
    const params = (ps: ReadonlyArray<{ key: string; type: string; required: boolean }>) => ps.map((p) => ({ key: p.key, type: p.type, required: p.required }));

    const namedQueries = (await platform.namedQueries(manifest.namedQueries))
      .filter((q) => q.reads.every(canRead))
      .map((q) => ({
        key: q.key, name: q.name, description: q.description, params: params(q.params),
        columns: q.columns.filter((c) => !c.readableBy || c.readableBy.includes(tenant.role)).map((c) => ({ key: c.key, label: c.label, type: c.type })),
      }))
      .filter((q) => q.columns.length > 0);

    const actions = (await platform.namedActions(manifest.actions))
      .filter((a) => a.reads.every(canRead) && a.writes.every(canWrite))
      .map((a) => ({ key: a.key, name: a.name, description: a.description, params: params(a.params) }));

    return { models, namedQueries, actions };
  });
};
