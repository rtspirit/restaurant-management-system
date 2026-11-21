// The generators inside a real copy of the template: `list_detail` for vendor (and the other
// three), then `rms lock` and every `rms check`, including the type check and the static build.
// Then each thing `check` must refuse, one test each.
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckName, CheckOutput } from "@rms/contracts";
import { runCheck, runGenerator, writeLockedHashes } from "@rms/generators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VENDOR_SCREENS, makeTempApp, prepareApp } from "./helpers.js";

const result = (out: CheckOutput, check: CheckName) => out.results.find((r) => r.check === check);

let app: { dir: string; cleanup: () => void };

beforeAll(async () => {
  app = makeTempApp();
  prepareApp(app.dir);
  await writeLockedHashes(app.dir);
  for (const input of VENDOR_SCREENS) {
    const out = await runGenerator(app.dir, input);
    expect(out.ok, out.notes.join(" ")).toBe(true);
  }
}, 60_000);

afterAll(() => app?.cleanup());

describe("generated screens in a copy of the template", () => {
  it("pass every check, in order, including the type check and the build", async () => {
    const out = await runCheck(app.dir);
    const failing = out.results.filter((r) => !r.ok);
    expect(failing, JSON.stringify(failing, null, 2)).toEqual([]);
    expect(out.results.map((r) => r.check)).toEqual(["locked", "deps", "imports", "safety", "manifest", "types", "build"]);
    expect(readFileSync(join(app.dir, "dist/index.html"), "utf8")).toContain("<div id=\"root\">");
  }, 180_000);
});

// ------------------------------------------------------------------ what check refuses

