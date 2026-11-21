// `imports`, `safety` and `manifest`: walk the mini-app's own code (the editable folders) with
// the TypeScript compiler AND its type checker.
//
// The safety rule is an allow list, not a ban list:
//   - every name the code uses is declared in the mini-app's own files (or imported), or is one
//     of SAFE_GLOBALS. Anything else from the browser (window, location, Worker, Image, ...) is
//     refused. Resolution is by scope, through the checker, so a local `const location` does
//     not unlock the real one elsewhere; those names may not be declared at all anyway.
//   - a computed key (`x[k]`) must have a fixed, literal type. `"vi" + "ew"` is a plain string
//     and is refused. Literal keys are checked against BANNED_MEMBERS like `x.name` is.
//   - no type casts (other than `as const`) and no `any`, so the checker's view holds.
//   - no DOM handle is ever reachable: no `ref`, no spreads onto elements, events give only
//     `target.value` / `target.checked`, and members that lead to the page are refused.
//   - host elements come from a short list; nothing on it loads anything from outside.
// `rms check` tells the agent early. The real walls stay the runner's own checks, the content
// policy header, the frame sandbox and the relay (ADR 0008).
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { ALLOWED_APP_IMPORTS, type SandboxCatalog, isEditablePath } from "@rms/contracts";
import ts from "typescript";
import type { AppFile } from "../lock.js";

export type Problem = { file?: string; line?: number; message: string };

/** The only code files a mini-app may hold in its own folders. Anything else fails `locked`. */
export const CODE_FILE = /\.(ts|tsx)$/;
const STYLESHEET = /\.(css|scss|sass|less|pcss|postcss|sss|styl|stylus)$/i;

/** Browser and language globals a mini-app may use, with the members it may use (`*` = any). */
const SAFE_GLOBALS = new Map<string, "*" | ReadonlySet<string>>([
  ...["Math", "JSON", "Number", "String", "Boolean", "Array", "Date", "Intl", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError", "RangeError", "BigInt", "Symbol", "console"].map((n) => [n, "*"] as const),
  ...["parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "structuredClone", "undefined", "NaN", "Infinity"].map((n) => [n, "*"] as const),
  ["Object", new Set(["keys", "fromEntries", "freeze", "is"])],
]);

/** Names a mini-app may not declare for itself: they are the page's own. */
const NO_DECLARE = new Set(["window", "self", "globalThis", "location", "open", "parent", "top", "opener", "frames", "document", "navigator", "history", "eval", "Function", "fetch"]);

const NETWORK = "No network calls: read and write through @rms/sdk.";
const PAGE = "A mini-app stays inside its frame: it may not reach the page, its window or its document.";
const CHANGE = "No direct page changes: use the components.";
const DYNAMIC = "No dynamic code.";
const STORAGE = "No browser storage or cookies: keep data through @rms/sdk.";
const group = (names: string[], message: string): Array<[string, string]> => names.map((n) => [n, message]);

/** Member names that lead out of the mini-app, as `x.name`, `x["name"]` or `{ name } = x`. */
const BANNED_MEMBERS = new Map<string, string>([
  ...group(["fetch", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "serviceWorker"], NETWORK),
  ...group(["ownerDocument", "defaultView", "view", "nativeEvent", "contentWindow", "contentDocument", "parentNode", "parentElement", "offsetParent", "getRootNode", "frameElement", "srcElement", "relatedTarget", "location", "opener", "frames", "top", "document", "navigator", "history"], PAGE),
  ...group(["cookie", "localStorage", "sessionStorage", "indexedDB", "caches"], STORAGE),
  ...group(["innerHTML", "outerHTML", "insertAdjacentHTML", "insertAdjacentElement", "setAttribute", "setAttributeNS", "toggleAttribute", "appendChild", "insertBefore", "replaceChild", "createElement", "createElementNS", "cloneElement", "createObjectURL", "attachShadow", "requestSubmit", "postMessage"], CHANGE),
  ...group(["eval", "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "call", "apply", "bind", "getPrototypeOf", "setPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "defineProperty", "defineProperties", "importScripts"], DYNAMIC),
]);

/** An event's element may be read only as `target.value` or `target.checked`. */
const EVENT_ELEMENT = new Set(["target", "currentTarget"]);
const EVENT_ELEMENT_READS = new Set(["value", "checked"]);

/** Host elements a mini-app may draw. Nothing here loads anything (img only with a relative src). */
const HOST_TAGS = new Set([
  ..."div span p a strong em b i u s small mark sub sup br hr h1 h2 h3 h4 h5 h6 section header footer nav main article aside".split(" "),
  ..."ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col label time abbr code pre blockquote q figure figcaption details summary img".split(" "),
  ..."svg g path circle rect line polyline polygon ellipse text tspan title desc defs linearGradient radialGradient stop clipPath".split(" "),
]);

/** Attributes refused on every element, components included. */
const NEVER_ATTRS = new Map<string, string>([
  ["ref", "No refs: a mini-app never holds a page element."],
  ["style", "No inline styles: the look comes from @rms/ui."],
  ["className", "No class names: compose the components instead."],
  ["dangerouslySetInnerHTML", CHANGE],
]);
/** Attributes refused on host elements: they send the page somewhere or load something. */
const HOST_LOADING_ATTRS = new Set(["href", "xlinkHref", "action", "formAction", "httpEquiv", "srcDoc", "src", "srcSet", "poster", "data", "ping", "background", "is"]);

const allowedImport = (spec: string): boolean => (ALLOWED_APP_IMPORTS as readonly string[]).includes(spec);

export type ScanResult = { imports: Problem[]; safety: Problem[]; used: { models: Set<string>; queries: Set<string>; actions: Set<string>; unresolved: Problem[] } };

export const editableCodeFiles = (files: AppFile[]): string[] => files.filter((f) => !f.link && isEditablePath(f.path) && CODE_FILE.test(f.path)).map((f) => f.path);

const typeContext = (node: ts.Node): boolean => {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isTypeParameterDeclaration(p) || ts.isHeritageClause(p)) return true;
    if (ts.isStatement(p) || ts.isSourceFile(p)) return false;
  }
  return false;
};

