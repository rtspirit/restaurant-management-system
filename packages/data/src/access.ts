// Who may touch what. Three checks, always in this order, and each one can only say no:
//   1. the mini-app's manifest lists the model with enough access   -> forbidden_model
//   2. the model exists for this restaurant in this environment     -> not_found
//   3. the user's role may do it (the model's defaultAccess)        -> forbidden_role
// Check 1 comes first so a mini-app cannot learn whether a model it may not use exists.
import { type AppManifest, type ModelAccess, type ModelDefinition, type TenantContext, isParentRef } from "@rms/contracts";
import { DataApiError } from "./errors.js";
import type { Platform } from "./platform.js";
import { type Shape, childShape, parentKeyOf, parentShape } from "./shape.js";

/** The access the manifest gives for a model, or null when it is not listed. */
export const manifestAccess = (manifest: AppManifest, ref: string): ModelAccess | null => manifest.models.find((m) => m.use === ref)?.access ?? null;

/** Check 1. Parent data can never be written, whatever a manifest says. */
export const checkManifest = (manifest: AppManifest, ref: string, need: ModelAccess): void => {
  if (need === "write" && isParentRef(ref)) throw new DataApiError("read_only");
  const access = manifestAccess(manifest, ref);
  if (access === null) throw new DataApiError("forbidden_model");
  if (need === "write" && access !== "write") throw new DataApiError("forbidden_model", "This mini-app may look at that information but not change it.");
};

/** Check 3. */
export const checkRole = (def: ModelDefinition, tenant: TenantContext, need: ModelAccess): void => {
  const access = def.defaultAccess[tenant.role];
  if (access !== "read" && access !== "write") throw new DataApiError("forbidden_role");
  if (need === "write" && access !== "write") throw new DataApiError("forbidden_role", "Your role may look at this but not change it.");
};

/**
 * Runs all three checks for a set of models and returns each one's shape for this caller.
 * Throws on the first refusal. Never returns a shape the caller may not use.
 */
export const shapesFor = async (
  platform: Platform,
  manifest: AppManifest,
  tenant: TenantContext,
  needs: ReadonlyArray<{ ref: string; need: ModelAccess }>,
): Promise<Map<string, Shape>> => {
  for (const n of needs) checkManifest(manifest, n.ref, n.need);
  const childKeys = needs.filter((n) => !isParentRef(n.ref)).map((n) => n.ref);
  const defs = await platform.models(childKeys);
  const out = new Map<string, Shape>();
  for (const n of needs) {
    if (isParentRef(n.ref)) {
      const key = parentKeyOf(n.ref);
      if (!key) throw new DataApiError("not_found", "That kind of record does not exist.");
      out.set(n.ref, parentShape(key, tenant.role, tenant.env));
      continue;
    }
    const def = defs.get(n.ref);
    if (!def) throw new DataApiError("not_found", "That kind of record is not set up for this restaurant yet.");
    checkRole(def, tenant, n.need);
    out.set(n.ref, childShape(def, tenant.role));
  }
  return out;
};

/** The highest access this caller has to a model through this mini-app, or null for none. */
export const effectiveAccess = (manifest: AppManifest, def: ModelDefinition | null, ref: string, tenant: TenantContext): ModelAccess | null => {
  const m = manifestAccess(manifest, ref);
  if (m === null) return null;
  if (isParentRef(ref)) return "read";
  if (!def) return null;
  const r = def.defaultAccess[tenant.role];
  if (r !== "read" && r !== "write") return null;
  return m === "write" && r === "write" ? "write" : "read";
};
