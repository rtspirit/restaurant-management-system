// @rms/generators: the `rms` command the build agent uses inside the sandbox, and the same
// functions as a library for the runner (task I). Signatures are fixed by docs/briefs/wave2.md.
import {
  AppManifest,
  type AppManifestInput,
  type CatalogLookupInput,
  type CatalogLookupOutput,
  type CheckInput,
  type CheckOutput,
  type GeneratorCatalogEntry,
  type LockedHashes,
  type RunGeneratorInput,
  type RunGeneratorOutput,
  type UiCatalogEntry,
} from "@rms/contracts";
import { runChecks } from "./check/index.js";
import { generate } from "./generate.js";
import { writeLockedHashes as writeHashes } from "./lock.js";
import { lookup, uiCatalog as catalogOfUi } from "./lookup.js";

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
export const lookupCatalog = (appDir: string, input: CatalogLookupInput): Promise<CatalogLookupOutput> => lookup(appDir, input);

/** `run_generator`: writes one working screen from a pattern. Only ever writes inside the screen's own folder and the screen list. */
export const runGenerator = (appDir: string, input: RunGeneratorInput): Promise<RunGeneratorOutput> => generate(appDir, input);

/** `check`: the checks listed under CheckName, run inside the app folder, in that order. */
export const runCheck = (appDir: string, input: CheckInput = {}): Promise<CheckOutput> => runChecks(appDir, input);

/** Writes `.rms/locked.json` for the files as they are now. Local use and tests only: in a build the runner writes it. */
export const writeLockedHashes = (appDir: string): Promise<LockedHashes> => writeHashes(appDir);

/** The components, patterns and generators the build agent can use, described by hand. */
export const uiCatalog = (): { components: UiCatalogEntry[]; patterns: UiCatalogEntry[]; generators: GeneratorCatalogEntry[] } => catalogOfUi();

export { hashLockedFiles, listAppFiles } from "./lock.js";