/** A declared name: variable, parameter, function, class, catch binding. */
const isDeclarationName = (id: ts.Identifier): boolean => {
  const p = id.parent;
  return (
    ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isEnumDeclaration(p)) && p.name === id) ||
    ((ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) && p.name === id)
  );
};

/** True for a name that is not a value read: `x.name`, `{ name: 1 }`, `<X name />`, labels, import/export names. */
const isNamePosition = (id: ts.Identifier): boolean => {
  const p = id.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isPropertySignature(p) && p.name === id) ||
    (ts.isPropertyDeclaration(p) && p.name === id) ||
    (ts.isMethodDeclaration(p) && p.name === id) ||
    (ts.isGetAccessorDeclaration(p) && p.name === id) ||
    (ts.isSetAccessorDeclaration(p) && p.name === id) ||
    (ts.isEnumMember(p) && p.name === id) ||
    (ts.isJsxAttribute(p) && p.name === id) ||
    (ts.isBindingElement(p) && p.propertyName === id) ||
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isLabeledStatement(p) ||
    ts.isBreakOrContinueStatement(p) ||
    ts.isMetaProperty(p) ||
    ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === id && /^[a-z]/.test(id.text))
  );
};

type Checked = { program: ts.Program; checker: ts.TypeChecker } | null;

const makeProgram = (appDir: string): Checked => {
  const read = ts.readConfigFile(join(appDir, "tsconfig.json"), ts.sys.readFile);
  if (read.error) return null;
  const config = ts.parseJsonConfigFileContent(read.config, ts.sys, appDir);
  const program = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: true } });
  return { program, checker: program.getTypeChecker() };
};

/** True when the symbol is the mini-app's own (declared in a source file, not a .d.ts). */
const isOwn = (symbol: ts.Symbol | undefined): boolean => (symbol?.declarations ?? []).some((d) => !d.getSourceFile().isDeclarationFile);

