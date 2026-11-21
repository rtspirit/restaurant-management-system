// Installing the model library, the safe way. Lead-owned entry point.
//
// `@rms/models` knows how to store the library and `@rms/data` knows which SQL templates are
// allowed to run (a real PostgreSQL parser and an allow list). Neither may depend on the other,
// so the one place that does both lives here: every named query and named action is checked
// first, and the library is stored only when all of them pass. A template that would be refused
// at run time is therefore refused at install time, before any restaurant can be given it.
import { TemplateError, checkNamedAction, checkNamedQuery } from "@rms/data";
import type { Sql } from "@rms/db";
import { LIBRARY, type Library, buildLibrary, installLibrary } from "@rms/models";

export type TemplateProblem = { kind: "named query" | "named action"; key: string; reason: string };

/** Runs every template in the library through the Data API's checker. Returns what failed. */
export const checkLibraryTemplates = async (library: Library): Promise<TemplateProblem[]> => {
  const problems: TemplateProblem[] = [];
  const reasonOf = (e: unknown): string => (e instanceof TemplateError ? e.message : "the template could not be read");
  for (const q of library.namedQueries) {
    await checkNamedQuery(q).catch((e: unknown) => problems.push({ kind: "named query", key: q.key, reason: reasonOf(e) }));
  }
  for (const a of library.namedActions) {
    await checkNamedAction(a).catch((e: unknown) => problems.push({ kind: "named action", key: a.key, reason: reasonOf(e) }));
  }
  return problems;
};

/**
 * Checks the whole library, then installs it. All or nothing: if any template is refused, this
 * throws and nothing is written. Admin connection only. Safe to run again.
 */
export const installPlatformLibrary = async (adminSql: Sql, library: Library = LIBRARY): Promise<{ models: number; namedQueries: number; namedActions: number }> => {
  // Parse first, so the checker reads exactly what would be stored.
  const lib = buildLibrary(library);
  const problems = await checkLibraryTemplates(lib);
  if (problems.length > 0) {
    throw new Error(`The library was not installed. ${problems.map((p) => `The ${p.kind} "${p.key}" is not allowed: ${p.reason}`).join(". ")}`);
  }
  return installLibrary(adminSql, lib);
};
