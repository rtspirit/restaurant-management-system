// The mini-app safety check (`rms check`: packages/generators/src/check/scan.ts), re-checked
// after task H's second security round made it an allow list built on the type checker.
//
// What is tried: every way of writing code that an allow list resting on TYPES and on NAMES
// could miss. Each case is one small file in a throwaway copy of the template. The whole set is
// scanned once, and each test asks one question: did the check refuse THIS file?
//
// Controls, so no test passes by accident: an honest file in the same scan has no problem at
// all (the scan is not refusing everything), and each case is its own module.
//
// KNOWN GAP tests use `it.fails`: the body states the rule we want, and today it does not hold.
// The day one is fixed its test goes red. That is the signal to remove `.fails`, nothing else.
// The check is an early warning for the build agent. The walls are the content policy header,
// the frame sandbox and the relay (ADR 0008), so a gap here is not by itself a way out.
//
// No database is touched. Files are written only under packages/app-template/.test-apps (git-ignored).
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoPath } from "../helpers/env.js";

type Problem = { file?: string; line?: number; message: string };
type AppFile = { path: string; link: boolean };
type Scan = { imports: Problem[]; safety: Problem[] };

// Loaded by path so this suite does not take on the packages' own build settings.
const { scanCode } = (await import(repoPath("packages/generators/src/check/scan.ts"))) as { scanCode: (appDir: string, files: AppFile[]) => Scan };
const { listAppFiles } = (await import(repoPath("packages/generators/src/lock.ts"))) as { listAppFiles: (appDir: string) => AppFile[] };
const { makeTempApp, prepareApp } = (await import(repoPath("packages/app-template/test/helpers.ts"))) as {
  makeTempApp: () => { dir: string; cleanup: () => void };
  prepareApp: (dir: string) => void;
};

// The compiler the check itself uses, to ask the second question a gap must answer: does the
// file also pass the `types` check? A file the type check refuses is not a gap.
const ts = createRequire(repoPath("packages/generators/package.json"))("typescript") as typeof import("typescript");

/** A change handler on a component: the only place a mini-app is handed an event. */
const handler = (body: string, before = ""): string =>
  `import { TextField } from "@rms/ui";\n${before}export function Screen() {\n  return <TextField label="x" onChange={(e) => { ${body} }} />;\n}\n`;

type Case = { name: string; file: string; text: string };
const tsx = (name: string, text: string, ext: "tsx" | "ts" = "tsx"): Case => ({ name, file: "", text, ...{ ext } }) as Case;

// ------------------------------------------------------------------ refused today (must stay refused)

