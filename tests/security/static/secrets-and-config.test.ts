// Things that can be checked by reading the repository: no secrets in tracked files, nothing
// secret reachable from browser code, and no database access in the packages a browser loads.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, repoPath } from "../helpers/env.js";

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|mp4|mov)$/i;
const SKIP = /(^|\/)pnpm-lock\.yaml$/;

/** Every tracked text file, read once. */
const files = tracked
  .filter((f) => !BINARY.test(f) && !SKIP.test(f) && existsSync(repoPath(f)) && statSync(repoPath(f)).isFile() && statSync(repoPath(f)).size < 2_000_000)
  .map((f) => ({ path: f, text: readFileSync(repoPath(f), "utf8") }));

describe("no secrets in the repository", () => {
  it("there are tracked files to look at (so the checks below are not empty)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.path === "packages/db/src/index.ts")).toBe(true);
  });

  it("none of this machine's real secret values appears in any tracked file", () => {
    const passwordOf = (url: string | undefined) => {
      try {
        return url ? decodeURIComponent(new URL(url).password) : "";
      } catch {
        return "";
      }
    };
    const secrets: Record<string, string> = {
      RMS_TOKEN_SECRET: process.env.RMS_TOKEN_SECRET ?? "",
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY ?? "",
      SUPABASE_DB_PASSWORD: process.env.SUPABASE_DB_PASSWORD ?? "",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
      DEMO_PASSWORD: process.env.DEMO_PASSWORD ?? "",
      "DATABASE_URL password": passwordOf(process.env.DATABASE_URL),
      "DATABASE_ADMIN_URL password": passwordOf(process.env.DATABASE_ADMIN_URL),
    };
    const hits: string[] = [];
    let checked = 0;
    for (const [name, value] of Object.entries(secrets)) {
      if (value.length < 12) continue; // unset, or too short to search for without false alarms
      checked++;
      for (const f of files) if (f.text.includes(value)) hits.push(`${name} in ${f.path}`);
    }
    expect(hits).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it("no tracked file holds anything shaped like a key, a token or a connection string with a password", () => {
    const PATTERNS: [string, RegExp][] = [
      ["Supabase secret key", /sb_secret_[A-Za-z0-9_-]{16,}/g],
      ["OpenAI key", /\bsk-(proj-)?[A-Za-z0-9_-]{24,}/g],
      ["signed token", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g],
      ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
      ["connection string with a password", /postgres(?:ql)?:\/\/[^:\s"'`/]+:([^@\s"'`$[\]<>{}]{8,})@[A-Za-z0-9.-]*/g],
      ["AWS key", /\bAKIA[0-9A-Z]{16}\b/g],
      ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
      ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
      ["Vercel token", /\bvercel_[A-Za-z0-9]{20,}\b/gi],
    ];
    // The local Docker database's built-in login, the same on every machine and documented by Supabase.
    const ALLOWED = [/postgres(?:ql)?:\/\/postgres:postgres@(127\.0\.0\.1|localhost)/];
    // Exact strings that look like a credential and are not one, by SHA-256 so the string is not repeated here.
    // Checked by hand before being added: say what each is.
    const ALLOWED_EXACT: Record<string, string> = {
      // apps/api/src/routes/auth.test.ts: a made-up token used to prove garbage is refused. Its header has no key id,
      // its claims are {sub: "x", role: "authenticated"} with no issuer or expiry, and its "signature" is the word "signature".
      "3425da024cd8eae04916a0eccce485336c3413de0d95aecc6384e59603c739a6": "apps/api/src/routes/auth.test.ts",
    };
    const hits: string[] = [];
    for (const f of files) {
      for (const [what, re] of PATTERNS) {
        for (const m of f.text.matchAll(re)) {
          if (ALLOWED.some((a) => a.test(m[0]))) continue;
          if (ALLOWED_EXACT[createHash("sha256").update(m[0]).digest("hex")] === f.path) continue;
          hits.push(`${what} in ${f.path}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("the settings file with real values is never tracked, and the example file has no values", () => {
    expect(tracked.filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith(".env.example"))).toEqual([]);
    expect(tracked.filter((f) => /\.(pem|key|p12|pfx)$/.test(f))).toEqual([]);
    const ignore = readFileSync(repoPath(".gitignore"), "utf8");
    expect(ignore).toMatch(/^\.env\.\*$/m);
    const example = readFileSync(repoPath(".env.example"), "utf8");
    for (const line of example.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!m) continue;
      if (/(SECRET|PASSWORD|KEY|TOKEN|DATABASE.*URL)/.test(m[1] as string)) expect(m[2], m[1]).toBe("");
    }
  });
});

describe("nothing secret can reach a browser", () => {
  const SECRET_NAMES = ["DATABASE_URL", "DATABASE_ADMIN_URL", "SUPABASE_SECRET_KEY", "SUPABASE_DB_PASSWORD", "RMS_TOKEN_SECRET", "OPENAI_API_KEY", "ASK_DATABASE_HOST", "DEMO_PASSWORD"];

  it("no browser-visible setting is named like a secret", () => {
    const hits: string[] = [];
    for (const f of files) for (const m of f.text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) if (/(SECRET|PASSWORD|PRIVATE|TOKEN|DATABASE|ADMIN|SERVICE_ROLE|OPENAI)/.test(m[0])) hits.push(`${m[0]} in ${f.path}`);
    expect(hits).toEqual([]);
  });

  it("no file that runs in the browser reads a secret setting or opens the database", () => {
    const hits: string[] = [];
    for (const f of files.filter((x) => /\.(tsx?|jsx?|mjs)$/.test(x.path))) {
      const client = /^\s*["']use client["']/m.test(f.text) || f.path.startsWith("packages/ui/");
      if (!client) continue;
      for (const name of SECRET_NAMES) if (f.text.includes(name)) hits.push(`${name} in ${f.path}`);
      if (/from\s+["'](@rms\/db|postgres|@rms\/seed|@rms\/parent)["']/.test(f.text)) hits.push(`database import in ${f.path}`);
    }
    expect(hits).toEqual([]);
  });

  it("the web apps and the UI package do not depend on the database packages", () => {
    for (const pkg of ["apps/web/package.json", "apps/admin/package.json", "packages/ui/package.json"]) {
      const json = JSON.parse(readFileSync(repoPath(pkg), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = Object.keys({ ...json.dependencies, ...json.devDependencies });
      for (const banned of ["@rms/db", "postgres", "pg", "@rms/seed", "@rms/parent"]) expect(deps, `${pkg} depends on ${banned}`).not.toContain(banned);
    }
  });

  it("only @rms/db opens database connections: no other product source imports the driver", () => {
    // Test files may import it (the seed's reset tests build connection objects from crafted addresses, without
    // connecting, to attack the wipe guard). Anything that ships must go through @rms/db.
    const hits = files
      .filter((f) => /\.(tsx?|mjs|js)$/.test(f.path) && !f.path.startsWith("packages/db/") && !f.path.startsWith("tests/security/") && !/\.test\.tsx?$/.test(f.path))
      .filter((f) => /from\s+["']postgres["']|require\(["']postgres["']\)|from\s+["']pg["']/.test(f.text))
      .map((f) => f.path);
    expect(hits).toEqual([]);
  });

  it("no product code connects as the database superuser", () => {
    const hits = files
      .filter((f) => /\.(tsx?|mjs|js)$/.test(f.path) && /^(apps|packages)\//.test(f.path) && !/\.test\.tsx?$/.test(f.path))
      .filter((f) => /postgres(?:ql)?:\/\/postgres[:@]|SUPABASE_DB_PASSWORD/.test(f.text))
      .map((f) => f.path);
    expect(hits).toEqual([]);
  });
});

describe("model names are never hard-coded", () => {
  it("no product source names an OpenAI model directly", () => {
    const hits = files
      .filter((f) => /^(apps|packages)\/.*\.(tsx?|mjs|js)$/.test(f.path))
      .filter((f) => /["'`](gpt-[0-9a-z.-]+|o[134]-[a-z0-9-]+|text-embedding-[0-9a-z-]+|codex-[a-z0-9-]+)["'`]/i.test(f.text))
      .map((f) => f.path);
    expect(hits).toEqual([]);
  });
});
