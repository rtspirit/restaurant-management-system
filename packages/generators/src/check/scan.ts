// `imports`, `safety` and `manifest`: walk the mini-app's own code (the editable folders) with
// the TypeScript compiler. A pattern match on text would miss `window["fe" + "tch"]`; the
// syntax tree does not, and anything computed where a fixed name is expected is refused.
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { ALLOWED_APP_IMPORTS, type SandboxCatalog, isEditablePath } from "@rms/contracts";
import ts from "typescript";
import type { AppFile } from "../lock.js";

export type Problem = { file?: string; line?: number; message: string };

const CODE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;

/** Names that reach the network, storage, other windows or dynamic code. */
const BANNED_NAMES: Record<string, string> = {
  fetch: "No network calls: read and write through @rms/sdk.",
  XMLHttpRequest: "No network calls: read and write through @rms/sdk.",
  WebSocket: "No network calls: read and write through @rms/sdk.",
  EventSource: "No network calls: read and write through @rms/sdk.",
  sendBeacon: "No network calls: read and write through @rms/sdk.",
  eval: "No dynamic code.",
  localStorage: "No browser storage: keep data through @rms/sdk.",
  sessionStorage: "No browser storage: keep data through @rms/sdk.",
  indexedDB: "No browser storage: keep data through @rms/sdk.",
  caches: "No browser storage: keep data through @rms/sdk.",
  postMessage: "No messages to other windows: @rms/sdk does that.",
  innerHTML: "No direct page changes: use the components.",
  outerHTML: "No direct page changes: use the components.",
  insertAdjacentHTML: "No direct page changes: use the components.",
  dangerouslySetInnerHTML: "No direct page changes: use the components.",
  cookie: "No cookies.",
  globalThis: "No reaching into the page's globals.",
  importScripts: "No dynamic code.",
};

/** Properties of the page's windows that lead out of the mini-app. */
const WINDOW_EXITS = new Set(["open", "top", "parent", "opener", "frames", "location"]);
const GLOBALS = new Set(["window", "self", "document", "navigator", "globalThis"]);

/** `(window as any)`, `window!` and `(window)` all name `window`. */
const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isTypeAssertionExpression(x) || ts.isNonNullExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  return x;
};
const globalName = (e: ts.Expression): string | null => {
  const x = unwrap(e);
  return ts.isIdentifier(x) && GLOBALS.has(x.text) ? x.text : null;
};

const allowedImport = (spec: string): boolean => (ALLOWED_APP_IMPORTS as readonly string[]).includes(spec);

export type ScanResult = { imports: Problem[]; safety: Problem[]; used: { models: Set<string>; queries: Set<string>; actions: Set<string>; unresolved: Problem[] } };

export const editableCodeFiles = (files: AppFile[]): string[] => files.filter((f) => !f.link && isEditablePath(f.path) && CODE.test(f.path)).map((f) => f.path);

