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
    ["a field named hasOwnProperty", "const o = { hasOwnProperty: 1 }; void o.hasOwnProperty;"],
    ["toLocaleString", "const n = 3; void n.toLocaleString();"],
    ["a local named toString", "const toString = 1; void toString;"],
    ["a state named shown", "const [shown, setShown] = [false, (v: boolean) => v]; void shown; void setShown;"],
    ["a field read with a fixed key", 'const box: Record<string, number> = { height: 1 }; void box["height"];'],
  ])("passes ordinary code: %s", async (_name, body) => {
    await withFile("src/screens/ok/index.tsx", screenWith(body), ["safety"], (out) => expect(result(out, "safety")?.problems).toEqual([]));
  });

  it("passes an in-page link", async () => {
    await withFile("src/components/ok.tsx", 'import { Button } from "@rms/ui";\nexport const X = () => <><a href="#/vendors">Vendors</a><Button variant="quiet">Go</Button></>;\n', ["safety"], (out) => expect(result(out, "safety")?.problems).toEqual([]));
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

// ------------------------------------------------------------------ security review, round 2

const handler = (body: string): string =>
  `import { TextField } from "@rms/ui";\nexport function Bad() {\n  return <TextField label="x" onChange={(e) => { ${body} }} />;\n}\n`;

describe("check refuses (review round 2)", () => {
  it.each([
    ["react/jsx-runtime", 'import { jsx } from "react/jsx-runtime";\nexport const X = () => jsx("iframe", { src: "https://example.com" });\n'],
    ["a namespace import of an allowed package", 'import * as UI from "@rms/ui";\nexport const X = UI;\n'],
    ["a namespace import of react", 'import * as R from "react";\nexport const X = R;\n'],
  ])("%s (imports)", async (_name, text) => {
    await withFile("src/components/x.tsx", text, ["imports"], (out) => expect(result(out, "imports")?.ok).toBe(false));
  });

  it.each([
    ["a local named location unlocking the real one", 'function a() { const location = 1; return location; }\nexport function b() { location.href = "https://example.com"; return a(); }\n'],
    ["a local named parent unlocking the real one", 'function a() { const parent = 1; return parent; }\nexport function b() { (parent as unknown as { postMessage(m: string): void }).postMessage("x"); return a(); }\n'],
    ["declaring window", "export function b() { const window = 1; return window; }\n"],
  ])("%s (safety)", async (_name, text) => {
    await withFile("src/components/x.tsx", text, ["safety"], (out) => expect(result(out, "safety")?.ok).toBe(false));
  });

  it.each([
    ["ref on a host element", 'import { useRef } from "react";\nexport function X() { const r = useRef<HTMLDivElement>(null); return <div ref={r} />; }\n'],
    ["ref on a component", 'import { useRef } from "react";\nimport { TextField } from "@rms/ui";\nexport function X() { const r = useRef<HTMLInputElement>(null); return <TextField label="x" ref={r} />; }\n'],
    ["a spread onto a component", 'import { TextField } from "@rms/ui";\nconst p = { label: "x" };\nexport const X = () => <TextField {...p} />;\n'],
  ])("%s (safety)", async (_name, text) => {
    await withFile("src/components/x.tsx", text, ["safety"], (out) => expect(result(out, "safety")?.ok).toBe(false));
  });

  it.each([
    ["e.view", "void e.view;"],
    ["e.nativeEvent", "void e.nativeEvent;"],
    ["e.target.ownerDocument", "void e.target.ownerDocument;"],
    ["e.currentTarget.ownerDocument.defaultView", "void e.currentTarget.ownerDocument.defaultView;"],
    ["e.target.parentNode", "void e.target.parentNode;"],
    ["e.target used on its own", "const t = e.target; void t;"],
    ["a computed key that is not a fixed name", 'const k = "vi" + "ew"; void e[k as "type"];'],
    ["a wide string key", 'const r: Record<string, unknown> = { ...e }; const k: string = "vi" + "ew"; void r[k];'],
    ["a literal banned key", 'void e["nativeEvent"];'],
    ["a computed destructuring key", 'const k = "view"; const { [k]: v } = e; void v;'],
    ["a cast to any", "void (e as any);"],
    ["Object.values", "void Object.values(e);"],
    ["Object.entries", "void Object.entries(e);"],
    ["Reflect", 'void Reflect.get(e, "view");'],
    [".constructor", 'void (() => 1).constructor;'],
    [".call", "const f = () => 1; void f.call(null);"],
  ])("reaching the page through an event: %s (safety)", async (_name, body) => {
    await withFile("src/components/x.tsx", handler(body), ["safety"], (out) => expect(result(out, "safety")?.ok).toBe(false));
  });

  it.each([
    ["RTCPeerConnection", "void new RTCPeerConnection();"],
    ["Worker", 'void new Worker("x.js");'],
    ["SharedWorker", 'void new SharedWorker("x.js");'],
    ["ServiceWorker", "void ServiceWorker;"],
    ["navigator.serviceWorker", "void navigator.serviceWorker;"],
    ["BroadcastChannel", 'void new BroadcastChannel("x");'],
    ["MessageChannel", "void new MessageChannel();"],
    ["URL.createObjectURL", "void URL.createObjectURL(new Blob([]));"],
    ["Blob", "void new Blob([]);"],
    ["Image", "void new Image();"],
    ["Audio", "void new Audio();"],
  ])("%s (safety)", async (_name, body) => {
    await withFile("src/screens/bad/index.tsx", screenWith(body), ["safety"], (out) => expect(result(out, "safety")?.ok).toBe(false));
  });

  it.each([
    ["img with an outside src", '<img alt="" src="https://example.com/x.png" />'],
    ["img with a protocol-relative src", '<img alt="" src="//example.com/x.png" />'],
    ["img with a computed src", '<img alt="" src={"https://" + "example.com"} />'],
    ["video", '<video src="x.mp4" />'],
    ["audio", '<audio src="x.mp3" />'],
    ["source", '<source src="x.mp4" />'],
    ["object", '<object data="x" />'],
    ["embed", '<embed src="x" />'],
    ["link", '<link rel="prefetch" href="x" />'],
    ["script", "<script />"],
    ["svg image", '<svg><image href="https://example.com/x.png" /></svg>'],
    ["svg use", '<svg><use href="https://example.com/x.svg#a" /></svg>'],
    ["a host element that is not on the list", "<marquee>x</marquee>"],
  ])("%s (safety)", async (_name, el) => {
    await withFile("src/components/x.tsx", `export const X = () => ${el};\n`, ["safety"], (out) => expect(result(out, "safety")?.ok).toBe(false));
  });

  it.each([["src/components/x.TSX"], ["src/components/x.js"], ["src/components/x.jsx"], ["src/components/x.mts"], ["src/components/data.json"], ["src/screens/a/notes.md"]])(
    "a file that is not .ts or .tsx: %s (locked)",
    async (rel) => {
      await withFile(rel, "export {};\n", ["locked"], (out) => expect(result(out, "locked")?.problems.map((p) => p.file)).toContain(rel));
    },
  );

  it.each([["vite.config.js"], [".env.development.local"], [".npmrc"], [".env"], ["postcss.config.js"]])("a new root file: %s (locked)", async (rel) => {
    await withFile(rel, "x=1\n", ["locked"], (out) => expect(result(out, "locked")?.problems.map((p) => p.file)).toContain(rel));
  });

  it("still passes ordinary handlers and a relative image", async () => {
    await withFile(
      "src/components/ok.tsx",
      'import { TextField } from "@rms/ui";\nimport { useState } from "react";\nexport function Ok() {\n  const [v, setV] = useState("");\n  const keys = Object.keys({ a: 1 });\n  return <div><img alt="" src="logo.png" /><TextField label={keys.join()} value={v} onChange={(e) => setV(e.target.value)} /></div>;\n}\n',
      ["imports", "safety"],
      (out) => expect(out.results.flatMap((r) => r.problems)).toEqual([]),
    );
  });
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
