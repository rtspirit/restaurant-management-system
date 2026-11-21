// Finds and loads the local settings file, and refuses to run against anything but a local database.
// This suite ATTACKS the database it is pointed at. It must only ever be our own local demo stack.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/**
 * Where `.env.local` may be, in order:
 *   1. `RMS_ENV_FILE`, if set.
 *   2. The repo root (the main checkout and CI).
 *   3. The main checkout, when this is a git worktree (a worktree has no `.env.local` of its own).
 *      A worktree's `.git` is a file that says `gitdir: <main>/.git/worktrees/<name>`.
 */
const envFileCandidates = (): string[] => {
  const out: string[] = [];
  if (process.env.RMS_ENV_FILE) out.push(process.env.RMS_ENV_FILE);
  out.push(resolve(REPO_ROOT, ".env.local"));
  const dotGit = resolve(REPO_ROOT, ".git");
  if (existsSync(dotGit) && statSync(dotGit).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    const marker = "/.git/worktrees/";
    const at = m?.[1]?.indexOf(marker) ?? -1;
    if (m?.[1] && at > 0) out.push(resolve(m[1].slice(0, at), ".env.local"));
  }
  return out;
};

const REQUIRED = ["DATABASE_URL", "DATABASE_ADMIN_URL", "ASK_DATABASE_HOST", "RMS_TOKEN_SECRET", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"] as const;

const isLocalHost = (host: string): boolean => host === "127.0.0.1" || host === "localhost" || host === "[::1]";

/** Loads the settings. Variables already set in the environment win (CI sets them itself). */
export const loadEnv = (): void => {
  for (const file of envFileCandidates()) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      break;
    }
  }
};

/**
 * Throws unless every setting is present and every address is local.
 * A missing database is a FAILURE, never a skip: a security suite that quietly runs nothing is worse than none.
 */
export const assertLocalTarget = (): void => {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Security suite cannot run: missing ${missing.join(", ")}. Start the local stack and run scripts/dev-db-roles.sh, or set RMS_ENV_FILE.`);
  }
  const hosts: Record<string, string> = {
    DATABASE_URL: new URL(process.env.DATABASE_URL as string).hostname,
    DATABASE_ADMIN_URL: new URL(process.env.DATABASE_ADMIN_URL as string).hostname,
    ASK_DATABASE_HOST: (process.env.ASK_DATABASE_HOST as string).split(":")[0] ?? "",
    SUPABASE_URL: new URL(process.env.SUPABASE_URL as string).hostname,
  };
  const remote = Object.entries(hosts).filter(([, h]) => !isLocalHost(h)).map(([k]) => k);
  if (remote.length > 0) {
    throw new Error(`Security suite refuses to run: ${remote.join(", ")} does not point at 127.0.0.1 or localhost. These are attack tests for the local demo database only.`);
  }
};

export const repoPath = (...parts: string[]): string => resolve(REPO_ROOT, ...parts);