const REFUSED: Case[] = [
  // Casts and `any`: the checker's view is the rule, so nothing may overrule it.
  tsx("a cast through unknown", handler('const k = ("vi" + "ew") as unknown as "type"; void e[k];')),
  tsx("an angle-bracket cast in a .ts file", 'export const k = <"type">(<unknown>("vi" + "ew"));\n', "ts"),
  tsx("a variable typed any", handler("const loose: any = e; void loose;")),
  tsx("satisfies does not make a text key a fixed name", handler('const k = ("vi" + "ew") satisfies string; void e[k];')),
  tsx("a text enum member that names a refused field", handler("void e[K.a];", 'enum K { a = "view" }\n')),
  tsx("a template key with no gaps", handler("void e[`nativeEvent`];")),
  tsx("a template key marked as const", handler('const k = `vi${"ew"}` as const; void e[k];')),
  tsx("an optional read with a refused name", handler('void e?.["view"];')),
  // The page's own names, however they are reached.
  tsx("typeof on a page name", "export const X = () => typeof window;\n"),
  tsx("a page name declared without a value (window)", "declare const window: { name: string };\nexport const X = () => window.name;\n"),
  tsx("a page name declared without a value (document)", "declare const document: { title: string };\nexport const X = () => document.title;\n"),
  tsx("a page name declared without a value (fetch)", 'declare function fetch(u: string): Promise<unknown>;\nexport const X = () => fetch("https://example.com");\n'),
  // Up the chain from an allowed global.
  tsx("Object.constructor", "export const X = () => Object.constructor;\n"),
  tsx("Math.constructor", "export const X = () => Math.constructor;\n"),
  tsx('Object["constructor"]', 'export const X = () => Object["constructor"];\n'),
  tsx("unpacking constructor from an allowed global", "export const X = () => { const { constructor } = Math; return constructor; };\n"),
  tsx("unpacking constructor under another name", "export const X = () => { const { constructor: c } = Math; return c; };\n"),
  tsx("Array.prototype", "export const X = () => Array.prototype;\n"),
  tsx("Object.getPrototypeOf", "export const X = () => Object.getPrototypeOf(Math);\n"),
  tsx("Object.assign", "export const X = () => Object.assign({}, { a: 1 });\n"),
  tsx("__proto__", "export const X = () => ({ a: 1 }).__proto__;\n"),
  tsx("Reflect", 'export const X = () => Reflect.get(Math, "abs");\n'),
  tsx("Proxy", "export const X = () => new Proxy({}, {});\n"),
  tsx("globalThis", "export const X = () => globalThis;\n"),
  // React's own ways to a page element.
  tsx("React.createElement through the default import", 'import React from "react";\nexport const X = () => React.createElement("iframe", { title: "x" });\n'),
  tsx("React.cloneElement through the default import", 'import React from "react";\nexport const X = () => React.cloneElement(<div />, {});\n'),
  tsx("a ref on a component", 'import { useRef } from "react";\nimport { TextField } from "@rms/ui";\nexport function X() { const r = useRef<HTMLInputElement>(null); return <TextField label="x" ref={r} />; }\n'),
  tsx("react-dom", 'import { createPortal } from "react-dom";\nexport const X = createPortal;\n'),
  tsx("react-dom/client", 'import { createRoot } from "react-dom/client";\nexport const X = createRoot;\n'),
  tsx("react/jsx-dev-runtime", 'import { jsxDEV } from "react/jsx-dev-runtime";\nexport const X = jsxDEV;\n'),
  // Code in text.
  tsx("text handed to setTimeout through a call", 'export const X = () => setTimeout(String("void 0"), 1);\n'),
  tsx("text handed to setInterval as a template", "export const X = () => setInterval(`void 0`, 1);\n"),
];

// ------------------------------------------------------------------ open today (KNOWN GAPS)

const OPEN: Case[] = [
  // A. A page name the code "declares" for itself. Nothing is made: the name still means the page's own.
  tsx("GAP a storage name declared without a value", 'declare const localStorage: { getItem(k: string): string | null };\nexport const X = () => localStorage.getItem("a");\n'),
  tsx("GAP a network name declared without a value", 'declare const WebSocket: new (u: string) => unknown;\nexport const X = () => new WebSocket("wss://example.com");\n'),
  tsx("GAP a page function declared without a value", 'declare function addEventListener(t: string, f: (m: { data: unknown }) => void): void;\nexport const X = () => addEventListener("message", () => undefined);\n'),
  tsx("GAP a page name declared for every file", "declare global {\n  var caches: CacheStorage;\n}\nexport const X = () => caches.keys();\n"),
  // B. A key whose TYPE is a fixed, harmless name while its VALUE is something else.
  tsx("GAP a key typed by JSON.parse", handler(`const k: "type" = JSON.parse('"view"'); void e[k];`)),
  tsx("GAP a key narrowed by a type guard that always says yes", handler('const k = "vi" + "ew"; if (isType(k)) void e[k];', 'const isType = (k: string): k is "type" => k.length > 0;\n')),
  tsx("GAP a key typed through an overload", handler('void e[key("vi" + "ew")];', 'function key(s: string): "type";\nfunction key(s: string): string { return s; }\n')),
  tsx("GAP a type error silenced with @ts-ignore", handler('// @ts-ignore\n    const k: "type" = "vi" + "ew"; void e[k];')),
  tsx("GAP a type error silenced with @ts-expect-error", handler('// @ts-expect-error\n    const k: "type" = "vi" + "ew"; void e[k];')),
  // C. Unpacking by assignment, not by declaration.
  tsx("GAP a refused field unpacked by assignment", handler("let v: unknown; ({ nativeEvent: v } = e); void v;")),
  tsx("GAP an event's element unpacked by assignment", handler("let t: unknown; ({ target: t } = e); void t;")),
  tsx("GAP constructor unpacked by assignment", "export const X = () => { let c: unknown; ({ constructor: c } = Math); return c; };\n"),
  // D. React by name, and a page element by another name.
  tsx("GAP createElement imported by name", 'import { createElement } from "react";\nexport const X = () => createElement("iframe", { src: "https://example.com", title: "x" });\n'),
  tsx("GAP createElement under another name, with markup as text", 'import { createElement as h } from "react";\nexport const X = () => h("div", { dangerouslySetInnerHTML: { __html: "x" } });\n'),
  tsx("GAP cloneElement imported by name, adding a style", 'import { cloneElement } from "react";\nexport const X = () => cloneElement(<div />, { style: { color: "red" } });\n'),
  tsx("GAP a ref handed over as a plain prop", 'import { createElement, useRef } from "react";\nexport function X() { const r = useRef<HTMLDivElement>(null); return createElement("div", { ref: r }); }\n'),
  tsx("GAP a page element behind a capital letter", 'const Frame = "iframe";\nexport const X = () => <Frame src="https://example.com" title="x" />;\n'),
  tsx("GAP a link out behind a capital letter", 'const Out = "a";\nexport const X = () => <Out href="https://example.com">Go</Out>;\n'),
  tsx("GAP a link out through a component", 'import { Button } from "@rms/ui";\nexport const X = () => <Button href="https://example.com">Go</Button>;\n'),
  // E. Code in text, through a variable.
  tsx("GAP text handed to setTimeout through a variable", 'export const X = () => { const code = "void 0"; return setTimeout(code, 1); };\n'),
];

