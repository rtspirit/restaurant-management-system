// @rms/generators: the `rms` command the build agent uses inside the sandbox, and the same
// functions as a library. Task H owns this package. Brief: docs/briefs/wave2.md, task H.
//
// The signatures below are the interface the runner (task I) and the command line use. They
// are fixed by the brief. Until task H lands, the tools answer "not built yet" in their typed
// output shape, so the runner can be written and tested against them today.
import {
  AppManifest,
  type AppManifestInput,
  type CatalogLookupInput,
  type CatalogLookupOutput,
  type CheckInput,
  type CheckOutput,
  type RunGeneratorInput,
  type RunGeneratorOutput,
} from "@rms/contracts";

const NOT_BUILT = "This tool is not built yet.";

/**
 * The contents of `rms.config.ts` for a manifest. The platform writes this file from the
 * confirmed plan. It is locked, and it is never read back: the copy that is enforced is the one
 * the platform keeps.
 */
export const renderManifestFile = (manifest: AppManifestInput): string => {
  const parsed = AppManifest.parse(manifest);
  return [
    "// Written by RMS from the plan the owner confirmed. Locked: do not edit.",
    "// To change what this mini-app keeps or reads, the owner asks for it and RMS writes this file again.",
    'import { defineApp } from "@rms/sdk";',
    "",
    `export default defineApp(${JSON.stringify(parsed, null, 2)});`,
    "",
  ].join("\n");
};

/** `catalog_lookup` for components, patterns and generators (from the template) and for the models in the app's catalog file. */
export const lookupCatalog = async (_appDir: string, input: CatalogLookupInput): Promise<CatalogLookupOutput> => ({ ok: true, kind: input.kind, entries: [], more: false });

/** `run_generator`: writes one working screen from a pattern. Only ever writes inside the screen's own folder and the screen list. */
export const runGenerator = async (_appDir: string, _input: RunGeneratorInput): Promise<RunGeneratorOutput> => ({ ok: false, files: [], notes: [NOT_BUILT] });

/** `check`: the checks listed under CheckName, run inside the app folder. */
export const runCheck = async (_appDir: string, _input: CheckInput = {}): Promise<CheckOutput> => ({
  ok: false,
  results: [{ check: "locked", ok: false, problems: [{ message: NOT_BUILT }] }],
  durationMs: 0,
});
