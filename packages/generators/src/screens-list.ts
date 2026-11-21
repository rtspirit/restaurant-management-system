// Keeps `src/screens/index.ts` up to date. It is read with the TypeScript compiler, never with
// pattern matching, and written again whole from what was read, so the order and titles the
// agent chose are kept.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_TEMPLATE } from "@rms/contracts";
import ts from "typescript";
import { ToolRefusal, lit } from "./app-files.js";

export type ScreenEntry = { name: string; title: string; component: string; from: string };

const SHAPE_HELP =
  "The screen list (src/screens/index.ts) must stay a list of { name, title, component } with each component imported from its own folder. Put it back in that shape and run the generator again.";

export const readScreens = async (appDir: string): Promise<ScreenEntry[]> => {
  const path = join(appDir, APP_TEMPLATE.screensFile);
  if (!existsSync(path)) return [];
  const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  const importedFrom = new Map<string, string>();
  for (const st of source.statements) {
    if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue;
    const from = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
    const named = st.importClause?.namedBindings;
    if (from === null || !named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) importedFrom.set(el.name.text, from);
  }

  let list: ts.ArrayLiteralExpression | null = null;
  for (const st of source.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === "screens" && d.initializer && ts.isArrayLiteralExpression(d.initializer)) list = d.initializer;
    }
  }
  if (list === null) throw new ToolRefusal(SHAPE_HELP);

  const entries: ScreenEntry[] = [];
  for (const el of list.elements) {
    if (!ts.isObjectLiteralExpression(el)) throw new ToolRefusal(SHAPE_HELP);
    const props = new Map<string, ts.Expression>();
    for (const p of el.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) props.set(p.name.text, p.initializer);
      else if (ts.isShorthandPropertyAssignment(p)) props.set(p.name.text, p.name);
    }
    const name = props.get("name");
    const title = props.get("title");
    const component = props.get("component");
    if (!name || !ts.isStringLiteral(name) || !title || !ts.isStringLiteral(title) || !component || !ts.isIdentifier(component)) throw new ToolRefusal(SHAPE_HELP);
    const from = importedFrom.get(component.text);
    if (from === undefined) throw new ToolRefusal(SHAPE_HELP);
    entries.push({ name: name.text, title: title.text, component: component.text, from });
  }
  return entries;
};

export const renderScreens = (entries: ScreenEntry[]): string =>
  [
    "// The mini-app's screens, in the order they show in its navigation.",
    "// The generators add to this list (`rms gen ...`). Editable: reorder or rename here.",
    'import type { ComponentType } from "react";',
    ...entries.map((e) => `import { ${e.component} } from ${lit(e.from)};`),
    "",
    "export type Screen = {",
    "  /** The screen's folder under src/screens/ and its address inside the mini-app. */",
    "  name: string;",
    "  /** What the navigation calls it. */",
    "  title: string;",
    "  component: ComponentType;",
    "};",
    "",
    "export const screens: Screen[] = [",
    ...entries.map((e) => `  { name: ${lit(e.name)}, title: ${lit(e.title)}, component: ${e.component} },`),
    "];",
    "",
  ].join("\n");

/**
 * Adds a screen, or updates its title and component when it is already listed. The starter
 * screen ("welcome") leaves the list when the first real screen arrives.
 */
export const upsertScreen = async (appDir: string, entry: ScreenEntry): Promise<"add" | "update"> => {
  const path = join(appDir, APP_TEMPLATE.screensFile);
  const existed = existsSync(path);
  const entries = (await readScreens(appDir)).filter((e) => e.name !== "welcome" || entry.name === "welcome");
  const at = entries.findIndex((e) => e.name === entry.name);
  if (at >= 0) entries[at] = entry;
  else entries.push(entry);
  await writeFile(path, renderScreens(entries));
  return existed ? "update" : "add";
};