const CONTROL: Case = tsx(
  "control",
  'import { TextField } from "@rms/ui";\nimport { useState } from "react";\nexport function Ok() {\n  const [v, setV] = useState("");\n  const keys = Object.keys({ a: 1 });\n  return <div><img alt="" src="logo.png" /><a href="#/x">x</a><TextField label={keys.join()} value={v} onChange={(e) => setV(e.target.value)} /></div>;\n}\n',
);

let app: { dir: string; cleanup: () => void } | null = null;
const problems = new Map<string, Problem[]>();
const typeErrors = new Map<string, string[]>();

beforeAll(() => {
  app = makeTempApp();
  prepareApp(app.dir);
  [CONTROL, ...REFUSED, ...OPEN].forEach((c, i) => {
    c.file = `src/components/sec/c${String(i).padStart(2, "0")}.${(c as Case & { ext: string }).ext}`;
    const path = join(app!.dir, c.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, c.text);
  });
  const scan = scanCode(app.dir, listAppFiles(app.dir));
  for (const p of [...scan.imports, ...scan.safety]) {
    if (p.file === undefined) continue;
    problems.set(p.file, [...(problems.get(p.file) ?? []), p]);
  }
  // The `types` check, file by file (the same settings file the check reads).
  const read = ts.readConfigFile(join(app.dir, "tsconfig.json"), ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(read.config, ts.sys, app.dir);
  const program = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: true } });
  for (const c of [CONTROL, ...OPEN]) {
    const source = program.getSourceFile(join(app.dir, c.file));
    if (!source) throw new Error(`${c.file} is not in the program`);
    const found = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
    typeErrors.set(c.file, found.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ").slice(0, 200)));
  }
}, 120_000);

afterAll(() => app?.cleanup());

const refusedFor = (c: Case): Problem[] => problems.get(c.file) ?? [];

describe("the mini-app safety check, after it became an allow list", () => {
  it("control: an honest file in the same scan has no problem, and the files were type checked", () => {
    expect(refusedFor(CONTROL)).toEqual([]);
    expect(typeErrors.get(CONTROL.file)).toEqual([]);
    const all = [...problems.values()].flat().map((p) => p.message);
    expect(all.some((m) => m.includes("could not be type checked"))).toBe(false);
  });

  for (const c of REFUSED) {
    it(`refuses: ${c.name}`, () => {
      expect(refusedFor(c).length, c.text).toBeGreaterThan(0);
    });
  }

  for (const c of OPEN) {
    it.fails(`KNOWN ${c.name}`, () => {
      // Refused by the scan (imports, safety) or by the type check: either closes the gap.
      const refusals = refusedFor(c).length + (typeErrors.get(c.file) ?? []).length;
      expect(refusals, c.text).toBeGreaterThan(0);
    });
  }
});
