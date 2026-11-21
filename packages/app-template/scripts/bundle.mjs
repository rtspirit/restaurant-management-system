#!/usr/bin/env node
// Writes bundle/template.tgz: a self-contained copy of the template that installs with
// `npm ci` from the public registry only. Our own packages are packed into vendor/.
//
// Holds NONE of the runner-written files (rms.config.ts, .env.local, .rms/) and no tests.
// The runner unpacks it into the app folder, writes its four files, then runs `npm ci`.
//
// Run with: pnpm --filter @rms/app-template bundle   (builds @rms/contracts and @rms/generators first)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES = join(TEMPLATE, "..");
const OUT = join(TEMPLATE, "bundle", "template.tgz");

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const template = read(join(TEMPLATE, "package.json"));
const exact = (name) => {
  const v = template.dependencies[name] ?? template.devDependencies[name];
  if (!v || !/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`${name} needs an exact version in the template's package.json`);
  return v;
};

/** Our packages and what goes into each. @rms/* dependencies are left out: the app lists all four at the top. */
const VENDORED = [
  { name: "@rms/contracts", dir: "contracts", files: ["dist"], need: "dist/index.js" },
  { name: "@rms/sdk", dir: "sdk", files: ["src"], need: "src/index.ts" },
  { name: "@rms/ui", dir: "ui", files: ["src"], need: "src/index.ts" },
  { name: "@rms/generators", dir: "generators", files: ["dist", "bin"], need: "dist/cli.js" },
];

const isTestFile = (path) => /\.test\.(ts|tsx)$/.test(path) || /(^|\/)testing(\/|$)/.test(path);

const stage = mkdtempSync(join(tmpdir(), "rms-template-"));
const app = join(stage, "app");
const packs = join(stage, "packs");
mkdirSync(join(app, "vendor"), { recursive: true });
mkdirSync(packs, { recursive: true });

try {
  // 1. Our packages, packed with npm from a clean copy with a publishable package.json.
  const vendorSpecs = {};
  for (const v of VENDORED) {
    const src = join(PACKAGES, v.dir);
    if (!existsSync(join(src, v.need))) throw new Error(`${v.name} is not built (${v.need} is missing). Run the build first.`);
    const copy = join(packs, v.dir);
    mkdirSync(copy, { recursive: true });
    for (const f of v.files) cpSync(join(src, f), join(copy, f), { recursive: true, filter: (p) => !isTestFile(p.slice(src.length + 1)) });
    const pkg = read(join(src, "package.json"));
    const deps = Object.fromEntries(Object.entries(pkg.dependencies ?? {}).filter(([n]) => !n.startsWith("@rms/")));
    const clean = {
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: "module",
      exports: pkg.exports,
      ...(pkg.bin ? { bin: pkg.bin } : {}),
      files: v.files,
      ...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}),
      ...(pkg.peerDependencies ? { peerDependencies: pkg.peerDependencies } : {}),
    };
    writeFileSync(join(copy, "package.json"), `${JSON.stringify(clean, null, 2)}\n`);
    const file = execFileSync("npm", ["pack", "--silent", "--pack-destination", join(app, "vendor")], { cwd: copy, encoding: "utf8" }).trim().split("\n").pop();
    vendorSpecs[v.name] = `file:vendor/${file}`;
  }

  // 2. The template's own files. Not the runner's four, not the tests.
  for (const f of ["index.html", "tsconfig.json", "vite.config.ts", "AGENTS.md", "src"]) cpSync(join(TEMPLATE, f), join(app, f), { recursive: true });

  // 3. The app's package.json: exactly the allowed dependencies, ours from vendor/.
  const pkg = {
    name: "rms-mini-app",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "vite build" },
    dependencies: { "@rms/sdk": vendorSpecs["@rms/sdk"], "@rms/ui": vendorSpecs["@rms/ui"], react: exact("react"), "react-dom": exact("react-dom") },
    devDependencies: {
      "@rms/contracts": vendorSpecs["@rms/contracts"],
      "@rms/generators": vendorSpecs["@rms/generators"],
      "@types/react": exact("@types/react"),
      "@types/react-dom": exact("@types/react-dom"),
      "@vitejs/plugin-react": exact("@vitejs/plugin-react"),
      typescript: exact("typescript"),
      vite: exact("vite"),
    },
  };
  writeFileSync(join(app, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

  // 4. The lock file, made by npm against the public registry.
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], { cwd: app, stdio: ["ignore", "ignore", "inherit"] });

  // 5. Pack it all up.
  mkdirSync(dirname(OUT), { recursive: true });
  rmSync(OUT, { force: true });
  execFileSync("tar", ["-czf", OUT, "-C", app, "."]);
  const listed = readdirSync(app).sort().join(", ");
  process.stdout.write(`Wrote ${OUT}\nTop level: ${listed}\n`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