export const scanCode = (appDir: string, files: AppFile[]): ScanResult => {
  const result: ScanResult = { imports: [], safety: [], used: { models: new Set(), queries: new Set(), actions: new Set(), unresolved: [] } };
  for (const f of files) {
    if (!f.link && isEditablePath(f.path) && STYLESHEET.test(f.path)) result.safety.push({ file: f.path, message: "No stylesheets: the look comes from @rms/ui." });
  }
  const code = editableCodeFiles(files);
  const checked = code.length > 0 ? makeProgram(appDir) : null;

  for (const path of code) {
    const fromProgram = checked?.program.getSourceFile(join(appDir, path));
    const source = fromProgram ?? ts.createSourceFile(path, readFileSync(join(appDir, path), "utf8"), ts.ScriptTarget.ES2022, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const checker = fromProgram && checked ? checked.checker : null;
    const at = (node: ts.Node): { file: string; line: number } => ({ file: path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    const safety = (node: ts.Node, message: string) => result.safety.push({ ...at(node), message });
    const importProblem = (node: ts.Node, message: string) => result.imports.push({ ...at(node), message });
    if (checker === null) safety(source, "This file could not be type checked, so it cannot be checked for safety. Fix tsconfig.json or the file.");

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
      if (STYLESHEET.test(spec.split("?")[0] ?? spec) || spec.includes("?")) {
        safety(node, "No CSS or asset imports: the look comes from @rms/ui.");
        return;
      }
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const target = normalize(join(dirname(path), spec)).split("\\").join("/");
        if (!target.startsWith("src/")) importProblem(node, `"${spec}" is outside src/. Import only your own files and ${ALLOWED_APP_IMPORTS.join(", ")}.`);
        return;
      }
      if (!allowedImport(spec)) importProblem(node, `"${spec}" cannot be used. Mini-apps import only ${ALLOWED_APP_IMPORTS.join(", ")} and their own files.`);
    };

    /** A member name read or written: `x.name`, `x["name"]`, `{ name } = x`. */
    const checkMember = (node: ts.Node, name: string): void => {
      const message = BANNED_MEMBERS.get(name);
      if (message !== undefined) safety(node, `${message} (${name})`);
    };

    /** The literal names a computed key can take, or null when it can be any text. */
    const keyNames = (key: ts.Expression): string[] | null => {
      if (ts.isStringLiteralLike(key)) return [key.text];
      if (ts.isNumericLiteral(key)) return [];
      if (checker === null) return null;
      const type = checker.getTypeAtLocation(key);
      const parts = type.isUnion() ? type.types : [type];
      const names: string[] = [];
      for (const t of parts) {
        if (t.isStringLiteral()) names.push(t.value);
        else if (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.Undefined)) continue;
        else return null;
      }
      return names;
    };

    const checkIdentifier = (id: ts.Identifier): void => {
      if (typeContext(id)) return;
      if (isDeclarationName(id)) {
        if (NO_DECLARE.has(id.text)) safety(id, `Do not name anything "${id.text}": that name is the page's own.`);
        return;
      }
      if (isNamePosition(id)) return;
      if (checker === null) return; // reported once for the file
      const symbol = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
      if (isOwn(symbol)) return;
      if (!SAFE_GLOBALS.has(id.text)) safety(id, `"${id.text}" is not available to a mini-app. Use @rms/sdk, @rms/ui, react and your own code.`);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        if (ts.isStringLiteral(node.moduleSpecifier)) checkSpecifier(node, node.moduleSpecifier.text);
        if (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) importProblem(node, "Import names one by one: no `import * as`.");
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier)) checkSpecifier(node, node.moduleSpecifier.text);
        if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) importProblem(node, "Export names one by one: no `export *`.");
      } else if (ts.isImportEqualsDeclaration(node)) {
        importProblem(node, "Use `import ... from`, not `import = require()`.");
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteralLike(arg)) checkSpecifier(node, arg.text);
          safety(node, "No import(): import at the top of the file.");
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          importProblem(node, "Use `import ... from`, not require().");
        } else if (ts.isIdentifier(node.expression) && (node.expression.text === "setTimeout" || node.expression.text === "setInterval")) {
          const arg = node.arguments[0];
          if (arg && !ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg) && !ts.isIdentifier(arg)) safety(node, "No code in a string: pass a function.");
        }
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
      } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        safety(node, "No import.meta: settings come from RMS, not from the build.");
      } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const isConst = ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(source) === "const";
        if (!isConst) safety(node, "No type casts (only `as const`): let the types say what a value is.");
      } else if (node.kind === ts.SyntaxKind.AnyKeyword) {
        safety(node, "No `any`: use a real type.");
      } else if (ts.isJsxSpreadAttribute(node)) {
        safety(node, "No spreading props: name each prop.");
      } else if (ts.isJsxAttribute(node)) {
        const attr = node.name.getText(source);
        const owner = node.parent.parent;
        const tag = owner.tagName.getText(source);
        const never = NEVER_ATTRS.get(attr);
        if (never !== undefined) safety(node, never);
        else if (/^[a-z]/.test(tag) && HOST_LOADING_ATTRS.has(attr)) {
          const init = node.initializer;
          const text = init !== undefined && ts.isStringLiteral(init) ? init.text : null;
          const inPageLink = attr === "href" && tag === "a" && text !== null && text.startsWith("#");
          const relativeImage = attr === "src" && tag === "img" && text !== null && !text.includes(":") && !text.startsWith("//") && !text.startsWith("\\");
          if (!inPageLink && !relativeImage) safety(node, `No ${attr} on <${tag}>: a mini-app loads nothing and sends the page nowhere. Links inside it start with "#".`);
        }
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        if (/^[a-z]/.test(tag) && !HOST_TAGS.has(tag)) safety(node, `No <${tag}> in a mini-app: use the components.`);
      } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
        const key = node.name.text;
        const v = fixed(node.initializer);
        if (key === "model" && v !== null) result.used.models.add(v);
        if (key === "query" && v !== null) result.used.queries.add(v);
        if (key === "action" && v !== null) result.used.actions.add(v);
      } else if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text;
        checkMember(node.name, name);
        if (EVENT_ELEMENT.has(name) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && EVENT_ELEMENT_READS.has(node.parent.name.text))) {
          safety(node, `Read an event only as ${name}.value or ${name}.checked.`);
        }
        const base = node.expression;
        if (ts.isIdentifier(base) && checker !== null && !isOwn(checker.getSymbolAtLocation(base))) {
          const members = SAFE_GLOBALS.get(base.text);
          if (members !== undefined && members !== "*" && !members.has(name)) safety(node, `${base.text}.${name} is not available to a mini-app.`);
        }
      } else if (ts.isElementAccessExpression(node)) {
        const names = keyNames(node.argumentExpression);
        if (names === null) safety(node, "Use a fixed name in [ ]: a key built from text cannot be checked.");
        else for (const n of names) {
          checkMember(node, n);
          if (EVENT_ELEMENT.has(n)) safety(node, `Read an event only as ${n}.value or ${n}.checked.`);
        }
        const base = node.expression;
        if (ts.isIdentifier(base) && checker !== null && !isOwn(checker.getSymbolAtLocation(base)) && SAFE_GLOBALS.get(base.text) !== "*") safety(node, `No [ ] on ${base.text}.`);
      } else if (ts.isBindingElement(node) && node.propertyName !== undefined) {
        if (ts.isComputedPropertyName(node.propertyName)) safety(node, "No computed names when unpacking: name each field.");
        else if (ts.isIdentifier(node.propertyName) || ts.isStringLiteral(node.propertyName)) {
          checkMember(node, node.propertyName.text);
          if (EVENT_ELEMENT.has(node.propertyName.text)) safety(node, "Read an event only as target.value or target.checked.");
        }
      } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)) {
        checkMember(node, node.name.text);
        if (EVENT_ELEMENT.has(node.name.text)) safety(node, "Read an event only as target.value or target.checked.");
      }
      if (ts.isIdentifier(node)) checkIdentifier(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return result;
};

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