const withFile = async (rel: string, text: string, only: CheckName[], run: (out: CheckOutput) => void): Promise<void> => {
  const path = join(app.dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  try {
    run(await runCheck(app.dir, { only }));
  } finally {
    rmSync(path, { force: true });
  }
};

const screenWith = (body: string): string => `import { useRms } from "@rms/sdk";\nexport function Bad() {\n  const rms = useRms();\n  ${body}\n  return null;\n}\n`;

const BANNED: Array<[string, string]> = [
  ["fetch", 'fetch("https://example.com");'],
  ["XMLHttpRequest", "new XMLHttpRequest();"],
  ["WebSocket", 'new WebSocket("wss://example.com");'],
  ["EventSource", 'new EventSource("/x");'],
  ["navigator.sendBeacon", 'navigator.sendBeacon("/x", "");'],
  ["eval", 'eval("1");'],
  ["new Function", 'new Function("return 1");'],
  ["import() of a computed path", 'const where = "x"; void import(where);'],
  ["innerHTML", 'document.body.innerHTML = "";'],
  ["document.cookie", "void document.cookie;"],
  ["localStorage", 'localStorage.setItem("a", "b");'],
  ["sessionStorage", "sessionStorage.clear();"],
  ["indexedDB", 'indexedDB.open("x");'],
  ["window.open", 'window.open("https://example.com");'],
  ["window.top", "void window.top;"],
  ["postMessage", 'window.parent.postMessage("x", "*");'],
  ["import.meta.env", "void import.meta.env;"],
  ["a computed window name", 'const k = "fet" + "ch"; (window as any)[k]("x");'],
  ["string code in setTimeout", 'setTimeout("alert(1)", 1);'],
  ["window kept in a variable", "const w = window as any; void w;"],
  ["globalThis", 'void (globalThis as any)["fe" + "tch"];'],
  ["bare location", 'location.href = "https://example.com";'],
  ["bare open()", 'open("https://example.com");'],
  ["bare parent[...]", 'void (parent as any)["post" + "Message"];'],
  ["bare top", "void top;"],
  ["bare opener", "void opener;"],
  ["bare frames", "void frames;"],
  ["bare self", "void self;"],
  ["document.defaultView", 'void (document.defaultView as any)["fe" + "tch"];'],
  ["Function kept in a variable", 'const F = Function; void F("return 1");'],
  ["eval kept in a variable", "const E = eval; void E;"],
  ["createElement with a style", 'void (rms as any).createElement("div", { style: {} });'],
  ["document.createElement", 'void document.createElement("script");'],
];

describe("check refuses", () => {
  it.each(BANNED)("%s (safety)", async (_name, body) => {
    await withFile("src/screens/bad/index.tsx", screenWith(body), ["safety"], (out) => {
      expect(out.ok).toBe(false);
      expect(result(out, "safety")?.problems[0]?.file).toBe("src/screens/bad/index.tsx");
    });
  });

  it.each([
    ["dangerouslySetInnerHTML", 'export const X = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;\n'],
    ["style=", "export const X = () => <div style={{ color: \"red\" }} />;\n"],
    ["className=", 'export const X = () => <div className="x" />;\n'],
    ["a CSS import", 'import "./look.css";\nexport const X = () => null;\n'],
    ["a PostCSS import", 'import "./look.pcss";\nexport const X = () => null;\n'],
    ["an import with a query", 'import look from "./look.ts?raw";\nexport const X = look;\n'],
    ["<a href> to another page", 'export const X = () => <a href="https://example.com">Go</a>;\n'],
    ["<form action>", 'export const X = () => <form action="https://example.com" />;\n'],
    ["<meta httpEquiv refresh>", 'export const X = () => <meta httpEquiv="refresh" content="0;url=https://example.com" />;\n'],
    ["<iframe>", 'export const X = () => <iframe title="x" />;\n'],
    ["a spread carrying style onto a host element", 'const p = { style: { color: "red" } };\nexport const X = () => <div {...p} />;\n'],
    ["a spread carrying className onto a host element", 'const p = { className: "x" };\nexport const X = () => <span {...p} />;\n'],
    ["a spread carrying dangerouslySetInnerHTML onto a host element", 'const p = { dangerouslySetInnerHTML: { __html: "x" } };\nexport const X = () => <p {...p} />;\n'],
  ])("%s (safety)", async (_name, text) => {
    await withFile("src/components/x.tsx", text, ["safety"], (out) => expect(result(out, "safety")?.ok).toBe(false));
  });

  it.each([["look.pcss"], ["look.styl"], ["look.sss"]])("a stylesheet file %s (safety)", async (name) => {
    await withFile(`src/components/${name}`, "a { color: red }\n", ["safety"], (out) => expect(result(out, "safety")?.ok).toBe(false));
  });

  it.each([
    ["toString", "const n = 3; void n.toString();"],
    ["valueOf", "const n = 3; void n.valueOf();"],
    ["hasOwnProperty", 'const o = { a: 1 }; void Object.prototype.hasOwnProperty.call(o, "a");'],
    ["constructor", "const o = {}; void o.constructor;"],
    ["a bare toString", "void toString;"],
    ["a state named open", "const [open, setOpen] = [false, (v: boolean) => v]; void open; void setOpen;"],
    ["a prop named top", "const box = { top: 1 }; void box.top;"],
  ])("passes ordinary code: %s", async (_name, body) => {
    await withFile("src/screens/ok/index.tsx", screenWith(body), ["safety"], (out) => expect(result(out, "safety")?.problems).toEqual([]));
  });

  it("passes an in-page link and a spread onto a component", async () => {
    await withFile("src/components/ok.tsx", 'import { Button } from "@rms/ui";\nconst p = { variant: "quiet" as const };\nexport const X = () => <><a href="#/vendors">Vendors</a><Button {...p}>Go</Button></>;\n', ["safety"], (out) => expect(result(out, "safety")?.problems).toEqual([]));
  });

  it("a stylesheet file (safety)", async () => {
    await withFile("src/components/look.css", "body { color: red }\n", ["safety"], (out) => expect(result(out, "safety")?.ok).toBe(false));
  });

  it.each([
    ["a package outside the list", 'import { z } from "zod";\nexport const X = z;\n'],
    ["node built-ins", 'import { readFileSync } from "node:fs";\nexport const X = readFileSync;\n'],
    ["a file outside src", 'import config from "../../vite.config";\nexport const X = config;\n'],
    ["require", 'const x = require("react");\nexport const X = x;\n'],
    ["re-export from another package", 'export { z } from "zod";\n'],
  ])("%s (imports)", async (_name, text) => {
    await withFile("src/components/x.tsx", text, ["imports"], (out) => expect(result(out, "imports")?.ok).toBe(false));
  });

  it("a model or report that is not in the plan (manifest)", async () => {
    await withFile("src/screens/bad/index.tsx", 'import { useNamedQuery, useQuery } from "@rms/sdk";\nexport function Bad() { useQuery({ model: "staff_shift" }); useNamedQuery("stock_on_hand"); return null; }\n', ["manifest"], (out) => {
      expect(result(out, "manifest")?.problems.map((p) => p.message).join(" ")).toMatch(/staff_shift.*stock_on_hand/s);
    });
  });

  it("a dependency that is not allowed (deps)", async () => {
    const path = join(app.dir, "package.json");
    const before = readFileSync(path, "utf8");
    const pkg = JSON.parse(before) as { dependencies: Record<string, string> };
    pkg.dependencies["left-pad"] = "1.3.0";
    writeFileSync(path, JSON.stringify(pkg));
    try {
      const out = await runCheck(app.dir, { only: ["deps", "locked"] });
      expect(result(out, "deps")?.ok).toBe(false);
      expect(result(out, "locked")?.problems.map((p) => p.file)).toContain("package.json");
    } finally {
      writeFileSync(path, before);
    }
  });

  it("a type error (types)", async () => {
    await withFile("src/components/x.tsx", "export const X: number = \"text\";\n", ["types"], (out) => {
      expect(result(out, "types")?.problems[0]).toMatchObject({ file: "src/components/x.tsx", line: 1 });
    });
  }, 60_000);
});

describe("the locked rule", () => {
  const lockedProblems = async () => result(await runCheck(app.dir, { only: ["locked"] }), "locked")?.problems ?? [];

  it("passes on the generated app after rms lock", async () => {
    expect(await lockedProblems()).toEqual([]);
  });

  it.each([["src/rms/app.tsx"], ["vite.config.ts"], ["rms.config.ts"], ["AGENTS.md"]])("fails when a locked file changes: %s", async (rel) => {
    const path = join(app.dir, rel);
    const before = readFileSync(path, "utf8");
    writeFileSync(path, `${before}\n// changed\n`);
    try {
      expect((await lockedProblems()).map((p) => p.file)).toContain(rel);
    } finally {
      writeFileSync(path, before);
    }
  });

  it("fails when .env.local changes", async () => {
    const path = join(app.dir, ".env.local");
    const before = readFileSync(path, "utf8");
    writeFileSync(path, "VITE_RMS_SHELL_ORIGIN=https://evil.example\n");
    try {
      expect((await lockedProblems()).map((p) => p.file)).toContain(".env.local");
    } finally {
      writeFileSync(path, before);
    }
  });

  it("fails on a new file in src/rms/", async () => {
    await withFile("src/rms/extra.ts", "export {};\n", ["locked"], (out) => expect(result(out, "locked")?.problems.map((p) => p.file)).toContain("src/rms/extra.ts"));
  });

  it("fails on a file in public/", async () => {
    await withFile("public/robots.txt", "x\n", ["locked"], (out) => expect(result(out, "locked")?.problems.map((p) => p.file)).toContain("public/robots.txt"));
  });

  it("fails when a listed locked file is missing", async () => {
    const path = join(app.dir, "src/rms/route.ts");
    const before = readFileSync(path, "utf8");
    rmSync(path);
    try {
      expect((await lockedProblems()).map((p) => p.file)).toContain("src/rms/route.ts");
    } finally {
      writeFileSync(path, before);
    }
  });

  it("fails on a link", async () => {
    const path = join(app.dir, "src/components/link.tsx");
    mkdirSync(join(app.dir, "src/components"), { recursive: true });
    symlinkSync(join(app.dir, "src/rms/app.tsx"), path);
    try {
      expect((await lockedProblems()).map((p) => p.file)).toContain("src/components/link.tsx");
    } finally {
      rmSync(path);
    }
  });

  it("fails when the hash list is not readable", async () => {
    const list = join(app.dir, ".rms/locked.json");
    const before = readFileSync(list, "utf8");
    writeFileSync(list, "{}");
    try {
      expect((await lockedProblems()).length).toBeGreaterThan(0);
    } finally {
      writeFileSync(list, before);
    }
  });
});
