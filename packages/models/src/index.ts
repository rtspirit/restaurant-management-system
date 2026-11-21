// @rms/models: model compiler, library assembly, store model provisioning. Task C.
// The library itself (src/packs) is NOT imported here. The lead wires
// `LIBRARY = buildLibrary(packs)` once the packs land.
export * from "./compiler/index.js";
export { type Library, type PackExports, buildLibrary, installLibrary } from "./library.js";
export {
  type ApplyOptions,
  type ApplyResult,
  type EnsureResult,
  type StoreOptions,
  STORE_LIMITS,
  applyChange,
  discardPendingChange,
  effectiveDefinition,
  ensureModels,
  publishModelChanges,
} from "./store.js";

// The real library, assembled from the packs. Wired by the lead at integration.
import * as packs from "./packs/index.js";
import { buildLibrary } from "./library.js";

/** Every library model, named query and named action RMS ships today. */
export const LIBRARY = buildLibrary({ models: packs.models, namedQueries: packs.namedQueries, namedActions: packs.namedActions });
export { DEFAULT_CHART_OF_ACCOUNTS, DEFAULT_POSTING_RULES, STANDARD_CALENDAR_NAME } from "./packs/index.js";
