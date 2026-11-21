// `check`: the checks in CheckName, in that order. Problems are for the agent: plain, short,
// and pointing at a file and line where there is one.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  ALLOWED_APP_DEPENDENCIES,
  APP_TEMPLATE,
  type CheckInput,
  type CheckName,
  type CheckOutput,
  LockedHashes,
  type SandboxCatalog,
  isEditablePath,
  isHashedPath,
  isIgnoredPath,
  isLockedPath,
} from "@rms/contracts";
import ts from "typescript";
import { readCatalogFile } from "../app-files.js";
import { type AppFile, listAppFiles, sha256File } from "../lock.js";
import { type Problem, type ScanResult, manifestProblems, scanCode } from "./scan.js";

const ORDER: CheckName[] = ["locked", "deps", "imports", "safety", "manifest", "types", "build"];
const MAX_PROBLEMS = 50;

// ------------------------------------------------------------------ locked

export const lockedProblems = (appDir: string, files: AppFile[]): Problem[] => {
  const problems: Problem[] = [];
  let listed: Record<string, string> = {};
  const listPath = join(appDir, APP_TEMPLATE.lockedHashesFile);
  if (!existsSync(listPath)) {
    problems.push({ file: APP_TEMPLATE.lockedHashesFile, message: "The list of locked files is missing. RMS writes it when a build starts." });
  } else {
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(listPath, "utf8"));
    } catch {
      // reported below
    }
    const parsed = LockedHashes.safeParse(raw);
    if (!parsed.success) problems.push({ file: APP_TEMPLATE.lockedHashesFile, message: "The list of locked files is not readable. It is locked: do not change it." });
    else listed = parsed.data.files;
  }

  const present = new Set<string>();
  for (const f of files) {
    present.add(f.path);
    if (f.link) {
      problems.push({ file: f.path, message: "Links are not allowed in a mini-app. Make it a plain file." });
      continue;
    }
    if (isHashedPath(f.path)) {
      const want = listed[f.path];
      if (want === undefined) problems.push({ file: f.path, message: "This file is in a locked place and RMS did not put it there. Remove it." });
      else if (sha256File(join(appDir, f.path)) !== want) problems.push({ file: f.path, message: "This file is locked and was changed. Put it back as it was." });
    } else if (!isLockedPath(f.path) && !isEditablePath(f.path) && !isIgnoredPath(f.path)) {
      problems.push({ file: f.path, message: "This file should not be here. Screens go in src/screens/, your own components in src/components/." });
    }
  }
  for (const path of Object.keys(listed)) if (!present.has(path)) problems.push({ file: path, message: "This locked file is missing. Put it back." });
  return problems;
};

// ------------------------------------------------------------------ deps

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"] as const;

export const depsProblems = (appDir: string): Problem[] => {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return [{ file: "package.json", message: "package.json is missing or not readable. It is locked: put it back." }];
  }
  const problems: Problem[] = [];
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    const allowed: readonly string[] = field === "dependencies" ? ALLOWED_APP_DEPENDENCIES.dependencies : field === "devDependencies" ? ALLOWED_APP_DEPENDENCIES.devDependencies : [];
    const names = deps !== null && typeof deps === "object" ? Object.keys(deps) : [];
    if (allowed.length === 0 && names.length > 0) problems.push({ file: "package.json", message: `"${field}" must be empty. Nothing can be installed in a mini-app.` });
    for (const name of names) if (allowed.length > 0 && !allowed.includes(name)) problems.push({ file: "package.json", message: `"${name}" is not allowed. Nothing can be installed in a mini-app.` });
  }
  return problems;
};

// ------------------------------------------------------------------ types

export const typeProblems = (appDir: string): Problem[] => {
  const configPath = join(appDir, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return [{ file: "tsconfig.json", message: "tsconfig.json is not readable. It is locked: put it back." }];
  const config = ts.parseJsonConfigFileContent(read.config, ts.sys, appDir);
  const program = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: true } });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n").slice(0, 400);
    if (!d.file || d.start === undefined) return { message };
    const file = d.file.fileName.startsWith(appDir) ? d.file.fileName.slice(appDir.length + 1) : d.file.fileName;
    return { file, line: d.file.getLineAndCharacterOfPosition(d.start).line + 1, message };
  });
};

// ------------------------------------------------------------------ build

export const buildProblems = (appDir: string): Problem[] => {
  let viteBin: string;
  try {
    const require = createRequire(join(appDir, "package.json"));
    const pkgPath = require.resolve("vite/package.json");
    const bin = (JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: Record<string, string> }).bin?.vite ?? "bin/vite.js";
    viteBin = join(dirname(pkgPath), bin);
  } catch {
    return [{ message: "The build tool is not installed here." }];
  }
  const run = spawnSync(process.execPath, [viteBin, "build", "--logLevel", "error"], { cwd: appDir, encoding: "utf8", timeout: 180_000, env: { ...process.env, NODE_ENV: "production" } });
  if (run.status === 0) return [];
  const text = `${run.stderr ?? ""}\n${run.stdout ?? ""}`.trim();
  const lines = text.split("\n").filter((l) => l.trim() !== "").slice(0, 8);
  return [{ message: (lines.join("\n") || "The build failed.").slice(0, 400) }];
};

// ------------------------------------------------------------------ all of them

export const runChecks = async (appDir: string, input: CheckInput = {}): Promise<CheckOutput> => {
  const started = Date.now();
  const wanted = new Set(input.only ?? ORDER);
  const files = listAppFiles(appDir);
  let scan: ScanResult | null = null;
  const getScan = (): ScanResult => (scan ??= scanCode(appDir, files));
  let catalog: SandboxCatalog | null = null;
  try {
    catalog = await readCatalogFile(appDir);
  } catch {
    catalog = null;
  }

  const results: CheckOutput["results"] = [];
  for (const check of ORDER) {
    if (!wanted.has(check)) continue;
    let problems: Problem[];
    switch (check) {
      case "locked":
        problems = lockedProblems(appDir, files);
        break;
      case "deps":
        problems = depsProblems(appDir);
        break;
      case "imports":
        problems = getScan().imports;
        break;
      case "safety":
        problems = getScan().safety;
        break;
      case "manifest":
        problems = manifestProblems(getScan(), catalog);
        break;
      case "types":
        problems = typeProblems(appDir);
        break;
      case "build":
        problems = buildProblems(appDir);
        break;
    }
    results.push({ check, ok: problems.length === 0, problems: problems.slice(0, MAX_PROBLEMS).map((p) => ({ ...p, message: p.message.slice(0, 400) })) });
  }
  return { ok: results.every((r) => r.ok), results, durationMs: Date.now() - started };
};