export const scanCode = (appDir: string, files: AppFile[]): ScanResult => {
  const result: ScanResult = { imports: [], safety: [], used: { models: new Set(), queries: new Set(), actions: new Set(), unresolved: [] } };
  for (const f of files) {
    if (!f.link && isEditablePath(f.path) && /\.(css|scss|sass|less)$/i.test(f.path)) result.safety.push({ file: f.path, message: "No stylesheets: the look comes from @rms/ui." });
  }

  for (const path of editableCodeFiles(files)) {
    const text = readFileSync(join(appDir, path), "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const at = (node: ts.Node): { file: string; line: number } => ({ file: path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    const safety = (node: ts.Node, message: string) => result.safety.push({ ...at(node), message });
    const importProblem = (node: ts.Node, message: string) => result.imports.push({ ...at(node), message });

    // Top-level `const NAME = "text"`, so `model: MODEL` can be followed.
    const constants = new Map<string, string>();
    for (const st of source.statements) {
      if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteralLike(d.initializer)) constants.set(d.name.text, d.initializer.text);
      }
    }
    const fixed = (e: ts.Expression): string | null => {
      if (ts.isStringLiteralLike(e)) return e.text;
      if (ts.isIdentifier(e)) return constants.get(e.text) ?? null;
      return null;
    };

    const checkSpecifier = (node: ts.Node, spec: string): void => {
      if (/\.(css|scss|sass|less)$/i.test(spec)) {
        safety(node, "No CSS imports: the look comes from @rms/ui.");
        return;
      }
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const target = normalize(join(dirname(path), spec)).split("\\").join("/");
        if (!target.startsWith("src/")) importProblem(node, `"${spec}" is outside src/. Import only your own files and ${ALLOWED_APP_IMPORTS.join(", ")}.`);
        return;
      }
      if (!allowedImport(spec)) importProblem(node, `"${spec}" cannot be used. Mini-apps import only ${ALLOWED_APP_IMPORTS.join(", ")} and their own files.`);
    };

    const visit = (node: ts.Node): void => {
      // Imports and exports from other files.
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier)) checkSpecifier(node, node.moduleSpecifier.text);
      } else if (ts.isImportEqualsDeclaration(node)) {
        importProblem(node, "Use `import ... from`, not `import = require()`.");
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteralLike(arg)) checkSpecifier(node, arg.text);
          else safety(node, "No import() of a computed path.");
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          importProblem(node, "Use `import ... from`, not require().");
        } else if (ts.isIdentifier(node.expression) && (node.expression.text === "setTimeout" || node.expression.text === "setInterval")) {
          const arg = node.arguments[0];
          if (arg && (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg))) safety(node, "No code in a string: pass a function.");
        }
        // Which models, reports and actions the screens use.
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        const arg = node.arguments[0];
        if (name === "useNamedQuery" && arg) {
          const v = fixed(arg);
          if (v === null) result.used.unresolved.push({ ...at(arg), message: "Name the report with fixed text, so it can be checked against the plan." });
          else result.used.queries.add(v);
        }
        if ((name === "insert" || name === "update" || name === "remove") && arg) {
          const v = fixed(arg);
          if (v !== null) result.used.models.add(v);
        }
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
        safety(node, "No dynamic code (new Function).");
      } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        safety(node, "No import.meta: settings come from RMS, not from the build.");
      } else if (ts.isJsxAttribute(node)) {
        const attr = node.name.getText(source);
        if (attr === "style") safety(node, "No inline styles: the look comes from @rms/ui.");
        else if (attr === "className") safety(node, "No class names: compose the components instead.");
        else if (attr === "dangerouslySetInnerHTML") safety(node, BANNED_NAMES.dangerouslySetInnerHTML!);
      } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
        const key = node.name.text;
        const v = fixed(node.initializer);
        if (key === "model" && v !== null) result.used.models.add(v);
        if (key === "query" && v !== null) result.used.queries.add(v);
        if (key === "action" && v !== null) result.used.actions.add(v);
      } else if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isKey = (ts.isPropertyAssignment(parent) && parent.name === node) || (ts.isJsxAttribute(parent) && parent.name === node) || (ts.isPropertySignature(parent) && parent.name === node);
        const message = BANNED_NAMES[node.text];
        if (message !== undefined && !isKey) safety(node, `${message} (${node.text})`);
        if (node.text === "Function" && ts.isCallExpression(parent) && parent.expression === node) safety(node, "No dynamic code (Function).");
        // The page's globals may only be used as `window.something`: never passed around or
        // stored, where a later computed access could not be checked.
        if (GLOBALS.has(node.text) && message === undefined && !isKey) {
          let outer: ts.Node = parent;
          let inner: ts.Node = node;
          while (ts.isParenthesizedExpression(outer) || ts.isAsExpression(outer) || ts.isTypeAssertionExpression(outer) || ts.isNonNullExpression(outer) || ts.isSatisfiesExpression(outer)) {
            inner = outer;
            outer = outer.parent;
          }
          const accessed = (ts.isPropertyAccessExpression(outer) || ts.isElementAccessExpression(outer)) && outer.expression === inner;
          if (!accessed && !ts.isTypeQueryNode(outer) && !ts.isQualifiedName(outer)) safety(node, `Use ${node.text} only as ${node.text}.something. Do not store it or pass it on.`);
        }
      } else if (ts.isPropertyAccessExpression(node)) {
        const base = globalName(node.expression);
        if (base !== null && WINDOW_EXITS.has(node.name.text)) safety(node, `No ${base}.${node.name.text}: a mini-app stays inside its frame.`);
      } else if (ts.isElementAccessExpression(node)) {
        const base = globalName(node.expression);
        const key = node.argumentExpression;
        if (base !== null) {
          if (!ts.isStringLiteralLike(key)) safety(node, `No computed access on ${base}.`);
          else if (BANNED_NAMES[key.text] !== undefined || WINDOW_EXITS.has(key.text)) safety(node, `${BANNED_NAMES[key.text] ?? "A mini-app stays inside its frame."} (${key.text})`);
        } else if (ts.isStringLiteralLike(key) && BANNED_NAMES[key.text] !== undefined) {
          safety(node, `${BANNED_NAMES[key.text]} (${key.text})`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return result;
};

/** `manifest`: every model, report and action the screens name is in the catalog file. */
export const manifestProblems = (scan: ScanResult, catalog: SandboxCatalog | null): Problem[] => {
  if (catalog === null) return [{ message: "There is no readable catalog file (.rms/catalog.json). RMS writes it when a build starts." }];
  const problems: Problem[] = [...scan.used.unresolved];
  const models = new Set(catalog.models.map((m) => m.ref));
  const queries = new Set(catalog.namedQueries.map((q) => q.key));
  const actions = new Set(catalog.actions.map((a) => a.key));
  for (const m of scan.used.models) if (!models.has(m)) problems.push({ message: `The screens use "${m}", which is not in this mini-app's plan. Its models are: ${[...models].join(", ") || "none"}.` });
  for (const q of scan.used.queries) if (!queries.has(q)) problems.push({ message: `The screens use the report "${q}", which is not in this mini-app's plan. Its reports are: ${[...queries].join(", ") || "none"}.` });
  for (const a of scan.used.actions) if (!actions.has(a)) problems.push({ message: `The screens use the action "${a}", which is not in this mini-app's plan. Its actions are: ${[...actions].join(", ") || "none"}.` });
  return problems;
};
