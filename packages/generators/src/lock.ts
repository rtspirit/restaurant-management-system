// The locked-file rule from @rms/contracts build.ts: every file is locked, editable or ignored.
// `writeLockedHashes` is for trying the template by hand and for tests. In a real build the
// RUNNER writes `.rms/locked.json`, after its own files, and keeps its own trusted copy.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_TEMPLATE, IGNORED_TEMPLATE_FOLDERS, LockedHashes, isHashedPath } from "@rms/contracts";

export type AppFile = { path: string; link: boolean };

const IGNORED_ROOTS = new Set(IGNORED_TEMPLATE_FOLDERS.map((f) => f.slice(0, -1)));

/** Every file in the app folder, relative, with forward slashes. Ignored folders are not entered. Links are listed, never followed. */
export const listAppFiles = (appDir: string): AppFile[] => {
  const out: AppFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (prefix === "" && IGNORED_ROOTS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) out.push({ path: rel, link: true });
      else if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push({ path: rel, link: false });
    }
  };
  walk(appDir, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
};

export const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The hashes of every locked file that exists, except the hash list itself. */
export const hashLockedFiles = (appDir: string): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const f of listAppFiles(appDir)) {
    if (f.link || !isHashedPath(f.path)) continue;
    if (!lstatSync(join(appDir, f.path)).isFile()) continue;
    files[f.path] = sha256File(join(appDir, f.path));
  }
  return files;
};

/** Writes `.rms/locked.json` for the files as they are now. Local use and tests only. */
export const writeLockedHashes = async (appDir: string): Promise<LockedHashes> => {
  const hashes = LockedHashes.parse({ version: 1, writtenAt: new Date().toISOString(), files: hashLockedFiles(appDir) });
  await mkdir(join(appDir, ".rms"), { recursive: true });
  await writeFile(join(appDir, APP_TEMPLATE.lockedHashesFile), `${JSON.stringify(hashes, null, 2)}\n`);
  return hashes;
};
