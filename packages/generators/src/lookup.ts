// `catalog_lookup` inside the sandbox: components, patterns and generators from the template
// itself, and models, named queries and actions from the runner-written catalog file.
import type { CatalogEntry, CatalogLookupInput, CatalogLookupOutput, GeneratorCatalogEntry, SandboxCatalog, UiCatalogEntry } from "@rms/contracts";
import { ToolRefusal, readCatalogFile } from "./app-files.js";
import { COMPONENTS, GENERATORS, PATTERNS } from "./catalog/ui.js";

const MAX = 60;

export const uiCatalog = (): { components: UiCatalogEntry[]; patterns: UiCatalogEntry[]; generators: GeneratorCatalogEntry[] } => ({
  components: COMPONENTS,
  patterns: PATTERNS,
  generators: GENERATORS,
});

const nameOf = (e: CatalogEntry): string => ("ref" in e ? e.ref : "key" in e ? e.key : e.name);
const textOf = (e: CatalogEntry): string => [nameOf(e), "name" in e ? e.name : "", "summary" in e ? e.summary : "", "description" in e ? e.description : ""].join(" ").toLowerCase();

export const lookup = async (appDir: string, input: CatalogLookupInput): Promise<CatalogLookupOutput> => {
  let all: CatalogEntry[];
  if (input.kind === "components") all = COMPONENTS;
  else if (input.kind === "patterns") all = PATTERNS;
  else if (input.kind === "generators") all = GENERATORS;
  else {
    let catalog: SandboxCatalog;
    try {
      catalog = await readCatalogFile(appDir);
    } catch (error) {
      if (error instanceof ToolRefusal) return { ok: true, kind: input.kind, entries: [], more: false };
      throw error;
    }
    all = input.kind === "models" ? catalog.models : input.kind === "named_queries" ? catalog.namedQueries : catalog.actions;
  }

  let found = all;
  if (input.name !== undefined) found = all.filter((e) => nameOf(e) === input.name);
  if (input.search !== undefined) {
    const words = input.search.toLowerCase().split(/\s+/).filter(Boolean);
    found = found.filter((e) => words.every((w) => textOf(e).includes(w)));
  }
  return { ok: true, kind: input.kind, entries: found.slice(0, MAX), more: found.length > MAX };
};
